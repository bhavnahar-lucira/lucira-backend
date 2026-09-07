/**
 * "From the Same Collection" Recommendation Engine — v2 (Tagalys-model)
 *
 * Replaces the retired Shopify Flow that maintained custom.matching_product.
 * Rules (Mongo `reco_rules`, managed from lucira-admin) describe:
 *
 *   source    - which products RECEIVE recommendations: a collection and/or an
 *               AND-list of attribute conditions ("Setup source products").
 *   sequences - ordered candidate slots ("Create recommendations"): each has a
 *               size, an AND-list of conditions (static values or dynamic
 *               "Matches source"), a candidate pool (same collection or whole
 *               store), and a sort.
 *   pins      - hand-picked products: global (shown for every source product
 *               in scope) and per-product overrides. Pins occupy the first
 *               slots, always.
 *   automatedEnabled - false = hand-picked only (pins, nothing else);
 *               true with pins = hybrid; true without pins = fully automated.
 *
 * v1 rules (blocks/attributePriority) still work: normalizeRule() converts
 * them on the fly with semantics-preserving mappings, so the live
 * cotton-candy rule computes identically without a migration.
 *
 * Behavioral metrics come from lib/recoSignals.js — GA4 when configured (the
 * store is HEADLESS: Shopify web analytics is blind to the storefront), else
 * the first-party beacon + cart timestamps; money always from Shopify.
 *
 * Output per product: up to 16 GIDs written to the PRODUCT metafield
 * custom.from_the_same_collection_headless (list.product_reference,
 * validation list.max=16 — writes of more than 16 FAIL, capped here).
 *
 * Exports:
 *   computeForRule(fastify, rule, options)   - pure compute, no writes
 *   previewForRule(fastify, rule, opts)      - dry run, preview shape
 *   previewScope(fastify, source)            - source-conditions scope preview
 *   runRule(fastify, rule, trigger, opts)    - run: bookkeeping + writes
 *   getPopularityMaps(fastify)               - shared social-proof maps
 *   normalizeRule(rule)                      - v1 -> v2 view
 *   ATTRIBUTES / SORT_KEYS / OPS_BY_KIND     - registry (served to the admin)
 *   runningRules                             - in-process Set behind run 409s
 */

const { shopifyAdminFetch } = require('./shopify');
const { getServerCache, stableCacheKey } = require('./cache');
const { getMetricMaps } = require('./recoSignals');

const METAFIELD_NAMESPACE = 'custom';
const METAFIELD_KEY = 'from_the_same_collection_headless';
const METAFIELD_TYPE = 'list.product_reference';

const MAX_RECOMMENDATIONS = 16;       // metafield validation list.max=16 — never write more
const WRITE_BATCH_SIZE = 25;          // metafieldsSet accepts up to 25 metafields per call
const MAX_RUN_ERRORS = 20;            // errors kept on a reco_runs doc

// Admin GraphQL cost model. The old estimate here (~11 points per product
// node, a 1,000-point ceiling) was wrong on both counts; these are measured
// against the live shop:
//
//   first: 80  -> 114 points  = 1.425 pts/product
//   first: 250 -> 156 points  = 0.624 pts/product
//
// Cost is dominated by a large FIXED per-request overhead, so bigger pages are
// strictly cheaper — going 80 -> 250 cuts points 56% AND requests 68% (34
// pages -> 11 for ~2.7k active products). 250 is Shopify's per-connection cap
// and this shop's bucket is 4,000 points, so a page uses under 4% of it.
// Pacing is the governor's job now (lib/shopifyGovernor.js), not the page size.
const SCAN_PAGE_SIZE = 250;
const SCAN_MAX_PAGES = 40;            // ~10k product cap per scan (was 100 pages of 80)
const SCAN_TTL_MS = 10 * 60 * 1000;   // preview and run share scans for 10 minutes

// Baseline hygiene: junk that must never be recommended or receive
// recommendations — internal test/customer-order/insurance items.
const JUNK_TITLE_RE = /(test[\s-]?order|customer[\s-]?order|insurance)/i;

// In-process guard behind POST /rules/:id/run's 409 (and the scheduler's own
// skip). Keys are String(rule._id). Cross-worker overlap is guarded separately
// by the reco_runs status:"running" check and the scheduler's Mongo lease.
const runningRules = new Set();

// Reduce any id form (numeric, "gid://shopify/Product/123") to its trailing
// numeric id — same normalization as routes/products.js social-proof.
const normalizeId = (id) => {
  const m = String(id || '').match(/\d+/g);
  return m ? m[m.length - 1] : '';
};

// ---------------------------------------------------------------------------
// Popularity signal (all-time orders*3 + carts + wishlists)
//
// Real Mongo counts, copied from routes/products.js social-proof. The
// getServerCache keys are THE SAME ones products.js uses so the two features
// share one cached computation.
// ---------------------------------------------------------------------------

// Social-proof counts must reflect the REAL store DB (where interactions
// accumulate). In production the primary Mongo connection already targets it;
// in local dev the primary connection points at a near-empty local DB, so we
// lazily read the real store via MONGODB_URI (mirrors routes/products.js).
let _popularityDbPromise = null;
// When the store DB is unreachable, REMEMBER that for a while. The previous
// version nulled the promise inside the catch, so every later call paid the
// full connect timeout again — a fixed ~8s on every preview, scope count and
// run, forever, on any machine that cannot reach the store cluster. One
// timeout per retry window is enough to notice it is down.
let _popularityDbFailedAt = 0;
const POPULARITY_DB_RETRY_MS = 5 * 60 * 1000;
// Short: this is an optional enrichment on a fallback path, so failing fast and
// degrading is better than making a person wait.
const POPULARITY_DB_CONNECT_MS = 3000;

async function getPopularityDb(fastify) {
  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev || !process.env.MONGODB_URI) return fastify.mongo.db;
  // When the primary connection already points at the store DB (LOCAL_MONGODB_URI
  // unset or equal to MONGODB_URI) a second client would just be a duplicate pool.
  if ((process.env.LOCAL_MONGODB_URI || process.env.MONGODB_URI) === process.env.MONGODB_URI) return fastify.mongo.db;

  // Still inside the back-off window from a previous failure.
  if (!_popularityDbPromise && (Date.now() - _popularityDbFailedAt) < POPULARITY_DB_RETRY_MS) {
    return fastify.mongo.db;
  }

  try {
    if (!_popularityDbPromise) {
      const { MongoClient } = require('mongodb');
      _popularityDbPromise = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: POPULARITY_DB_CONNECT_MS })
        .connect()
        .then((client) => client.db());
    }
    return await _popularityDbPromise;
  } catch (err) {
    _popularityDbFailedAt = Date.now();
    _popularityDbPromise = null;
    console.warn(`[Reco] Store DB unreachable for popularity (${err.message}). ` +
      `Using the primary connection; popularity will read low. ` +
      `Not retrying for ${POPULARITY_DB_RETRY_MS / 60000} min.`);
    return fastify.mongo.db;
  }
}

