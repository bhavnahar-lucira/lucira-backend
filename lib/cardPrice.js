/**
 * Card price — the price a shopper actually SEES on a collection-page card.
 *
 * `price` elsewhere in the engine is Shopify's priceRangeV2.minVariantPrice:
 * the cheapest of ALL variants, any size or purity, stocked or not. The
 * storefront card never shows that. It prices ONE variant, picked by
 * getPrioritizedVariant() in lucira-frontend/src/components/product/
 * ProductCard.jsx, from the variants routes/collection.js hands it:
 *
 *   1. In `9kt-collection`: the first in-stock 9KT variant, else the first
 *      9KT variant at all.
 *   2. The first IN-STOCK variant (availableForSale && !currentlyNotInStock,
 *      i.e. units on hand, not made-to-order) — for products whose type
 *      contains "ring", an in-stock Yellow Gold variant wins first. The check
 *      is a plain substring, so "Earrings" get the Yellow Gold preference too;
 *      mirrored as-is, because matching the card matters more than tidiness.
 *   3. Otherwise the first variant.
 *
 * A variant exists for the card only if the Storefront API returns it: it must
 * be published on the Online Store channel (variant-level publishing), and
 * among the first STOREFRONT_VARIANT_LIMIT — a variant past it is invisible
 * and the card falls back to the first variant. Both are mirrored.
 *
 * The limit MUST equal what routes/collection.js asks for on BOTH its paths.
 * Until 26 Sep 2026 they differed: the store-ordered path (pincode/store
 * selected) fetched variants(first: 100), the plain path variants(first: 50),
 * so a ring whose only stock is variant #57 (Hex Frame Diamond Ring, 10 such
 * rings store-wide) showed 20,615 to one shopper and 15,862 to another, and no
 * single sort could match both. Both paths now fetch 100.
 *
 * Checked 26 Sep 2026 against the Storefront API running the card's own
 * getPrioritizedVariant: identical price for 1,476/1,476 products in
 * lucira-express, 298/298 in 9kt-collection, 171/171 in bestsellers.
 * Known approximation: the fallback "first variant" is the scan's first
 * variant, which is not checked for publication.
 *
 * Measured 25 Sep 2026 on lucira-express: Hexora-Enamel Scarlet Chain
 * Bracelet has minVariantPrice 25,950 but its card shows 32,131 (in-stock
 * Rose Gold 6.5"), so "Price low to high" put it ahead of a 26,011 card.
 *
 * DATA. The product scan only carries variants(first: 5) and cannot be
 * widened (rings have 84 variants; 250 products x 84 blows the query-cost
 * cap). Instead ONE store-wide walk of the variants that have stock:
 * productVariants(query: "inventory_quantity:>0") — ~2,000 variants / ~1,500
 * products / 9 pages of 250 when measured. It is cached and shared by every
 * rule and every collection, the global pass included. (Beware:
 * productVariantsCount IGNORES that same query string and reports all ~101k —
 * the connection filters, the count does not.)
 *
 * Untracked inventory never appears in that walk (no quantity to compare), but
 * the card counts it as in stock, so products with tracksInventory === false
 * fall back to their first few variants' availableForSale.
 */

const { shopifyAdminFetch } = require('./shopify');
const { getServerCache } = require('./cache');

const STOREFRONT_VARIANT_LIMIT = 100;  // routes/collection.js: variants(first: 100), both paths
const NINE_KT_HANDLE = '9kt-collection';
const STOCK_TTL_MS = 10 * 60 * 1000;   // same lifetime as the product scans
const STOCK_PAGE_SIZE = 250;
const STOCK_MAX_PAGES = 80;            // 20k variants, ~4x the largest walk measured

// The Online Store publication — the channel the storefront's STOREFRONT_TOKEN
// reads. A variant switched off there is absent from the Storefront API, so the
// card can never show it, however much stock it has (measured 26 Sep 2026: 21
// of 2,038 in-stock variants were hidden this way — mostly 18KT nosepins,
// whose cards therefore fall back to the 14KT first variant). Variant-level
// publishedOnPublication needs Admin API 2026-07; only these walks use it.
const ONLINE_STORE_PUBLICATION = process.env.ONLINE_STORE_PUBLICATION_ID || 'gid://shopify/Publication/150766158042';
const VARIANT_PUBLICATION_API_VERSION = '2026-07';

