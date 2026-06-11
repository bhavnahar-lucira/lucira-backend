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

  const fetchUpdatedPrices = async (ids, handles) => {
    if (!ids.length && !handles.length) return {};
    
    const { metalRates, stonePricingDB } = await getShopPricingData();
    const priceMap = {};

    const formatINR = (val) => '\u20b9' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(val);

    const processVariant = (node, variant) => {
        let finalPrice = Number(variant.price.amount);
        let comparePrice = variant.compareAtPrice ? Number(variant.compareAtPrice.amount) : null;
        if (variant.variant_config?.value) {
          try {
            const breakup = calculatePriceBreakup(JSON.parse(variant.variant_config.value), metalRates, stonePricingDB);
            if (breakup?.total) finalPrice = breakup.total;
          } catch (e) {}
        }
        const data = {
          price: formatINR(finalPrice),
          originalPrice: comparePrice ? formatINR(comparePrice) : null,
          discount: comparePrice ? `${Math.round(((comparePrice - finalPrice) / comparePrice) * 100)}% OFF` : null
        };
        if (node.id) priceMap[node.id] = data;
        if (node.handle) priceMap[node.handle] = data;
    };

    if (ids.length > 0) {
      const queryIds = `
        query GetBatchPricesByIds($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
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
      `;
      try {
        const data = await shopifyStorefrontFetch(queryIds, { ids });
        data?.nodes?.forEach(node => {
          if (!node || !node.variants) return;
          const variant = node.variants.edges[0]?.node;
          if (variant) processVariant(node, variant);
        });
      } catch (err) { console.error("Batch price fetch by ID error:", err); }
    }

    if (handles.length > 0) {
      const queryHandles = `
        query GetBatchPricesByHandles($query: String!) {
          products(first: 100, query: $query) {
            edges {
              node {
                id
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
        const data = await shopifyStorefrontFetch(queryHandles, { query: shopifyQuery });
        data?.products?.edges.forEach(({ node }) => {
          const variant = node.variants.edges[0]?.node;
          if (variant) processVariant(node, variant);
        });
      } catch (err) { console.error("Batch price fetch by Handle error:", err); }
    }

    return priceMap;
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
    
    const ids = [];
    const handles = [];
    looks.forEach(l => {
      l.hotspots?.forEach(h => {
        if (h.product?.productId) {
            ids.push(h.product.productId);
        } else if (h.product?.href) {
          const match = h.product.href.match(/\/products\/([^/?#]+)/);
          if (match) handles.push(match[1]);
        }
      });
    });

    const uniqueIds = [...new Set(ids)];
    const uniqueHandles = [...new Set(handles)];
    const priceMap = await fetchUpdatedPrices(uniqueIds, uniqueHandles);

    const updatedLooks = looks.map(l => ({
      ...l,
      id: l._id,
      image: l.image || '',
      hotspots: l.hotspots?.map(h => {
        if (!h.product) return h;
        let pId = h.product.productId;
        let pHandle = null;
        if (h.product.href) {
           const match = h.product.href.match(/\/products\/([^/?#]+)/);
           if (match) pHandle = match[1];
        }
        
        const priceData = priceMap[pId] || priceMap[pHandle];
        if (priceData) {
          return {
            ...h,
            product: {
              ...h.product,
              price: priceData.price,
              oldPrice: priceData.originalPrice
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

    const ids = [];
    const handles = [];
    videos.forEach(v => {
      v.products?.forEach(p => {
        if (p.productId) {
          ids.push(p.productId);
        } else if (p.url) {
          const match = p.url.match(/\/products\/([^/?#]+)/);
          if (match) handles.push(match[1]);
        }
      });
    });

    const uniqueIds = [...new Set(ids)];
    const uniqueHandles = [...new Set(handles)];
    const priceMap = await fetchUpdatedPrices(uniqueIds, uniqueHandles);

    const updatedVideos = videos.map(v => ({
      ...v,
      id: v._id,
      video: v.video || '',
      products: v.products?.map(p => {
        if (!p) return p;
        let pId = p.productId;
        let pHandle = null;
        if (p.url) {
           const match = p.url.match(/\/products\/([^/?#]+)/);
           if (match) pHandle = match[1];
        }

        const priceData = priceMap[pId] || priceMap[pHandle];
        if (priceData) {
          return {
            ...p,
            price: priceData.price,
            originalPrice: priceData.originalPrice,
            discount: priceData.discount
          };
        }
        return p;
      })
    }));

    return { success: true, videos: updatedVideos };
  });

  fastify.get('/styled-videos-collection', async (request) => {
    const { collection } = request.query;
    const query = collection ? { collectionHandle: collection } : {};
    const videos = await db.collection('styled_videos_collection').find(query).toArray();

    const ids = [];
    const handles = [];
    videos.forEach(v => {
      v.products?.forEach(p => {
        if (p.productId) {
          ids.push(p.productId);
        } else if (p.url) {
          const match = p.url.match(/\/products\/([^/?#]+)/);
          if (match) handles.push(match[1]);
        }
      });
    });

    const uniqueIds = [...new Set(ids)];
    const uniqueHandles = [...new Set(handles)];
    const priceMap = await fetchUpdatedPrices(uniqueIds, uniqueHandles);

    const updatedVideos = videos.map(v => ({
      ...v,
      id: v._id,
      video: v.video || '',
      collectionHandle: v.collectionHandle || '',
      products: v.products?.map(p => {
        if (!p) return p;
        let pId = p.productId;
        let pHandle = null;
        if (p.url) {
           const match = p.url.match(/\/products\/([^/?#]+)/);
           if (match) pHandle = match[1];
        }

        const priceData = priceMap[pId] || priceMap[pHandle];
        if (priceData) {
          return {
            ...p,
            price: priceData.price,
            originalPrice: priceData.originalPrice,
            discount: priceData.discount
          };
        }
        return p;
      })
    }));

    return { success: true, videos: updatedVideos };
  });

  fastify.post('/styled-videos-collection', async (request, reply) => {
    try {
      const videos = request.body;
      if (!Array.isArray(videos)) return reply.code(400).send({ error: 'Array expected' });
      await db.collection('styled_videos_collection').deleteMany({});
      if (videos.length > 0) {
        const cleanVideos = videos.map(v => {
          const { _id, id, ...rest } = v;
          return {
            video: v.video || '',
            collectionHandle: v.collectionHandle || '',
            products: Array.isArray(v.products) ? v.products.map(p => ({
              productId: p.productId || null,
              image: p.image || '',
              title: p.title || '',
              price: p.price || '',
              url: p.url || ''
            })) : [],
            totalPrice: v.totalPrice || '₹0',
            updatedAt: new Date()
          };
        });
        await db.collection('styled_videos_collection').insertMany(cleanVideos);
      }
      return { success: true };
    } catch (error) {
      console.error("POST /styled-videos-collection Error:", error);
      return reply.code(500).send({ success: false, error: error.message });
    }
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
          products: Array.isArray(v.products) ? v.products.map(p => ({
            productId: p.productId || null,
            image: p.image || '',
            title: p.title || '',
            price: p.price || '',
            url: p.url || ''
          })) : [],
          totalPrice: v.totalPrice || '₹0',
          updatedAt: new Date()
        };
      });
      await db.collection('styled_videos').insertMany(cleanVideos);
    }
    return { success: true };
  });
}

module.exports = routes;
