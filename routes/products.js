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
    const { handle = 'all', q = '', limit = 25, cursor, sort = 'featured', filters: filtersRaw } = request.query;
    
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
    if (q && (handle === "all" || !handle)) {
      const data = await shopifyStorefrontFetch(SEARCH_QUERY, { query: q, first: parseInt(limit), after: cursor || null, filters: finalFilters });
      productsData = data?.search;
      totalCount = data?.search?.totalCount || 0;
    } else {
      const data = await shopifyStorefrontFetch(COLLECTION_QUERY, { handle, first: parseInt(limit), after: cursor || null, sortKey: sortConfig.sortKey === "RELEVANCE" ? "BEST_SELLING" : sortConfig.sortKey, reverse: sortConfig.reverse, filters: finalFilters });
      productsData = data?.collectionByHandle?.products;
    }

    if (!productsData) return { products: [], pagination: { total: 0, hasNextPage: false } };

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
        let diamondDiscount = 0, makingDiscount = 0;
        const variantData = variantConfigs[v.id];
        const configValue = variantData?.variant_config?.value;
        if (configValue) {
          try {
            const config = JSON.parse(configValue);
            const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);
            dynamic = { carat: breakup.diamond.carat, clarity: breakup.diamond.clarity, color: breakup.diamond.color, weight: breakup.metal.weight, diamondCharges: breakup.diamond.final };
            diamondDiscount = breakup.diamond.discount_percent || 0;
            makingDiscount = breakup.making_charges.discount_percent || 0;
          } catch (e) {}
        }
        return {
          id: v.id.split("/").pop(), shopifyId: v.id, sku: v.sku, size: options.size || null,
          price: Number(v.price.amount), compare_price: v.compareAtPrice ? Number(v.compareAtPrice.amount) : null,
          inStock: v.availableForSale === true && Number(v.quantityAvailable || 0) > 0,
          image: v.image?.url || null, altText: v.image?.altText || "",
          diamondDiscount, makingDiscount
        };
      });

      let selectedVariant = variants.find((v) => v.inStock) || variants[0];
      return {
        id: node.id.split("/").pop(), shopifyId: node.id, title: node.title, handle: node.handle,
        price: selectedVariant.price, compare_price: selectedVariant.compare_price,
        image: selectedVariant.image || node.featuredImage?.url, variants, productMetafields
      };
    });

    return { products, pagination: { hasNextPage: productsData.pageInfo.hasNextPage, endCursor: productsData.pageInfo.endCursor, total: totalCount } };
  });

  // GET /api/variant-pricing
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

    return { variantId, sku: data.node.sku, selectedVariant: data.node.title, price: breakup.total, raw_breakup: breakup };
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
      query KeywordFilters($query: String!) {
        search(query: $query, first: 1, types: [PRODUCT]) {
          productFilters {
            label
            type
            values { label count input }
          }
        }
      }
    `;

    const COLLECTION_FILTERS_QUERY = `
      query CollectionFilters($handle: String!) {
        collectionByHandle(handle: $handle) {
          products(first: 1) {
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

      if (q) {
        storefrontData = await shopifyStorefrontFetch(SEARCH_FILTERS_QUERY, { query: q });
        rawFilters = storefrontData?.search?.productFilters || [];
      } else if (handle) {
        storefrontData = await shopifyStorefrontFetch(COLLECTION_FILTERS_QUERY, { handle });
        rawFilters = storefrontData?.collectionByHandle?.products?.filters || [];
      }

      const filters = {};
      rawFilters.forEach((f) => {
        if (f.type === "PRICE_RANGE") {
          // Special handling for price if needed
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
}

module.exports = routes;
