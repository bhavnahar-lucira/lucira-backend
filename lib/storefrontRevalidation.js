/**
 * Storefront cache flushing — one queue for every source of change.
 *
 * Two caches sit between Shopify/Mongo and a shopper:
 *   1. this server's in-memory cache (lib/cache.js), and
 *   2. the Next.js ISR cache on Vercel — pages are cached for 24h and only
 *      refresh early when POST /api/revalidate is called for their path.
 *
 * Shopify webhooks (products, collections, inventory) and dashboard saves
 * (hero banners, smart collection syncs) all queue their work here, so they
 * share one debounce window and one call to the frontend per window.
 *
 * HISTORY: this used to live inside routes/webhooks.js with a single 20s
 * "quiet window" timer. On 16 Sep inventory webhooks were added to the same
 * timer. They fire constantly (orders, stock syncs, every variant of a saved
 * product), so the window rarely went quiet: product edits piled up behind it
 * and, past 5 handles, were treated as a bulk update that only refreshed the
 * homepage. Product pages then needed a manual clear. MAX_WAIT_MS below caps
 * how long any change can wait, and the bulk cutoff is now high enough that
 * only the daily price update hits it.
 */
const { clearAllCache } = require('./cache');
const { warmStoreProductIds } = require('./storeAvailability');

// ---------------------------------------------------------------------------
// Backend cache invalidation — rate-limited
// ---------------------------------------------------------------------------
// PROBLEM: this used to call clearAllCache() on EVERY product webhook. During the
// daily bulk price update Shopify fires ~2,500 of them, so the entire cache was
// wiped 2,500 times in a row. The expensive derived entries never survived long
// enough to be used — collection-id-order (6h TTL) and store-product-ids (15m
// TTL), the two full-catalogue scans behind store-proximity ordering, were gone
// before the next request arrived. Every collection page paid the cold cost.
//
// SOLUTION: leading edge + cooldown + trailing edge.
//   • leading  — a wipe outside the cooldown happens IMMEDIATELY, so a single
//                product edit is reflected exactly as fast as it was before.
//   • cooldown — further wipes inside the window are suppressed, so a 2,500
//                webhook burst wipes once instead of 2,500 times and the caches
//                can actually serve traffic while the burst is in flight.
//   • trailing — one final wipe once the burst goes quiet, so whatever changed
//                during the cooldown is never left stale behind it.
// ---------------------------------------------------------------------------
let cacheClearTimer = null;
let lastCacheClearAt = 0;
let suppressedClears = 0;
const CACHE_CLEAR_COOLDOWN_MS = 30000;   // min gap between wipes during a burst
const CACHE_CLEAR_TRAILING_MS = 20000;   // quiet window before the final wipe

function scheduleCacheClear(reason) {
  const now = Date.now();

  if (now - lastCacheClearAt > CACHE_CLEAR_COOLDOWN_MS) {
    lastCacheClearAt = now;
    clearAllCache();
    console.log(`[Cache] Backend caches cleared (${reason})`);
    // A wipe also throws away the per-store stock sets behind store-proximity
    // ordering. Rebuild them right away, off the request path, so the next
    // pincoded shopper gets a warm ordering instead of paying for the scans.
    warmStoreProductIds();
  } else {
    suppressedClears += 1;
  }

  if (cacheClearTimer) clearTimeout(cacheClearTimer);
  cacheClearTimer = setTimeout(() => {
    cacheClearTimer = null;
    lastCacheClearAt = Date.now();
    clearAllCache();
    console.log(
      `[Cache] Backend caches cleared (trailing; ${suppressedClears} redundant wipes suppressed during burst)`
    );
    suppressedClears = 0;
    warmStoreProductIds();
  }, CACHE_CLEAR_TRAILING_MS);
}

// ---------------------------------------------------------------------------
// Frontend (Vercel ISR) revalidation — debounced, batched
// ---------------------------------------------------------------------------
const QUIET_MS = 20000;          // flush once changes stop arriving for this long…
const MAX_WAIT_MS = 60000;       // …but never later than this after the first one
const PRODUCT_PAGE_LIMIT = 50;   // more products than this in one window = bulk update
const COLLECTION_PAGE_LIMIT = 200;

let pending = emptyPending();
let quietTimer = null;
let maxWaitTimer = null;
let loggedEndpoint = false;

function emptyPending() {
  return {
    products: new Set(),
    collections: new Set(),
    paths: new Set(),
    collectionsAll: false,
    home: false,
    reasons: new Set(),
  };
}

