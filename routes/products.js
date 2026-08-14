/**
 * Products Routes (Fastify)
 * Handles search, filters, and variant pricing
 */

const { shopifyStorefrontFetch, shopifyAdminFetch } = require('../lib/shopify');
const { calculatePriceBreakup } = require('../lib/priceEngine');
const { getServerCache, stableCacheKey } = require('../lib/cache');
const { expandSynonyms, synonymQuery } = require('../lib/searchSynonyms');
const { getCollectionVisibleStats } = require('../lib/visibleCounts');

// Social-proof counts must reflect the REAL store DB (where interactions accumulate).
// In production the primary Mongo connection already targets it. In local dev the primary
// connection points at a near-empty local DB, so we lazily read the real store via MONGODB_URI.
// Read-only aggregation; falls back to the primary connection if the store DB is unreachable.
let _socialProofDbPromise = null;
async function getSocialProofDb(fastify) {
  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev || !process.env.MONGODB_URI) return fastify.mongo.db;
  try {
    if (!_socialProofDbPromise) {
      const { MongoClient } = require('mongodb');
      _socialProofDbPromise = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
        .connect()
        .then((client) => client.db());
    }
    return await _socialProofDbPromise;
  } catch (err) {
    console.warn(`[social-proof] Could not reach store DB, using primary connection: ${err.message}`);
    _socialProofDbPromise = null;
    return fastify.mongo.db;
  }
}

const SORT_MAP = {
  featured: { sortKey: "RELEVANCE", reverse: false },
  relevance: { sortKey: "RELEVANCE", reverse: false },
  best_selling: { sortKey: "BEST_SELLING", reverse: false },
  az: { sortKey: "TITLE", reverse: false },
  za: { sortKey: "TITLE", reverse: true },
  price_low_high: { sortKey: "PRICE", reverse: false },
  price_high_low: { sortKey: "PRICE", reverse: true },
  date_new_old: { sortKey: "CREATED_AT", reverse: true },
  date_old_new: { sortKey: "CREATED_AT", reverse: false },
};

