/**
 * Visible product counts (excluding `hidden`-tagged products).
 *
 * Shopify's collection/facet counts include products the storefront hides
 * (anything tagged `hidden`). The app strips those products before rendering, so
 * the Shopify-reported counts end up larger than what is actually shown — e.g. a
 * "Charms" category reports 34 items while only 1 is visible because 33 are
 * tagged `hidden`.
 *
 * There is no way to negate a tag inside a Storefront `ProductFilter`, so we
 * count the non-hidden products ourselves with a lightweight scan (id/tags/
 * productType only). The result is cached with the app's EXISTING cache utility
 * (getServerCache) — this file does NOT change any caching logic; it only uses
 * it. Product create/update webhooks already call clearAllCache(), so the count
 * refreshes automatically when products change; the 24h TTL is just a safety net.
 */

const { shopifyStorefrontFetch } = require('./shopify');
const { getServerCache, stableCacheKey } = require('./cache');

const HIDDEN_TAG = 'hidden';
const PAGE_SIZE = 250;      // Storefront max per page
const MAX_PAGES = 40;       // Safety cap (10,000 products) to avoid runaway scans
const VISIBLE_STATS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (also webhook-invalidated)

const SCAN_QUERY = `
  query VisibleScan($handle: String!, $after: String, $filters: [ProductFilter!]) {
    collectionByHandle(handle: $handle) {
      products(first: ${PAGE_SIZE}, after: $after, filters: $filters) {
        pageInfo { hasNextPage endCursor }
        nodes { productType tags }
      }
    }
  }
`;

const isHidden = (tags) =>
  Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === HIDDEN_TAG);

/**
 * Scan a collection (optionally with active Shopify ProductFilters applied) and
 * tally products that are NOT tagged `hidden`. Cached via the existing cache util.
 *
 * @returns {Promise<{ total: number, byType: Record<string, number>, capped: boolean }>}
 *   total  — visible product count
 *   byType — visible count per productType (for the "Product Category" facet)
 *   capped — true if the scan hit MAX_PAGES before finishing (count is a floor)
 */
async function getCollectionVisibleStats(handle, filters = []) {
  if (!handle || handle === 'all') return { total: 0, byType: {}, capped: false };

  const cacheKey = stableCacheKey(['visible-stats', handle, filters]);

  return getServerCache(
    cacheKey,
    async () => {
      let after = null;
      let total = 0;
      let pages = 0;
      let capped = false;
      const byType = {};

      do {
        const data = await shopifyStorefrontFetch(SCAN_QUERY, { handle, after, filters });
        const products = data?.collectionByHandle?.products;
        if (!products) break;

        for (const node of products.nodes || []) {
          if (isHidden(node.tags)) continue;
          total += 1;
          const type = node.productType || '';
          byType[type] = (byType[type] || 0) + 1;
        }

        pages += 1;
        after = products.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
        if (after && pages >= MAX_PAGES) {
          capped = true;
          after = null;
        }
      } while (after);

      return { total, byType, capped };
    },
    { ttlMs: VISIBLE_STATS_TTL_MS }
  );
}

module.exports = { getCollectionVisibleStats };
