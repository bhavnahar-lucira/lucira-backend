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

  // GET /api/products/search
  fastify.get('/search', async (request, reply) => {
    let { handle = 'all', q = '', limit = 25, cursor, sort = 'featured', filters: filtersRaw } = request.query;
    // Guard: if q was sent as an array (e.g. ?q=rings&q=rings), take the first value
    if (Array.isArray(q)) q = q[0] || '';

    let parsedPriceFilter = null;
    let cleanSearchQuery = q;

    // Price query regex parsing (e.g., under 60k, above 30000, below 10k, less than 60000)
    const underRegex = /(?:under|below|less\s+than)\s*₹?\s*(\d+)\s*(k|thousand)?/i;
    const aboveRegex = /(?:above|over|more\s+than|greater\s+than)\s*₹?\s*(\d+)\s*(k|thousand)?/i;

    const underMatch = q.match(underRegex);
    const aboveMatch = q.match(aboveRegex);

    if (underMatch) {
      let val = parseInt(underMatch[1]);
      if (underMatch[2]?.toLowerCase() === 'k' || underMatch[2]?.toLowerCase() === 'thousand') val *= 1000;
      parsedPriceFilter = { max: val };
      cleanSearchQuery = q.replace(underRegex, '').trim();
    } else if (aboveMatch) {
      let val = parseInt(aboveMatch[1]);
      if (aboveMatch[2]?.toLowerCase() === 'k' || aboveMatch[2]?.toLowerCase() === 'thousand') val *= 1000;
      parsedPriceFilter = { min: val };
      cleanSearchQuery = q.replace(aboveRegex, '').trim();
    }

    if (!cleanSearchQuery && parsedPriceFilter) {
      cleanSearchQuery = "*";
    }

    // Search matched collections via storefront collections API if there is a query term
    let matchedCollections = [];
    if (cleanSearchQuery && cleanSearchQuery !== "*") {
      const COLLECTION_SEARCH_QUERY = `
        query SearchCollections($query: String!) {
          collections(first: 6, query: $query) {
            edges {
              node {
                id
                title
                handle
                image { url }
              }
            }
          }
        }
      `;
      try {
        const escaped = cleanSearchQuery.replace(/[:"'\(\)\*]/g, '').trim();
        const collQuery = escaped ? `title:*${escaped}* OR handle:*${escaped}*` : "";
        if (collQuery) {
          const collData = await shopifyStorefrontFetch(COLLECTION_SEARCH_QUERY, { query: collQuery });
          matchedCollections = (collData?.collections?.edges || []).map(({ node }) => ({
            id: node.id,
            title: node.title,
            handle: node.handle,
            image: node.image?.url || ""
          }));
        }
      } catch (e) {
        console.error("Error searching collections:", e);
      }
    }

    let shopifySearchQuery = cleanSearchQuery;
    if (cleanSearchQuery && cleanSearchQuery !== "*") {
      const escaped = cleanSearchQuery.replace(/[:"'\(\)\*]/g, '').trim();
      if (escaped) {
        // If the term is part of a Search & Discovery synonym group (mirrored
        // in lib/searchSynonyms), expand to the whole group so Shopify returns
        // the canonical products (e.g. "kada"/"kangan"/"braclet" → Bracelets).
        // Otherwise fall back to the clean term + a prefix variant.
        const synonyms = expandSynonyms(cleanSearchQuery);
        if (synonyms && synonyms.length) {
          shopifySearchQuery = synonymQuery(synonyms);
        } else {
          const words = escaped.split(/\s+/).filter(Boolean);
          shopifySearchQuery = words.map(w => `(${w} OR ${w}*)`).join(" OR ");
        }
      }
      if (handle && handle !== 'all') {
        shopifySearchQuery = `(${shopifySearchQuery}) AND collection:${handle}`;
      }
    } else if (handle && handle !== 'all' && cleanSearchQuery === "*") {
      shopifySearchQuery = `collection:${handle}`;
    }

    const activeFilters = parseFilters(filtersRaw);
    const sortConfig = SORT_MAP[sort] || SORT_MAP.featured;


    const shopifyFilters = [];
    Object.entries(request.query).forEach(([key, value]) => {
      if (key.startsWith("filter.")) {
        if (key === "filter.v.price.gte" || key === "filter.v.price.lte") {
          const existingPrice = shopifyFilters.find(f => f.price);
          if (existingPrice) {
            if (key === "filter.v.price.gte") existingPrice.price.min = parseFloat(value);
            else existingPrice.price.max = parseFloat(value);
          } else {
            shopifyFilters.push({ price: { min: key === "filter.v.price.gte" ? parseFloat(value) : 0, max: key === "filter.v.price.lte" ? parseFloat(value) : 1000000 }});
          }
        } else if (key === "filter.p.product_type") {
          shopifyFilters.push({ productType: value });
        } else {
          try { shopifyFilters.push(JSON.parse(value)); } catch(e) { shopifyFilters.push({ [key.replace("filter.", "")]: value }); }
        }
      }
    });

    const finalFilters = shopifyFilters.length > 0 ? shopifyFilters : activeFilters;
    const { metalRates, stonePricingDB } = await getShopPricingData();

    const COLLECTION_QUERY = `
      query SearchProducts(
        $handle: String!
        $first: Int!
        $after: String
        $sortKey: ProductCollectionSortKeys
        $reverse: Boolean
        $filters: [ProductFilter!]
      ) {
        collectionByHandle(handle: $handle) {
          products(
            first: $first
            after: $after
            sortKey: $sortKey
            reverse: $reverse
            filters: $filters
          ) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title handle productType description descriptionHtml createdAt tags
                featuredImage { url }
                productMetafields: metafields(identifiers: [
                  {namespace: "ornaverse", key: "weight"},
                  {namespace: "ornaverse", key: "quality"},
                  {namespace: "ornaverse", key: "carat_range"},
                  {namespace: "ornaverse", key: "lead_time"},
                  {namespace: "ornaverse", key: "components"},
                  {namespace: "ornaverse", key: "bestsellers"},
                  {namespace: "custom", key: "matching_product"}
                ]) {
                  key
                  value
                }
                media(first: 20) {
                  edges {
                    node {
                      mediaContentType
                      ... on MediaImage { image { url altText } }
                      ... on Video { sources { url mimeType } }
                    }
                  }
                }
                variants(first: 50) {
                  edges {
                    node {
                      id sku price { amount } compareAtPrice { amount }
                      availableForSale currentlyNotInStock selectedOptions { name value }
                      image { url altText }
                      metal_weight: metafield(namespace: "ornaverse", key: "metal_weight") { value }
                      gross_weight: metafield(namespace: "ornaverse", key: "gross_weight") { value }
                      top_width: metafield(namespace: "ornaverse", key: "top_width") { value }
                      top_height: metafield(namespace: "ornaverse", key: "top_height") { value }
                      diamonds_meta: metafield(namespace: "ornaverse", key: "diamonds") { value }
                      gemstones_meta: metafield(namespace: "ornaverse", key: "gemstones") { value }
                      components: metafield(namespace: "ornaverse", key: "components") { value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const SEARCH_QUERY = `
      query KeywordSearch(
        $query: String!
        $first: Int!
        $after: String
        $filters: [ProductFilter!]
      ) {
        search(
          query: $query
          first: $first
          after: $after
          productFilters: $filters
          types: [PRODUCT]
        ) {
          totalCount
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              __typename
              ... on Product {
                id title handle productType description descriptionHtml createdAt tags
                collectionHandles: collections(first: 10) {
                  edges { node { handle } }
                }
                featuredImage { url }
                productMetafields: metafields(identifiers: [
                  {namespace: "ornaverse", key: "weight"},
                  {namespace: "ornaverse", key: "quality"},
                  {namespace: "ornaverse", key: "carat_range"},
                  {namespace: "ornaverse", key: "lead_time"},
                  {namespace: "ornaverse", key: "components"},
                  {namespace: "ornaverse", key: "bestsellers"},
                  {namespace: "custom", key: "matching_product"}
                ]) {
                  key
                  value
                }
                media(first: 20) {
                  edges {
                    node {
                      mediaContentType
                      ... on MediaImage { image { url altText } }
                      ... on Video { sources { url mimeType } }
                    }
                  }
                }
                variants(first: 50) {
                  edges {
                    node {
                      id sku price { amount } compareAtPrice { amount }
                      availableForSale currentlyNotInStock selectedOptions { name value }
                      image { url altText }
                      metal_weight: metafield(namespace: "ornaverse", key: "metal_weight") { value }
                      gross_weight: metafield(namespace: "ornaverse", key: "gross_weight") { value }
                      top_width: metafield(namespace: "ornaverse", key: "top_width") { value }
                      top_height: metafield(namespace: "ornaverse", key: "top_height") { value }
                      diamonds_meta: metafield(namespace: "ornaverse", key: "diamonds") { value }
                      gemstones_meta: metafield(namespace: "ornaverse", key: "gemstones") { value }
                      components: metafield(namespace: "ornaverse", key: "components") { value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let productsData;
    let totalCount = 0;
    if (shopifySearchQuery) {
      const data = await shopifyStorefrontFetch(SEARCH_QUERY, { query: shopifySearchQuery, first: parseInt(limit), after: cursor || null, filters: finalFilters.length > 0 ? finalFilters : null });
      productsData = data?.search;
      totalCount = data?.search?.totalCount || 0;
    } else {
      const data = await shopifyStorefrontFetch(COLLECTION_QUERY, { handle, first: parseInt(limit), after: cursor || null, sortKey: sortConfig.sortKey === "RELEVANCE" ? "BEST_SELLING" : sortConfig.sortKey, reverse: sortConfig.reverse, filters: finalFilters.length > 0 ? finalFilters : null });
      productsData = data?.collectionByHandle?.products;
    }

    if (!productsData) return { products: [], matchedCollections, pagination: { total: 0, hasNextPage: false } };



    const variantGids = [];
    productsData.edges.forEach(({ node }) => {
      if (node.variants) {
        node.variants.edges.forEach(({ node: v }) => variantGids.push(v.id));
      }
    });

    const variantConfigs = {};
    if (variantGids.length > 0) {
      const variantQuery = `query getVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value } metal_weight: metafield(namespace: "ornaverse", key: "metal_weight") { value } gross_weight: metafield(namespace: "ornaverse", key: "gross_weight") { value } top_width: metafield(namespace: "ornaverse", key: "top_width") { value } top_height: metafield(namespace: "ornaverse", key: "top_height") { value } diamonds_meta: metafield(namespace: "ornaverse", key: "diamonds") { value } gemstones_meta: metafield(namespace: "ornaverse", key: "gemstones") { value } components: metafield(namespace: "ornaverse", key: "components") { value } } } }`;
      const uniqueGids = [...new Set(variantGids)];
      const CHUNK_SIZE = 100;
      const chunkPromises = [];
      for (let i = 0; i < uniqueGids.length; i += CHUNK_SIZE) {
        const chunk = uniqueGids.slice(i, i + CHUNK_SIZE);
        chunkPromises.push(
          getServerCache(stableCacheKey(["search-variant-configs", chunk]), () => shopifyStorefrontFetch(variantQuery, { ids: chunk }))
        );
      }
      const chunkResults = await Promise.all(chunkPromises);
      chunkResults.forEach((adminData) => {
        adminData?.nodes?.forEach(node => { if (node) variantConfigs[node.id] = node; });
      });
    }

    const products = productsData.edges.map(({ node }) => {
      if (node.__typename === "Page" || node.__typename === "Article") {
        return {
          id: node.id.split("/").pop(),
          shopifyId: node.id,
          title: node.title,
          handle: node.handle,
          type: node.__typename.toLowerCase(),
          tags: [],
          images: [],
          media: [],
          price: 0,
          compare_price: null,
          image: null,
          variants: [],
          productMetafields: {}
        };
      }

      const productMetafields = {};
      node.productMetafields?.forEach(m => { if (m) productMetafields[m.key] = m.value; });

      const variants = node.variants.edges.map(({ node: v }) => {
        const options = {};
        v.selectedOptions.forEach((o) => { options[o.name.toLowerCase()] = o.value; });

        let dynamic = {};
        let diamondDiscount = 0;
        let makingDiscount = 0;
        let configMetalPurity = null;
        let dynamicPrice = null;
        let dynamicComparePrice = null;
        const variantData = variantConfigs[v.id];
        const configValue = variantData?.variant_config?.value;
        if (configValue) {
          try {
            const config = JSON.parse(configValue);
            const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);
            dynamic = { carat: breakup.diamond.carat, clarity: breakup.diamond.clarity, color: breakup.diamond.color, weight: breakup.metal.weight, diamondCharges: breakup.diamond.final };
            diamondDiscount = breakup.diamond.discount_percent || 0;
            makingDiscount = breakup.making_charges.discount_percent || 0;
            configMetalPurity = config.purity;
            dynamicPrice = breakup.total;
            dynamicComparePrice = breakup.original_total > breakup.total ? breakup.original_total : null;
          } catch (e) {}
        }

        const getOpt = (keys) => {
          for (const key of keys) {
            const lowerKey = key.toLowerCase();
            if (options[lowerKey] !== undefined) return options[lowerKey];
          }
          return null;
        };

        const comps = v.components?.value ? JSON.parse(v.components.value) : null;
        const metalComp = comps?.components?.find(c => c.item_group_name === "Gold");
        let metal_color = metalComp?.stone_color_code && metalComp.stone_color_code !== "NA" ? metalComp.stone_color_code : null;
        if (!metal_color) {
          const t = v.title || "";
          if (t.toLowerCase().includes('rose')) metal_color = 'Rose Gold';
          else if (t.toLowerCase().includes('white')) metal_color = 'White Gold';
          else if (t.toLowerCase().includes('yellow')) metal_color = 'Yellow Gold';
        }

        return {
          id: v.id.split("/").pop(),
          shopifyId: v.id,
          sku: v.sku,
          size: options.size || null,
          color: getOpt(["color", "metal", "metal color"]),
          carat: dynamic.carat ?? getOpt(["carat"]),
          clarity: dynamic.clarity ?? getOpt(["clarity"]),
          diamond_color: dynamic.color ?? getOpt(["diamond color"]),
          weight: dynamic.weight ?? getOpt(["weight"]),
          price: dynamicPrice || Number(v.price.amount || 0),
          compare_price: dynamicComparePrice || (v.compareAtPrice ? Number(v.compareAtPrice.amount) : null),
          inStock: v.availableForSale === true && v.currentlyNotInStock === false,
          image: v.image?.url || null,
          altText: v.image?.altText || "",
          metafields: { metal_purity: configMetalPurity || getOpt(["purity"]), metal_color, metal_weight: dynamic.weight || v.metal_weight?.value || variantData?.metal_weight?.value },
          diamondDiscount,
          makingDiscount
        };
      });

      let selectedVariant = variants.find((v) => v.inStock) || variants[0];
      const images = node.media?.edges?.filter(m => m.node.mediaContentType === "IMAGE").map(m => ({ url: m.node.image.url, alt: m.node.image.altText || "" }));
      const media = node.media?.edges?.map(m => {
        const n = m.node;
        if (n.mediaContentType === "VIDEO") {
          return {
            mediaContentType: "VIDEO",
            sources: n.sources?.map(s => ({ url: s.url, mimeType: s.mimeType })) || []
          };
        }
        return null;
      }).filter(Boolean) || [];

      return {
        id: node.id.split("/").pop(),
        shopifyId: node.id,
        title: node.title,
        handle: node.handle,
        type: node.productType,
        tags: node.tags || [],
        isNew: new Date(node.createdAt) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        images,
        media,
        price: selectedVariant.price,
        compare_price: selectedVariant.compare_price,
        image: selectedVariant.image || node.featuredImage?.url,
        variants,
        productMetafields
      };
    });

    let minPrice = request.query["filter.v.price.gte"];
    let maxPrice = request.query["filter.v.price.lte"];
    let priceFilter = finalFilters.find(f => f.price);
    if (!priceFilter && (minPrice || maxPrice)) {
      priceFilter = {
        price: {
          min: minPrice ? parseFloat(minPrice) : 0,
          max: maxPrice ? parseFloat(maxPrice) : 5000000
        }
      };
    }

    let filteredProducts = products;
    if (priceFilter && priceFilter.price) {
      const { min = 0, max = 5000000 } = priceFilter.price;
      filteredProducts = products.filter(p => p.price >= min && p.price <= max);
      totalCount = filteredProducts.length;
    } else if (parsedPriceFilter) {
      const { min = 0, max = 5000000 } = parsedPriceFilter;
      filteredProducts = products.filter(p => p.price >= min && p.price <= max);
      totalCount = filteredProducts.length;
    }

    // Sort products array dynamically
    if (sort === "price_low_high") {
      filteredProducts.sort((a, b) => a.price - b.price);
    } else if (sort === "price_high_low") {
      filteredProducts.sort((a, b) => b.price - a.price);
    } else if (cleanSearchQuery && cleanSearchQuery !== "*") {
      // Relevance sorting based on number of matched words with first word priority
      const words = cleanSearchQuery.split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
      if (words.length > 1) {
        
        const countMatches = (p) => {
          let score = 0;
          const title = (p.title || "").toLowerCase();
          const type = (p.type || "").toLowerCase();
          
          words.forEach((word, index) => {
            let matched = false;
            if (title.includes(word)) matched = true;
            else if (type.includes(word)) matched = true;
            else if (p.tags && p.tags.some(t => typeof t === 'string' && t.toLowerCase().includes(word))) matched = true;
            
            // Give the first word an absolute priority weight (100) 
            // so it always outranks matches of any combination of other words.
            if (matched) {
              score += (index === 0 ? 100 : 1);
            }
          });
          return score;
        };

        filteredProducts.sort((a, b) => {
          const aScore = countMatches(a);
          const bScore = countMatches(b);
          return bScore - aScore; // Highest score first
        });
      }
    }

    return { 
      products: filteredProducts, 
      matchedCollections, 
      pagination: { 
        hasNextPage: productsData.pageInfo.hasNextPage, 
        endCursor: productsData.pageInfo.endCursor, 
        total: totalCount 
      } 
    };
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
    const variant = data.node;
    
    if (!variant) return reply.code(404).send({ error: 'Variant not found' });

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
    const metalRates = data.shop.metalPrices?.value ? JSON.parse(data.shop.metalPrices.value) : {};
    const stonePricingDB = data.shop.stonePricing?.value ? JSON.parse(data.shop.stonePricing.value) : [];
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

  // GET /api/products/bestsellers
  fastify.get('/bestsellers', async (request, reply) => {
    const { tab = 'All' } = request.query;
    
    // Map tab to tag or filter logic
    const handle = "bestsellers";
    const { metalRates, stonePricingDB } = await getShopPricingData();

    const query = `
      query GetBestsellers($handle: String!, $filters: [ProductFilter!]) {
        collectionByHandle(handle: $handle) {
          products(first: 20, filters: $filters) {
            edges {
              node {
                id title handle productType tags featuredImage { url }
                productMetafields: metafields(identifiers: [
                  {namespace: "ornaverse", key: "bestsellers"}
                ]) { key value }
                variants(first: 100) {
                  edges {
                    node {
                      id title sku price { amount } compareAtPrice { amount }
                      availableForSale currentlyNotInStock selectedOptions { name value }
                      variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let filters = [];
    if (tab !== 'All') {
      filters.push({ productType: tab.endsWith('s') ? tab.slice(0, -1) : tab });
    }

    const data = await shopifyStorefrontFetch(query, { handle, filters });
    const productsData = data?.collectionByHandle?.products;

    if (!productsData) return { products: [] };

    const products = productsData.edges.map(({ node }) => {
      const productMetafields = {};
      node.productMetafields?.forEach(m => { if (m) productMetafields[m.key] = m.value; });

      const variants = node.variants.edges.map(({ node: v }) => {
        let breakup = null;
        if (v.variant_config?.value) {
          try {
            breakup = calculatePriceBreakup(JSON.parse(v.variant_config.value), metalRates, stonePricingDB);
          } catch(e) {}
        }
        return {
          id: v.id.split("/").pop(), shopifyId: v.id, sku: v.sku,
          price: breakup?.total || Number(v.price.amount),
          compare_price: v.compareAtPrice ? Number(v.compareAtPrice.amount) : null,
          inStock: v.availableForSale === true && v.currentlyNotInStock === false,
        };
      });

      let selectedVariant = variants.find(v => v.inStock) || variants[0];

      return {
        id: node.id.split("/").pop(),
        shopifyId: node.id,
        title: node.title,
        handle: node.handle,
        type: node.productType,
        tags: node.tags || [],
        image: node.featuredImage?.url,
        price: selectedVariant.price,
        compare_price: selectedVariant.compare_price,
        productMetafields
      };
    });

    return { products };
  });

  // GET /api/products/filters
  fastify.get('/filters', async (request, reply) => {
    const { q, handle } = request.query;

    const SEARCH_FILTERS_QUERY = `
      query KeywordFilters($query: String!, $filters: [ProductFilter!]) {
        search(query: $query, first: 1, productFilters: $filters, types: [PRODUCT]) {
          productFilters {
            label
            type
            values { label count input }
          }
        }
      }
    `;

    const COLLECTION_FILTERS_QUERY = `
      query CollectionFilters($handle: String!, $filters: [ProductFilter!]) {
        collectionByHandle(handle: $handle) {
          products(first: 1, filters: $filters) {
            filters {
              label
              type
              values { label count input }
            }
          }
        }
      }
    `;

    try {
      let storefrontData;
      let rawFilters = [];

      // 1. Fetch raw unfiltered filters first to get mapping schema for incoming params
      if (q) {
        storefrontData = await shopifyStorefrontFetch(SEARCH_FILTERS_QUERY, { query: q, filters: [] });
        rawFilters = storefrontData?.search?.productFilters || [];
      } else if (handle) {
        storefrontData = await shopifyStorefrontFetch(COLLECTION_FILTERS_QUERY, { handle, filters: [] });
        rawFilters = storefrontData?.collectionByHandle?.products?.filters || [];
      }

      // 2. Parse incoming user-friendly query params and map them to standard Shopify ProductFilter objects
      const shopifyFilters = [];
      Object.entries(request.query).forEach(([key, value]) => {
        if (["handle", "q", "sort", "cursor", "limit", "page"].includes(key)) return;
        if (key.startsWith("filter.")) {
          if (key === "filter.v.price.gte" || key === "filter.v.price.lte") {
            // Handled separately below
          } else {
            try {
              shopifyFilters.push(JSON.parse(value));
            } catch (e) {
              shopifyFilters.push({ [key.replace("filter.", "")]: value });
            }
          }
          return;
        }

        // Match user-friendly keys like "Ring Size" to filter definitions
        rawFilters.forEach((f) => {
          if (f.label.toLowerCase() === key.toLowerCase()) {
            const vals = Array.isArray(value) ? value : [value];
            vals.forEach((val) => {
              const matchedVal = f.values.find((v) => {
                let optionVal = v.label;
                try {
                  const input = JSON.parse(v.input);
                  if (input.variantOption) optionVal = input.variantOption.value;
                  else if (input.productMetafield) optionVal = input.productMetafield.value;
                  else if (input.productType) optionVal = input.productType;
                  else if (input.tag) optionVal = input.tag;
                } catch (e) {}
                return optionVal.toLowerCase() === val.toLowerCase() || v.label.toLowerCase() === val.toLowerCase();
              });
              if (matchedVal) {
                try {
                  shopifyFilters.push(JSON.parse(matchedVal.input));
                } catch (e) {}
              }
            });
          }
        });
      });

      // Price filter handling
      let minPrice = request.query["filter.v.price.gte"];
      let maxPrice = request.query["filter.v.price.lte"];
      if (minPrice || maxPrice) {
        shopifyFilters.push({
          price: {
            min: minPrice ? parseFloat(minPrice) : 0,
            max: maxPrice ? parseFloat(maxPrice) : 5000000
          }
        });
      }

      // 3. Re-fetch filters with active filters applied to calculate correct dynamic counts!
      if (shopifyFilters.length > 0) {
        if (q) {
          storefrontData = await shopifyStorefrontFetch(SEARCH_FILTERS_QUERY, { query: q, filters: shopifyFilters });
          rawFilters = storefrontData?.search?.productFilters || [];
        } else if (handle) {
          storefrontData = await shopifyStorefrontFetch(COLLECTION_FILTERS_QUERY, { handle, filters: shopifyFilters });
          rawFilters = storefrontData?.collectionByHandle?.products?.filters || [];
        }
      }

      const filters = {};
      rawFilters.forEach((f) => {
        if (f.type === "PRICE_RANGE") {
          const maxVal = Math.max(...f.values.map(v => { try { return JSON.parse(v.input).price.max || 1000000; } catch(e) { return 1000000; } }));
          filters["Price"] = {
            min: 0,
            max: maxVal
          };
          return;
        }
        const values = f.values
          .filter((v) => v.count > 0)
          .map((v) => {
            let value = v.label;
            try {
                const input = JSON.parse(v.input);
                if (input.variantOption) value = input.variantOption.value;
                else if (input.productMetafield) value = input.productMetafield.value;
                else if (input.productType) value = input.productType;
                else if (input.tag) value = input.tag;
            } catch(e) {}

            return { 
                label: v.label, 
                count: v.count, 
                input: v.input,
                value: value 
            };
          });
        
        if (values.length > 0) {
          filters[f.label] = values;
        }
      });

      // Shopify's facet counts include `hidden`-tagged products, which the storefront
      // strips out — so "Charms (34)" shows even though only 1 is visible. Override the
      // productType-based facet ("Product Category") with accurate visible counts.
      // Cached via the existing cache util (24h + webhook-invalidated). The scan applies
      // every active filter EXCEPT productType ones, matching Shopify's behaviour of not
      // self-narrowing a facet.
      if (handle) {
        try {
          const nonTypeFilters = shopifyFilters.filter((f) => !(f && "productType" in f));
          const stats = await getCollectionVisibleStats(handle, nonTypeFilters);
          if (!stats.capped) {
            Object.entries(filters).forEach(([label, values]) => {
              if (!Array.isArray(values)) return;
              const isProductTypeFacet = values.every((v) => {
                try { return "productType" in JSON.parse(v.input); } catch { return false; }
              });
              if (!isProductTypeFacet) return;
              filters[label] = values
                .map((v) => ({ ...v, count: stats.byType[v.value] ?? 0 }))
                .filter((v) => v.count > 0);
            });
          }
        } catch (e) {
          console.error("Filters visible-count override failed:", e);
        }
      }

      return filters;
    } catch (err) {
      console.error("❌ Filters API Error:", err);
      return {};
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
    } catch (error) {
      console.error("Product Details Error:", error);
      return reply.code(500).send({ error: "Failed to fetch product details", message: error.message });
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