async function routes(fastify, options) {

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

  const parseFilters = (rawFilters) => {
    if (!rawFilters) return [];
    try {
      const parsed = typeof rawFilters === "string" ? JSON.parse(rawFilters) : rawFilters;
      if (Array.isArray(parsed)) return parsed;
      const shopifyFilters = [];
      Object.values(parsed).forEach((group) => {
        if (!Array.isArray(group)) return;
        group.forEach((opt) => {
          if (!opt?.input) return;
          shopifyFilters.push(typeof opt.input === "string" ? JSON.parse(opt.input) : opt.input);
        });
      });
      return shopifyFilters;
    } catch { return []; }
  };

  // GET /api/products/analytics-search
  fastify.get('/analytics-search', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://server.lucirajewelry.com';
      const response = await fetch(`${EXPO_API}/api/analytics/search`);
      if (!response.ok) throw new Error(`Analytics Search API error: ${response.status}`);
      const data = await response.json();
      return data;
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Analytics Search failed" });
    }
  });

  // GET /api/products/home-component/:component
  fastify.get('/home-component/:component', async (request, reply) => {
    try {
      const { component } = request.params;
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://server.lucirajewelry.com';
      const response = await fetch(`${EXPO_API}/api/cms/homepage-components?id=${component}`);
      if (!response.ok) throw new Error(`Home Component API error: ${response.status}`);
      const data = await response.json();
      return data;
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Home Component fetch failed" });
    }
  });

  // Helper to convert frontend Shopify-style array filters to Mobile Object payload expected by live server
  function convertShopifyFiltersToMobile(filtersJsonStr) {
    if (!filtersJsonStr) return filtersJsonStr;
    try {
      const rawFilters = JSON.parse(filtersJsonStr);
      if (!Array.isArray(rawFilters)) {
         // Patch to handle type mismatches on the remote server
         Object.keys(rawFilters).forEach(groupKey => {
            if (Array.isArray(rawFilters[groupKey])) {
               rawFilters[groupKey].forEach(opt => {
                  if (opt.input) {
                     Object.keys(opt.input).forEach(k => {
                        let vals = opt.input[k];
                        if (!Array.isArray(vals)) vals = [vals];
                        let newVals = [];
                        vals.forEach(v => {
                           newVals.push(v);
                           if (typeof v === 'number') newVals.push(String(v));
                           if (typeof v === 'string' && !isNaN(Number(v)) && String(v).trim() !== '') newVals.push(Number(v));
                        });
                        opt.input[k] = [...new Set(newVals)];
                     });
                  }
               });
            }
         });
         return JSON.stringify(rawFilters);
      }

      const mobileFilters = {};
      rawFilters.forEach(f => {
        if (f.price) {
          if (!mobileFilters["Price"]) mobileFilters["Price"] = [];
          mobileFilters["Price"].push({ min: f.price.min || 0, max: f.price.max || 5000000 });
        } else if (f.productMetafield) {
          const { key, value } = f.productMetafield;
          let mobileKey = key;
          if (key === "in_store_available") mobileKey = "In Store Available";
          else if (key === "store") mobileKey = "In Store Available";
          else if (key === "ring_size") mobileKey = "Ring Size";
          else if (key === "shop_for") mobileKey = "Shop For";
          else if (key === "weight") mobileKey = "Weight Ranges";
          else if (key === "carat_range") mobileKey = "Carat Range";
          else if (key === "material_type") mobileKey = "Material";
          else if (key === "finishing") mobileKey = "Finishing";
          else if (key === "fit") mobileKey = "Fit";
          if (!mobileFilters[mobileKey]) mobileFilters[mobileKey] = [];
          mobileFilters[mobileKey].push({ label: value });
        } else if (f.variantMetafield) {
          const { key, value } = f.variantMetafield;
          let mobileKey = key;
          if (key === "diamond_1_shape") mobileKey = "Diamond Shape";
          else if (key === "gemstone_1_shape") mobileKey = "Gemstone Shape";
          else if (key === "metal_purity") mobileKey = "Metal Purity";
          if (!mobileFilters[mobileKey]) mobileFilters[mobileKey] = [];
          mobileFilters[mobileKey].push({ label: value });
        } else if (f.productType) {
          if (!mobileFilters["Product Type"]) mobileFilters["Product Type"] = [];
          mobileFilters["Product Type"].push({ label: f.productType });
        }
      });
      return JSON.stringify(mobileFilters);
    } catch (e) {
      return filtersJsonStr;
    }
  }

  // GET /api/products/filters
  fastify.get('/filters', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://server.lucirajewelry.com';
      const queryParams = new URLSearchParams(request.query);
      
      if (queryParams.has('filters')) {
        queryParams.set('filters', convertShopifyFiltersToMobile(queryParams.get('filters')));
      }
      const queryString = queryParams.toString();
      
      const response = await fetch(`${EXPO_API}/api/search?${queryString}`);
      if (!response.ok) {
        throw new Error(`Search API error: ${response.status}`);
      }
      
      const data = await response.json();
      return data.filters || {};
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Filters fetch failed" });
    }
  });

  // GET /api/products/search
  fastify.get('/search', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://server.lucirajewelry.com';
      const originalLimit = parseInt(request.query.limit) || 25;
      const originalPage = parseInt(request.query.page) || 1;
      
      const queryParams = new URLSearchParams(request.query);
      
      if (queryParams.has('filters')) {
        queryParams.set('filters', convertShopifyFiltersToMobile(queryParams.get('filters')));
      }
      
      // Use the requested limit, no more 1000 hack!
      
      const queryString = queryParams.toString();
      
      const response = await fetch(`${EXPO_API}/api/search?${queryString}`);
      if (!response.ok) {
        throw new Error(`Search API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // The core search engine (EXPO_API) now handles exact-match sorting natively.

      return data;
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Search failed" });
    }
  });

  // GET /api/products/pricing
  fastify.get('/pricing', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://server.lucirajewelry.com';
      const queryString = new URLSearchParams(request.query).toString();
      
      const response = await fetch(`${EXPO_API}/api/variant-pricing?${queryString}`);
      if (!response.ok) {
        let errData = { error: `Pricing API error: ${response.status}` };
        try {
          errData = await response.json();
        } catch(e) {}
        return reply.status(response.status).send(errData);
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Pricing fetch failed" });
    }
  });

  // GET /api/products/related
  fastify.get('/related', async (request, reply) => {
    const { handle } = request.query;
    if (!handle) return reply.code(400).send({ error: 'handle required' });

    const ID_QUERY = `
      query GetProductId($handle: String!) {
        product(handle: $handle) {
          id
        }
      }
    `;

    const RECS_QUERY = `
      query GetRecommendations($productId: ID!) {
        productRecommendations(productId: $productId) {
          id
          title
          handle
          featuredImage { url }
          variants(first: 1) {
            edges {
              node {
                price { amount }
                compareAtPrice { amount }
              }
            }
          }
        }
      }
    `;

    try {
      // 1. Get ID
      const idData = await shopifyStorefrontFetch(ID_QUERY, { handle });
      const productId = idData?.product?.id;
      if (!productId) return { complementaryProducts: [], matchingProducts: [] };

      // 2. Get Recommendations
      const data = await shopifyStorefrontFetch(RECS_QUERY, { productId });
      const recs = data?.productRecommendations || [];
      
      const mapped = recs.map(p => {
        const variant = p.variants?.edges?.[0]?.node;
        const compareAtPrice = variant?.compareAtPrice?.amount;
        return {
          id: p.id.split("/").pop(),
          shopifyId: p.id,
          title: p.title,
          handle: p.handle,
          image: p.featuredImage?.url,
          price: variant ? Number(variant.price.amount) : 0,
          compare_price: compareAtPrice ? Number(compareAtPrice) : null
        };
      });

      return { complementaryProducts: mapped, matchingProducts: [] };
    } catch (err) {
      console.error("❌ Related Products API Error:", err);
      return { complementaryProducts: [], matchingProducts: [] };
    }
  });

  // GET /api/products/details
  fastify.get('/details', async (request, reply) => {
    try {
      const { handle } = request.query;
      if (!handle) {
        return reply.code(400).send({ error: "Handle is required" });
      }

      let product = null;

      if (!product) {
        // Fallback to Shopify
        const { shopifyStorefrontFetch } = require('../lib/shopify');
        const { calculatePriceBreakup } = require('../lib/priceEngine');
        const { metalRates, stonePricingDB } = await getShopPricingData();

        const query = `
          query GetProduct($handle: String!) {
            product(handle: $handle) {
              id
              title
              handle
              featuredImage { url }
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    price { amount }
                    compareAtPrice { amount }
                    availableForSale
                    currentlyNotInStock
                    selectedOptions { name value }
                    image { url altText }
                    variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
                  }
                }
              }
            }
          }
        `;
        const data = await shopifyStorefrontFetch(query, { handle });
        if (data?.product) {
          const shopifyProd = data.product;
          
          const variants = shopifyProd.variants.edges.map(({node: v}) => {
             let breakup = null;
             let diamondDiscount = 0;
             let makingDiscount = 0;
             if (v.variant_config?.value) {
               try {
                 breakup = calculatePriceBreakup(JSON.parse(v.variant_config.value), metalRates, stonePricingDB);
                 diamondDiscount = breakup.diamond.discount_percent || 0;
                 makingDiscount = breakup.making_charges.discount_percent || 0;
               } catch(e) {}
             }
             
             return {
                id: v.id.split("/").pop(),
                shopifyId: v.id,
                sku: v.sku,
                price: breakup?.total || Number(v.price.amount),
                compare_price: breakup?.original_total > breakup?.total ? breakup.original_total : (v.compareAtPrice ? Number(v.compareAtPrice.amount) : null),
                inStock: v.availableForSale === true && v.currentlyNotInStock === false,
                image: v.image?.url,
                title: v.selectedOptions.map(o => o.value).join(" / "),
                color: v.selectedOptions.find(o => o.name.toLowerCase().includes("color"))?.value,
                size: v.selectedOptions.find(o => o.name.toLowerCase() === "size")?.value,
                price_breakup: breakup,
                diamondDiscount,
                makingDiscount
             };
          });

          product = {
            id: shopifyProd.id.split("/").pop(),
            shopifyId: shopifyProd.id,
            title: shopifyProd.title,
            handle: shopifyProd.handle,
            image: shopifyProd.featuredImage?.url,
            variants: variants,
            diamondDiscount: variants[0]?.diamondDiscount || 0,
            makingDiscount: variants[0]?.makingDiscount || 0,
            hasSimilar: false
          };
        }
      }

      if (!product) {
        return reply.code(404).send({ error: "Product not found" });
      }

      // Ensure discounts are present for UI badges
      const diamondDiscount = product.diamondDiscount || product.variants?.[0]?.price_breakup?.diamond?.discount_percent || 0;
      const makingDiscount = product.makingDiscount || product.variants?.[0]?.price_breakup?.making_charges?.discount_percent || 0;

      return { 
        product: {
          ...product,
          diamondDiscount,
          makingDiscount,
          hasSimilar: !!(product.matchingProductIds && product.matchingProductIds.length > 0)
        } 
      };
    } catch (err) {
      console.error("❌ Product Details API Error:", err);
      return reply.code(500).send({ error: "Internal Server Error" });
    }
  });

  // POST /api/products/social-proof
  // Returns REAL per-product social-proof counts { orders, addToCart, wishlist } for the given productIds.
  // Counts are computed store-wide and cached; the frontend amplifies per-metric (orders x20, cart x50, wishlist x100) and formats.
  // Sources (all Mongo): orders -> `orders` (shopifyPayload.line_items); addToCart -> `abandoned_carts`; wishlist -> `wishlists`.
  fastify.post('/social-proof', async (request, reply) => {
    try {
      const db = await getSocialProofDb(fastify);
      const ids = Array.isArray(request.body?.productIds) ? request.body.productIds : [];

      // Reduce any id form (numeric, "gid://shopify/Product/123") to its trailing numeric id.
      const normalize = (id) => {
        const m = String(id || "").match(/\d+/g);
        return m ? m[m.length - 1] : "";
      };

      // Fold a list of {_id: <rawProductId>, c} rows into a numeric-id -> count map,
      // merging any mixed id formats (GID vs numeric) that reduce to the same product.
      const foldRows = (rows) => {
        const map = {};
        for (const r of rows) {
          const nid = normalize(r._id);
          if (nid) map[nid] = (map[nid] || 0) + r.c;
        }
        return map;
      };

      // Count DISTINCT documents (carts / wishlists) containing each product, so a single cart
      // listing a product in two sizes counts once — the accurate "N carts / N people" number.
      // Dropping null productIds first skips the large insurance/gold-coin/free-gift bucket.
      const buildDistinctDocCountMap = async (collectionName) => {
        const rows = await db.collection(collectionName).aggregate([
          { $unwind: "$items" },
          { $match: { "items.productId": { $ne: null } } },
          { $group: { _id: { doc: "$_id", pid: "$items.productId" } } },
          { $group: { _id: "$_id.pid", c: { $sum: 1 } } }
        ], { allowDiskUse: true }).toArray();
        return foldRows(rows);
      };

      // Orders: count each order once per product (distinct) from shopifyPayload.line_items[].product_id.
      const buildOrderCountMap = async () => {
        const rows = await db.collection('orders').aggregate([
          // Only count orders that actually went through — exclude failed/queued attempts
          // that stay in the collection with a full shopifyPayload. Whitelist is case-tolerant.
          { $match: { status: { $in: ["success", "SUCCESS", "PAID", "paid"] } } },
          { $unwind: "$shopifyPayload.line_items" },
          { $match: { "shopifyPayload.line_items.product_id": { $ne: null } } },
          { $group: { _id: { order: "$_id", pid: "$shopifyPayload.line_items.product_id" } } },
          { $group: { _id: "$_id.pid", c: { $sum: 1 } } }
        ], { allowDiskUse: true }).toArray();
        return foldRows(rows);
      };

      // Build the three store-wide maps in parallel (each cached independently).
      // Sources: orders -> `orders`; addToCart -> `abandoned_carts` (dashboard's cart collection); wishlist -> `wishlists`.
      const [orderMap, cartMap, wishlistMap] = await Promise.all([
        getServerCache("social-proof:orders", buildOrderCountMap, { ttlMs: 30 * 60 * 1000, maxEntries: 10 }),
        getServerCache("social-proof:cart", () => buildDistinctDocCountMap('abandoned_carts'), { ttlMs: 15 * 60 * 1000, maxEntries: 10 }),
        getServerCache("social-proof:wishlist", () => buildDistinctDocCountMap('wishlists'), { ttlMs: 15 * 60 * 1000, maxEntries: 10 }),
      ]);

      const counts = {};
      for (const rawId of ids) {
        const nid = normalize(rawId);
        if (!nid) continue;
        counts[rawId] = {
          orders: orderMap[nid] || 0,
          addToCart: cartMap[nid] || 0,
          wishlist: wishlistMap[nid] || 0,
        };
      }

      return { success: true, counts };
    } catch (err) {
      console.error("[social-proof] Error:", err);
      return reply.code(500).send({ error: "Failed to fetch social proof", message: err.message });
    }
  });
}

module.exports = routes;
