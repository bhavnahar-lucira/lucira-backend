/**
 * Webhooks Route (Fastify)
 */
const { scheduleCacheClear, queueRevalidation } = require('../lib/storefrontRevalidation');
const crypto = require('crypto');
const returnsLib = require('../lib/returns');

async function routes(fastify, options) {

  const verifyShopifyHmac = (request) => {
    const hmacHeader = request.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) return true; // not configured -> skip (dev)
    if (!hmacHeader || !request.rawBody) return false;
    const generatedHash = crypto
      .createHmac('sha256', secret)
      .update(request.rawBody, 'utf8')
      .digest('base64');
    try {
      return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
    } catch (_) {
      return false;
    }
  };

  // Custom parser to save raw body for HMAC verification
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
    try {
      req.rawBody = body; // Save raw body for HMAC
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // POST /api/webhooks/checkout-crm
  fastify.post('/checkout-crm', async (request, reply) => {
    try {
      const { type, payload } = request.body || {};

      const webhookUrl = type === "add_payment_info"
        ? "https://payment-info-webhook-385594025448.asia-south1.run.app/webhookb7n1p132p4"
        : "https://checkout-crm-webhook-385594025448.us-central1.run.app/webhookb6n1p8s2z3";

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.text();

      if (!response.ok) {
        console.error(`[Webhook Error] ${webhookUrl} responded with status ${response.status}:`, data);
        return reply.code(response.status).send({ error: "Webhook failed", details: data });
      }

      return reply.code(200).send({ success: true, message: "Webhook sent successfully" });
    } catch (error) {
      console.error("[Webhook Exception]:", error);
      return reply.code(500).send({ error: "Internal Server Error", details: error.message });
    }
  });

  // POST /api/webhooks/headless
  fastify.post('/headless', async (request, reply) => {
    try {
      const { type, payload } = request.body || {};

      const webhookUrl = type === "ProductView"
        ? "https://productview-headless-webhook-385594025448.asia-south1.run.app/webhookb1n6q4h1b8"
        : "https://atc-headless-webhook-385594025448.asia-south1.run.app/webhookbe2p6x9n4r8";

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.text();

      if (!response.ok) {
        console.error(`[Webhook Error] ${webhookUrl} responded with status ${response.status}:`, data);
        return reply.code(response.status).send({ error: "Webhook failed", details: data });
      }

      return reply.code(200).send({ success: true, message: "Webhook sent successfully" });
    } catch (error) {
      console.error("[Webhook Exception]:", error);
      return reply.code(500).send({ error: "Internal Server Error", details: error.message });
    }
  });

  // POST /api/webhooks/shopify/products
  fastify.post('/shopify/products', async (request, reply) => {
    // 1. Verify Shopify HMAC Signature
    const hmacHeader = request.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

    if (secret && hmacHeader && request.rawBody) {
      const generatedHash = crypto
        .createHmac('sha256', secret)
        .update(request.rawBody, 'utf8')
        .digest('base64');

      if (generatedHash !== hmacHeader) {
        console.warn(`[Webhook] Invalid HMAC signature! Expected ${hmacHeader}, got ${generatedHash}`);
        return reply.code(401).send({ error: 'Unauthorized webhook' });
      }
    } else if (secret && !hmacHeader) {
      console.warn(`[Webhook] Missing HMAC header in request.`);
      return reply.code(401).send({ error: 'Missing signature' });
    }

    // 2. Acknowledge Shopify Webhook immediately
    reply.code(200).send({ success: true, message: "Webhook received" });

    // One endpoint serves products/create, products/update and products/delete;
    // Shopify names the event in the topic header.
    const topic = request.headers['x-shopify-topic'] || 'products/update';
    const payload = request.body || {};

    try {
      // 3. Work out which product pages changed. A delete payload is only
      //    { id }, and a handle rename leaves the OLD url cached, so both need
      //    the handle this product had last time — see resolveHandles.
      const handles = await resolveHandles(fastify, 'product', topic, payload);
      console.log(`[Webhook] ${topic}: ${handles.join(', ') || `id ${payload.id || 'unknown'} (handle not known yet)`}`);

      // 4. Clear all backend memory caches — rate-limited, see scheduleCacheClear.
      scheduleCacheClear(`${topic}:${handles[0] || payload.id || 'unknown'}`);

      // 5. Debounced frontend revalidation (see lib/storefrontRevalidation.js).
      //    The product's own page, plus every collection page and the homepage,
      //    since any of their grids may show it. A 2,500-product bulk update
      //    still costs one call to Vercel.
      queueRevalidation({ products: handles, collectionsAll: true, home: true }, topic);
    } catch (err) {
      console.error("[Webhook] Error during webhook processing:", err);
    }
  });

  // POST /api/webhooks/shopify/collections
  // Register collections/create, collections/update and collections/delete here.
  fastify.post('/shopify/collections', async (request, reply) => {
    if (!verifyShopifyHmac(request)) {
      console.warn('[Webhook collections] Invalid or missing HMAC signature.');
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    reply.code(200).send({ success: true, message: "Webhook received" });

    const topic = request.headers['x-shopify-topic'] || 'collections/update';
    const payload = request.body || {};

    try {
      const handles = await resolveHandles(fastify, 'collection', topic, payload);
      console.log(`[Webhook] ${topic}: ${handles.join(', ') || `id ${payload.id || 'unknown'} (handle not known yet)`}`);

      scheduleCacheClear(`${topic}:${handles[0] || payload.id || 'unknown'}`);

      // A deleted collection we never saw a handle for can't be targeted, so
      // fall back to every collection page. The homepage carries collection
      // carousels (bestsellers, gemstone, sports), so refresh it as well.
      queueRevalidation(
        { collections: handles, collectionsAll: handles.length === 0, home: true },
        topic
      );
    } catch (err) {
      console.error('[Webhook collections] Processing error:', err);
    }
  });

  // POST /api/webhooks/shopify/returns
  // Register these topics in Shopify for production status sync:
  //   returns/request, returns/approve, returns/decline, returns/close,
  //   returns/cancel, returns/update, returns/process
  // On localhost the storefront falls back to live-fetching status on load,
  // so this route is only required in production (needs a public URL).
  fastify.post('/shopify/returns', async (request, reply) => {
    if (!verifyShopifyHmac(request)) {
      console.warn('[Webhook returns] Invalid or missing HMAC signature.');
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    // Acknowledge immediately (Shopify requires a fast 200).
    reply.code(200).send({ success: true });

    try {
      const payload = request.body || {};
      const topic = request.headers['x-shopify-topic'] || 'returns/update';
      const returnGid = payload.admin_graphql_api_id
        || (payload.id ? `gid://shopify/Return/${payload.id}` : null);
      if (!returnGid) return;

      const db = fastify.mongo.db;
      const returnsCollection = db.collection('returns');

      // Prefer authoritative status straight from Shopify; fall back to the topic.
      let status = null;
      try {
        const view = await returnsLib.getReturnDetail(returnGid);
        status = view?.status || null;
      } catch (_) { /* fall through to topic mapping */ }

      if (!status) {
        const TOPIC_STATUS = {
          'returns/request': 'REQUESTED',
          'returns/approve': 'OPEN',
          'returns/decline': 'DECLINED',
          'returns/cancel': 'CANCELED',
          'returns/close': 'CLOSED',
        };
        status = TOPIC_STATUS[topic] || payload.status || 'REQUESTED';
      }

      await returnsCollection.updateOne(
        { returnId: returnGid },
        { $set: { status, updatedAt: new Date(), lastWebhookTopic: topic } }
      );
      console.log(`[Webhook returns] ${topic} -> ${returnGid} = ${status}`);
    } catch (err) {
      console.error('[Webhook returns] processing error:', err);
    }
  });

  // ---------------------------------------------------------------------------
  // Shopify Inventory Webhooks
  // Handles:
  //   - inventory_items/create
  //   - inventory_items/update
  //   - inventory_items/delete
  //   - inventory_levels/connect
  //   - inventory_levels/update
  //   - inventory_levels/disconnect
  // ---------------------------------------------------------------------------
  const handleShopifyInventory = async (request, reply) => {
    // 1. Verify Shopify HMAC Signature
    if (!verifyShopifyHmac(request)) {
      console.warn('[Webhook inventory] Invalid or missing HMAC signature.');
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    // 2. Acknowledge Shopify Webhook immediately (Shopify requires 200 within 5 seconds)
    reply.code(200).send({ success: true, message: "Inventory webhook received" });

    const topic = request.headers['x-shopify-topic'] || 'inventory_levels/update';
    const payload = request.body || {};
    const itemId = payload.inventory_item_id || payload.id || null;
    const locationId = payload.location_id || null;
    const available = payload.available !== undefined ? payload.available : null;

    console.log(`[Webhook] Inventory event received [${topic}]: Item ID ${itemId || 'unknown'}, Location: ${locationId || 'N/A'}, Available: ${available !== null ? available : 'N/A'}`);

    try {
      // 3. Clear backend memory caches with rate-limiting & cooldown (store-availability, collection sorting, counts)
      scheduleCacheClear(`inventory:${topic}`);

      // 4. Debounced Frontend ISR Revalidation (homepage and store availability)
      queueRevalidation({ home: true }, topic);
    } catch (err) {
      console.error('[Webhook inventory] Processing error:', err);
    }
  };

  // POST /api/webhooks/shopify/inventory (Unified endpoint for all 6 inventory events)
  fastify.post('/shopify/inventory', handleShopifyInventory);

  // Dedicated topic endpoints (in case configured individually in Shopify)
  fastify.post('/shopify/inventory-items', handleShopifyInventory);
  fastify.post('/shopify/inventory-levels', handleShopifyInventory);

  // ---------------------------------------------------------------------------
  // Order Status Webhook (ERP / WebEngage sync)
  // Handles incoming ERP / manufacturing milestone status updates
  // POST /api/webhooks/order-status
  // ---------------------------------------------------------------------------
  fastify.post('/order-status', async (request, reply) => {
    try {
      const payload = request.body || {};

      // Flexible extraction from nested or flat payload:
      // Case 1: Webhook forwarder format: { data: { document_no, reason_status_description, ... }, customer, lead }
      // Case 2: WebEngage event format: { eventData: { document_no, reason_status_description, ... }, userId }
      // Case 3: Direct payload format: { document_no, reason_status_description, ... }
      const data = payload.data || payload.eventData || payload;
      const customer = payload.customer || payload.lead || {};

      const rawDocNo = data.document_no || data.documentNo || data.order_number || data.orderNumber || payload.document_no || "";
      const statusDescription = (data.reason_status_description || data.status || data.order_status || payload.reason_status_description || "").trim();
      const documentDate = data.document_date || data.event_time || payload.event_time || payload.timestamp || new Date().toISOString();
      const mobile = data.mobile || data["Phone Number"] || customer.phone || payload.userId || "";
      const itemName = data.item_name || data.itemName || "";
      const itemCode = data.item_code || data.itemCode || "";
      const weight = Number(data.weight) || 0;
      const netWeight = Number(data.net_weight) || 0;
      const image = data.image || "";
      const partyName = data.party_name || customer.name || "";

      if (!rawDocNo) {
        return reply.code(400).send({
          success: false,
          error: "document_no is required"
        });
      }

      const docNoStr = String(rawDocNo).trim();
      // Clean order number: e.g. "#2905" -> "2905", "SO-2905" -> "2905"
      const cleanOrderNumber = docNoStr.replace(/^[#\s]+/, '').trim();
      const digitsOnly = docNoStr.replace(/\D/g, '');

      const db = fastify.mongo.db;
      const orderStatusesCol = db.collection('order_statuses');

      const normDesc = statusDescription.toLowerCase().replace(/[^a-z0-9]/g, '');
      let mappedStatus = statusDescription;
      let mappedStage = statusDescription;

      if (normDesc === 'pogenerated' || normDesc === 'inprogress') {
        mappedStatus = 'Processing';
        mappedStage = 'PO Generated';
      } else if (normDesc.includes('readytoinvoice') || normDesc.includes('readytoship')) {
        mappedStatus = 'Dispatch';
        mappedStage = 'Ready to Invoice';
      } else if (normDesc.includes('outfordelivery') || normDesc.includes('outfordeliver')) {
        mappedStatus = 'Out For Delivery';
        mappedStage = 'Out For Delivery';
      } else if (normDesc.includes('intransit') || normDesc === 'transit') {
        mappedStatus = 'In Transit';
        mappedStage = 'In Transit';
      } else if (normDesc.includes('delivered')) {
        mappedStatus = 'Delivered';
        mappedStage = 'Delivered';
      } else if (normDesc.includes('orderplaced') || normDesc.includes('pickuppending') || normDesc.includes('onlineshipmentbooked')) {
        mappedStatus = 'Order Placed';
        mappedStage = 'Pickup Pending';
      }

      const statusUpdate = {
        status: mappedStatus,
        stage: mappedStage,
        originalStatus: statusDescription,
        date: documentDate,
        timestamp: new Date()
      };

      const queryCriteria = [
        { orderNumber: cleanOrderNumber },
        { documentNo: docNoStr },
        { documentNo: `#${cleanOrderNumber}` }
      ];
      if (digitsOnly && digitsOnly !== cleanOrderNumber) {
        queryCriteria.push({ orderNumber: digitsOnly });
      }

      await orderStatusesCol.updateOne(
        { $or: queryCriteria },
        {
          $set: {
            orderNumber: cleanOrderNumber,
            documentNo: docNoStr,
            status: mappedStatus,
            stage: mappedStage,
            reason_status_description: statusDescription,
            documentDate: documentDate,
            mobile: mobile,
            itemName: itemName,
            itemCode: itemCode,
            weight: weight,
            netWeight: netWeight,
            image: image,
            partyName: partyName,
            updatedAt: new Date()
          },
          $push: {
            history: statusUpdate
          }
        },
        { upsert: true }
      );

      console.log(`[Webhook Order Status] Synced Order #${cleanOrderNumber} (${docNoStr}) -> "${statusDescription}" at ${documentDate}`);

      return reply.code(200).send({
        success: true,
        message: "Order status synchronized successfully",
        orderNumber: cleanOrderNumber,
        status: statusDescription,
        date: documentDate
      });
    } catch (err) {
      console.error("[Webhook Order Status] Error:", err);
      return reply.code(500).send({
        success: false,
        error: "Internal Server Error",
        details: err.message
      });
    }
  });

  // GET /api/webhooks/order-status/:id
  fastify.get('/order-status/:id', async (request, reply) => {
    try {
      const id = String(request.params.id || "").trim();
      const cleanId = id.replace(/^[#\s]+/, '');
      const db = fastify.mongo.db;
      const status = await db.collection('order_statuses').findOne({
        $or: [
          { orderNumber: cleanId },
          { documentNo: id },
          { documentNo: `#${cleanId}` }
        ]
      });
      if (!status) return reply.code(404).send({ error: "Order status not found" });
      return { success: true, status };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Handle memory for product / collection webhooks
// ---------------------------------------------------------------------------
// A products/delete (or collections/delete) payload is only { id } — no handle,
// and the product is already gone from Shopify, so there is nothing left to
// look it up from. A rename has the same problem in reverse: the payload has
// the NEW handle, but the page cached on Vercel lives at the OLD one.
//
// So every create/update records id → handle in Mongo, and a delete or rename
// reads it back. The map fills itself: the daily price update touches every
// product, so after one day every live product is known.
//
// Returns every handle whose page should be refreshed (possibly empty).
const HANDLE_MAP_COLLECTION = 'shopify_handle_map';

async function resolveHandles(fastify, kind, topic, payload) {
  const id = payload?.id ? String(payload.id) : null;
  const handle = typeof payload?.handle === 'string' ? payload.handle.trim() : '';
  const db = fastify.mongo?.db;
  if (!id || !db) return handle ? [handle] : [];

  const col = db.collection(HANDLE_MAP_COLLECTION);
  const key = `${kind}:${id}`;

  try {
    if (topic.endsWith('/delete')) {
      const prev = await col.findOneAndDelete({ _id: key });
      return prev?.handle ? [prev.handle] : [];
    }
    if (!handle) return [];

    const prev = await col.findOneAndUpdate(
      { _id: key },
      { $set: { handle, updatedAt: new Date() } },
      { upsert: true, returnDocument: 'before' }
    );
    return prev?.handle && prev.handle !== handle ? [handle, prev.handle] : [handle];
  } catch (err) {
    // The map is a nice-to-have. Never let it block the refresh itself.
    console.error(`[Webhook] Handle map lookup failed for ${key}: ${err.message}`);
    return handle ? [handle] : [];
  }
}

module.exports = routes;
