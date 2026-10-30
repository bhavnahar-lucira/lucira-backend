/**
 * Admin Dashboard Routes (Fastify)
 */

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const { shopifyAdminRestFetch } = require('../lib/shopify');

  // Background index creation to speed up dashboard queries (non-blocking)
  db.collection('abandoned_carts').createIndex({ updatedAt: -1 }).catch(console.error);
  db.collection('user_tracking').createIndex({ timestamp: -1 }).catch(console.error);
  db.collection('user_tracking').createIndex({ type: 1, timestamp: -1 }).catch(console.error);

  // GET /api/admin/carts
  fastify.get('/carts', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const { start_date, end_date, customer_type, page, limit } = request.query;
      const collection = db.collection('abandoned_carts');
      
      const query = { "items.0": { $exists: true } };
      
      if (customer_type === 'CUSTOMER') {
        query.userId = { $exists: true, $ne: null };
      } else if (customer_type === 'GUEST') {
        query.userId = { $exists: false };
      }

      let startD = start_date ? new Date(`${start_date}T00:00:00+05:30`) : new Date(0);
      let endD = end_date ? new Date(`${end_date}T23:59:59+05:30`) : new Date();

      if (start_date || end_date) {
        query.updatedAt = {};
        if (start_date) query.updatedAt.$gte = startD;
        if (end_date) query.updatedAt.$lte = endD;
      }

      const inHouseIPs = ['106.201.243.160', '106.201.243.156', '122.179.139.168', '122.179.140.17', '103.88.221.55', '45.250.47.102'];

      const total = await collection.countDocuments(query);

      // DEBUG DATES
      console.log(`[Admin Carts] start_date: ${start_date}, end_date: ${end_date}`);
      console.log(`[Admin Carts] startD: ${startD.toISOString()}, endD: ${endD.toISOString()}`);
      console.log(`[Admin Carts] Total matched docs: ${total}`);

      // Fast, full date-range overview aggregation for 3 KPI Cards
      const baseDateQuery = { "items.0": { $exists: true } };
      if (start_date || end_date) {
        baseDateQuery.updatedAt = {};
        if (start_date) baseDateQuery.updatedAt.$gte = startD;
        if (end_date) baseDateQuery.updatedAt.$lte = endD;
      }

      const overviewStatsArr = await collection.aggregate([
        { $match: baseDateQuery },
        {
          $project: {
            userId: 1,
            ip: 1,
            totalAmount: 1,
            items: 1,
            updatedAt: 1,
            createdDate: {
              $convert: {
                input: "$_id",
                to: "date",
                onError: "$updatedAt",
                onNull: "$updatedAt"
              }
            }
          }
        },
        {
          $project: {
            isRegistered: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ["$userId", ""] } }, 0] },
                1,
                0
              ]
            },
            isInHouse: { $cond: [{ $in: ["$ip", inHouseIPs] }, 1, 0] },
            isNew: {
              $cond: [
                { $and: [{ $gte: ["$createdDate", startD] }, { $lte: ["$createdDate", endD] }] },
                1,
                0
              ]
            },
            cartValue: { $ifNull: ["$totalAmount", 0] },
            itemCount: {
              $reduce: {
                input: "$items",
                initialValue: 0,
                in: {
                  $add: [
                    "$$value",
                    { $cond: [{ $isNumber: "$$this.quantity" }, "$$this.quantity", 1] }
                  ]
                }
              }
            }
          }
        },
        {
          $group: {
            _id: null,
            totalCarts: { $sum: 1 },
            totalItems: { $sum: "$itemCount" },
            totalValue: { $sum: "$cartValue" },
            newCarts: { $sum: "$isNew" },
            newItems: { $sum: { $cond: [{ $eq: ["$isNew", 1] }, "$itemCount", 0] } },
            returningCarts: { $sum: { $cond: [{ $eq: ["$isNew", 0] }, 1, 0] } },
            returningItems: { $sum: { $cond: [{ $eq: ["$isNew", 0] }, "$itemCount", 0] } },

            regCarts: { $sum: "$isRegistered" },
            regItems: { $sum: { $cond: [{ $eq: ["$isRegistered", 1] }, "$itemCount", 0] } },
            regNewCarts: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 1] }, { $eq: ["$isNew", 1] }] }, 1, 0] } },
            regNewItems: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 1] }, { $eq: ["$isNew", 1] }] }, "$itemCount", 0] } },
            regRetCarts: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 1] }, { $eq: ["$isNew", 0] }] }, 1, 0] } },
            regRetItems: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 1] }, { $eq: ["$isNew", 0] }] }, "$itemCount", 0] } },

            guestCarts: { $sum: { $cond: [{ $eq: ["$isRegistered", 0] }, 1, 0] } },
            guestItems: { $sum: { $cond: [{ $eq: ["$isRegistered", 0] }, "$itemCount", 0] } },
            guestNewCarts: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 0] }, { $eq: ["$isNew", 1] }] }, 1, 0] } },
            guestNewItems: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 0] }, { $eq: ["$isNew", 1] }] }, "$itemCount", 0] } },
            guestRetCarts: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 0] }, { $eq: ["$isNew", 0] }] }, 1, 0] } },
            guestRetItems: { $sum: { $cond: [{ $and: [{ $eq: ["$isRegistered", 0] }, { $eq: ["$isNew", 0] }] }, "$itemCount", 0] } },

            inHouseCarts: { $sum: "$isInHouse" },
            externalCarts: { $sum: { $cond: [{ $eq: ["$isInHouse", 0] }, 1, 0] } }
          }
        }
      ]).toArray();

      const ov = overviewStatsArr[0] || {};

      // Aggregation for Date Range Item/User Stats (filtered by query)
      const summaryStats = await collection.aggregate([
        { $match: query },
        { $unwind: "$items" },
        { 
          $addFields: { 
            itemDate: { 
              $convert: { 
                input: { $ifNull: ["$items.addedAt", "$updatedAt"] }, 
                to: "date", 
                onError: "$updatedAt", 
                onNull: "$updatedAt" 
              } 
            },
            qty: { $cond: { if: { $isNumber: "$items.quantity" }, then: "$items.quantity", else: 1 } }
          }
        },
        { 
          $match: { 
             itemDate: { $gte: startD, $lte: endD }
          }
        },
        {
          $group: {
            _id: "$_id", // group by cart (which equals unique user/session)
            ip: { $first: "$ip" },
            itemsAdded: { $sum: "$qty" }
          }
        },
        {
          $group: {
            _id: null,
            uniqueUsers: { $sum: 1 },
            totalItems: { $sum: "$itemsAdded" },
            inHouseUsers: {
              $sum: { $cond: [{ $in: ["$ip", inHouseIPs] }, 1, 0] }
            },
            inHouseItems: {
              $sum: { $cond: [{ $in: ["$ip", inHouseIPs] }, "$itemsAdded", 0] }
            }
          }
        }
      ]).toArray();

      const inHouseCarts = ov.inHouseCarts || 0;
      const externalCarts = ov.externalCarts || 0;

      const stats = {
        uniqueUsers: summaryStats.length > 0 ? summaryStats[0].uniqueUsers : (ov.totalCarts || 0),
        totalItems: ov.totalItems || (summaryStats.length > 0 ? summaryStats[0].totalItems : 0),
        totalCarts: ov.totalCarts || total,
        totalValue: ov.totalValue || 0,
        newCarts: ov.newCarts || 0,
        newItems: ov.newItems || 0,
        returningCarts: ov.returningCarts || 0,
        returningItems: ov.returningItems || 0,
        registered: {
          activeCarts: ov.regCarts || 0,
          items: ov.regItems || 0,
          newCarts: ov.regNewCarts || 0,
          newItems: ov.regNewItems || 0,
          returningCarts: ov.regRetCarts || 0,
          returningItems: ov.regRetItems || 0
        },
        guest: {
          activeCarts: ov.guestCarts || 0,
          items: ov.guestItems || 0,
          newCarts: ov.guestNewCarts || 0,
          newItems: ov.guestNewItems || 0,
          returningCarts: ov.guestRetCarts || 0,
          returningItems: ov.guestRetItems || 0
        },
        inHouseUsers: summaryStats.length > 0 ? (summaryStats[0].inHouseUsers || 0) : 0,
        inHouseItems: summaryStats.length > 0 ? (summaryStats[0].inHouseItems || 0) : 0,
        externalUsers: summaryStats.length > 0 ? (summaryStats[0].uniqueUsers - (summaryStats[0].inHouseUsers || 0)) : (ov.externalCarts || 0),
        externalItems: summaryStats.length > 0 ? (summaryStats[0].totalItems - (summaryStats[0].inHouseItems || 0)) : (ov.totalItems || 0),
        inHouseCarts,
        externalCarts
      };

      let cartsQuery = collection.find(query).sort({ updatedAt: -1 });

      if (page || limit) {
        const p = parseInt(page) || 1;
        const l = parseInt(limit) || 10;
        const skip = (p - 1) * l;
        cartsQuery = cartsQuery.skip(skip).limit(l);
      }

      const carts = await cartsQuery.toArray();

      return { success: true, data: carts, total, stats };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/admin/wishlists
  fastify.get('/wishlists', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const { start_date, end_date } = request.query;
      const collection = db.collection('wishlists');
      const ordersCol = db.collection('orders');

      const query = { "items.0": { $exists: true } };
      
      if (start_date || end_date) {
        query.updatedAt = {};
        // Adjust for IST (+05:30)
        if (start_date) query.updatedAt.$gte = new Date(`${start_date}T00:00:00+05:30`);
        if (end_date) query.updatedAt.$lte = new Date(`${end_date}T23:59:59+05:30`);
      }

      const wishlists = await collection.find(query)
        .sort({ updatedAt: -1 })
        .toArray();

      const enhancedWishlists = await Promise.all(wishlists.map(async (list) => {
          let customer = null;
          if (list.userId) {
              const prevOrder = await ordersCol.findOne(
                  { "shopifyPayload.customer.id": Number(list.userId) },
                  { projection: { "shopifyPayload.customer": 1 } }
              );
              if (prevOrder?.shopifyPayload?.customer) {
                  customer = {
                      firstName: prevOrder.shopifyPayload.customer.first_name,
                      lastName: prevOrder.shopifyPayload.customer.last_name,
                      email: prevOrder.shopifyPayload.customer.email,
                      phone: prevOrder.shopifyPayload.customer.phone
                  };
              }
          }
          return { ...list, customer };
      }));

      return { success: true, data: enhancedWishlists };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/admin/orders (Confirmed Payments)
  fastify.get('/orders', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const { start_date, end_date, page, limit, customer_type } = request.query;
      
      const params = {
        status: 'any',
        financial_status: 'paid,partially_paid',
        limit: 250
      };

      if (start_date) {
        // Convert YYYY-MM-DD to Shopify ISO format with IST offset (+05:30)
        params.created_at_min = `${start_date}T00:00:00+05:30`;
      } else {
        // Default fallback if no date provided
        params.created_at_min = '2026-05-31T18:30:00Z';
      }

      if (end_date) {
        // Convert YYYY-MM-DD to Shopify ISO format with IST offset (+05:30)
        params.created_at_max = `${end_date}T23:59:59+05:30`;
      }

      const { data } = await shopifyAdminRestFetch('orders.json', params);

      const shopifyOrders = data.orders || [];

      // Filter for Shopify Admin API sources only (Specifically app_id 307193511937 as identified for #2013)
      // ALSO filter out cancelled orders as requested by user
      // Also include orders with null/empty app_id as they usually represent Admin API/Manual orders (like #2102)
      const filteredOrders = shopifyOrders.filter(order => {
        const appId = String(order.app_id || "");
        const isCancelled = !!order.cancelled_at || !!order.cancel_reason;
        
        // Exclude the identified incorrect app
        if (appId === "283870494721") return false;

        // Include storefront app OR Admin/Manual orders (empty appId)
        return (appId === "307193511937" || appId === "" || appId === "null") && !isCancelled;
      });

      // Map to the format expected by the frontend
      const formattedOrders = filteredOrders.map(order => ({
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        customer: {
          firstName: order.customer?.first_name,
          lastName: order.customer?.last_name,
          email: order.customer?.email
        },
        shippingAddress: {
          city: order.shipping_address?.city,
          province: order.shipping_address?.province
        },
        paymentMethod: {
          type: order.gateway === 'partial_cod' ? 'partial_cod' : 'prepaid',
          prepaidAmount: order.total_outstanding > 0 
            ? (Number(order.total_price) - Number(order.total_outstanding)) 
            : Number(order.total_price)
        },
        razorpayPaymentId: order.note_attributes?.find(attr => attr.name === 'razorpay_payment_id')?.value || 'N/A',
        totalAmount: Number(order.total_price),
        createdAt: order.created_at,
        status: order.financial_status.toUpperCase()
      }));

      let finalOrders = formattedOrders;
      if (customer_type === 'CUSTOMER') {
        // Shopify customers with state 'enabled' or 'invited' are considered registered
        finalOrders = formattedOrders.filter(o => o.customer && o.customer.firstName);
      } else if (customer_type === 'GUEST') {
        finalOrders = formattedOrders.filter(o => !o.customer || !o.customer.firstName);
      }

      const totalCount = finalOrders.length;
      const totalSales = finalOrders.reduce((acc, o) => acc + (o.totalAmount || 0), 0);

      let slicedOrders = finalOrders;
      if (page || limit) {
        const p = parseInt(page) || 1;
        const l = parseInt(limit) || 10;
        const skip = (p - 1) * l;
        slicedOrders = finalOrders.slice(skip, skip + l);
      }

      return { success: true, data: slicedOrders, totalCount, totalSales };
    } catch (err) {
      console.error('Error fetching Shopify orders:', err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/admin/tracking
  fastify.get('/tracking', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const { start_date, end_date, type } = request.query;
      console.log('--- TRACKING FETCH ---');
      console.log('Query Params:', { start_date, end_date, type });

      const collection = db.collection('user_tracking');
      
      const query = {};
      const isAll = !type || type.trim() === '' || type.toUpperCase() === 'ALL';
      
      if (!isAll) {
        // Specific type requested
        query.type = { $regex: new RegExp(`^${type.trim()}$`, 'i') };
      } else {
        // Exclude internal beacons and high-volume popup view impressions from activity rows
        query.type = { 
          $not: /view$/i,
          $nin: ['try_at_home_click'] 
        };
      }

      const dateMatch = {};
      if (start_date || end_date) {
        query.timestamp = {};
        dateMatch.timestamp = {};
        // Adjust for IST (+05:30)
        if (start_date) {
          const dGte = new Date(`${start_date}T00:00:00+05:30`);
          query.timestamp.$gte = dGte;
          dateMatch.timestamp.$gte = dGte;
        }
        if (end_date) {
          const dLte = new Date(`${end_date}T23:59:59+05:30`);
          query.timestamp.$lte = dLte;
          dateMatch.timestamp.$lte = dLte;
        }
      }

      console.log('MongoDB Query:', JSON.stringify(query));

      const limit = parseInt(request.query.limit, 10) || 10000;

      // When type is ALL, run parallel queries: activity rows + fast popup aggregation
      if (isAll) {
        const [tracking, totalViewsAgg, uniqueSessionsAgg] = await Promise.all([
          collection.find(query)
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray(),

          collection.aggregate([
            {
              $match: {
                type: { $regex: /view$/i, $nin: ['product_view', 'scheme_view'] },
                ...dateMatch
              }
            },
            {
              $group: {
                _id: '$type',
                totalViews: { $sum: 1 }
              }
            }
          ]).toArray(),

          collection.aggregate([
            {
              $match: {
                type: { $regex: /view$/i, $nin: ['product_view', 'scheme_view'] },
                ...dateMatch
              }
            },
            {
              $group: {
                _id: { type: '$type', sessionId: '$sessionId' }
              }
            },
            {
              $group: {
                _id: '$_id.type',
                uniqueSessions: { $sum: 1 }
              }
            }
          ]).toArray()
        ]);

        let scratchTotal = 0;
        let spinTotal = 0;
        let atcTotal = 0;
        let couponTotal = 0;
        let othersTotal = 0;
        totalViewsAgg.forEach(x => {
          const id = (x._id || '').toLowerCase();
          if (id === 'scratch_card_view') scratchTotal += x.totalViews;
          else if (id === 'spin_wheel_view' || id === 'wheel_view') spinTotal += x.totalViews;
          else if (id === 'atc_login_view') atcTotal += x.totalViews;
          else if (id === 'unlock_coupon_view') couponTotal += x.totalViews;
          else othersTotal += x.totalViews;
        });

        let scratchSessions = 0;
        let spinSessions = 0;
        let atcSessions = 0;
        let couponSessions = 0;
        let othersSessions = 0;
        uniqueSessionsAgg.forEach(x => {
          const id = (x._id || '').toLowerCase();
          if (id === 'scratch_card_view') scratchSessions += x.uniqueSessions;
          else if (id === 'spin_wheel_view' || id === 'wheel_view') spinSessions += x.uniqueSessions;
          else if (id === 'atc_login_view') atcSessions += x.uniqueSessions;
          else if (id === 'unlock_coupon_view') couponSessions += x.uniqueSessions;
          else othersSessions += x.uniqueSessions;
        });

        // Converted sessions from activities
        const convertedScratchSessions = new Set();
        const convertedWheelSessions = new Set();
        const convertedAtcSessions = new Set();
        const convertedCouponSessions = new Set();
        const convertedOtherSessions = new Set();
        tracking.forEach(item => {
          const t = (item.type || '').toUpperCase();
          if (t === 'REGISTER' || t === 'LOGIN') {
            const rs = (item.rewardSource || '').toLowerCase().trim();
            const isScratch = rs === 'scratch_card';
            const isWheel = rs === 'spin_wheel' || rs === 'wheel';
            const isAtc = rs === 'atc_login' || rs === 'atc';
            const isCoupon = rs === 'unlock_coupon' || rs === 'coupon' || (typeof item.tags === 'string' && item.tags.includes('pdp-offers-lead'));
            if (item.sessionId) {
              if (isScratch) convertedScratchSessions.add(item.sessionId);
              else if (isWheel) convertedWheelSessions.add(item.sessionId);
              else if (isAtc) convertedAtcSessions.add(item.sessionId);
              else if (isCoupon) convertedCouponSessions.add(item.sessionId);
              else convertedOtherSessions.add(item.sessionId);
            }
          }
        });

        const scratchViewOnly = Math.max(0, scratchSessions - convertedScratchSessions.size);
        const spinViewOnly = Math.max(0, spinSessions - convertedWheelSessions.size);
        const atcViewOnly = Math.max(0, atcSessions - convertedAtcSessions.size);
        const couponViewOnly = Math.max(0, couponSessions - convertedCouponSessions.size);
        const othersViewOnly = Math.max(0, othersSessions - convertedOtherSessions.size);
        const totalViewOnly = scratchViewOnly + spinViewOnly + atcViewOnly + couponViewOnly + othersViewOnly;
        const totalConverted = convertedScratchSessions.size + convertedWheelSessions.size + convertedAtcSessions.size + convertedCouponSessions.size + convertedOtherSessions.size;
        const totalSessions = scratchSessions + spinSessions + atcSessions + couponSessions + othersSessions;

        const popupStats = {
          total: scratchTotal + spinTotal + atcTotal + couponTotal + othersTotal,
          scratchTotal,
          spinTotal,
          atcTotal,
          couponTotal,
          othersTotal,
          scratchSessions,
          spinSessions,
          atcSessions,
          couponSessions,
          othersSessions,
          viewOnly: {
            total: totalViewOnly,
            scratch: scratchViewOnly,
            spin: spinViewOnly,
            atc: atcViewOnly,
            coupon: couponViewOnly,
            others: othersViewOnly,
            totalSessions,
            convertedSessions: totalConverted
          }
        };

        console.log('Results Found:', tracking.length, 'Popup Stats:', popupStats);
        return { success: true, data: tracking, popupStats };
      }

      // If specific type was requested
      const tracking = await collection.find(query)
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

      console.log('Results Found:', tracking.length);
      return { success: true, data: tracking };
    } catch (err) {
      console.error('Tracking Error:', err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/admin/scratch-card
  // Signups (REGISTER) and logins (LOGIN) that came through the scratch-card
  // popup, with the prize each user got. Only events logged after rewardSource
  // tracking shipped appear here.
  fastify.get('/scratch-card', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { start_date, end_date } = request.query;
      // Signup/login rows (rewardSource) plus the card-on-screen beacons.
      const query = { $or: [{ rewardSource: 'scratch_card' }, { type: 'scratch_card_view' }] };
      if (start_date || end_date) {
        query.timestamp = {};
        if (start_date) query.timestamp.$gte = new Date(`${start_date}T00:00:00+05:30`);
        if (end_date) query.timestamp.$lte = new Date(`${end_date}T23:59:59+05:30`);
      }
      const data = await db.collection('user_tracking')
        .find(query).sort({ timestamp: -1 }).limit(10000).toArray();
      return { success: true, data };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/admin/tracking/summary
  fastify.get('/tracking/summary', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const collection = db.collection('user_tracking');
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [totalLogin, totalRegister, todayLogin, todayRegister] = await Promise.all([
        collection.countDocuments({ type: 'LOGIN' }),
        collection.countDocuments({ type: 'REGISTER' }),
        collection.countDocuments({ type: 'LOGIN', timestamp: { $gte: today } }),
        collection.countDocuments({ type: 'REGISTER', timestamp: { $gte: today } })
      ]);

      return { 
        success: true, 
        summary: {
          totalLogin,
          totalRegister,
          todayLogin,
          todayRegister
        } 
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