async function getPopularityMaps(fastify) {
  const db = await getPopularityDb(fastify);

  const foldRows = (rows) => {
    const map = {};
    for (const r of rows) {
      const nid = normalizeId(r._id);
      if (nid) map[nid] = (map[nid] || 0) + r.c;
    }
    return map;
  };

  // Count DISTINCT documents (carts / wishlists) containing each product.
  const buildDistinctDocCountMap = async (collectionName) => {
    const rows = await db.collection(collectionName).aggregate([
      { $unwind: "$items" },
      { $match: { "items.productId": { $ne: null } } },
      { $group: { _id: { doc: "$_id", pid: "$items.productId" } } },
      { $group: { _id: "$_id.pid", c: { $sum: 1 } } }
    ], { allowDiskUse: true }).toArray();
    return foldRows(rows);
  };

  const buildOrderCountMap = async () => {
    const rows = await db.collection('orders').aggregate([
      { $match: { status: { $in: ["success", "SUCCESS", "PAID", "paid"] } } },
      { $unwind: "$shopifyPayload.line_items" },
      { $match: { "shopifyPayload.line_items.product_id": { $ne: null } } },
      { $group: { _id: { order: "$_id", pid: "$shopifyPayload.line_items.product_id" } } },
      { $group: { _id: "$_id.pid", c: { $sum: 1 } } }
    ], { allowDiskUse: true }).toArray();
    return foldRows(rows);
  };

  const [orderMap, cartMap, wishlistMap] = await Promise.all([
    getServerCache("social-proof:orders", buildOrderCountMap, { ttlMs: 30 * 60 * 1000 }),
    getServerCache("social-proof:cart", () => buildDistinctDocCountMap('abandoned_carts'), { ttlMs: 15 * 60 * 1000 }),
    getServerCache("social-proof:wishlist", () => buildDistinctDocCountMap('wishlists'), { ttlMs: 15 * 60 * 1000 }),
  ]);

  return { orderMap, cartMap, wishlistMap };
}

const popularityCountFor = (maps, gid) => {
  const nid = normalizeId(gid);
  if (!nid) return 0;
  return (maps.orderMap[nid] || 0) * 3 + (maps.cartMap[nid] || 0) + (maps.wishlistMap[nid] || 0);
};

// ---------------------------------------------------------------------------
// Product scans (Admin GraphQL, paginated, cached)
// ---------------------------------------------------------------------------

const PRODUCT_NODE_FIELDS = `
  id
  title
  handle
  status
  vendor
  productType
  tags
  createdAt
  totalInventory
  tracksInventory
  onlineStoreUrl
  featuredImage { url }
  priceRangeV2 { minVariantPrice { amount } }
  compareAtPriceRange { minVariantCompareAtPrice { amount } }
  variants(first: 5) { nodes { availableForSale } }
  stoneType: metafield(namespace: "custom", key: "stone_type") { value }
  shopForCustom: metafield(namespace: "custom", key: "shop_for") { value }
  shopForOrna: metafield(namespace: "ornaverse", key: "shop_for") { value }
  caratRange: metafield(namespace: "custom", key: "carat_range") { value }
  current: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") { value }
`;

const COLLECTION_SCAN_QUERY = `
  query recoCollectionScan($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PRODUCT_NODE_FIELDS} }
      }
    }
  }
`;

const CATALOG_SCAN_QUERY = `
  query recoCatalogScan($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_NODE_FIELDS} }
    }
  }
`;

const mapNode = (node) => {
  const price = parseFloat(node.priceRangeV2?.minVariantPrice?.amount) || 0;
  const compareAt = parseFloat(node.compareAtPriceRange?.minVariantCompareAtPrice?.amount) || 0;
  let caratRange = node.caratRange?.value || null;
  // carat_range is list-typed JSON like '["0.25-0.49"]' — flatten for matching.
  if (caratRange && caratRange.trim().startsWith('[')) {
    try { caratRange = (JSON.parse(caratRange) || []).join(', ') || null; } catch (_) { /* keep raw */ }
  }
  return {
    id: node.id,
    title: node.title || '',
    handle: node.handle || '',
    status: node.status,
    vendor: node.vendor || '',
    productType: node.productType || '',
    tags: Array.isArray(node.tags) ? node.tags : [],
    createdAt: node.createdAt ? new Date(node.createdAt).getTime() : 0,
    totalInventory: Number(node.totalInventory) || 0,
    tracksInventory: node.tracksInventory !== false,
    // "Live on the storefront?" — deliberately NOT publishedOnCurrentPublication.
    // That field means "published to the publication of the app making this
    // request", which is app-relative and had been silently excluding whole
    // collections of live products (verified: every product in "Gold Earrings
    // for Kids" is ACTIVE, published to Online Store and reachable by URL, yet
    // returned false). onlineStoreUrl is non-null only for genuinely live
    // products and null for UNLISTED junk like the "Test order" SKUs — and it
    // needs no read_product_listings scope.
    published: Boolean(node.onlineStoreUrl),
    // Buyable, NOT "has stock": made-to-order catalogue — most variants sit at
    // inventoryQuantity 0 with inventoryPolicy CONTINUE and availableForSale
    // true. Gating on totalInventory alone would wrongly exclude products a
    // shopper can buy right now.
    buyable: (node.variants?.nodes || []).some((v) => v.availableForSale === true)
      || Number(node.totalInventory) > 0
      || node.tracksInventory === false,
    image: node.featuredImage?.url || null,
    price,
    compareAtPrice: compareAt,
    discountAmount: compareAt > price ? compareAt - price : 0,
    discountPercent: compareAt > price ? ((compareAt - price) / compareAt) * 100 : 0,
    stoneType: node.stoneType?.value || null,
    shopFor: node.shopForCustom?.value || node.shopForOrna?.value || null,
    caratRange,
    currentValue: node.current?.value || null
  };
};

async function pagedScan(query, baseVars, unwrap, label) {
  const products = [];
  let after = null;
  let pages = 0;
  do {
    const data = await shopifyAdminFetch(
      query,
      { ...baseVars, first: SCAN_PAGE_SIZE, after },
      { priority: 'background' }
    );
    const page = unwrap(data);
    if (!page) break;
    for (const node of page.nodes || []) {
      if (node?.id) products.push(mapNode(node));
    }
    pages += 1;
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    if (after && pages >= SCAN_MAX_PAGES) after = null;
  } while (after);
  console.log(`[Reco] ${label}: ${products.length} products (${pages} pages)`);
  return products;
}

async function scanCollection(collectionId) {
  return getServerCache(
    stableCacheKey(['reco-collection-scan', collectionId]),
    () => pagedScan(COLLECTION_SCAN_QUERY, { id: collectionId }, (d) => d?.collection?.products, `Scanned collection ${collectionId}`),
    { ttlMs: SCAN_TTL_MS }
  );
}

let _lastCatalogScan = null; // powers metafield dropdown options, never awaited

