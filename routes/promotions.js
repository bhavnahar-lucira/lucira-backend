/**
 * Promotions & UI Content Routes (Fastify)
 */

const { shopifyStorefrontFetch, shopifyAdminFetch } = require('../lib/shopify');
const { calculatePriceBreakup } = require('../lib/priceEngine');
const { getServerCache } = require('../lib/cache');

async function routes(fastify, options) {
  const db = fastify.mongo.db;

  const getShopPricingData = () =>
    getServerCache(
      "shop-pricing-data",
      async () => {
        const shopPricingQuery = `
          query {
            shop {
              metalPrices: metafield(namespace: "DI-GoldPrice", key: "metal_prices") { value }
              stonePricing: metafield(namespace: "DI-GoldPrice", key: "stone_pricing") { value }
            }
          }
        `;
        const shopData = await shopifyAdminFetch(shopPricingQuery);
        return {
          metalRates: shopData?.shop?.metalPrices?.value ? JSON.parse(shopData.shop.metalPrices.value) : {},
          stonePricingDB: shopData?.shop?.stonePricing?.value ? JSON.parse(shopData.shop.stonePricing.value) : [],
        };
      },
      { ttlMs: 60 * 60 * 1000, maxEntries: 20 }
    );

  const fetchUpdatedPrices = async (handles) => {
    if (!handles.length) return {};
    
    const { metalRates, stonePricingDB } = await getShopPricingData();
    const query = `
      query GetBatchPrices($query: String!) {
        products(first: 100, query: $query) {
          edges {
            node {
              handle
              variants(first: 1) {
                edges {
                  node {
                    price { amount }
                    compareAtPrice { amount }
                    variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const shopifyQuery = handles.map(h => `handle:${h}`).join(' OR ');
    try {
      const data = await shopifyStorefrontFetch(query, { query: shopifyQuery });
      const priceMap = {};

      data?.products?.edges.forEach(({ node }) => {
        const variant = node.variants.edges[0]?.node;
        if (!variant) return;

        let finalPrice = Number(variant.price.amount);
        let comparePrice = variant.compareAtPrice ? Number(variant.compareAtPrice.amount) : null;

        if (variant.variant_config?.value) {
          try {
            const breakup = calculatePriceBreakup(JSON.parse(variant.variant_config.value), metalRates, stonePricingDB);
            if (breakup?.total) finalPrice = breakup.total;
          } catch (e) {}
        }

        const formatINR = (val) => '\u20b9' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(val);

        priceMap[node.handle] = {
          price: formatINR(finalPrice),
          originalPrice: comparePrice ? formatINR(comparePrice) : null,
          discount: comparePrice ? `${Math.round(((comparePrice - finalPrice) / comparePrice) * 100)}% OFF` : null
        };
      });

      return priceMap;
    } catch (err) {
      console.error("Batch price fetch error:", err);
      return {};
    }
  };

  fastify.get('/announcements', async () => {
    const settings = await db.collection('announcements').findOne({ key: 'global_settings' });
    return { announcements: settings?.announcements || [], isVisible: settings?.isVisible ?? true };
  });

  fastify.get('/home-reviews', async () => {
    const reviews = await db.collection('home_reviews').find({ isVisible: true }).limit(10).toArray();
    return { reviews };
  });

  fastify.get('/curated-looks', async () => {
    const looks = await db.collection('curated_looks').find({}).toArray();
    
    // Extract handles
    const handles = [];
    looks.forEach(l => {
      l.hotspots?.forEach(h => {
        if (h.product?.href) {
          const match = h.product.href.match(/\/products\/([^/?#]+)/);
          if (match) handles.push(match[1]);
        }
      });
    });

    const uniqueHandles = [...new Set(handles)];
    const priceMap = await fetchUpdatedPrices(uniqueHandles);

    const updatedLooks = looks.map(l => ({
      ...l,
      id: l._id,
      image: l.image || '',
      hotspots: l.hotspots?.map(h => {
        if (!h.product?.href) return h;
        const match = h.product.href.match(/\/products\/([^/?#]+)/);
        if (match && priceMap[match[1]]) {
          return {
            ...h,
            product: {
              ...h.product,
              price: priceMap[match[1]].price,
              oldPrice: priceMap[match[1]].originalPrice
            }
          };
        }
        return h;
      })
    }));

    return { success: true, looks: updatedLooks };
  });

  fastify.post('/curated-looks', async (request, reply) => {
    const looks = request.body;
    if (!Array.isArray(looks)) return reply.code(400).send({ error: 'Array expected' });
    await db.collection('curated_looks').deleteMany({});
    if (looks.length > 0) {
      const cleanLooks = looks.map(l => {
        const { _id, id, ...rest } = l;
        return {
          name: l.name || '',
          image: l.image || '',
          assetName: l.assetName || '',
          href: l.href || '',
          hotspots: l.hotspots || [],
          updatedAt: new Date()
        };
      });
      await db.collection('curated_looks').insertMany(cleanLooks);
    }
    return { success: true };
  });

  fastify.get('/styled-videos', async () => {
    const videos = await db.collection('styled_videos').find({}).toArray();

    // Extract handles
    const handles = [];
    videos.forEach(v => {
      v.products?.forEach(p => {
        if (p.url) {
          const match = p.url.match(/\/products\/([^/?#]+)/);
          if (match) handles.push(match[1]);
        }
      });
    });

    const uniqueHandles = [...new Set(handles)];
    const priceMap = await fetchUpdatedPrices(uniqueHandles);

    const updatedVideos = videos.map(v => ({
      ...v,
      id: v._id,
      video: v.video || '',
      products: v.products?.map(p => {
        if (!p.url) return p;
        const match = p.url.match(/\/products\/([^/?#]+)/);
        if (match && priceMap[match[1]]) {
          return {
            ...p,
            price: priceMap[match[1]].price,
            originalPrice: priceMap[match[1]].originalPrice,
            discount: priceMap[match[1]].discount
          };
        }
        return p;
      })
    }));

    return { success: true, videos: updatedVideos };
  });

  fastify.post('/styled-videos', async (request, reply) => {
    const videos = request.body;
    if (!Array.isArray(videos)) return reply.code(400).send({ error: 'Array expected' });
    await db.collection('styled_videos').deleteMany({});
    if (videos.length > 0) {
      const cleanVideos = videos.map(v => {
        const { _id, id, ...rest } = v;
        return {
          video: v.video || '',
          products: v.products || [],
          totalPrice: v.totalPrice || '?0',
          updatedAt: new Date()
        };
      });
      await db.collection('styled_videos').insertMany(cleanVideos);
    }
    return { success: true };
  });
}

module.exports = routes;
