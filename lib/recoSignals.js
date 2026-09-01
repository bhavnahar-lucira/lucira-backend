/**
 * Windowed behavioral metrics for the recommendation rules engine.
 *
 * Source-of-truth split (the store is HEADLESS — Shopify's own web analytics
 * is blind to the Vercel storefront, verified ~468 sessions/30d vs real
 * traffic; money still flows through Shopify checkout and is exact there):
 *
 *   views / add-to-carts  -> GA4 items report when configured (lib/ga4.js),
 *                            else first-party: `product_events` beacon counters
 *                            (views) + carts/abandoned_carts item timestamps
 *                            (ATC).
 *   orders / revenue /    -> Shopify Admin orders scan (all channels, exact
 *   discount                 money) — NOT Mongo `orders`, which is written by
 *                            the external Expo service and misses web checkout.
 *   wishlist              -> Mongo wishlists (all-time, shared social-proof
 *                            aggregation in lib/recommendations.js).
 *
 * Everything returns Map<numericProductId, number> per window and is cached;
 * the nightly run and interactive previews share the same pulls.
 */

const { shopifyAdminFetch } = require('./shopify');
const { getServerCache, stableCacheKey } = require('./cache');
const { isGa4Configured, getGa4Windows } = require('./ga4');

const WINDOWS = [3, 7, 30];

const normalizeId = (id) => {
  const m = String(id || '').match(/\d+/g);
  return m ? m[m.length - 1] : '';
};

const istDateNDaysAgo = (n) => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
};

// ---------------------------------------------------------------------------
// First-party views (beacon counters in `product_events`)
// ---------------------------------------------------------------------------
async function beaconWindow(db, days, field) {
  const since = istDateNDaysAgo(days - 1); // inclusive: today counts as day 1
  const rows = await db.collection('product_events').aggregate([
    { $match: { d: { $gte: since } } },
    { $group: { _id: '$pid', c: { $sum: `$${field}` } } }
  ]).toArray();
  const map = new Map();
  for (const r of rows) if (r.c > 0) map.set(String(r._id), r.c);
  return map;
}

