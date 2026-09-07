async function routes(fastify, options) {
  fastify.post('/', async (request, reply) => {
    const { event, page, sessionId, anonymousId, customerId, productId, variantId, productTitle, price, quantity, metadata } = request.body;

    if (!event || !sessionId) {
      return reply.code(400).send({ error: 'event and sessionId required' });
    }

    try {
      // 1. Dual-write to MongoDB (user_tracking)
      const trackingCollection = fastify.mongo.db.collection('user_tracking');
      await trackingCollection.insertOne({
        type: event,
        userId: customerId || 'guest',
        sessionId: sessionId || 'unknown',
        anonymousId: anonymousId || sessionId || 'unknown',
        context: 'storefront',
        sourcePage: page || 'unknown',
        product: productTitle || productId || 'unknown',
        variantId: variantId || 'unknown',
        price: price || 0,
        quantity: quantity || 0,
        metadata: metadata || {},
        timestamp: new Date(),
        ip: request.ip
      });

      // 2. Dual-write to Postgres via Internal Sync API
      const syncServer = process.env.SYNC_SERVER_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:5000' : 'https://server.lucirajewelry.com');
      fetch(`${syncServer}/api/internal/sync/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          page: page || 'unknown',
          sessionId,
          anonymousId: anonymousId || sessionId,
          customerId,
          productId,
          variantId,
          productTitle,
          price,
          quantity,
          metadata: { ...metadata, ip: request.ip, source: 'website' }
        })
      }).catch(e => console.error("[Sync Postgres] Failed tracking sync:", e.message));

      return { success: true };
    } catch (err) {
      fastify.log.error('Tracking Error:', err);
      return reply.code(500).send({ error: 'Failed to save tracking event' });
    }
  });
}

module.exports = routes;