function frontendRevalidateEndpoint() {
  const frontendUrl = (process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const endpoint = `${frontendUrl}/api/revalidate`;
  if (!loggedEndpoint) {
    loggedEndpoint = true;
    console.log(`[Revalidate] Storefront revalidation endpoint: ${endpoint}`);
  }
  return endpoint;
}

/**
 * Queue storefront pages for revalidation.
 *
 * @param {object} work
 * @param {string[]} [work.products]    product handles → /products/<handle>
 * @param {string[]} [work.collections] collection handles → /collections/<handle>
 * @param {string[]} [work.paths]       any other storefront path, e.g. '/pages/store-locator'
 * @param {boolean}  [work.collectionsAll] every /collections/<handle> page
 * @param {boolean}  [work.home]        the homepage
 * @param {string}   reason             shows up in the logs
 * @param {object}   [opts]
 * @param {number}   [opts.quietMs]     shorter quiet window, for dashboard saves
 *                                      where someone is waiting to see the change
 */
function queueRevalidation(work = {}, reason = 'unknown', opts = {}) {
  const add = (set, values) => {
    for (const v of values || []) {
      const s = typeof v === 'string' ? v.trim() : '';
      if (s) set.add(s);
    }
  };
  add(pending.products, work.products);
  add(pending.collections, work.collections);
  add(pending.paths, work.paths);
  if (work.collectionsAll) pending.collectionsAll = true;
  if (work.home) pending.home = true;
  pending.reasons.add(reason);

  const quietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : QUIET_MS;
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(flushRevalidation, quietMs);
  if (!maxWaitTimer) maxWaitTimer = setTimeout(flushRevalidation, MAX_WAIT_MS);
}

async function flushRevalidation() {
  if (quietTimer) clearTimeout(quietTimer);
  if (maxWaitTimer) clearTimeout(maxWaitTimer);
  quietTimer = null;
  maxWaitTimer = null;

  const batch = pending;
  pending = emptyPending();

  let products = [...batch.products];
  let collections = [...batch.collections];
  const paths = [...batch.paths];
  let { collectionsAll, home } = batch;
  const reasons = [...batch.reasons].slice(0, 5).join(', ') + (batch.reasons.size > 5 ? ', …' : '');

  if (!products.length && !collections.length && !paths.length && !collectionsAll && !home) return;

  // BULK UPDATE (the daily price update touches ~2,500 products): don't rebuild
  // every product page. PDP prices are fetched live on the client, and the
  // pages still refresh on their own 24h cycle. Refresh the listings instead.
  if (products.length > PRODUCT_PAGE_LIMIT) {
    console.log(`[Revalidate] Bulk update (${products.length} products) — skipping per-product pages, refreshing homepage + collections.`);
    products = [];
    collectionsAll = true;
    home = true;
  }
  if (collections.length > COLLECTION_PAGE_LIMIT) {
    collections = [];
    collectionsAll = true;
  }

  const body = { type: 'batch', products, collections, paths, collectionsAll, home };
  const endpoint = frontendRevalidateEndpoint();
  const summary = `${products.length} products, ${collections.length} collections, ${paths.length} paths, allCollections=${collectionsAll}, home=${home}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.revalidated && data?.type === 'batch') {
      console.log(`[Revalidate] Flushed (${summary}) — ${reasons}`);
      return;
    }
    // A frontend deployed before `type: 'batch'` existed answers with a plain
    // homepage revalidation. Fall back to the one-call-per-page form it knows.
    console.warn(`[Revalidate] Batch not supported by frontend (HTTP ${res.status}), using per-page calls.`);
  } catch (err) {
    console.error(`[Revalidate] Batch call to ${endpoint} failed: ${err.message}. Retrying per page.`);
  }

  const post = (payload) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => console.error(`[Revalidate] ${JSON.stringify(payload)} failed: ${err.message}`));

  if (home && !products.length) await post({ handle: null }); // product calls refresh '/' too
  for (const h of products) await post({ handle: h });
  for (const h of collections) await post({ type: 'collection', handle: h });
  if (collectionsAll) await post({ type: 'collections' });
  for (const p of paths) await post({ type: 'path', path: p });
  console.log(`[Revalidate] Flushed via per-page calls (${summary}) — ${reasons}`);
}

module.exports = { scheduleCacheClear, queueRevalidation, flushRevalidation };