const variantWalkQuery = (name, search) => `
  query ${name}($first: Int!, $after: String, $publication: ID!) {
    productVariants(first: $first, after: $after, query: ${JSON.stringify(search)}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
        position
        price
        compareAtPrice
        availableForSale
        inventoryQuantity
        publishedOnPublication(publicationId: $publication)
        selectedOptions { name value }
        product { id }
      }
    }
  }
`;

const IN_STOCK_VARIANTS_QUERY = variantWalkQuery('cardPriceInStockVariants', 'inventory_quantity:>0');
// Only for 9kt-collection, where the card takes the first 9KT variant even
// when it has no stock — and 9KT often sits past the scan's first 5 variants.
// 4,680 variants / 397 products / 19 pages when measured.
const NINE_KT_VARIANTS_QUERY = variantWalkQuery('cardPriceNineKtVariants', 'title:*9KT*');

const toVariant = (v) => ({
  title: v.title || '',
  position: Number(v.position) || 0,
  price: parseFloat(v.price) || 0,
  compareAtPrice: parseFloat(v.compareAtPrice) || 0,
  availableForSale: v.availableForSale === true,
  selectedOptions: Array.isArray(v.selectedOptions) ? v.selectedOptions : []
});

/**
 * Walk a filtered productVariants connection into a map of product GID -> the
 * matching variants the storefront can see (published on Online Store, within
 * the first 50), in variant position order. Throws on a Shopify failure;
 * getServerCache does not cache a rejection, so the next caller retries.
 */
async function walkVisibleVariants(query, label, keep) {
  const map = new Map();
  let after = null;
  let pages = 0;
  let count = 0;
  do {
    const data = await shopifyAdminFetch(
      query,
      { first: STOCK_PAGE_SIZE, after, publication: ONLINE_STORE_PUBLICATION },
      { priority: 'background', apiVersion: VARIANT_PUBLICATION_API_VERSION }
    );
    const conn = data?.productVariants;
    if (!conn) throw new Error('productVariants returned nothing');
    for (const v of conn.nodes || []) {
      const pid = v.product?.id;
      if (!pid || v.publishedOnPublication !== true || !keep(v)) continue;
      const variant = toVariant(v);
      if (variant.position > STOREFRONT_VARIANT_LIMIT) continue;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid).push(variant);
      count += 1;
    }
    pages += 1;
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    if (after && pages >= STOCK_MAX_PAGES) {
      console.warn(`[CardPrice] ${label} walk capped at ${pages} pages; later variants ignored`);
      after = null;
    }
  } while (after);
  for (const list of map.values()) list.sort((a, b) => a.position - b.position);
  console.log(`[CardPrice] ${label}: ${count} visible variants across ${map.size} products (${pages} pages)`);
  return map;
}

// Units on hand. availableForSale is checked too: the card needs both.
async function getInStockVariantMap() {
  return getServerCache('card-price:in-stock-variants', () => walkVisibleVariants(
    IN_STOCK_VARIANTS_QUERY, 'In-stock variants',
    (v) => v.availableForSale === true && Number(v.inventoryQuantity) > 0
  ), { ttlMs: STOCK_TTL_MS });
}

// Every visible 9KT variant, stocked or not. The title search is a superset;
// is9KT re-applies the card's own test.
async function getNineKtVariantMap() {
  return getServerCache('card-price:9kt-variants', () => walkVisibleVariants(
    NINE_KT_VARIANTS_QUERY, '9KT variants',
    (v) => is9KT(toVariant(v))
  ), { ttlMs: STOCK_TTL_MS });
}

// ProductCard reads `v.color || v.title`, where color is the first of the
// options "color", "metal", "metal color" (in that priority) — see getOpt in
// routes/collection.js.
function colourOrTitle(v) {
  const byName = new Map(v.selectedOptions.map((o) => [String(o.name || '').toLowerCase(), o.value]));
  for (const key of ['color', 'metal', 'metal color']) {
    if (byName.get(key) !== undefined) return String(byName.get(key) || v.title || '');
  }
  return String(v.title || '');
}

