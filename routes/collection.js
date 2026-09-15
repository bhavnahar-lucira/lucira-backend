/**
 * Collection Routes (Fastify)
 */

const { shopifyStorefrontFetch, shopifyAdminFetch, shopifyAdminRestFetch } = require('../lib/shopify');
const { calculatePriceBreakup } = require('../lib/priceEngine');
const { getServerCache, stableCacheKey } = require('../lib/cache');
const { getCollectionVisibleStats } = require('../lib/visibleCounts');
const {
  STORE_COLLECTION_HANDLES,
  parseStoreHandles,
  getStoreProductIds,
  getCollectionIdOrder,
  orderIdsByStore,
} = require('../lib/storeAvailability');

const SORT_MAP = {
  manual: { sortKey: "MANUAL", reverse: false },
  best_selling: { sortKey: "BEST_SELLING", reverse: false },
  price_low_high: { sortKey: "PRICE", reverse: false },
  price_high_low: { sortKey: "PRICE", reverse: true },
  created_at_desc: { sortKey: "CREATED", reverse: true },
  created_at_asc: { sortKey: "CREATED", reverse: false },
  az: { sortKey: "TITLE", reverse: false },
};

/**
 * The product selection set, shared by the paginated collection query and the
 * fetch-these-exact-ids query used for store-proximity ordering.
 *
 * Extracted so the two can never drift: both paths must return an identically
 * shaped product to the same transform below, and duplicating forty lines of
 * selection set is the reliable way to end up with one of them missing a field.
 */
const PRODUCT_NODE_FIELDS = `
  id title handle productType description descriptionHtml createdAt tags featuredImage { url }
  productMetafields: metafields(identifiers: [
    {namespace: "ornaverse", key: "weight"},
    {namespace: "ornaverse", key: "quality"},
    {namespace: "ornaverse", key: "carat_range"},
    {namespace: "ornaverse", key: "lead_time"},
    {namespace: "ornaverse", key: "components"},
    {namespace: "ornaverse", key: "bestsellers"},
    {namespace: "custom", key: "matching_product"}
  ]) { key value }
  media(first: 20) {
    edges {
      node {
        mediaContentType
        ... on MediaImage { image { url altText } }
        ... on Video { sources { url mimeType } }
      }
    }
  }
  variants(first: 100) {
    edges {
      node {
        id title sku price { amount } compareAtPrice { amount }
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
`;

/** Fetch a specific, already-ordered page of products by id. */
const PRODUCTS_BY_IDS_QUERY = `
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { ${PRODUCT_NODE_FIELDS} }
    }
  }
`;

// How long a request will wait for store-proximity ordering before giving up and
// serving Shopify's own order. Tuned above a warm resolve (~single-digit ms) and
// below the point a shopper reads the grid as broken.
const STORE_ORDER_BUDGET_MS = Number(process.env.STORE_ORDER_BUDGET_MS) || 1500;

