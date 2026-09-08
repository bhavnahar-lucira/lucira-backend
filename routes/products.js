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
// See lib/recommendations.js getPopularityDb: nulling the promise in the catch
// made every subsequent request pay the connect timeout again. Remember the
// failure for a window instead — social proof is an optional badge, so a fast
// degrade beats a slow, repeated retry on a shopper-facing endpoint.
let _socialProofDbFailedAt = 0;
const SOCIAL_PROOF_DB_RETRY_MS = 5 * 60 * 1000;
const SOCIAL_PROOF_DB_CONNECT_MS = 3000;

async function getSocialProofDb(fastify) {
  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev || !process.env.MONGODB_URI) return fastify.mongo.db;
  // When the primary connection already points at the store DB (LOCAL_MONGODB_URI
  // unset or equal to MONGODB_URI) a second client would just be a duplicate pool.
  if ((process.env.LOCAL_MONGODB_URI || process.env.MONGODB_URI) === process.env.MONGODB_URI) return fastify.mongo.db;

  if (!_socialProofDbPromise && (Date.now() - _socialProofDbFailedAt) < SOCIAL_PROOF_DB_RETRY_MS) {
    return fastify.mongo.db;
  }

  try {
    if (!_socialProofDbPromise) {
      const { MongoClient } = require('mongodb');
      _socialProofDbPromise = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: SOCIAL_PROOF_DB_CONNECT_MS })
        .connect()
        .then((client) => client.db());
    }
    return await _socialProofDbPromise;
  } catch (err) {
    _socialProofDbFailedAt = Date.now();
    _socialProofDbPromise = null;
    console.warn(`[social-proof] Store DB unreachable (${err.message}). Using the primary ` +
      `connection; not retrying for ${SOCIAL_PROOF_DB_RETRY_MS / 60000} min.`);
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

  // GET /api/products/admin-search
  // Unlike /search (which queries the storefront-facing search index and
  // therefore only returns products published to the Online Store), this
  // goes straight to the Shopify Admin API — so a deliberately Unlisted
  // product (the normal way to keep a gift/add-on product out of storefront
  // browsing and search) still shows up here. For internal pickers only
  // (e.g. Free Gift Tiers), never expose this to customer-facing code.
  fastify.get('/admin-search', async (request, reply) => {
    try {
      const term = String(request.query.q || '').trim();
      if (!term) return { products: [] };
      const limit = Math.min(parseInt(request.query.limit) || 10, 25);

      const query = `
        query AdminProductSearch($query: String!, $first: Int!) {
          products(first: $first, query: $query) {
            edges {
              node {
                id
                title
                handle
                status
                featuredImage { url }
                variants(first: 50) {
                  edges {
                    node {
                      id
                      title
                      price
                      availableForSale
                      image { url }
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const searchQuery = `title:${term}*`;
      const data = await shopifyAdminFetch(query, { query: searchQuery, first: limit });
      const products = (data?.products?.edges || []).map(({ node: p }) => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        status: p.status,
        image: p.featuredImage?.url || '',
        variants: (p.variants?.edges || []).map(({ node: v }) => ({
          shopifyId: v.id,
          title: v.title,
          price: Number(v.price) || 0,
          inStock: v.availableForSale,
          image: v.image?.url || '',
        })),
      }));
      return { products };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Admin product search failed" });
    }
  });

  // GET /api/products/admin-collections-search
  // Internal picker endpoint for the discounts dashboard. With `q` it does a
  // title-prefix search; without one (the picker opens on focus, before the
  // staff member has typed anything) it browses the full collection list
  // alphabetically instead of returning nothing — a store can have 1000+
  // collections, so this is paginated via `cursor`/`pageInfo` rather than
  // dumping them all at once.
  fastify.get('/admin-collections-search', async (request, reply) => {
    try {
      const term = String(request.query.q || '').trim();
      const limit = Math.min(parseInt(request.query.limit) || 20, 50);
      const cursor = request.query.cursor ? String(request.query.cursor) : null;

      const query = `
        query AdminCollectionSearch($query: String, $first: Int!, $after: String) {
          collections(first: $first, query: $query, after: $after, sortKey: TITLE) {
            edges {
              cursor
              node {
                id
                title
                handle
                image { url }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;
      const searchQuery = term ? `title:${term}*` : null;
      const data = await shopifyAdminFetch(query, { query: searchQuery, first: limit, after: cursor });
      const collections = (data?.collections?.edges || []).map(({ node: c }) => ({
        id: c.id,
        title: c.title,
        handle: c.handle,
        image: { src: c.image?.url || '' } // Match the frontend's p.image?.src expectation
      }));
      const pageInfo = data?.collections?.pageInfo || { hasNextPage: false, endCursor: null };
      return { collections, pageInfo };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Admin collection search failed" });
    }
  });

  // GET /api/products/pricing
  fastify.get('/pricing', async (request, reply) => {
    const { variantId } = request.query;
    if (!variantId) return reply.code(400).send({ error: 'variantId required' });

    const gid = variantId.includes("ProductVariant") ? variantId : `gid://shopify/ProductVariant/${variantId}`;
    const query = `query ($id: ID!) { 
      node(id: $id) { 
        ... on ProductVariant { 
          id title sku 
          price
          compareAtPrice
          metafield(namespace: "DI-GoldPrice", key: "variant_config") { value } 
        } 
      } 
      shop { 
        metalPrices: metafield(namespace: "DI-GoldPrice", key: "metal_prices") { value } 
        stonePricing: metafield(namespace: "DI-GoldPrice", key: "stone_pricing") { value } 
      } 
    }`;
    
    const data = await getServerCache(`variant-pricing:${gid}`, () => shopifyAdminFetch(query, { id: gid }), { ttlMs: 0 });
    const variant = data?.node;
    
    if (!variant) return reply.code(404).send({ error: 'Variant config not found' });

    const formatINR = (amount) => {
      if (!amount || amount <= 0) return '\u20b90';
      return '\u20b9' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(amount));
    };

    // If variant_config is missing, return simple price info
    if (!variant.metafield?.value) {
      const price = Number(variant.price || 0);
      const comparePrice = variant.compareAtPrice ? Number(variant.compareAtPrice) : null;
      
      return {
        variantId,
        sku: variant.sku,
        selectedVariant: variant.title,
        price,
        compare_price: comparePrice,
        price_breakup: {
          price: [
            { label: "Product Price", value: formatINR(price) }
          ],
          grand_total: formatINR(price),
          total_savings: comparePrice && comparePrice > price ? formatINR(comparePrice - price) : '\u20b90'
        }
      };
    }

    const config = JSON.parse(variant.metafield.value);
    const metalRates = JSON.parse(data.shop.metalPrices.value);
    const stonePricingDB = JSON.parse(data.shop.stonePricing.value);
    const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);

    const taxPercent = breakup.gst?.percent || metalRates.default_tax || 3;
    const originalSubtotal = (breakup.metal?.cost || 0) + 
                             (breakup.diamond?.original || 0) + 
                             (breakup.gemstone?.original || 0) + 
                             (breakup.making_charges?.original || 0);
    const originalGst = Math.round((originalSubtotal * taxPercent) / 100);
    const originalGrandTotal = originalSubtotal + originalGst;
    
    // Calculate total savings
    const totalSavingsAmount = Math.round(originalGrandTotal - (breakup.total || 0));

    // --- Dynamic Mined Diamond Comparison Logic ---
    let minedDiamondTotal = 0;
    if (config.advanced_stone_config && Array.isArray(config.advanced_stone_config)) {
      config.advanced_stone_config.forEach(stone => {
        if (stone.stone_type === 'diamond' && stone.stone_quantity > 0) {
          const avgWeight = stone.stone_weight / stone.stone_quantity;
          let minedRate = 0;
          if (avgWeight <= 0.109) minedRate = 86800;
          else if (avgWeight <= 0.249) minedRate = 97020;
          else if (avgWeight <= 0.499) minedRate = 114917;
          else if (avgWeight <= 0.749) minedRate = 74266;
          else if (avgWeight <= 0.999) minedRate = 89373;
          else if (avgWeight <= 1.499) minedRate = 126906;
          else if (avgWeight <= 1.999) minedRate = 179840;
          else if (avgWeight <= 2.999) minedRate = 301515;
          else minedRate = 395589;
          minedDiamondTotal += (minedRate * stone.stone_weight);
        }
      });
    }

    // If mined diamond total was calculated via slabs, use it. Otherwise, fallback to 1.3x markup of original diamond price.
    const finalMinedDiamondPrice = minedDiamondTotal > 0 ? minedDiamondTotal : Math.round(breakup.diamond.original * 1.3);
    const comparisonSavings = finalMinedDiamondPrice - (breakup.diamond.final || 0);

    const price_breakup = {
      price: [
        breakup.metal?.cost > 0 ? { label: `${breakup.metal.purity || ''} ${breakup.metal.metal_type || 'Gold'} (${breakup.metal.weight}g @ \u20b9${breakup.metal.rate_per_gram}/g)`, value: formatINR(breakup.metal.cost) } : null,
        breakup.diamond?.final > 0 ? { label: `Diamond (${breakup.diamond.pcs} pcs, ${breakup.diamond.carat}ct)`, value: formatINR(breakup.diamond.final), oldValue: (breakup.diamond.original > breakup.diamond.final) ? formatINR(breakup.diamond.original) : null, discount: breakup.diamond.discount_percent > 0 ? `${breakup.diamond.discount_percent}% OFF` : null } : null,
        breakup.gemstone?.final > 0 ? { label: `Gemstone (${breakup.gemstone.pcs} pcs)`, value: formatINR(breakup.gemstone.final) } : null,
        breakup.making_charges?.original > 0 ? { 
          label: 'Making Charges', 
          value: breakup.making_charges.final <= 0 ? 'FREE' : formatINR(breakup.making_charges.final), 
          oldValue: (breakup.making_charges.original > (breakup.making_charges.final > 0 ? breakup.making_charges.final : 0)) ? formatINR(breakup.making_charges.original) : null, 
          discount: breakup.making_charges.discount_percent > 0 ? `${breakup.making_charges.discount_percent}% OFF` : null 
        } : null,
        breakup.gst?.amount > 0 ? { label: `GST (${breakup.gst.percent}%)`, value: formatINR(breakup.gst.amount), oldValue: originalGst > breakup.gst.amount ? formatINR(originalGst) : null } : null,
      ].filter(Boolean),
      grand_total: formatINR(breakup.total),
      total_savings: totalSavingsAmount >= 10 ? formatINR(totalSavingsAmount) : '\u20b90',
      comparison: breakup.diamond?.original > 0 ? {
        price: { lucira: formatINR(breakup.diamond.final), mined: formatINR(finalMinedDiamondPrice) },
        carat: `${breakup.diamond.carat}ct`,
        clarity: { lucira: breakup.diamond.clarity || 'VVS-VS', mined: 'SI' },
        color: { lucira: breakup.diamond.color || 'EF', mined: 'IJ' },
        savings: formatINR(comparisonSavings > 0 ? comparisonSavings : 0),
      } : null,
    };

    return {
      variantId,
      sku: data.node.sku,
      selectedVariant: data.node.title,
      price: breakup.total,
      raw_breakup: breakup,
      price_breakup,
    };
  });

  // GET /api/products/variant-price
  // Plain Shopify variant price/compareAtPrice, for fixed-price gift SKUs (e.g. the free
  // Silver Bracelet) that carry no DI-GoldPrice variant_config for the dynamic pricing
  // service above to compute from.
  fastify.get('/variant-price', async (request, reply) => {
    const { variantId } = request.query;
    if (!variantId) return reply.code(400).send({ error: "variantId required" });

    const gid = String(variantId).includes("gid://shopify/ProductVariant/")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;

    try {
      const data = await shopifyAdminFetch(`
        query ($id: ID!) { node(id: $id) { ... on ProductVariant { price compareAtPrice } } }
      `, { id: gid });

      const node = data?.node;
      if (!node) return reply.code(404).send({ error: "Variant not found" });

      return {
        price: Number(node.price || 0),
        compare_price: Number(node.compareAtPrice || node.price || 0),
      };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Variant price fetch failed" });
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