const is9KT = (v) => colourOrTitle(v).includes('9KT');
const isYellowGold = (v) => colourOrTitle(v).includes('Yellow Gold');

/**
 * The variant the storefront card prices, for one scanned product.
 * `product.leadVariants` is the scan's first few variants (position order).
 * Returns { price, compareAtPrice, variantTitle, source } or null when the
 * product has no variants at all.
 */
function cardVariantFor(product, stockMap, { collectionHandle, nineKtMap } = {}) {
  const lead = product.leadVariants || [];
  const inStock = product.tracksInventory === false
    ? lead.filter((v) => v.availableForSale)
    : (stockMap.get(product.id) || []);

  let pick = null;
  let source = null;

  if (collectionHandle === NINE_KT_HANDLE) {
    // First in-stock 9KT variant, else the first 9KT variant at all.
    const nineKt = nineKtMap ? (nineKtMap.get(product.id) || []) : lead.filter(is9KT);
    pick = inStock.find(is9KT) || nineKt[0] || null;
    if (pick) source = '9kt';
  }
  if (!pick && inStock.length) {
    if (String(product.productType || '').toLowerCase().includes('ring')) pick = inStock.find(isYellowGold) || null;
    pick = pick || inStock[0];
    source = 'in_stock';
  }
  if (!pick && lead.length) {
    pick = lead[0];
    source = 'first_variant';
  }
  if (!pick) return null;
  return {
    price: pick.price,
    compareAtPrice: pick.compareAtPrice > pick.price ? pick.compareAtPrice : 0,
    variantTitle: pick.title,
    source
  };
}

/**
 * Per-context resolver: memoises cardVariantFor per product id, so ranking a
 * 1,500-product pool calls it once per product, not once per comparison.
 */
function makeCardPriceResolver(stockMap, opts = {}) {
  const memo = new Map();
  return (product) => {
    if (!memo.has(product.id)) memo.set(product.id, cardVariantFor(product, stockMap, opts));
    return memo.get(product.id);
  };
}

// Attribute keys that read the card price. A rule that uses none of them does
// not need the in-stock walk to succeed.
const CARD_PRICE_KEYS = new Set(['card_price', 'card_discount_percent']);

// Does a rule (smart-sort or reco shape) reference a card-price attribute in a
// condition, a sort, or a weighted blend?
function ruleUsesCardPrice(rule) {
  const hits = (list) => (list || []).some((x) => CARD_PRICE_KEYS.has(x?.attr) || CARD_PRICE_KEYS.has(x?.key)
    || Object.keys(x?.weights || {}).some((k) => CARD_PRICE_KEYS.has(k)));
  const groups = [rule?.slots, rule?.sequences].filter(Array.isArray).flat();
  return groups.some((g) => hits(g.conditions) || hits(g.sortBy))
    || hits(rule?.remainderSortBy)
    || hits(rule?.source?.conditions)
    || hits(rule?.commonConditions);
}

/**
 * Load the resolver for a compute context. A rule that ranks or filters on the
 * card price FAILS if the stock walk fails — silently falling back to the
 * lowest variant price would write exactly the wrong order this exists to fix.
 * Any other rule just carries no resolver (previews then show no card price).
 */
async function loadCardPriceResolver(rule, opts = {}) {
  try {
    const [stockMap, nineKtMap] = await Promise.all([
      getInStockVariantMap(),
      opts.collectionHandle === NINE_KT_HANDLE ? getNineKtVariantMap() : null
    ]);
    return makeCardPriceResolver(stockMap, { ...opts, nineKtMap });
  } catch (err) {
    if (ruleUsesCardPrice(rule)) {
      throw new Error(`Card prices unavailable (in-stock variant scan failed: ${err.message})`);
    }
    console.warn('[CardPrice] In-stock variant scan failed; card prices omitted:', err.message);
    return null;
  }
}

module.exports = {
  getInStockVariantMap,
  getNineKtVariantMap,
  cardVariantFor,
  makeCardPriceResolver,
  loadCardPriceResolver,
  ruleUsesCardPrice,
  CARD_PRICE_KEYS,
  STOREFRONT_VARIANT_LIMIT
};
