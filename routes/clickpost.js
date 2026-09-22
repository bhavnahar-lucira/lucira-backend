/**
 * Clickpost Tracking Routes (Fastify)
 * Handles order tracking queries and Clickpost tracking webhook updates.
 * Order creation is handled upstream via Ornaverse / ERP.
 */

const { shopifyAdminRestFetch } = require('../lib/shopify');

async function routes(fastify, options) {

  // GET /api/clickpost/track/:orderId
  // Retrieves tracking details and Clickpost order status link
  fastify.get('/track/:orderId', async (request, reply) => {
    try {
      const orderId = String(request.params.orderId || "").trim();
      const cleanId = orderId.replace(/^[#\s]+/, '');
      const digitsOnly = orderId.replace(/\D/g, '');
      const queryWaybill = request.query.waybill ? String(request.query.waybill).trim() : null;

      let waybill = queryWaybill;
      let cp_id = request.query.cp_id || null;
      let courierName = null;
      let trackingUrl = null;
      let customStatus = null;

      const db = fastify.mongo?.db;
      if (db) {
        const queryCriteria = [
          { orderNumber: cleanId },
          { documentNo: orderId },
          { documentNo: `#${cleanId}` }
        ];
        if (digitsOnly && digitsOnly !== cleanId) {
          queryCriteria.push({ orderNumber: digitsOnly });
        }
        if (queryWaybill) {
          queryCriteria.push({ clickpost_waybill: queryWaybill }, { waybill: queryWaybill });
        }

        customStatus = await db.collection('order_statuses').findOne({ $or: queryCriteria });
        if (customStatus) {
          waybill = waybill || customStatus.clickpost_waybill || customStatus.waybill || customStatus.awb || customStatus.tracking_number || customStatus.tracking_no;
          cp_id = cp_id || customStatus.clickpost_courier_partner_id || customStatus.courier_partner_id || customStatus.cp_id;
          courierName = courierName || customStatus.courier_name || customStatus.courier;
          trackingUrl = trackingUrl || customStatus.tracking_url || customStatus.clickpost_tracking_url;
        }
      }

      // If waybill not found in Mongo, try querying Shopify Admin order fulfillment
      if (!waybill) {
        try {
          const shopifyId = digitsOnly || cleanId;
          if (shopifyId) {
            const { data } = await shopifyAdminRestFetch(`orders/${shopifyId}.json`, {});
            const orderRaw = data?.order;
            if (orderRaw?.fulfillments?.length > 0) {
              for (const f of orderRaw.fulfillments) {
                if (f.tracking_number) {
                  waybill = f.tracking_number;
                  courierName = courierName || f.tracking_company;
                  trackingUrl = trackingUrl || f.tracking_url;
                  break;
                }
              }
            }
          }
        } catch (e) {
          // Non-fatal, Shopify lookup is best effort
          console.warn("[Clickpost] Shopify fulfillment lookup fallback failed (non-fatal):", e.message);
        }
      }

      const clickpostUsername = process.env.CLICKPOST_USERNAME || "lucirajewels-test";
      const clickpostKey = process.env.CLICKPOST_API_KEY || "334a7fc0-598e-45d9-b599-455dea42da45";

      if (!waybill) {
        return {
          success: true,
          waybill: null,
          courierName: null,
          tracking: null,
          clickpostUrl: null,
          message: "Tracking number not yet assigned for this order."
        };
      }

      // Build default Clickpost tracking portal link
      let finalClickpostUrl = trackingUrl || (clickpostUsername 
        ? `https://${clickpostUsername}.clickpost.in/?waybill=${encodeURIComponent(waybill)}`
        : `https://track.clickpost.in/?waybill=${encodeURIComponent(waybill)}`);

      let trackingResult = null;

      // Query ClickPost Track API
      try {
        let trackApiUrl = `https://api.clickpost.in/api/v2/track-order/?username=${encodeURIComponent(clickpostUsername)}&key=${encodeURIComponent(clickpostKey)}&waybill=${encodeURIComponent(waybill)}`;
        if (cp_id) {
          trackApiUrl += `&cp_id=${encodeURIComponent(cp_id)}`;
        }

        const cpResponse = await fetch(trackApiUrl);
        const cpData = await cpResponse.json();

        if (cpResponse.ok && cpData?.meta?.success) {
          const resultObj = cpData.result?.[waybill] || cpData.result?.[Object.keys(cpData.result || {})[0]];
          if (resultObj) {
            trackingResult = resultObj;
            if (resultObj.courier_name && !courierName) {
              courierName = resultObj.courier_name;
            }
            if (resultObj.tracking_url || resultObj.additional?.tracking_url) {
              finalClickpostUrl = resultObj.tracking_url || resultObj.additional.tracking_url;
            }
          }
        } else {
          console.warn(`[Clickpost] API returned non-success for waybill ${waybill}:`, cpData?.meta?.message || cpData);
        }
      } catch (fetchErr) {
        console.warn("[Clickpost] Error fetching live tracking from Clickpost API:", fetchErr.message);
      }

      return {
        success: true,
        waybill,
        courierName,
        clickpostUrl: finalClickpostUrl,
        tracking: trackingResult
      };
    } catch (err) {
      console.error("[Clickpost] Error in /track/:orderId:", err);
      return reply.code(500).send({ error: "Failed to fetch tracking details", message: err.message });
    }
  });

  // POST /api/clickpost/tracking-webhook
  // Listens to status updates pushed by ClickPost
  fastify.post('/tracking-webhook', async (request, reply) => {
    reply.code(200).send({ success: true, message: "Webhook acknowledged" });
    try {
      const payload = request.body || {};
      const waybill = payload.waybill || payload.awb;
      const latestStatus = payload.latest_status || payload.status;

      if (!waybill || !latestStatus) return;

      const db = fastify.mongo?.db;
      if (db) {
        await db.collection('order_statuses').updateOne(
          { 
            $or: [
              { clickpost_waybill: waybill },
              { waybill: waybill }
            ]
          },
          {
            $set: {
              clickpost_latest_status: latestStatus,
              updatedAt: new Date()
            },
            $push: {
              clickpost_scans: latestStatus
            }
          }
        );
        console.log(`[Clickpost Webhook] Updated tracking for waybill ${waybill}`);
      }
    } catch (err) {
      console.error("[Clickpost Webhook] Error processing webhook:", err);
    }
  });

  // POST /api/clickpost/test-sync-order
  // Development & Testing helper:
  // Creates a test shipment in ClickPost (or links a given waybill) and saves it to MongoDB
  fastify.post('/test-sync-order', async (request, reply) => {
    try {
      const { orderNumber, waybill: manualWaybill, courierName } = request.body || {};

      if (!orderNumber) {
        return reply.code(400).send({ error: "orderNumber is required (e.g. '2905' or 'LUCIRA-TEST-001')" });
      }

      const cleanOrderNumber = String(orderNumber).replace(/^[#\s]+/, '').trim();
      let waybill = manualWaybill;
      let courierPartnerId = 5;
      let resolvedCourierName = courierName || "Bluedart";
      let clickpostResponse = null;

      // If no waybill provided, create a test order in ClickPost Sandbox
      if (!waybill) {
        const clickpostUsername = process.env.CLICKPOST_USERNAME || "lucirajewels-test";
        const clickpostKey = process.env.CLICKPOST_API_KEY || "334a7fc0-598e-45d9-b599-455dea42da45";

        const testPayload = {
          pickup_info: {
            pickup_name: "Lucira Jewelry Test",
            pickup_address: "Lucira HQ Test Hub",
            pickup_city: "Mumbai",
            pickup_state: "Maharashtra",
            pickup_pincode: "400062",
            pickup_country: "India",
            pickup_phone: "9967337489",
            email: "tech@lucirajewelry.com",
            pickup_time: new Date(Date.now() + 86400000).toISOString()
          },
          drop_info: {
            drop_name: "Customer Test",
            drop_address: "Customer Address Test",
            drop_city: "Mumbai",
            drop_state: "Maharashtra",
            drop_pincode: "400001",
            drop_country: "IN",
            drop_phone: "9999999999",
            drop_email: "customer@example.com"
          },
          shipment_details: {
            order_id: cleanOrderNumber,
            reference_number: cleanOrderNumber,
            order_type: "PREPAID",
            invoice_value: 1500,
            invoice_number: `INV-${cleanOrderNumber}`,
            invoice_date: new Date().toISOString().split('T')[0],
            length: 15,
            breadth: 10,
            height: 5,
            weight: 500,
            cod_value: 0,
            courier_partner: 5,
            account_code: "Bluedart Lucira",
            delivery_type: "FORWARD",
            items: [
              {
                sku: `SKU-${cleanOrderNumber}`,
                price: 1500,
                weight: 500,
                quantity: 1,
                description: "Fine Jewelry Item"
              }
            ]
          },
          additional: {
            async: false,
            label: true,
            channel_name: "Shopify",
            is_fragile: true,
            is_dangerous: false
          }
        };

        const cpResponse = await fetch(`https://www.clickpost.in/api/v3/create-order/?key=${clickpostKey}&username=${clickpostUsername}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testPayload)
        });

        clickpostResponse = await cpResponse.json();

        if (cpResponse.ok && clickpostResponse.meta?.success) {
          waybill = clickpostResponse.result?.waybill;
          courierPartnerId = clickpostResponse.result?.courier_partner_id || 5;
          resolvedCourierName = clickpostResponse.result?.courier_name || resolvedCourierName;
        } else {
          return reply.code(400).send({
            error: "Failed to create order in ClickPost",
            details: clickpostResponse
          });
        }
      }

      // Save waybill to MongoDB order_statuses so /api/clickpost/track/:orderId finds it immediately
      const db = fastify.mongo?.db;
      if (db) {
        await db.collection('order_statuses').updateOne(
          {
            $or: [
              { orderNumber: cleanOrderNumber },
              { documentNo: cleanOrderNumber },
              { documentNo: `#${cleanOrderNumber}` }
            ]
          },
          {
            $set: {
              orderNumber: cleanOrderNumber,
              documentNo: cleanOrderNumber,
              clickpost_waybill: waybill,
              waybill: waybill,
              clickpost_courier_partner_id: courierPartnerId,
              courier_name: resolvedCourierName,
              status: "In Transit",
              reason_status_description: "In Transit",
              updatedAt: new Date()
            }
          },
          { upsert: true }
        );
      }

      return {
        success: true,
        message: `Order #${cleanOrderNumber} synced with ClickPost test tracking successfully!`,
        orderNumber: cleanOrderNumber,
        waybill,
        courierName: resolvedCourierName,
        trackingTestUrl: `/api/clickpost/track/${cleanOrderNumber}`,
        frontendOrderUrl: `/admin/orders/${cleanOrderNumber}`,
        clickpostResult: clickpostResponse?.result || null
      };
    } catch (err) {
      console.error("[Clickpost Test Sync] Error:", err);
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
