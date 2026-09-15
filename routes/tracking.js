async function routes(fastify, options) {
  fastify.post('/', async (request, reply) => {
    const { event, page, sessionId, anonymousId, customerId, productId, variantId, productTitle, price, quantity, metadata, email, mobile } = request.body;

    if (!event || !sessionId) {
      return reply.code(400).send({ error: 'event and sessionId required' });
    }

    try {
      // Exclude only these three events from saving to MongoDB user_tracking:
      // 1. product_view
      // 2. scheme_view
      // 3. try_at_home_click
      const mongoExcludedEvents = ['product_view', 'scheme_view', 'try_at_home_click'];
      const normalizedEvent = String(event).toLowerCase().trim().replace(/[-\s]/g, '_');

      if (!mongoExcludedEvents.includes(normalizedEvent)) {
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
          metadata: { ...metadata, email, mobile },
          timestamp: new Date(),
          ip: request.ip
        });
      }

      // Sync activity to Postgres via Internal Sync API (including product_view, scheme_view, try_at_home_click)
      const syncServer = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://127.0.0.1:5000';
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
          metadata: {
            ...metadata,
            email,
            mobile,
            ip: request.ip,
            source: 'website',
            image: request.body.image || null,
            handle: request.body.handle || null,
            category: request.body.category || null,
            deviceType: request.body.deviceType || null,
          }
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
