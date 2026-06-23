/**
 * Admin Dashboard Routes (Fastify)
 */

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const { shopifyAdminRestFetch } = require('../lib/shopify');

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

      if (start_date || end_date) {
        query.updatedAt = {};
        // Adjust for IST (+05:30)
        if (start_date) query.updatedAt.$gte = new Date(`${start_date}T00:00:00+05:30`);
        if (end_date) query.updatedAt.$lte = new Date(`${end_date}T23:59:59+05:30`);
      }

      const total = await collection.countDocuments(query);

      let cartsQuery = collection.find(query).sort({ updatedAt: -1 });

      if (page || limit) {
        const p = parseInt(page) || 1;
        const l = parseInt(limit) || 10;
        const skip = (p - 1) * l;
        cartsQuery = cartsQuery.skip(skip).limit(l);
      }

      const carts = await cartsQuery.toArray();

      return { success: true, data: carts, total };
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
      
      if (type && type.trim() !== '' && type.toUpperCase() !== 'ALL') {
        // Use case-insensitive regex for robustness
        query.type = { $regex: new RegExp(`^${type.trim()}$`, 'i') };
      }

      if (start_date || end_date) {
        query.timestamp = {};
        // Adjust for IST (+05:30)
        if (start_date) query.timestamp.$gte = new Date(`${start_date}T00:00:00+05:30`);
        if (end_date) query.timestamp.$lte = new Date(`${end_date}T23:59:59+05:30`);
      }

      console.log('MongoDB Query:', JSON.stringify(query));

      const tracking = await collection.find(query)
        .sort({ timestamp: -1 })
        .toArray();
      
      console.log('Results Found:', tracking.length);
      return { success: true, data: tracking };
    } catch (err) {
      console.error('Tracking Error:', err);
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
