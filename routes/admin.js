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
      const collection = db.collection('carts');
      const ordersCol = db.collection('orders');

      const carts = await collection.find({ "items.0": { $exists: true } })
        .sort({ updatedAt: -1 })
        .limit(100)
        .toArray();

      // Attach customer info from previous orders if available
      const enhancedCarts = await Promise.all(carts.map(async (cart) => {
          let customer = null;
          if (cart.userId) {
              const prevOrder = await ordersCol.findOne(
                  { "shopifyPayload.customer.id": Number(cart.userId) },
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
          return { ...cart, customer };
      }));

      return { success: true, data: enhancedCarts };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/admin/wishlists
  fastify.get('/wishlists', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const collection = db.collection('wishlists');
      const ordersCol = db.collection('orders');

      const wishlists = await collection.find({ "items.0": { $exists: true } })
        .sort({ updatedAt: -1 })
        .limit(100)
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
      // Show only Shopify Admin API only and payment status partially paid and paid
      // Filter from 1st June 2026 (IST start is 2026-05-31 18:30 UTC)
      const { data } = await shopifyAdminRestFetch('orders.json', {
        status: 'any',
        financial_status: 'paid,partially_paid',
        created_at_min: '2026-05-31T18:30:00Z',
        limit: 100
      });

      const shopifyOrders = data.orders || [];

      // Filter for Shopify Admin API sources only (Specifically app_id 307193511937 as identified for #2013)
      const filteredOrders = shopifyOrders.filter(order => {
        const appId = String(order.app_id || "");
        
        // As per user feedback, #2013 (app_id 307193511937) is the correct one.
        // #2014 (app_id 283870494721) should be excluded.
        return appId === "307193511937";
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

      return { success: true, data: formattedOrders };
    } catch (err) {
      console.error('Error fetching Shopify orders:', err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/admin/tracking
  fastify.get('/tracking', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const collection = db.collection('user_tracking');
      const tracking = await collection.find({})
        .sort({ timestamp: -1 })
        .limit(200)
        .toArray();
      return { success: true, data: tracking };
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
