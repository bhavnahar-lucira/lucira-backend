/**
 * Settings Routes (Fastify)
 */

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('settings');

  // GET /api/settings/gold-coin
  fastify.get('/gold-coin', async (request, reply) => {
    const { shopifyAdminFetch } = require('../lib/shopify');
    const settings = await collection.findOne({ key: 'gold_coin_offer' });
    
    let shopifyProduct = null;
    const variantId = "gid://shopify/ProductVariant/47661824082138";

    try {
      const query = `
        query getVariant($id: ID!) {
          node(id: $id) {
            ... on ProductVariant {
              id
              title
              price
              image {
                url
              }
              product {
                id
                title
                featuredImage {
                  url
                }
              }
            }
          }
        }
      `;
      const data = await shopifyAdminFetch(query, { id: variantId });
      if (data?.node) {
        shopifyProduct = {
          id: data.node.product.id,
          variantId: data.node.id,
          title: data.node.product.title,
          variantTitle: data.node.title,
          price: data.node.price,
          image: data.node.image?.url || data.node.product.featuredImage?.url
        };
      }
    } catch (err) {
      fastify.log.error('Error fetching gold coin from Shopify: ' + err.message);
    }

    return {
      enabled: settings?.enabled ?? false,
      threshold: settings?.threshold ?? 20000,
      message: settings?.message || "Complimentary Gold Coin available",
      shopifyProduct
    };
  });

  // POST /api/settings/gold-coin
  fastify.post('/gold-coin', async (request, reply) => {
    const { enabled, threshold, message } = request.body;
    await collection.updateOne(
      { key: 'gold_coin_offer' },
      { $set: { enabled, threshold: parseInt(threshold), message, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/settings/announcements
  fastify.get('/announcements', async () => {
    const settings = await fastify.mongo.db.collection('announcements').findOne({ key: 'global_settings' });
    return {
      announcements: settings?.announcements || [],
      isVisible: settings?.isVisible ?? true
    };
  });

  // POST /api/settings/announcements
  fastify.post('/announcements', async (request, reply) => {
    const { announcements, isVisible } = request.body;
    await fastify.mongo.db.collection('announcements').updateOne(
      { key: 'global_settings' },
      { $set: { announcements, isVisible, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });
}

module.exports = routes;
