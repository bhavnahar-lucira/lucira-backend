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

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.withCardFields] Also return the offer labels and the
   *   product's featured image. Off by default so callers that only need a
   *   refreshed price keep the smaller response.
   */
  const fetchUpdatedPrices = async (ids, handles, opts = {}) => {
    if (!ids.length && !handles.length) return {};
    
    const { metalRates, stonePricingDB } = await getShopPricingData();
    const priceMap = {};

    const { withCardFields = false } = opts;
    const formatINR = (val) => '\u20b9' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(val);

    // Spliced into both batch queries below; empty unless withCardFields is set.
    const CARD_PRODUCT_FIELDS = withCardFields ? `
              featuredImage { url }` : '';

    const processVariant = (node, variant) => {
        let finalPrice = Number(variant.price.amount);
        let comparePrice = variant.compareAtPrice ? Number(variant.compareAtPrice.amount) : null;
        let breakup = null;
        if (variant.variant_config?.value) {
          try {
            breakup = calculatePriceBreakup(JSON.parse(variant.variant_config.value), metalRates, stonePricingDB);
            if (breakup?.total) finalPrice = breakup.total;
          } catch (e) {}
        }
        const data = {
          price: formatINR(finalPrice),
          originalPrice: comparePrice ? formatINR(comparePrice) : null,
          discount: comparePrice ? `${Math.round(((comparePrice - finalPrice) / comparePrice) * 100)}% OFF` : null
        };
        if (withCardFields) {
          // The breakup is already computed above for the price, so these two
          // discount percentages come free with it.
          const offers = [];
          if (breakup?.diamond?.discount_percent > 0) offers.push(`${breakup.diamond.discount_percent}% OFF on Diamonds`);
          if (breakup?.making_charges?.discount_percent > 0) offers.push(`${breakup.making_charges.discount_percent}% OFF on Making Charges`);

          data.offers = offers;
          data.featuredImage = node.featuredImage?.url || null;
          data.handle = node.handle || null;
          data.variantId = variant.id || null;
        }

        if (node.id) priceMap[node.id] = data;
        if (node.handle) priceMap[node.handle] = data;
    };

    if (ids.length > 0) {
      const queryIds = `
        query GetBatchPricesByIds($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              handle${CARD_PRODUCT_FIELDS}
              variants(first: 1) {
                edges {
                  node {
                    id
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
                handle${CARD_PRODUCT_FIELDS}
                variants(first: 1) {
                  edges {
                    node {
                      id
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

  /**
   * The section renders a single look: one image plus an ordered list of products.
   * Positions (x/y) are optional and only rendered when the look has showHotspots
   * set — see the Curated Looks dashboard.
   */
  fastify.get('/curated-looks', async () => {
    const look = await db.collection('curated_looks').findOne({});
    if (!look) return { success: true, look: null, looks: [] };

    // Tolerate the pre-redesign shape (hotspots[].product) so a storefront hitting
    // this before the dashboard has been re-saved still renders. Safe to drop once
    // the look has been saved from the new dashboard.
    const rawProducts = Array.isArray(look.products)
      ? look.products
      : (look.hotspots || [])
          .filter((h) => h.product)
          .map((h) => ({ ...h.product, id: h.id, x: h.x, y: h.y }));

    const handleOf = (p) => {
      if (p.handle) return p.handle;
      const match = String(p.href || '').match(/\/products\/([^/?#]+)/);
      return match ? match[1] : null;
    };

    const ids = [...new Set(rawProducts.map((p) => p.productId).filter(Boolean))];
    const handles = [...new Set(
      rawProducts.filter((p) => !p.productId).map(handleOf).filter(Boolean)
    )];

    const priceMap = await fetchUpdatedPrices(ids, handles, { withCardFields: true });

    const products = rawProducts.map((p) => {
      const live = priceMap[p.productId] || priceMap[handleOf(p)] || {};
      return {
        id: p.id,
        productId: p.productId || null,
        handle: handleOf(p),
        name: p.name || '',
        href: p.href || '',
        x: p.x || null,
        y: p.y || null,
        // Stored image wins: the admin may have tagged a specific variant shot.
        image: p.image || live.featuredImage || '',
        price: live.price || p.price || '',
        oldPrice: live.originalPrice || null,
        offers: live.offers || [],
        // For the storefront's promoClick datalayer push (promo_id = variant id).
        variantId: live.variantId || null,
      };
    });

    const payload = {
      id: look._id,
      name: look.name || '',
      image: look.image || '',
      assetName: look.assetName || '',
      href: look.href || '',
      showHotspots: look.showHotspots === true,
      // 0 disables auto-advance.
      autoSwitchSeconds: Number(look.autoSwitchSeconds) || 0,
      products,
    };

    return {
      success: true,
      look: payload,
      // Kept for one release so a storefront deployed before this backend keeps
      // rendering. Remove once both sides are live.
      looks: [{ ...payload, hotspots: products.map((p) => ({ id: p.id, x: p.x, y: p.y, product: p })) }],
    };
  });

  fastify.post('/curated-looks', async (request, reply) => {
    // The dashboard posts a single look object. An array is still accepted so an
    // older dashboard build doesn't hard-fail; only its first entry is kept.
    const body = Array.isArray(request.body) ? request.body[0] : request.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Look object expected' });
    }

    const products = (Array.isArray(body.products) ? body.products : []).map((p) => ({
      id: p.id ?? null,
      productId: p.productId || null,
      handle: p.handle || null,
      name: p.name || '',
      image: p.image || '',
      href: p.href || '',
      // Kept even while showHotspots is off, so toggling it back on doesn't lose
      // the placements the admin already set.
      x: p.x || null,
      y: p.y || null,
    }));

    await db.collection('curated_looks').deleteMany({});
    await db.collection('curated_looks').insertOne({
      name: body.name || '',
      image: body.image || '',
      assetName: body.assetName || '',
      href: body.href || '',
      showHotspots: body.showHotspots === true,
      autoSwitchSeconds: Math.max(0, Number(body.autoSwitchSeconds) || 0),
      products,
      updatedAt: new Date(),
    });

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
