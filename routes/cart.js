/**
 * Cart Routes (Fastify)
 */

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('carts');

  // GET /api/cart/get
  fastify.get('/get', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { userId, sessionId } = request.query;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const query = userId ? { userId: String(userId) } : { sessionId };
    const cart = await collection.findOne(query);

    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });

  // POST /api/cart/add
  fastify.post('/add', async (request, reply) => {
    const { userId, sessionId, product } = request.body;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const query = userId ? { userId: String(userId) } : { sessionId };
    const cart = await collection.findOne(query) || { items: [], totalAmount: 0, totalQuantity: 0 };

    const existingIndex = cart.items.findIndex(i => i.variantId === product.variantId);
    if (existingIndex > -1) {
      cart.items[existingIndex].quantity += (product.quantity || 1);
    } else {
      cart.items.unshift(product);
    }

    // Recalculate totals
    cart.totalAmount = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.updatedAt = new Date();

    await collection.updateOne(query, { $set: cart }, { upsert: true });
    return cart;
  });

  // POST /api/cart/remove
  fastify.post('/remove', async (request, reply) => {
    const { userId, sessionId, variantId } = request.body;
    const query = userId ? { userId: String(userId) } : { sessionId };
    const cart = await collection.findOne(query);

    if (cart) {
      cart.items = cart.items.filter(i => i.variantId !== variantId);
      cart.totalAmount = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      cart.updatedAt = new Date();
      await collection.updateOne(query, { $set: cart });
    }

    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });

  // POST /api/cart/update
  fastify.post('/update', async (request, reply) => {
    const { userId, sessionId, currentVariantId, nextVariantId, quantity, size, price, variantTitle, inStock, sku } = request.body;
    const query = userId ? { userId: String(userId) } : { sessionId };
    const cart = await collection.findOne(query);

    if (cart) {
      const itemIndex = cart.items.findIndex(i => i.variantId === currentVariantId);
      if (itemIndex > -1) {
        if (nextVariantId) {
          cart.items[itemIndex].variantId = nextVariantId;
          cart.items[itemIndex].size = size;
          cart.items[itemIndex].price = price;
          cart.items[itemIndex].variantTitle = variantTitle;
          cart.items[itemIndex].inStock = inStock;
          cart.items[itemIndex].sku = sku;
        }
        if (quantity !== undefined) {
          cart.items[itemIndex].quantity = quantity;
        }
      }
      
      cart.totalAmount = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      cart.updatedAt = new Date();
      await collection.updateOne(query, { $set: cart });
    }

    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });

  // POST /api/cart/merge
  fastify.post('/merge', async (request, reply) => {
    const { userId, sessionId } = request.body;
    if (!userId || !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const guestCart = await collection.findOne({ sessionId });
    const userCart = await collection.findOne({ userId: String(userId) }) || { items: [], totalAmount: 0, totalQuantity: 0 };

    if (guestCart && guestCart.items.length > 0) {
      guestCart.items.forEach(gItem => {
        const existing = userCart.items.find(uItem => uItem.variantId === gItem.variantId);
        if (existing) {
          existing.quantity += gItem.quantity;
        } else {
          userCart.items.unshift(gItem);
        }
      });

      userCart.totalAmount = userCart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      userCart.totalQuantity = userCart.items.reduce((sum, item) => sum + item.quantity, 0);
      userCart.updatedAt = new Date();

      await collection.updateOne({ userId: String(userId) }, { $set: userCart }, { upsert: true });
      await collection.deleteOne({ sessionId });
    }

    return userCart;
  });

  // POST /api/cart/checkout
  fastify.post('/checkout', async (request, reply) => {
    const { userId, sessionId } = request.body;
    const query = userId ? { userId: String(userId) } : { sessionId };
    const cart = await collection.findOne(query);
    
    // For now, just return the cart. Real pricing validation would happen here.
    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });
}

module.exports = routes;