const collectionCountCache = new Map();
const SHOP_PRICING_CACHE_TTL = 24 * 60 * 60 * 1000;
const PRODUCT_DATA_CACHE_TTL = 24 * 60 * 60 * 1000;
const VARIANT_CONFIG_CACHE_TTL = 24 * 60 * 60 * 1000;

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
      { ttlMs: SHOP_PRICING_CACHE_TTL, maxEntries: 20 }
    );

  const getCollectionTotalCount = async (handle) => {
    const cacheKey = `collection-count:${handle}`;
    if (collectionCountCache.has(cacheKey)) {
      return collectionCountCache.get(cacheKey);
    }

    try {
      const collectionQuery = `query GetCollectionId($handle: String!) { collectionByHandle(handle: $handle) { id } }`;
      const collData = await shopifyAdminFetch(collectionQuery, { handle });
      const gid = collData?.collectionByHandle?.id;
      if (!gid) return 0;

      const collectionId = gid.split("/").pop();
      const countRes = await shopifyAdminRestFetch(`products/count.json`, {
        collection_id: collectionId,
        status: "active",
        published_status: "published"
      });

      const count = countRes?.data?.count ?? 0;
      collectionCountCache.set(cacheKey, count);
      setTimeout(() => collectionCountCache.delete(cacheKey), 24 * 60 * 60 * 1000);
      return count;
    } catch (e) {
      return 0;
    }
  };

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

  // GET /api/collection/metadata
  // MOVED TO TOP to avoid matching conflicts
  fastify.get('/metadata', async (request, reply) => {
    const { handle } = request.query;
    if (!handle) return reply.code(400).send({ error: 'handle required' });

    try {
      const db = fastify.mongo.db;
      const collection = await db.collection('collections').findOne({ handle });
      
      if (!collection) return { success: false };
      return { success: true, collection };
    } catch (err) {
      console.error("Metadata error:", err);
      return { success: false };
    }
  });

  // GET /api/collection
  fastify.get('/', async (request, reply) => {
    const { handle, sort = 'manual', cursor, limit = 25, filters, stores } = request.query;

    if (!handle) {
      return { products: [], filters: {}, pageInfo: {}, totalProducts: 0 };
    }

    const cacheKey = stableCacheKey(["api_collection", request.url]);

    return getServerCache(cacheKey, async () => {
      const activeFilters = parseFilters(filters);
      const sortConfig = SORT_MAP[sort] || SORT_MAP.manual;

      // Handle filter. prefixes in query string
      const shopifyFilters = [];
      Object.entries(request.query).forEach(([key, value]) => {
        if (key.startsWith("filter.")) {
          if (key === "filter.v.price.gte" || key === "filter.v.price.lte") {
            const existingPrice = shopifyFilters.find(f => f.price);
            if (existingPrice) {
              if (key === "filter.v.price.gte") existingPrice.price.min = parseFloat(value);
              else existingPrice.price.max = parseFloat(value);
            } else {
              shopifyFilters.push({ price: { 
                min: key === "filter.v.price.gte" ? parseFloat(value) : 0,
                max: key === "filter.v.price.lte" ? parseFloat(value) : 1000000 
              }});
            }
          } else {
            try {
              shopifyFilters.push(JSON.parse(value));
            } catch(e) {
              shopifyFilters.push({ [key.replace("filter.", "")]: value });
            }
          }
        }
      });

      const finalFilters = shopifyFilters.length > 0 ? shopifyFilters : activeFilters;

      let metalRates = {};
      let stonePricingDB = [];
      try {
        const pricingData = await getShopPricingData();
        metalRates = pricingData.metalRates;
        stonePricingDB = pricingData.stonePricingDB;
      } catch (e) {}

      const COLLECTION_QUERY = `
        query CollectionProducts(
          $handle: String!
          $first: Int!
          $after: String
          $sortKey: ProductCollectionSortKeys
          $reverse: Boolean
          $filters: [ProductFilter!]
        ) {
          collectionByHandle(handle: $handle) {
            title
            description
            descriptionHtml
            seo { title description }
            image { url altText }
            metafield_seocontent: metafield(namespace: "custom", key: "seocontent") { value }
            metafield_faqanswers: metafield(namespace: "custom", key: "FaqAnswers") { value }
            metafield_faqquestion: metafield(namespace: "custom", key: "FaqQuestion") { value }
            metafield_seo_content_data: metafield(namespace: "custom", key: "Seo_contentData") { value }
            metafield_bestsellers_html: metafield(namespace: "custom", key: "bestsellers_html") { value }
            metafield_bestseller_products: metafield(namespace: "custom", key: "bestseller_products") {
              references(first: 10) {
                edges {
                  node {
                    ... on Product {
                      id title handle featuredImage { url } priceRange { minVariantPrice { amount } }
                    }
                  }
                }
              }
            }
            products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, filters: $filters) {
              pageInfo { hasNextPage endCursor }
              filters { label type values { label count input } }
              edges {
                node { ${PRODUCT_NODE_FIELDS} }
              }
            }
          }
        }
      `;

      const ALL_PRODUCTS_QUERY = `
        query AllProducts($first: Int!, $after: String, $sortKey: ProductSortKeys, $reverse: Boolean, $query: String) {
          products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, query: $query) {
            pageInfo { hasNextPage endCursor }
            filters { label type values { label count input } }
            edges {
              node {
                id title handle productType description descriptionHtml createdAt tags featuredImage { url }
                productMetafields: metafields(identifiers: [
                  {namespace: "ornaverse", key: "weight"},
                  {namespace: "ornaverse", key: "quality"},
                  {namespace: "ornaverse", key: "carat_range"},
                  {namespace: "ornaverse", key: "lead_time"},
                  {namespace: "ornaverse", key: "components"},
                  {namespace: "ornaverse", key: "bestsellers"},
                  {namespace: "custom", key: "matching_product"}
                ]) { key value }
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
                      id title sku price { amount } compareAtPrice { amount }
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
      `;

      const pageSize = parseInt(limit) || 25;

      // ── Store-proximity ordering ────────────────────────────────────────────
      // Engages only when every one of these holds:
      //   • the shopper sent a resolved store ranking (`stores`, nearest first)
      //   • it is a real collection — "all" uses a different query with no
      //     collection to scan
      //   • the sort is the default. An explicit Price or Newest sort must win
      //     outright, otherwise prices look scrambled and the control reads as
      //     broken.
      //   • the collection is not itself a store page — those are already scoped
      //     to one store, so reordering them would be redundant.
      // Anything else falls through to the untouched original code path.
      const requestedStores = parseStoreHandles(stores);
      let useStoreOrder =
        requestedStores.length > 0 &&
        handle !== "all" &&
        sort === "manual" &&
        !STORE_COLLECTION_HANDLES.has(handle);

      // Resolved BEFORE the main product fetch on purpose. The reordered page is
      // fetched by id, so this call needs to know up front whether to ask Shopify
      // for a full page or just the collection's metadata — deciding afterwards
      // would leave a failed reorder serving a one-product page.
      let orderedIds = null;
      if (useStoreOrder) {
        try {
          const ordering = Promise.all([
            getCollectionIdOrder(handle, sortConfig, finalFilters),
            ...requestedStores.map((h) => getStoreProductIds(h)),
          ]);
          // Losing the race below must not surface as an unhandled rejection.
          ordering.catch(() => {});

          // Time budget. On a cold instance these are full catalogue scans, and
          // without a ceiling a slow Shopify makes the shopper wait for them with
          // nothing on screen. Past the budget we serve Shopify's own order —
          // which is what an un-pincoded shopper gets anyway, so nothing is
          // broken, just un-personalised.
          //
          // The scans are deliberately NOT cancelled: they keep running and land
          // in getServerCache, so the request that pays the latency is the only
          // one that does and the next request is fast.
          const TIMED_OUT = Symbol("store-order-timeout");
          let budgetTimer;
          const budget = new Promise((resolve) => {
            budgetTimer = setTimeout(() => resolve(TIMED_OUT), STORE_ORDER_BUDGET_MS);
          });

          const raced = await Promise.race([ordering, budget]);
          clearTimeout(budgetTimer);

          if (raced === TIMED_OUT) {
            console.warn(
              `Store ordering exceeded ${STORE_ORDER_BUDGET_MS}ms for "${handle}", serving default order (scan continues into cache)`
            );
            useStoreOrder = false;
          } else {
            const [order, ...storeSets] = raced;
            // A capped scan means the tail of the collection was never seen, so the
            // "no store stocks this" bucket would be wrong for those products.
            // Serving Shopify's own order beats serving a confidently wrong one.
            if (order.capped || !order.ids.length) useStoreOrder = false;
            else orderedIds = orderIdsByStore(order.ids, storeSets);
          }
        } catch (e) {
          console.error("Store ordering unavailable, serving default order:", e?.message);
          useStoreOrder = false;
        }
      }

      // In store-order mode the cursor is an offset into our own ordered list
      // rather than an opaque Shopify cursor. The frontend only ever echoes back
      // whatever endCursor it was handed, so this round-trips with no client change.
      const storeOffset = useStoreOrder ? Math.max(0, parseInt(cursor, 10) || 0) : 0;

      try {
        let storefrontData;
        if (handle === "all") {
          let filterQuery = "";
          if (finalFilters.length > 0) {
              finalFilters.forEach(f => {
                  if (f.productType) filterQuery += ` product_type:${f.productType}`;
                  if (f.tag) filterQuery += ` tag:${f.tag}`;
                  if (f.variantOption) filterQuery += ` variant_option:${f.variantOption.name}:${f.variantOption.value}`;
              });
          }

          let allSortKey = sortConfig.sortKey;
          if (allSortKey === "CREATED") allSortKey = "CREATED_AT";
          if (allSortKey === "MANUAL") allSortKey = "RELEVANCE";

          storefrontData = await shopifyStorefrontFetch(ALL_PRODUCTS_QUERY, {
            first: parseInt(limit),
            after: cursor || null,
            sortKey: allSortKey,
            reverse: sortConfig.reverse,
            query: filterQuery.trim() || null,
          });
        } else {
          storefrontData = await shopifyStorefrontFetch(COLLECTION_QUERY, {
            handle,
            // In store-order mode this request is only for the collection's own
            // metadata and its facet list — `filters` on the connection describes
            // the whole filtered set, not the page, which is why one product is
            // enough. The products for the page are fetched by id below, in the
            // reordered sequence.
            first: useStoreOrder ? 1 : pageSize,
            after: useStoreOrder ? null : (cursor || null),
            sortKey: sortConfig.sortKey,
            reverse: sortConfig.reverse,
            filters: finalFilters,
          });
        }

        const collectionData = storefrontData?.collectionByHandle;
        let productsData = handle === "all" ? storefrontData?.products : collectionData?.products;

        // Swap in the store-ordered page. Everything downstream — variant configs,
        // the product transform, facets, totals — runs on this exactly as it does
        // on a Shopify page, because the shape is identical.
        if (useStoreOrder && orderedIds && productsData) {
          const pageIds = orderedIds.slice(storeOffset, storeOffset + pageSize);
          let nodes = [];
          if (pageIds.length) {
            const byIds = await shopifyStorefrontFetch(PRODUCTS_BY_IDS_QUERY, { ids: pageIds });
            // nodes(ids:) answers in the order asked, and returns null for anything
            // unpublished since the scan — drop those rather than render a hole.
            nodes = (byIds?.nodes || []).filter(Boolean);
          }
          productsData = {
            ...productsData,
            edges: nodes.map((node) => ({ node })),
            pageInfo: {
              hasNextPage: storeOffset + pageSize < orderedIds.length,
              endCursor: String(storeOffset + pageSize),
            },
          };
        }

        if (!productsData) {
          return {
            collection: handle === "all" ? { title: "All Products", description: "All of our products" } : (collectionData || {}),
            products: [], filters: {}, pageInfo: {}, totalProducts: 0
          };
        }

        const variantGids = [];
        productsData.edges.forEach(({ node }) => {
          node.variants.edges.forEach(({ node: v }) => variantGids.push(v.id));
        });

        const variantConfigs = {};
        if (variantGids.length > 0) {
          const variantQuery = `query getVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id metafield(namespace: "DI-GoldPrice", key: "variant_config") { value } } } }`;
          const uniqueGids = [...new Set(variantGids)];
          const CHUNK_SIZE = 100;
          const chunkPromises = [];
          for (let i = 0; i < uniqueGids.length; i += CHUNK_SIZE) {
            const chunk = uniqueGids.slice(i, i + CHUNK_SIZE);
            chunkPromises.push(
              getServerCache(
                stableCacheKey(["collection-variant-configs", chunk]),
                () => shopifyAdminFetch(variantQuery, { ids: chunk }),
                { ttlMs: VARIANT_CONFIG_CACHE_TTL, maxEntries: 2000 }
              )
            );
          }
          const chunkResults = await Promise.all(chunkPromises);
          chunkResults.forEach((adminData) => {
            adminData?.nodes?.forEach(node => {
              if (node?.metafield?.value) variantConfigs[node.id] = node.metafield.value;
            });
          });
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
            const configValue = variantConfigs[v.id];
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
              id: (v.id || "").split("/").pop(),
              shopifyId: v.id, sku: v.sku,
              size: options.size || null,
              color: getOpt(["color", "metal", "metal color"]),
              carat: dynamic.carat ?? getOpt(["carat"]),
              clarity: dynamic.clarity ?? getOpt(["clarity"]),
              diamond_color: dynamic.color ?? getOpt(["diamond color"]),
              weight: dynamic.weight ?? getOpt(["weight"]),
              price: dynamicPrice || Number(v.price?.amount || 0),
              compare_price: dynamicComparePrice || (v.compareAtPrice ? Number(v.compareAtPrice.amount) : null),
              inStock: v.availableForSale === true && v.currentlyNotInStock === false,
              image: v.image?.url || null,
              altText: v.image?.altText || "",
              metafields: { metal_purity: configMetalPurity || getOpt(["purity"]), metal_color, metal_weight: dynamic.weight || v.metal_weight?.value },
              diamondDiscount, makingDiscount
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
            id: (node.id || "").split("/").pop(),
            shopifyId: node.id, title: node.title, handle: node.handle,
            type: node.productType,
            tags: node.tags || [],
            isNew: new Date(node.createdAt) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            createdAt: node.createdAt,
            images,
            media,
            price: selectedVariant.price, compare_price: selectedVariant.compare_price,
            image: selectedVariant.image || node.featuredImage?.url,
            variants, productMetafields
          };
        });

        const processedFilters = {};
        productsData.filters.forEach((f) => {
          if (f.type === "PRICE_RANGE") {
              processedFilters["Price"] = {
                  min: 0,
                  max: Math.max(...f.values.map(v => { try { return JSON.parse(v.input).price.max || 1000000; } catch(e) { return 1000000; } }))
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
            processedFilters[f.label] = values;
          }
        });

        // Filter products by dynamic price if price filter is present
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
          filteredProducts = products.filter(p => {
            return p.price >= min && p.price <= max;
          });
        }

        let totalProducts = 0;
        if (handle === "all") {
          totalProducts = await getCollectionTotalCount(handle);
        } else {
          // Count only VISIBLE products. Shopify's counts include `hidden`-tagged
          // products, which the storefront strips out — that mismatch is what made a
          // 34-product "Charms" category display "34 items" while showing just 1.
          // Cached via the existing cache util (24h + webhook-invalidated), so this
          // scan runs once and is reused. Falls back to the raw count on error or if
          // the scan was capped for a very large collection.
          try {
            const stats = await getCollectionVisibleStats(handle, finalFilters);
            totalProducts = stats.capped
              ? await getCollectionTotalCount(handle)
              : stats.total;
          } catch (e) {
            console.error("Error fetching collection visible count:", e);
            totalProducts = await getCollectionTotalCount(handle);
          }
        }

        // Adjust total count if we filtered out products and reached the end
        if (!productsData.pageInfo.hasNextPage && priceFilter) {
          totalProducts = filteredProducts.length;
        }

        // Sort products array dynamically if sorting by price is selected
        if (sort === "price_low_high") {
          filteredProducts.sort((a, b) => a.price - b.price);
        } else if (sort === "price_high_low") {
          filteredProducts.sort((a, b) => b.price - a.price);
        } else if (sort === "created_at_desc") {
          filteredProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } else if (sort === "created_at_asc") {
          filteredProducts.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        }

        return {
          collection: { 
            title: collectionData?.title, 
            description: collectionData?.description,
            descriptionHtml: collectionData?.descriptionHtml, 
            seo: collectionData?.seo, 
            image: collectionData?.image,
            metafields: {
              "custom.seocontent": collectionData?.metafield_seocontent?.value,
              "custom.faqanswers": collectionData?.metafield_faqanswers?.value,
              "custom.faqquestion": collectionData?.metafield_faqquestion?.value,
              "custom.seo_content_data": collectionData?.metafield_seo_content_data?.value,
              "custom.bestsellers_html": collectionData?.metafield_bestsellers_html?.value
            },
            bestsellerProducts: collectionData?.metafield_bestseller_products?.references?.edges?.map(e => ({
              id: (e.node.id || "").split("/").pop(),
              title: e.node.title,
              handle: e.node.handle,
              image: e.node.featuredImage?.url,
              price: Number(e.node.priceRange?.minVariantPrice?.amount || 0)
            })) || []
          },
          products: filteredProducts, filters: processedFilters, pageInfo: productsData.pageInfo, totalProducts
        };
      } catch (err) {
        console.error("Collection error:", err);
        return { products: [], filters: {}, pageInfo: {}, totalProducts: 0 };
      }
    }, { ttlMs: 10 * 60 * 1000 }); // Cache for 10 minutes
  });

  // GET /api/collection/filters
  fastify.get('/filters', async (request, reply) => {
    const { handle } = request.query;
    if (!handle) return { filters: {} };

    return getServerCache(`filters:${handle}`, async () => {
      const query = `query CollectionFilters($handle: String!) { collectionByHandle(handle: $handle) { products(first: 1) { filters { id label type values { id label count input } } } } }`;
      const data = await shopifyStorefrontFetch(query, { handle });
      const rawFilters = data?.collectionByHandle?.products?.filters || [];
      const filters = {};
      rawFilters.forEach((f) => {
        if (f.type === "PRICE_RANGE") return;
        const values = f.values.filter((v) => v.count > 0).map((v) => {
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
        if (values.length) filters[f.label || f.id] = values;
      });
      return { filters };
    }, { ttlMs: 10 * 60 * 1000 });
  });
}

module.exports = routes;
