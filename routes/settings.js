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

  // GET /api/settings/hero-banners
  fastify.get('/hero-banners', async () => {
    const settings = await collection.findOne({ key: 'hero_banners' });
    // Provide some default banners if none exist so the frontend doesn't break
    const defaultBanners = [
      { id: "1", type: "image", name: "Baarish", alt: "Baarish", url: "/collections/jewelry", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Baarish-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Baarish-Mobile.jpg" },
      { id: "2", type: "image", name: "9KT", alt: "9KT Collection", url: "/collections/9kt-collection", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-9KT-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-9KT-Mobile.jpg" },
      { id: "3", type: "image", name: "Solitaire", alt: "Solitaire Twist Ring", url: "/products/round-diamond-solitaire-twist-ring", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Solitaire-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Solitaire-Mobile.jpg" }
    ];
    return {
      banners: settings?.banners || defaultBanners
    };
  });

  // POST /api/settings/hero-banners
  fastify.post('/hero-banners', async (request, reply) => {
    const { banners } = request.body;
    if (!Array.isArray(banners)) {
      return reply.code(400).send({ error: 'banners must be an array' });
    }
    await collection.updateOne(
      { key: 'hero_banners' },
      { $set: { banners, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });
}

module.exports = routes;
