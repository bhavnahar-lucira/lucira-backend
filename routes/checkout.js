/**
 * Checkout and Payment Routes (Fastify)
 * Handles Razorpay and checkout webhooks
 */

async function routes(fastify, options) {
  
  // POST /api/payment/razorpay/order
  fastify.post('/payment/razorpay/order', async (request, reply) => {
    return { id: "order_dummy_" + Date.now(), amount: 10000, currency: "INR" };
  });

  // POST /api/payment/razorpay/complete
  fastify.post('/payment/razorpay/complete', async (request, reply) => {
    return { success: true };
  });

  // PATCH /api/checkout/address-selection
  fastify.patch('/checkout/address-selection', async (request, reply) => {
    return { success: true };
  });

  // POST /api/webhooks/checkout-crm
  fastify.post('/webhooks/checkout-crm', async (request, reply) => {
    return { success: true };
  });

  // GET /api/sync-status
  fastify.get('/sync-status', async (request, reply) => {
    return { status: 'idle', lastSync: new Date() };
  });
}

  // POST /api/webhooks/shopify
  fastify.post('/webhooks/shopify', async (request, reply) => {
    fastify.log.info('Received Shopify webhook in backend');
    return { success: true };
  });

module.exports = routes;
