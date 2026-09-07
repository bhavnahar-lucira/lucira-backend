/**
 * Wishlist Routes (Fastify)
 */

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('wishlists');

  // GET /api/wishlist
  fastify.get('/', async (request, reply) => {
    const { userId, sessionId } = request.query;
    if (!userId && !sessionId) return { items: [] };

    const query = userId ? { userId: String(userId) } : { sessionId };
    const wishlist = await collection.findOne(query);

    return wishlist || { items: [] };
  });

  // POST /api/wishlist
  fastify.post('/', async (request, reply) => {
    const { userId, sessionId, items, product } = request.body;
    
    // Fallback to query params for identity
    const effectiveUserId = userId || request.query.userId;
    const effectiveSessionId = sessionId || request.query.sessionId;

    if (!effectiveUserId && !effectiveSessionId) {
      return reply.code(400).send({ error: 'Identity required' });
    }
    
    const query = effectiveUserId ? { userId: String(effectiveUserId) } : { sessionId: effectiveSessionId };
    const wishlist = await collection.findOne(query) || { items: [] };

    if (items) {
      // Direct set of items (bulk update)
      wishlist.items = items;
    } else if (product) {
      // Add a single product
      const exists = wishlist.items.some(i => i.productId === product.productId && i.variantId === product.variantId);
      if (!exists) {
        wishlist.items.unshift(product);
        
        // 🔥 Dual-write to Postgres
        const syncServer = process.env.SYNC_SERVER_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:5000' : 'https://server.lucirajewelry.com');
        fetch(`${syncServer}/api/internal/sync/wishlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: effectiveUserId ? String(effectiveUserId) : null,
            sessionId: effectiveSessionId || null,
            productId: product.productId,
            variantId: product.variantId || null,
            action: 'add',
            metadata: { source: 'website', title: product.title }
          })
        }).catch(e => console.error("[Sync Postgres] Failed wishlist add sync:", e.message));
      }
    } else {
        // Assume the entire body is a product if neither items nor product keys are present
        const exists = wishlist.items.some(i => i.productId === request.body.productId && i.variantId === request.body.variantId);
        if (!exists && request.body.productId) {
            wishlist.items.unshift(request.body);
            
            // 🔥 Dual-write to Postgres
            const syncServer = process.env.SYNC_SERVER_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:5000' : 'https://server.lucirajewelry.com');
            fetch(`${syncServer}/api/internal/sync/wishlist`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId: effectiveUserId ? String(effectiveUserId) : null,
                sessionId: effectiveSessionId || null,
                productId: request.body.productId,
                variantId: request.body.variantId || null,
                action: 'add',
                metadata: { source: 'website', title: request.body.title }
              })
            }).catch(e => console.error("[Sync Postgres] Failed wishlist add sync:", e.message));
        }
    }

    await collection.updateOne(
      query,
      { $set: { items: wishlist.items, updatedAt: new Date() } },
      { upsert: true }
    );

    return { success: true, items: wishlist.items };
  });

  // DELETE /api/wishlist
  fastify.delete('/', async (request, reply) => {
    const { userId, sessionId, productId, variantId } = request.query;
    
    // Fallback to body for identity
    const effectiveUserId = userId || request.body?.userId;
    const effectiveSessionId = sessionId || request.body?.sessionId;

    if (!effectiveUserId && !effectiveSessionId) {
      return reply.code(400).send({ error: 'Identity required' });
    }

    const query = effectiveUserId ? { userId: String(effectiveUserId) } : { sessionId: effectiveSessionId };
    const wishlist = await collection.findOne(query);

    if (wishlist) {
      wishlist.items = wishlist.items.filter(item => {
        if (variantId) {
          return !(item.productId === productId && item.variantId === variantId);
        }
        return item.productId !== productId;
      });
      
      await collection.updateOne(query, { $set: { items: wishlist.items, updatedAt: new Date() } });

      // 🔥 Dual-write to Postgres
      const syncServer = process.env.SYNC_SERVER_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:5000' : 'https://server.lucirajewelry.com');
      fetch(`${syncServer}/api/internal/sync/wishlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: effectiveUserId ? String(effectiveUserId) : null,
          sessionId: effectiveSessionId || null,
          productId: productId,
          variantId: variantId || null,
          action: 'remove'
        })
      }).catch(e => console.error("[Sync Postgres] Failed wishlist remove sync:", e.message));
    }

    return { success: true };
  });
}

module.exports = routes;