async function scanCatalog() {
  const products = await getServerCache(
    stableCacheKey(['reco-catalog-scan']),
    () => pagedScan(CATALOG_SCAN_QUERY, {}, (d) => d?.products, 'Scanned catalog'),
    { ttlMs: SCAN_TTL_MS }
  );
  _lastCatalogScan = products;
  return products;
}

// ---------------------------------------------------------------------------
// Dropdown options for the rule editor
//
// Typing "earrings" by hand is how a rule silently matches nothing (a real
// case here: a tag typed "bestselllers" matched 0 of 79 products). So the
// editor offers the REAL values instead of a free-text box.
//
// product type and vendor come straight from Shopify in one cheap query.
// The metafield-backed ones (stone type, audience, carat) have no such query,
// so they are derived from the last completed catalogue scan — and simply
// omitted until one exists, leaving those fields as free text rather than
// blocking this endpoint behind a full scan.
// ---------------------------------------------------------------------------
const SHOP_FACETS_QUERY = `
  query recoShopFacets {
    shop {
      productTypes(first: 100) { edges { node } }
      productVendors(first: 100) { edges { node } }
    }
  }
`;

// App-generated and internal entries that must never be offered as a choice.
const JUNK_FACET_RE = /shopstorm_hidden|sam_protect/i;
const NOT_A_VALUE = new Set(["#n/a", "n/a", "na", "none", "null"]);

const cleanFacet = (values) => [...new Set(
  (values || []).map((v) => String(v || '').trim())
    .filter((v) => v && !JUNK_FACET_RE.test(v) && !NOT_A_VALUE.has(v.toLowerCase()))
)].sort((a, b) => a.localeCompare(b));

async function getAttributeOptions() {
  // Only the Shopify round-trip is cached. The metafield facets are recomputed
  // from the in-memory scan on every call (a map over ~2.7k items, negligible)
  // so they start appearing the moment a scan completes, instead of being
  // frozen out for the life of a cache entry.
  const shopFacets = await getServerCache('reco:shop-facets', async () => {
    try {
      const data = await shopifyAdminFetch(SHOP_FACETS_QUERY, {});
      const pluck = (conn) => (conn?.edges || []).map((e) => e.node);
      return {
        product_type: cleanFacet(pluck(data?.shop?.productTypes)),
        vendor: cleanFacet(pluck(data?.shop?.productVendors))
      };
    } catch (err) {
      console.error('[Reco] Could not load product type/vendor options:', err.message);
      return {};
    }
  }, { ttlMs: 60 * 60 * 1000 });

  const options = { ...shopFacets };
  if (_lastCatalogScan) {
    options.stone_type = cleanFacet(_lastCatalogScan.map((x) => x.stoneType));
    options.shop_for = cleanFacet(_lastCatalogScan.map((x) => x.shopFor));
    options.carat_range = cleanFacet(_lastCatalogScan.map((x) => x.caratRange));
  } else {
    // Nothing has scanned the catalogue yet (fresh boot). Without this, the
    // metafield-backed conditions — audience, stone type, carat — silently fall
    // back to FREE TEXT boxes in the rule editor, which is exactly the typo
    // hazard the dropdowns exist to remove (a tag typed "bestselllers" matched
    // 0 of 79 products). Warm it in the background so the options appear within
    // a minute instead of only once someone happens to trigger a scan.
    // getServerCache dedupes on the in-flight promise, so concurrent callers
    // share one scan rather than starting several.
    scanCatalog().catch((err) =>
      console.warn('[Reco] Background catalogue warm-up for condition options failed:', err.message));
  }
  for (const k of Object.keys(options)) if (!options[k] || !options[k].length) delete options[k];
  return options;
}