// ---------------------------------------------------------------------------
// First-party ATC (cart item timestamps — covers all shoppers, not only the
// beacon's; `items.addedAt` is set by routes/cart.js on every add)
// ---------------------------------------------------------------------------
async function cartAtcWindow(db, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const build = async (collectionName) => db.collection(collectionName).aggregate([
    { $unwind: '$items' },
    { $match: { 'items.productId': { $ne: null }, 'items.addedAt': { $gte: cutoff } } },
    { $group: { _id: { doc: '$_id', pid: '$items.productId' } } },
    { $group: { _id: '$_id.pid', c: { $sum: 1 } } }
  ], { allowDiskUse: true }).toArray();

  const map = new Map();
  for (const rows of await Promise.all([build('carts'), build('abandoned_carts')])) {
    for (const r of rows) {
      const nid = normalizeId(r._id);
      if (nid) map.set(nid, (map.get(nid) || 0) + r.c);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Variant SKU -> product id index
//
// GA4's dominant item_id for view_item / add_to_cart on this store is the
// variant SKU ("LJ-CH0018-18YGPG-16"), not a Shopify id — so views cannot be
// attributed to products without this lookup. Cached 6h: SKUs change only when
// the catalogue does.
// ---------------------------------------------------------------------------
const VARIANT_SKU_QUERY = `
  query recoVariantSkus($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { sku product { id } }
    }
  }
`;

const SKU_INDEX_TTL_MS = 24 * 60 * 60 * 1000; // SKUs change only when the catalogue does
const SKU_INDEX_MAX_PAGES = 600;              // 150k variants; the live catalogue needed 398 pages (99,177 SKUs)

async function buildSkuIndex() {
  const map = new Map();
  let after = null;
  let pages = 0;
  const startedAt = Date.now();
  do {
    const data = await shopifyAdminFetch(VARIANT_SKU_QUERY, { first: 250, after });
    const page = data?.productVariants;
    if (!page) break;
    for (const node of page.nodes || []) {
      const sku = (node.sku || '').trim();
      const pid = normalizeId(node.product?.id);
      if (sku && pid) map.set(sku.toUpperCase(), pid);
    }
    pages += 1;
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    if (after && pages >= SKU_INDEX_MAX_PAGES) {
      console.warn(`[RecoSignals] SKU index hit the ${SKU_INDEX_MAX_PAGES}-page ceiling — some SKUs are unmapped`);
      after = null;
    }
  } while (after);
  console.log(`[RecoSignals] SKU index built: ${map.size} variant SKUs (${pages} pages, ${Math.round((Date.now() - startedAt) / 1000)}s)`);
  return map;
}

// The catalogue has ~30k variants, so a full build is 120+ sequential Admin
// calls (minutes). It is cached for a day and deliberately NOT built inside a
// user-facing request: `wait:false` returns whatever is on hand (possibly null)
// and lets the build continue in the background, so an admin preview never
// hangs on it. The nightly run passes wait:true and can afford to block.
let _skuIndex = { value: null, builtAt: 0, building: null };

async function getSkuIndex({ wait = true } = {}) {
  const fresh = _skuIndex.value && (Date.now() - _skuIndex.builtAt) < SKU_INDEX_TTL_MS;
  if (fresh) return _skuIndex.value;

  if (!_skuIndex.building) {
    _skuIndex.building = buildSkuIndex()
      .then((map) => {
        _skuIndex = { value: map, builtAt: Date.now(), building: null };
        return map;
      })
      .catch((err) => {
        _skuIndex.building = null;
        throw err;
      });
  }

  if (!wait) return _skuIndex.value; // stale or null — never block a request
  return _skuIndex.building;
}

// ---------------------------------------------------------------------------
// Money: Shopify Admin orders scan (exact, all channels)
// ---------------------------------------------------------------------------
const ORDERS_QUERY = `
  query recoOrdersScan($query: String!, $after: String) {
    orders(first: 100, query: $query, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        createdAt
        lineItems(first: 50) {
          nodes {
            quantity
            product { id }
            discountedTotalSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

async function shopifyOrderWindows() {
  return getServerCache('reco-signals:orders-30d', async () => {
    const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cut3 = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const cut7 = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const orders = { d3: new Map(), d7: new Map(), d30: new Map() };
    const revenue = { d3: new Map(), d7: new Map(), d30: new Map() };
    const bump = (m, pid, n) => m.set(pid, (m.get(pid) || 0) + n);

    let after = null;
    let pages = 0;
    do {
      const data = await shopifyAdminFetch(ORDERS_QUERY, {
        query: `created_at:>=${sinceIso} status:any`,
        after
      });
      const page = data?.orders;
      if (!page) break;

      for (const order of page.nodes || []) {
        const t = new Date(order.createdAt).getTime();
        const perOrderSeen = new Set(); // an order counts once per product
        for (const li of order.lineItems?.nodes || []) {
          const pid = normalizeId(li.product?.id);
          if (!pid) continue;
          const amount = parseFloat(li.discountedTotalSet?.shopMoney?.amount) || 0;
          bump(revenue.d30, pid, amount);
          if (t >= cut7) bump(revenue.d7, pid, amount);
          if (t >= cut3) bump(revenue.d3, pid, amount);
          if (!perOrderSeen.has(pid)) {
            perOrderSeen.add(pid);
            bump(orders.d30, pid, 1);
            if (t >= cut7) bump(orders.d7, pid, 1);
            if (t >= cut3) bump(orders.d3, pid, 1);
          }
        }
      }

      pages += 1;
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      if (after && pages >= 40) after = null; // 4k orders/30d cap, far above reality
    } while (after);

    console.log(`[RecoSignals] Shopify orders scan: ${pages} pages`);
    return { orders, revenue };
  }, { ttlMs: 60 * 60 * 1000 });
}

// ---------------------------------------------------------------------------
// Combined metric maps
// ---------------------------------------------------------------------------

/**
 * Returns:
 * {
 *   views:   { d3, d7, d30 },      Map<pid, count>
 *   atc:     { d3, d7, d30 },
 *   orders:  { d3, d7, d30 },
 *   revenue: { d3, d7, d30 },
 *   sources: { views: 'ga4'|'beacon', atc: 'ga4'|'carts' },
 *   viewsTrackingSince: 'YYYY-MM-DD'|null   (beacon start date, for the UI)
 * }
 */
async function getMetricMaps(fastify, options = {}) {
  const db = fastify.mongo.db;

  // Only needed to decode GA4 item ids. `waitForSkuIndex` is true for the
  // nightly run (correctness matters more than latency) and false for admin
  // previews (never make a person wait minutes on a catalogue-wide scan).
  const skuIndex = isGa4Configured()
    ? await getSkuIndex({ wait: options.waitForSkuIndex !== false }).catch((err) => {
        console.error('[RecoSignals] SKU index unavailable, GA4 SKU rows dropped this run:', err.message);
        return null;
      })
    : null;

  // GA4 without the SKU index would silently report zero views (its dominant
  // item_id is the variant SKU). Rather than serve misleading zeros, fall back
  // to the first-party beacon and flag the state so the UI can say so.
  const skuIndexPending = isGa4Configured() && !skuIndex;
  const ga4 = skuIndexPending ? null : await getGa4Windows(skuIndex);

  const [beaconViews, cartAtc, money, firstEvent] = await Promise.all([
    ga4 ? Promise.resolve(null) : Promise.all(WINDOWS.map((d) =>
      getServerCache(stableCacheKey(['reco-signals:views', d]), () => beaconWindow(db, d, 'v'), { ttlMs: 15 * 60 * 1000 })
    )),
    ga4 ? Promise.resolve(null) : Promise.all(WINDOWS.map((d) =>
      getServerCache(stableCacheKey(['reco-signals:atc', d]), () => cartAtcWindow(db, d), { ttlMs: 15 * 60 * 1000 })
    )),
    shopifyOrderWindows(),
    db.collection('product_events').find().sort({ d: 1 }).limit(1).toArray().catch(() => [])
  ]);

  const pick = (winMaps, key) => ({
    d3: new Map([...winMaps.d3].map(([pid, m]) => [pid, m[key]]).filter(([, v]) => v > 0)),
    d7: new Map([...winMaps.d7].map(([pid, m]) => [pid, m[key]]).filter(([, v]) => v > 0)),
    d30: new Map([...winMaps.d30].map(([pid, m]) => [pid, m[key]]).filter(([, v]) => v > 0))
  });

  const views = ga4 ? pick(ga4, 'views') : { d3: beaconViews[0], d7: beaconViews[1], d30: beaconViews[2] };
  const atc = ga4 ? pick(ga4, 'atc') : { d3: cartAtc[0], d7: cartAtc[1], d30: cartAtc[2] };

  return {
    views,
    atc,
    orders: money.orders,
    revenue: money.revenue,
    sources: {
      views: ga4 ? 'ga4' : 'beacon',
      atc: ga4 ? 'ga4' : 'carts'
    },
    // True only in the window after a restart while the catalogue-wide SKU
    // index builds in the background. The numbers shown are first-party, not
    // GA4 — the UI says so rather than passing them off as complete.
    skuIndexPending,
    ga4Configured: isGa4Configured(),
    viewsTrackingSince: firstEvent[0]?.d || null
  };
}

module.exports = { getMetricMaps, getSkuIndex, WINDOWS };
