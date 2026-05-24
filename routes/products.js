/**
 * Products Routes (Fastify)
 * Handles search, filters, and variant pricing
 */

const { shopifyStorefrontFetch, shopifyAdminFetch } = require('../lib/shopify');
const { calculatePriceBreakup } = require('../lib/priceEngine');
const { getServerCache, stableCacheKey } = require('../lib/cache');

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
        const shopData = await shopifyStorefrontFetch(shopPricingQuery);
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
        const collQuery = escaped ? `title:*${escaped}*` : "";
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

    // Build rich search query matching title, body, tag, product type, and sku
    let shopifySearchQuery = cleanSearchQuery;
    if (cleanSearchQuery && cleanSearchQuery !== "*") {
      const escaped = cleanSearchQuery.replace(/[:"'\(\)\*]/g, '').trim();
      if (escaped) {
        shopifySearchQuery = `title:${escaped}* OR body:${escaped}* OR tag:${escaped}* OR product_type:${escaped}* OR sku:${escaped}* OR ${escaped}`;
      }
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
                id title handle description descriptionHtml createdAt tags
                featuredImage { url }
                productMetafields: metafields(identifiers: [
                  {namespace: "ornaverse", key: "weight"},
                  {namespace: "ornaverse", key: "quality"},
                  {namespace: "ornaverse", key: "carat_range"},
                  {namespace: "ornaverse", key: "lead_time"},
                  {namespace: "ornaverse", key: "components"}
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
                      availableForSale quantityAvailable selectedOptions { name value }
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
              ... on Product {
                id title handle description descriptionHtml createdAt tags
                collectionHandles: collections(first: 10) {
                  edges { node { handle } }
                }
                featuredImage { url }
                productMetafields: metafields(identifiers: [
                  {namespace: "ornaverse", key: "weight"},
                  {namespace: "ornaverse", key: "quality"},
                  {namespace: "ornaverse", key: "carat_range"},
                  {namespace: "ornaverse", key: "lead_time"},
                  {namespace: "ornaverse", key: "components"}
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
                      availableForSale quantityAvailable selectedOptions { name value }
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
    if (shopifySearchQuery && (handle === "all" || !handle)) {
      const data = await shopifyStorefrontFetch(SEARCH_QUERY, { query: shopifySearchQuery, first: parseInt(limit), after: cursor || null, filters: finalFilters });
      productsData = data?.search;
      totalCount = data?.search?.totalCount || 0;
    } else {
      const data = await shopifyStorefrontFetch(COLLECTION_QUERY, { handle, first: parseInt(limit), after: cursor || null, sortKey: sortConfig.sortKey === "RELEVANCE" ? "BEST_SELLING" : sortConfig.sortKey, reverse: sortConfig.reverse, filters: finalFilters });
      productsData = data?.collectionByHandle?.products;
    }

    if (!productsData) return { products: [], matchedCollections, pagination: { total: 0, hasNextPage: false } };

    // ── SKU Fallback via MongoDB ──────────────────────────────────────────────
    // Shopify's search() doesn't support partial/substring SKU matching.
    // SKU format: LJ-R00358-14RGLGD-10 — users often search by the middle segment (e.g. "R00358")
    // When Shopify returns 0 results and q looks like a SKU fragment, query MongoDB directly.
    const isSkuLike = q && /^[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?$/.test(q.trim()) && !q.trim().includes(' ');
    if (totalCount === 0 && isSkuLike && !cursor) {
      try {
        const db = fastify.mongo.client.db("next_local_db");
        const productsCol = db.collection("products");
        const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const mongoProducts = await productsCol
          .find({
            status: "ACTIVE",
            isPublished: true,
            "variants.sku": { $regex: escaped, $options: "i" }
          })
          .project({
            title: 1, handle: 1, shopifyId: 1, image: 1, price: 1,
            variants: 1, productMetafields: 1
          })
          .limit(parseInt(limit))
          .toArray();

        if (mongoProducts.length > 0) {
          const mapped = mongoProducts.map(p => {
            const variants = (p.variants || []).map(v => ({
              id: v.shopifyId?.split("/").pop() || String(v._id),
              shopifyId: v.shopifyId || "",
              sku: v.sku || "",
              size: v.size || null,
              price: Number(v.price || 0),
              compare_price: v.compare_price ? Number(v.compare_price) : null,
              inStock: v.inStock !== false,
              image: v.image || null,
              altText: v.altText || "",
              diamondDiscount: v.diamondDiscount || 0,
              makingDiscount: v.makingDiscount || 0,
            }));
            const selectedVariant = variants.find(v => v.inStock) || variants[0] || { price: Number(p.price || 0), compare_price: null, image: p.image || null };
            return {
              id: p.shopifyId?.split("/").pop() || String(p._id),
              shopifyId: p.shopifyId || "",
              title: p.title,
              handle: p.handle,
              price: selectedVariant.price,
              compare_price: selectedVariant.compare_price,
              image: selectedVariant.image || p.image || null,
              variants,
              productMetafields: p.productMetafields || {},
            };
          });
          return { products: mapped, pagination: { hasNextPage: false, endCursor: null, total: mongoProducts.length }, _source: "sku_fallback" };
        }
      } catch (err) {
        console.error("SKU fallback MongoDB error:", err.message);
        // Fall through — return empty Shopify result below
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const variantGids = [];
    productsData.edges.forEach(({ node }) => node.variants.edges.forEach(({ node: v }) => variantGids.push(v.id)));

    const variantConfigs = {};
    if (variantGids.length > 0) {
      const variantQuery = `query getVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value } metal_weight: metafield(namespace: "ornaverse", key: "metal_weight") { value } gross_weight: metafield(namespace: "ornaverse", key: "gross_weight") { value } top_width: metafield(namespace: "ornaverse", key: "top_width") { value } top_height: metafield(namespace: "ornaverse", key: "top_height") { value } diamonds_meta: metafield(namespace: "ornaverse", key: "diamonds") { value } gemstones_meta: metafield(namespace: "ornaverse", key: "gemstones") { value } components: metafield(namespace: "ornaverse", key: "components") { value } } } }`;
      const uniqueGids = [...new Set(variantGids)];
      const CHUNK_SIZE = 100;
      for (let i = 0; i < uniqueGids.length; i += CHUNK_SIZE) {
        const chunk = uniqueGids.slice(i, i + CHUNK_SIZE);
        const adminData = await getServerCache(stableCacheKey(["search-variant-configs", chunk]), () => shopifyStorefrontFetch(variantQuery, { ids: chunk }));
        adminData?.nodes?.forEach(node => { if (node) variantConfigs[node.id] = node; });
      }
    }

    const products = productsData.edges.map(({ node }) => {
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
          inStock: v.availableForSale === true && (v.quantityAvailable === null || Number(v.quantityAvailable) > 0),
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
    const query = `query ($id: ID!) { node(id: $id) { ... on ProductVariant { id title sku metafield(namespace: "DI-GoldPrice", key: "variant_config") { value } } } shop { metalPrices: metafield(namespace: "DI-GoldPrice", key: "metal_prices") { value } stonePricing: metafield(namespace: "DI-GoldPrice", key: "stone_pricing") { value } } }`;
    
    const data = await getServerCache(`variant-pricing:${gid}`, () => shopifyAdminFetch(query, { id: gid }), { ttlMs: 60 * 60 * 1000 });
    if (!data.node?.metafield?.value) return reply.code(404).send({ error: 'Variant config not found' });

    const config = JSON.parse(data.node.metafield.value);
    const metalRates = JSON.parse(data.shop.metalPrices.value);
    const stonePricingDB = JSON.parse(data.shop.stonePricing.value);
    const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);

    // Calculate total savings (diamond discount + making charges discount)
    const diamondSavings = Math.round((breakup.diamond?.original || 0) - (breakup.diamond?.final || 0));
    const makingSavings = Math.round((breakup.making_charges?.original || 0) - (breakup.making_charges?.final || 0));
    const totalSavingsAmount = diamondSavings + makingSavings;

    const formatINR = (amount) => {
      if (!amount || amount <= 0) return '\u20b90';
      return '\u20b9' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(amount));
    };

    // Build a price_breakup structure matching what the frontend expects
    const price_breakup = {
      price: [
        breakup.metal?.cost > 0 ? { label: `${breakup.metal.purity || ''} ${breakup.metal.metal_type || 'Gold'} (${breakup.metal.weight}g @ \u20b9${breakup.metal.rate_per_gram}/g)`, value: formatINR(breakup.metal.cost) } : null,
        breakup.diamond?.final > 0 ? { label: `Diamond (${breakup.diamond.pcs} pcs, ${breakup.diamond.carat}ct)`, value: formatINR(breakup.diamond.final), oldValue: formatINR(breakup.diamond.original), discount: breakup.diamond.discount_percent > 0 ? `${breakup.diamond.discount_percent}% OFF` : null } : null,
        breakup.gemstone?.final > 0 ? { label: `Gemstone (${breakup.gemstone.pcs} pcs)`, value: formatINR(breakup.gemstone.final) } : null,
        breakup.making_charges?.final > 0 ? { label: 'Making Charges', value: formatINR(breakup.making_charges.final), oldValue: formatINR(breakup.making_charges.original), discount: breakup.making_charges.discount_percent > 0 ? `${breakup.making_charges.discount_percent}% OFF` : null } : null,
        breakup.gst?.amount > 0 ? { label: `GST (${breakup.gst.percent}%)`, value: formatINR(breakup.gst.amount) } : null,
      ].filter(Boolean),
      grand_total: formatINR(breakup.total),
      total_savings: totalSavingsAmount > 0 ? formatINR(totalSavingsAmount) : '\u20b90',
      comparison: breakup.diamond?.original > 0 ? {
        price: { lucira: formatINR(breakup.total), mined: formatINR(Math.round(breakup.total * 1.3)) },
        carat: `${breakup.diamond.carat}ct`,
        clarity: { lucira: breakup.diamond.clarity || 'VVS-VS', mined: 'VS-SI' },
        color: { lucira: breakup.diamond.color || 'EF', mined: 'GH' },
        savings: formatINR(totalSavingsAmount),
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
                id title handle featuredImage { url }
                variants(first: 10) {
                  edges {
                    node {
                      id title sku price { amount } compareAtPrice { amount }
                      availableForSale quantityAvailable selectedOptions { name value }
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
          inStock: v.availableForSale === true && Number(v.quantityAvailable || 0) > 0,
        };
      });

      let selectedVariant = variants.find(v => v.inStock) || variants[0];

      return {
        id: node.id.split("/").pop(),
        shopifyId: node.id,
        title: node.title,
        handle: node.handle,
        image: node.featuredImage?.url,
        price: selectedVariant.price,
        compare_price: selectedVariant.compare_price
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
          priceRange { minVariantPrice { amount } }
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
      
      const mapped = recs.map(p => ({
        id: p.id.split("/").pop(),
        shopifyId: p.id,
        title: p.title,
        handle: p.handle,
        image: p.featuredImage?.url,
        price: Number(p.priceRange.minVariantPrice.amount)
      }));

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

      const db = fastify.mongo.client.db("next_local_db");
      const productsCollection = db.collection("products");

      const product = await productsCollection.findOne({ 
        handle: handle,
        status: "ACTIVE",
        isPublished: true
      });
      
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
}

module.exports = routes;