// BASELINE HYGIENE (always, before pins, sequences, or backfill).
const passesHygiene = (p) => {
  if (p.status !== 'ACTIVE') return false;
  if (p.published === false) return false;
  if (JUNK_TITLE_RE.test(p.title)) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Attribute registry — one definition serves the condition evaluator, the
// sort engine, validation, and (via GET /attributes) the admin UI dropdowns.
//
// kind: 'number' | 'string' | 'boolean' | 'tags' | 'collection'
// matchable: usable with op "matches_source".
// metric: [group, window] reads lib/recoSignals.js maps by numeric id.
// ---------------------------------------------------------------------------

const ATTRIBUTES = {
  // Product details
  price:            { label: 'Price', group: 'Product details', kind: 'number', matchable: true, get: (p) => p.price },
  compare_at_price: { label: 'Compare-at price', group: 'Product details', kind: 'number', matchable: true, get: (p) => p.compareAtPrice },
  discount_percent: { label: 'Discount percentage', group: 'Product details', kind: 'number', matchable: true, get: (p) => p.discountPercent },
  discount_amount:  { label: 'Discount amount', group: 'Product details', kind: 'number', matchable: true, get: (p) => p.discountAmount },
  product_title:    { label: 'Product title', group: 'Product details', kind: 'string', matchable: false, get: (p) => p.title },
  product_type:     { label: 'Product type', group: 'Product details', kind: 'string', matchable: true, get: (p) => p.productType },
  vendor:           { label: 'Vendor', group: 'Product details', kind: 'string', matchable: true, get: (p) => p.vendor },
  tag:              { label: 'Tag', group: 'Product details', kind: 'tags', matchable: false, get: (p) => p.tags },
  stone_type:       { label: 'Diamond / stone type', group: 'Product details', kind: 'string', matchable: true, get: (p) => p.stoneType },
  shop_for:         { label: 'Shop for (audience)', group: 'Product details', kind: 'string', matchable: true, get: (p) => p.shopFor },
  carat_range:      { label: 'Carat range', group: 'Product details', kind: 'string', matchable: true, get: (p) => p.caratRange },
  created_days_ago: { label: 'Days since created', group: 'Product details', kind: 'number', matchable: false, get: (p) => p.createdAt ? (Date.now() - p.createdAt) / 86400000 : 9999 },
  in_collection:    { label: 'In collection', group: 'Product details', kind: 'collection', matchable: false, get: null },

  // Inventory
  buyable:          { label: 'Available to buy', group: 'Inventory', kind: 'boolean', matchable: false, get: (p) => p.buyable },
  inventory_total:  { label: 'Inventory - total units', group: 'Inventory', kind: 'number', matchable: false, get: (p) => p.totalInventory },

  // Performance — 3D / 7D / 30D windows
  views_3d:    { label: 'Product views (last 3 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['views', 'd3'] },
  views_7d:    { label: 'Product views (last 7 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['views', 'd7'] },
  views_30d:   { label: 'Product views (last 30 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['views', 'd30'] },
  atc_3d:      { label: 'Add to carts (last 3 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['atc', 'd3'] },
  atc_7d:      { label: 'Add to carts (last 7 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['atc', 'd7'] },
  atc_30d:     { label: 'Add to carts (last 30 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['atc', 'd30'] },
  orders_3d:   { label: 'Orders (last 3 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['orders', 'd3'] },
  orders_7d:   { label: 'Orders (last 7 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['orders', 'd7'] },
  orders_30d:  { label: 'Orders (last 30 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['orders', 'd30'] },
  revenue_3d:  { label: 'Revenue (last 3 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['revenue', 'd3'] },
  revenue_7d:  { label: 'Revenue (last 7 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['revenue', 'd7'] },
  revenue_30d: { label: 'Revenue (last 30 days)', group: 'Performance', kind: 'number', matchable: false, metric: ['revenue', 'd30'] },
  // Add-to-cart rate = add_to_cart events / view_item events, as a percentage.
  // The single best "does this product convert interest into intent" signal —
  // it is volume-independent, so a quiet niche piece can out-rank a bestseller.
  atc_rate_3d:  { label: 'Add to cart rate % (last 3 days)', group: 'Performance', kind: 'number', matchable: false, ratio: ['atc', 'views', 'd3'] },
  atc_rate_7d:  { label: 'Add to cart rate % (last 7 days)', group: 'Performance', kind: 'number', matchable: false, ratio: ['atc', 'views', 'd7'] },
  atc_rate_30d: { label: 'Add to cart rate % (last 30 days)', group: 'Performance', kind: 'number', matchable: false, ratio: ['atc', 'views', 'd30'] },
  view_to_cart_30d: { label: 'View to cart rate % (last 30 days)', group: 'Performance', kind: 'number', matchable: false, derived: true },
  popularity:  { label: 'Popularity (all-time orders + carts + wishlist)', group: 'Performance', kind: 'number', matchable: false, popularity: true }
};

// Sort options offered to the rule editor.
//
// `directional: true` means both ends are meaningful, so the editor shows a
// High to low / Low to high switch. That is the whole point of sorting on a
// metric: it ranks the pool without anyone having to invent a threshold
// number. A sequence with a sort and NO conditions is simply "top N by this".
//
// Any numeric attribute key is a valid sort key — buildComparator falls back to
// attrValue() — so adding an attribute to ATTRIBUTES makes it sortable by
// listing it here.
const SORT_KEYS = {
  // Relative to the product being viewed — only one direction makes sense.
  score:            { label: 'Best match (weighted score)' },
  price_proximity:  { label: 'Closest price to source' },
  newest:           { label: 'Newest first' },

  // Price (kept as explicit pairs: they predate the direction switch and
  // existing saved rules still reference them).
  price_asc:        { label: 'Price low to high' },
  price_desc:       { label: 'Price high to low' },

  // Everything below ranks on a number, so both directions are offered.
  popularity:       { label: 'Popularity (all-time)', directional: true },
  views_3d:         { label: 'Product views (3 days)', directional: true },
  views_7d:         { label: 'Product views (7 days)', directional: true },
  views_30d:        { label: 'Product views (30 days)', directional: true },
  atc_3d:           { label: 'Add to carts (3 days)', directional: true },
  atc_7d:           { label: 'Add to carts (7 days)', directional: true },
  atc_30d:          { label: 'Add to carts (30 days)', directional: true },
  atc_rate_3d:      { label: 'Add to cart rate (3 days)', directional: true },
  atc_rate_7d:      { label: 'Add to cart rate (7 days)', directional: true },
  atc_rate_30d:     { label: 'Add to cart rate (30 days)', directional: true },
  orders_3d:        { label: 'Orders (3 days)', directional: true },
  orders_7d:        { label: 'Orders (7 days)', directional: true },
  orders_30d:       { label: 'Orders (30 days)', directional: true },
  revenue_3d:       { label: 'Revenue (3 days)', directional: true },
  revenue_7d:       { label: 'Revenue (7 days)', directional: true },
  revenue_30d:      { label: 'Revenue (30 days)', directional: true },
  view_to_cart_30d: { label: 'View to cart rate (30 days)', directional: true },
  discount_percent: { label: 'Discount %', directional: true },
  discount_amount:  { label: 'Discount amount', directional: true },
  inventory_total:  { label: 'Inventory units', directional: true },
  price:            { label: 'Price', directional: true }
};

const OPS_BY_KIND = {
  // has_any / above_average / below_average take NO value: they answer
  // "is there any" and "is this better than typical" without anyone having to
  // invent a threshold. above/below average is measured against the candidate
  // pool of that sequence, so it retunes itself as the catalogue changes.
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'has_any', 'above_average', 'below_average', 'within_percent', 'within_amount'],
  string: ['eq', 'neq', 'contains', 'not_contains'],
  tags: ['contains', 'not_contains'],
  boolean: ['eq'],
  collection: ['in', 'not_in']
};

// Resolve an attribute's value for a product within a compute context.
function attrValue(key, product, ctx) {
  const def = ATTRIBUTES[key];
  if (!def) return null;
  const pid = normalizeId(product.id);
  if (def.metric) {
    const [groupKey, win] = def.metric;
    return ctx.metrics ? (ctx.metrics[groupKey][win].get(pid) || 0) : 0;
  }
  if (def.popularity) return ctx.popCache.get(product.id) ?? 0;
  if (def.ratio) {
    // e.g. atc_rate_30d = atc.d30 / views.d30 * 100. A product with no views
    // has no rate — return 0 rather than dividing by zero, so "rate > 5"
    // never matches a product nobody has seen.
    const [numGroup, denGroup, win] = def.ratio;
    if (!ctx.metrics) return 0;
    const num = ctx.metrics[numGroup][win].get(pid) || 0;
    const den = ctx.metrics[denGroup][win].get(pid) || 0;
    return den > 0 ? (num / den) * 100 : 0;
  }
  if (def.derived && key === 'view_to_cart_30d') {
    const v = ctx.metrics ? (ctx.metrics.views.d30.get(pid) || 0) : 0;
    const a = ctx.metrics ? (ctx.metrics.atc.d30.get(pid) || 0) : 0;
    return v > 0 ? (a / v) * 100 : 0;
  }
  return def.get ? def.get(product) : null;
}

const normStr = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Mean of an attribute across the pool a sequence is drawing from, so
// "above average" means above average FOR THAT POOL (the collection, or the
// whole store) rather than some global constant. Cached per pool+attribute;
// ctx.currentPool is set by the caller before each sequence is evaluated.
function poolAverage(ctx, attrKey) {
  const pool = ctx.currentPool || ctx.collectionPool || [];
  const cacheKey = (pool === ctx.catalogPool ? 'catalog:' : 'collection:') + attrKey;
  if (ctx.avgCache.has(cacheKey)) return ctx.avgCache.get(cacheKey);
  let sum = 0;
  for (const p of pool) sum += Number(attrValue(attrKey, p, ctx)) || 0;
  const avg = pool.length ? sum / pool.length : 0;
  ctx.avgCache.set(cacheKey, avg);
  return avg;
}

// Evaluate one condition for a candidate. `source` is null for source-scope
// conditions, where matches_source / within_* are invalid (validation rejects
// them; the evaluator degrades safely anyway).
function evalCondition(cand, source, cond, ctx) {
  const def = ATTRIBUTES[cond.attr];
  if (!def) return true; // unknown attr: never brick a run over a stale rule

  if (cond.op === 'matches_source') {
    if (!source) return false;
    const a = attrValue(cond.attr, cand, ctx);
    const b = attrValue(cond.attr, source, ctx);
    if (def.kind === 'number') return Number(a) === Number(b);
    if (a == null || b == null || a === '' || b === '') return false;
    return normStr(a) === normStr(b);
  }

  if (cond.op === 'within_percent' || cond.op === 'within_amount') {
    // Dynamic band around the source's value (price family).
    if (!source) return true;
    const a = Number(attrValue(cond.attr, cand, ctx)) || 0;
    const b = Number(attrValue(cond.attr, source, ctx)) || 0;
    const band = cond.op === 'within_percent' ? (Number(cond.value) / 100) * b : Number(cond.value);
    return Math.abs(a - b) <= band;
  }

  if (def.kind === 'collection') {
    const set = ctx.collectionSets.get(String(cond.value));
    const inIt = set ? set.has(cand.id) : false;
    return cond.op === 'not_in' ? !inIt : inIt;
  }

  const val = attrValue(cond.attr, cand, ctx);

  if (def.kind === 'tags') {
    const want = normStr(cond.value);
    const has = (val || []).some((t) => normStr(t) === want);
    return cond.op === 'not_contains' ? !has : has;
  }

  if (def.kind === 'boolean') {
    return Boolean(val) === (cond.value === true || cond.value === 'true');
  }

  if (def.kind === 'number') {
    const a = Number(val) || 0;
    if (cond.op === 'has_any') return a > 0;
    if (cond.op === 'above_average' || cond.op === 'below_average') {
      const avg = poolAverage(ctx, cond.attr);
      return cond.op === 'above_average' ? a > avg : a < avg;
    }
    const b = Number(cond.value) || 0;
    switch (cond.op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'gt': return a > b;
      case 'gte': return a >= b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      default: return true;
    }
  }

  // strings
  const a = normStr(val);
  const b = normStr(cond.value);
  switch (cond.op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'contains': return a.includes(b);
    case 'not_contains': return !a.includes(b);
    default: return true;
  }
}

const evalConditions = (cand, source, conditions, ctx) =>
  (conditions || []).every((c) => evalCondition(cand, source, c, ctx));

// ---------------------------------------------------------------------------
// v1 -> v2 normalization (semantics-preserving: the live cotton-candy rule
// keeps computing identically without a migration)
// ---------------------------------------------------------------------------
function normalizeRule(rule) {
  if (rule.version === 2) {
    return {
      source: {
        collectionId: rule.source?.collectionId || rule.collectionId || null,
        // An explicit list of source products. When present the rule covers
        // exactly these products, whatever collection they sit in — the third
        // scope alongside "one collection" and "the whole store".
        productIds: rule.source?.productIds || [],
        conditions: rule.source?.conditions || []
      },
      sequences: (rule.sequences || []).map((s) => ({
        size: Number(s.size) || 0,
        label: s.label || '',
        pool: s.pool === 'catalog' ? 'catalog' : 'collection',
        conditions: s.conditions || [],
        sortBy: (Array.isArray(s.sortBy) && s.sortBy.length) ? s.sortBy : [{ key: 'score', dir: 'desc' }]
      })),
      commonConditions: rule.commonConditions || [],
      pins: {
        global: rule.pins?.global || [],
        perProduct: rule.pins?.perProduct || {}
      },
      automatedEnabled: rule.automatedEnabled !== false,
      attributePriority: rule.attributePriority || ['price', 'collection', 'inventory', 'popularity', 'diamond_type'],
      backfill: rule.backfill !== false
    };
  }

  // v1: blocks + attributePriority
  const sequences = (rule.blocks || []).map((block) => {
    const c = block.conditions || {};
    const conditions = [];
    if (c.priceBandPercent != null) conditions.push({ attr: 'price', op: 'within_percent', value: Number(c.priceBandPercent) });
    if (c.inStock) conditions.push({ attr: 'buyable', op: 'eq', value: true });
    if (c.diamondTypeMatch) conditions.push({ attr: 'stone_type', op: 'matches_source' });
    return {
      size: Number(block.size) || 0,
      label: block.label || '',
      pool: 'collection', // v1 was always same-collection
      conditions,
      sortBy: c.popularity ? [{ key: 'popularity', dir: 'desc' }] : [{ key: 'score', dir: 'desc' }]
    };
  });

  return {
    source: { collectionId: rule.collectionId || null, productIds: [], conditions: [] },
    sequences,
    commonConditions: [],
    pins: { global: [], perProduct: {} },
    automatedEnabled: true,
    attributePriority: rule.attributePriority || ['price', 'collection', 'inventory', 'popularity', 'diamond_type'],
    backfill: rule.backfill !== false
  };
}

// ---------------------------------------------------------------------------
// v1 weighted score — kept as the default "Best match" sort
// ---------------------------------------------------------------------------
const buildWeights = (attributePriority) => {
  const list = Array.isArray(attributePriority) ? attributePriority : [];
  const weights = {};
  list.forEach((attr, idx) => { weights[attr] = list.length - idx; });
  return weights;
};

const weightedScore = (source, cand, weights, ctx) => {
  let score = 0;
  if (weights.price) {
    const sp = source.price;
    const priceScore = sp > 0
      ? 1 - Math.min(1, Math.abs(cand.price - sp) / sp)
      : (cand.price === sp ? 1 : 0);
    score += weights.price * priceScore;
  }
  if (weights.collection) score += weights.collection;
  if (weights.inventory && cand.buyable) score += weights.inventory;
  if (weights.popularity && ctx.maxPop > 0) {
    score += weights.popularity * ((ctx.popCache.get(cand.id) || 0) / ctx.maxPop);
  }
  if (weights.diamond_type && cand.stoneType && source.stoneType && cand.stoneType === source.stoneType) {
    score += weights.diamond_type;
  }
  return score;
};

// Comparator chain for a sequence's sortBy list; ties fall through the chain,
// then to weighted score, then newest-first.
function buildComparator(sortBy, source, scores, ctx) {
  const keyValue = (key, p) => {
    switch (key) {
      case 'score': return scores.get(p.id) || 0;
      case 'popularity': return ctx.popCache.get(p.id) || 0;
      case 'price_proximity': return source ? -Math.abs(p.price - source.price) : 0; // higher = closer
      case 'newest': return p.createdAt;
      case 'price_asc': return -p.price;
      case 'price_desc': return p.price;
      default: return Number(attrValue(key, p, ctx)) || 0;
    }
  };
  const chain = (sortBy || []).map((s) => ({ key: s.key, mul: s.dir === 'asc' ? -1 : 1 }));
  return (a, b) => {
    for (const { key, mul } of chain) {
      const diff = (keyValue(key, b) - keyValue(key, a)) * mul;
      if (diff !== 0) return diff;
    }
    return (scores.get(b.id) - scores.get(a.id)) || (b.createdAt - a.createdAt);
  };
}

// ---------------------------------------------------------------------------
// Per-product slot assembly: per-product pins -> global pins -> sequences
// (when automated) -> backfill (when automated + opted in). Cap 16 ALWAYS.
// ---------------------------------------------------------------------------
function computeSlotsForProduct(source, norm, ctx) {
  const weights = buildWeights(norm.attributePriority);
  const picked = [];
  const pickedIds = new Set();
  const slots = [];

  const push = (cand) => {
    if (pickedIds.has(cand.id) || cand.id === source.id) return false;
    if (picked.length >= MAX_RECOMMENDATIONS) return false;
    picked.push(cand);
    pickedIds.add(cand.id);
    return true;
  };

  // 1) Pins (hand-picked). Pins bypass conditions but never hygiene.
  const pinList = [
    ...(norm.pins.perProduct[normalizeId(source.id)] || []),
    ...(norm.pins.global || [])
  ];
  const pinnedProducts = [];
  for (const gid of pinList) {
    const cand = ctx.byId.get(gid) || ctx.byId.get(`gid://shopify/Product/${normalizeId(gid)}`);
    if (!cand || !passesHygiene(cand)) continue;
    if (push(cand)) pinnedProducts.push(cand);
  }
  if (pinnedProducts.length) {
    slots.push({ blockIndex: -1, blockLabel: 'Pinned', pinned: true, products: pinnedProducts });
  }

  // 2) Automated sequences
  const scores = new Map();
  if (norm.automatedEnabled) {
    norm.sequences.forEach((seq, blockIndex) => {
      const size = Math.max(0, Math.min(Number(seq.size) || 0, MAX_RECOMMENDATIONS - picked.length));
      const basePool = seq.pool === 'catalog' ? ctx.catalogPool : ctx.collectionPool;
      ctx.currentPool = basePool; // scopes above/below-average to this pool

      const survivors = [];
      for (const cand of basePool) {
        if (cand.id === source.id || pickedIds.has(cand.id)) continue;
        if (!evalConditions(cand, source, norm.commonConditions, ctx)) continue;
        if (!evalConditions(cand, source, seq.conditions, ctx)) continue;
        if (!scores.has(cand.id)) scores.set(cand.id, weightedScore(source, cand, weights, ctx));
        survivors.push(cand);
      }

      const chosen = survivors.sort(buildComparator(seq.sortBy, source, scores, ctx)).slice(0, size);
      for (const cand of chosen) push(cand);
      slots.push({ blockIndex, blockLabel: seq.label || `Sequence ${blockIndex + 1}`, products: chosen });
    });

    // 3) Backfill from the collection pool, ranked by weighted score.
    //    It obeys the rule's common conditions too — otherwise a rule that
    //    carefully asks for earrings everywhere would still end up padded
    //    with pendants and rings whenever a sequence came up short.
    if (norm.backfill && picked.length < MAX_RECOMMENDATIONS) {
      // Two rungs: exhaust the collection first, then widen to the whole store.
      // A tight set of common conditions can easily empty a 38-product
      // collection, and a short row helps nobody — but the widened rung still
      // obeys those conditions, so it stays on-brief.
      const takeFrom = (pool, label) => {
        if (picked.length >= MAX_RECOMMENDATIONS) return;
        ctx.currentPool = pool;
        const leftovers = [];
        for (const cand of pool) {
          if (cand.id === source.id || pickedIds.has(cand.id)) continue;
          if (!evalConditions(cand, source, norm.commonConditions, ctx)) continue;
          if (!scores.has(cand.id)) scores.set(cand.id, weightedScore(source, cand, weights, ctx));
          leftovers.push(cand);
        }
        const chosen = leftovers
          .sort((a, b) => (scores.get(b.id) - scores.get(a.id)) || (b.createdAt - a.createdAt))
          .slice(0, MAX_RECOMMENDATIONS - picked.length);
        for (const cand of chosen) push(cand);
        if (chosen.length) {
          slots.push({ blockIndex: norm.sequences.length, blockLabel: label, products: chosen });
        }
      };

      takeFrom(ctx.collectionPool, 'Backfill');
      if (picked.length < MAX_RECOMMENDATIONS && ctx.catalogPool !== ctx.collectionPool) {
        takeFrom(ctx.catalogPool, 'Backfill - whole store');
      }
    }
  }

  return {
    slots,
    picks: picked.slice(0, MAX_RECOMMENDATIONS).map((p) => p.id),
    totalFilled: Math.min(picked.length, MAX_RECOMMENDATIONS)
  };
}

// ---------------------------------------------------------------------------
// Shared compute context: scans, metric maps, popularity, collection sets for
// in_collection conditions, pin resolution index.
// ---------------------------------------------------------------------------
async function buildContext(fastify, norm, opts = {}) {
  const needsCatalog =
    !norm.source.collectionId ||
    norm.source.productIds.length > 0 ||
    norm.backfill ||   // backfill widens to the whole store when the collection runs short
    norm.sequences.some((s) => s.pool === 'catalog') ||
    norm.pins.global.length > 0 ||
    Object.keys(norm.pins.perProduct).length > 0;

  const [collectionProducts, catalogProducts, popMaps, metrics] = await Promise.all([
    norm.source.collectionId ? scanCollection(norm.source.collectionId) : Promise.resolve(null),
    needsCatalog ? scanCatalog() : Promise.resolve(null),
    getPopularityMaps(fastify),
    getMetricMaps(fastify, { waitForSkuIndex: opts.waitForSkuIndex !== false }).catch((err) => {
      // Metrics must never brick a run — degrade to empty windows.
      console.error('[Reco] Metric maps unavailable, using zeros:', err.message);
      const empty = () => ({ d3: new Map(), d7: new Map(), d30: new Map() });
      return { views: empty(), atc: empty(), orders: empty(), revenue: empty(), sources: {}, viewsTrackingSince: null };
    })
  ]);

  const sourceScan = collectionProducts || catalogProducts || [];
  const catalogScan = catalogProducts || collectionProducts || [];

  const byId = new Map();
  for (const p of catalogScan) byId.set(p.id, p);
  for (const p of sourceScan) if (!byId.has(p.id)) byId.set(p.id, p);

  // Collection sets for in_collection conditions (unique across the rule).
  const collectionSets = new Map();
  const condCollectionIds = new Set();
  const collectFrom = (conds) => {
    for (const c of conds || []) {
      if (ATTRIBUTES[c.attr]?.kind === 'collection' && c.value) condCollectionIds.add(String(c.value));
    }
  };
  collectFrom(norm.source.conditions);
  collectFrom(norm.commonConditions);
  for (const s of norm.sequences) collectFrom(s.conditions);
  for (const cid of condCollectionIds) {
    try {
      const prods = await scanCollection(cid);
      collectionSets.set(cid, new Set(prods.map((p) => p.id)));
    } catch (err) {
      console.warn(`[Reco] in_collection scan failed for ${cid}: ${err.message}`);
      collectionSets.set(cid, new Set());
    }
  }

  const collectionPool = sourceScan.filter(passesHygiene);
  const catalogPool = catalogScan.filter(passesHygiene);

  const popCache = new Map();
  let maxPop = 0;
  const seedPop = (p) => {
    if (popCache.has(p.id)) return;
    const c = popularityCountFor(popMaps, p.id);
    popCache.set(p.id, c);
    if (c > maxPop) maxPop = c;
  };
  for (const p of catalogPool) seedPop(p);
  for (const p of collectionPool) seedPop(p);

  return {
    byId,
    collectionPool,
    catalogPool,
    avgCache: new Map(),
    currentPool: null,
    collectionSets,
    popCache,
    maxPop,
    metrics,
    scannedCount: sourceScan.length
  };
}

// ---------------------------------------------------------------------------
// computeForRule — the shared compute step (NO writes)
//
// options:
//   productId  - gid or numeric: compute only that source product
//   limit      - compute only the first N eligible source products
//   excludeIds - Set of product GIDs owned by a higher-priority rule; skipped
//                as SOURCES (still allowed as candidates)
// ---------------------------------------------------------------------------
async function computeForRule(fastify, rule, options = {}) {
  const norm = normalizeRule(rule);
  const ctx = await buildContext(fastify, norm, { waitForSkuIndex: options.waitForSkuIndex !== false });

  // Source scope: hygiene + the rule's own (static) source conditions.
  // Scope order: explicit product list first (if any), then the collection /
  // store-wide pool, then the rule's own source conditions.
  const listed = norm.source.productIds.length
    ? new Set(norm.source.productIds.map((id) => normalizeId(id)))
    : null;
  const scopePool = listed
    ? ctx.collectionPool.filter((p) => listed.has(normalizeId(p.id)))
    : ctx.collectionPool;
  const eligible = scopePool.filter((p) => evalConditions(p, null, norm.source.conditions, ctx));

  let sources = eligible;
  // Products claimed by a higher-priority rule are never this rule's to write —
  // and that has to hold when previewing ONE product too, or the preview shows
  // recommendations the run will never produce.
  const owned = options.excludeIds && options.excludeIds.size ? options.excludeIds : null;
  if (options.productId) {
    const wanted = normalizeId(options.productId);
    const found = eligible.find((p) => normalizeId(p.id) === wanted);
    if (!found) {
      const err = new Error('Product not found among the eligible source products of this rule');
      err.statusCode = 404;
      throw err;
    }
    if (owned && owned.has(found.id)) {
      const err = new Error('Another rule with a higher priority owns this product, so this rule will not write its recommendations');
      err.statusCode = 409;
      throw err;
    }
    sources = [found];
  } else if (owned) {
    sources = sources.filter((p) => !owned.has(p.id));
  }
  if (options.limit) sources = sources.slice(0, options.limit);

  const results = [];
  for (const source of sources) {
    results.push({ source, ...computeSlotsForProduct(source, norm, ctx) });
    // Yield periodically so a large run does not starve the event loop.
    if (results.length % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    results,
    ctx,
    norm,
    scannedCount: ctx.scannedCount,
    eligibleCount: eligible.length
  };
}

// ---------------------------------------------------------------------------
// previewScope — "N products in scope" for the rule editor's source tab
// ---------------------------------------------------------------------------
async function previewScope(fastify, sourceDef) {
  const fakeRule = {
    version: 2,
    source: {
      collectionId: sourceDef?.collectionId || null,
      productIds: sourceDef?.productIds || [],
      conditions: sourceDef?.conditions || []
    },
    sequences: [],
    pins: { global: [], perProduct: {} },
    automatedEnabled: true
  };
  const norm = normalizeRule(fakeRule);
  const ctx = await buildContext(fastify, norm, { waitForSkuIndex: false });
  const inScope = ctx.collectionPool.filter((p) => evalConditions(p, null, norm.source.conditions, ctx));
  return {
    count: inScope.length,
    sample: inScope.slice(0, 12).map((p) => ({
      id: p.id, title: p.title, handle: p.handle, image: p.image, price: p.price
    }))
  };
}

// ---------------------------------------------------------------------------
// previewForRule — DRY RUN, no writes, preview shape (with 30d metrics so the
// product team sees WHY a product ranked)
// ---------------------------------------------------------------------------
async function previewForRule(fastify, rule, { productId, limit } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 12);

  // Same ownership exclusion the run applies, so preview matches reality.
  const excludeIds = await getOwnedByHigherPriority(fastify, rule);

  const { results, ctx } = await computeForRule(fastify, rule, {
    productId: productId || null,
    limit: productId ? 1 : cappedLimit,
    excludeIds,
    waitForSkuIndex: false // an admin preview must never block on the catalogue scan
  });

  const m = (group, win, p) => ctx.metrics[group][win].get(normalizeId(p.id)) || 0;
  const toPreviewProduct = (cand) => ({
    id: cand.id,
    title: cand.title,
    handle: cand.handle,
    image: cand.image,
    price: cand.price,
    inStock: cand.buyable,
    popularity: ctx.popCache.get(cand.id) || 0,
    stoneType: cand.stoneType,
    // Audience (custom.shop_for ?? ornaverse.shop_for). Surfaced so the admin's
    // "same audience only" switch can be VERIFIED on sight: source says Men,
    // every card should say Men.
    shopFor: cand.shopFor,
    metrics: {
      views30: m('views', 'd30', cand),
      atc30: m('atc', 'd30', cand),
      orders30: m('orders', 'd30', cand),
      revenue30: Math.round(m('revenue', 'd30', cand))
    }
  });

  return results.map(({ source, slots, totalFilled }) => ({
    source: {
      id: source.id,
      title: source.title,
      handle: source.handle,
      image: source.image,
      price: source.price,
      shopFor: source.shopFor,
      productType: source.productType
    },
    slots: slots.map((slot) => ({
      blockIndex: slot.blockIndex,
      blockLabel: slot.blockLabel,
      pinned: slot.pinned === true,
      products: slot.products.map(toPreviewProduct)
    })),
    totalFilled,
    metricSources: { ...(ctx.metrics.sources || {}), skuIndexPending: ctx.metrics.skuIndexPending === true }
  }));
}

// ---------------------------------------------------------------------------
// Multi-rule ownership: products also in a HIGHER-priority rule's scope are
// owned by that rule — this rule's run skips them as sources.
// ---------------------------------------------------------------------------
async function getOwnedByHigherPriority(fastify, rule) {
  const owned = new Set();
  const higher = await fastify.mongo.db.collection('reco_rules').find({
    enabled: true,
    priority: { $gt: rule.priority || 0 },
    _id: { $ne: rule._id }
  }).toArray();

  for (const other of higher) {
    const pids = other.source?.productIds || [];
    if (pids.length) {
      // Product-scoped rule: it owns those products and nothing else. Ids are
      // matched as full GIDs elsewhere, so record both forms.
      for (const pid of pids) {
        owned.add(pid);
        const nid = normalizeId(pid);
        if (nid) owned.add('gid://shopify/Product/' + nid);
      }
      continue;
    }
    const cid = other.source?.collectionId || other.collectionId;
    if (!cid) {
      // A higher-priority rule with no collection is STORE-WIDE, so it owns
      // every product and this rule has nothing left to write. Without this,
      // both rules would write the same metafield and the last run would win
      // at random.
      try {
        for (const prod of await scanCatalog()) owned.add(prod.id);
      } catch (err) {
        console.warn('[Reco] Store-wide ownership scan failed: ' + err.message);
      }
      continue;
    }
    try {
      const products = await scanCollection(cid);
      for (const p of products) owned.add(p.id);
    } catch (err) {
      // Best effort: an unreadable higher-priority collection must not kill
      // this run — the next run of that rule reclaims its products.
      console.warn(`[Reco] Ownership scan failed for "${other.collectionHandle}": ${err.message}`);
    }
  }
  return owned;
}

// ---------------------------------------------------------------------------
// Metafield write (metafieldsSet in chunks of 25, per routes/auth.js pattern)
// ---------------------------------------------------------------------------

const METAFIELDS_SET_MUTATION = `
  mutation setFromSameCollection($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------
// runRule — full run with bookkeeping
//
// Inserts a reco_runs doc (status running -> completed/failed) and updates the
// rule's lastRunAt/lastRunStats around computeForRule + the metafield writes.
// opts.runId lets the run-now route reply with the id BEFORE the run starts.
// opts.preAcquired: the route claimed runningRules synchronously pre-reply.
// ---------------------------------------------------------------------------
async function runRule(fastify, rule, trigger, opts = {}) {
  const db = fastify.mongo.db;
  const runsCol = db.collection('reco_runs');
  const rulesCol = db.collection('reco_rules');
  const ruleKey = String(rule._id);

  if (!opts.preAcquired) {
    if (runningRules.has(ruleKey)) {
      throw new Error('A run for this rule is already in progress');
    }
    runningRules.add(ruleKey);
  }

  const startedAt = new Date();
  const runDoc = {
    ruleId: ruleKey,
    collectionHandle: rule.collectionHandle,
    trigger,
    status: 'running',
    startedAt,
    finishedAt: null,
    productsProcessed: 0,
    written: 0,
    unchanged: 0,
    failed: 0,
    errors: [],
    durationMs: null
  };
  if (opts.runId) runDoc._id = opts.runId;

  const stats = { productsProcessed: 0, written: 0, unchanged: 0, failed: 0 };
  const errors = [];
  const pushError = (msg) => { if (errors.length < MAX_RUN_ERRORS) errors.push(String(msg).slice(0, 300)); };

  try {
    const inserted = await runsCol.insertOne(runDoc);
    const runId = runDoc._id || inserted.insertedId;
    console.log(`[Reco] Run started (${trigger}) for "${rule.collectionHandle}" — runId ${runId}`);

    try {
      const excludeIds = await getOwnedByHigherPriority(fastify, rule);
      const { results } = await computeForRule(fastify, rule, { excludeIds });

      // DIFF-SKIP: the scan already carries each product's current metafield
      // value; identical arrays (same order) are not rewritten.
      const toWrite = [];
      for (const r of results) {
        stats.productsProcessed += 1;
        const picks = r.picks;
        let currentArr = null;
        try {
          currentArr = r.source.currentValue ? JSON.parse(r.source.currentValue) : null;
        } catch (_) {
          currentArr = null;
        }
        if (Array.isArray(currentArr) &&
            currentArr.length === picks.length &&
            currentArr.every((v, i) => v === picks[i])) {
          stats.unchanged += 1;
          continue;
        }
        // An empty list is rejected by Shopify ("Value can't be blank") and,
        // because metafieldsSet is atomic per batch, one empty entry would
        // fail up to 24 good writes alongside it. Leave the existing value.
        if (!picks.length) { stats.unchanged += 1; continue; }
        toWrite.push({ ownerId: r.source.id, picks, source: r.source });
      }

      for (let i = 0; i < toWrite.length; i += WRITE_BATCH_SIZE) {
        const batch = toWrite.slice(i, i + WRITE_BATCH_SIZE);
        const metafields = batch.map((w) => ({
          ownerId: w.ownerId,
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: METAFIELD_TYPE,
          value: JSON.stringify(w.picks)
        }));

        try {
          const data = await shopifyAdminFetch(METAFIELDS_SET_MUTATION, { metafields });
          const userErrors = data?.metafieldsSet?.userErrors || [];
          if (userErrors.length) {
            console.error('[Reco] metafieldsSet userErrors:', JSON.stringify(userErrors));
            for (const ue of userErrors) {
              pushError(`metafieldsSet: ${ue.message} (${(ue.field || []).join('.')})`);
            }
            // metafieldsSet is ATOMIC per call: if any input errors, none of
            // the batch is written. The whole batch failed.
            stats.failed += batch.length;
          } else {
            stats.written += batch.length;
            // Keep the cached scan in step with what we just wrote; otherwise
            // a second run inside the scan TTL sees stale currentValue and
            // rewrites every product.
            for (const w of batch) { if (w.source) w.source.currentValue = JSON.stringify(w.picks); }
          }
        } catch (err) {
          console.error('[Reco] metafieldsSet batch failed:', err.message);
          pushError(`metafieldsSet batch failed: ${err.message}`);
          stats.failed += batch.length;
        }
      }

      const finishedAt = new Date();
      await runsCol.updateOne(
        { _id: runId },
        { $set: { status: 'completed', finishedAt, durationMs: finishedAt - startedAt, ...stats, errors } }
      );
      await rulesCol.updateOne(
        { _id: rule._id },
        { $set: { lastRunAt: finishedAt, lastRunStats: { ...stats }, updatedAt: finishedAt } }
      );
      console.log(`[Reco] Run completed for "${rule.collectionHandle}":`, JSON.stringify(stats));
      return { runId, ...stats };
    } catch (err) {
      console.error(`[Reco] Run failed for "${rule.collectionHandle}":`, err);
      pushError(err.message);
      const finishedAt = new Date();
      const runId = runDoc._id || inserted.insertedId;
      await runsCol.updateOne(
        { _id: runId },
        { $set: { status: 'failed', finishedAt, durationMs: finishedAt - startedAt, ...stats, errors } }
      ).catch(console.error);
      // lastRunAt is set even on failure so the scheduler's 10-minute guard
      // stops a broken rule from retrying every tick of its minute.
      await rulesCol.updateOne(
        { _id: rule._id },
        { $set: { lastRunAt: finishedAt, lastRunStats: { ...stats }, updatedAt: finishedAt } }
      ).catch(console.error);
      throw err;
    }
  } finally {
    runningRules.delete(ruleKey);
  }
}

module.exports = {
  attrValue,
  getAttributeOptions,          // exported for unit tests of the condition maths
  computeForRule,
  previewForRule,
  previewScope,
  runRule,
  getPopularityMaps,
  normalizeRule,
  ATTRIBUTES,
  SORT_KEYS,
  OPS_BY_KIND,
  runningRules,
  // Shared with lib/smartCollections.js — the Smart Collection sort engine
  // speaks the same attribute/condition/sort vocabulary over a whole
  // collection ordering instead of a per-product 16-slot grid.
  scanCollection,
  scanCatalog,
  evalConditions,
  buildComparator,
  passesHygiene,
  popularityCountFor,
  normalizeId
};
