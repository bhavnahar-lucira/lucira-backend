/**
 * Smart Collection Sort — daily performance history.
 *
 * One `smart_sort_stats` doc per (rule, IST date), holding TRUE PER-DAY
 * engagement split into "the top rows" (first TOP_N positions of the current
 * order — the part the sort controls) vs the rest:
 *
 *   views / atc      -> GA4 daily items report (date x itemId, event-pinned),
 *                       first-party beacon + cart timestamps when GA4 is off.
 *   orders / revenue -> Shopify Admin orders scan, bucketed per IST day.
 *
 * Every snapshot pass UPSERTS the whole trailing window (default 15 days), so
 * the history back-fills itself the first time it runs and self-corrects on
 * later passes (GA4 lags a few hours, so "today" firms up overnight). Two
 * honesty rules:
 *   - liveVersionId is stamped only on TODAY's doc (we know what is live now,
 *     not what was live last Tuesday); older docs keep whatever they have —
 *     that per-day stamp is what powers the per-version comparison.
 *   - docs created for days before yesterday are marked backfilled: the
 *     top-vs-rest split there uses the CURRENT product order, because the
 *       historical order was not recorded.
 */

const { getSkuIndex } = require('./recoSignals');
const { scanCollection, normalizeId } = require('./recommendations');
const { getGa4DailyMaps, isGa4Configured } = require('./ga4');
const { shopifyAdminFetch } = require('./shopify');
const { getServerCache } = require('./cache');

const TOP_N = 24;           // six rows of four on the storefront grid
const DEFAULT_DAYS = 15;

const istDateOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istToday = () => istDateOf(Date.now());

// The trailing `days` IST dates, oldest first, ending today.
const dateRange = (days) => {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(istDateOf(Date.now() - i * 24 * 60 * 60 * 1000));
  return out;
};

// ---------------------------------------------------------------------------
// Daily money from Shopify (exact, all channels), bucketed per IST day.
// ---------------------------------------------------------------------------
const DAILY_ORDERS_QUERY = `
  query smartStatsOrdersScan($query: String!, $after: String) {
    orders(first: 250, query: $query, after: $after) {
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

async function getDailyOrderMaps(days) {
  return getServerCache('smart-stats:orders-daily:' + days, async () => {
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const orders = new Map();  // date -> Map<pid, count>
    const revenue = new Map(); // date -> Map<pid, amount>
    const bump = (byDate, date, pid, n) => {
      if (!byDate.has(date)) byDate.set(date, new Map());
      const m = byDate.get(date);
      m.set(pid, (m.get(pid) || 0) + n);
    };

    let after = null;
    let pages = 0;
    do {
      const data = await shopifyAdminFetch(DAILY_ORDERS_QUERY, {
        query: `created_at:>=${sinceIso} status:any`,
        after
      }, { priority: 'background' });
      const page = data?.orders;
      if (!page) break;
      for (const order of page.nodes || []) {
        const date = istDateOf(order.createdAt);
        const perOrderSeen = new Set();
        for (const li of order.lineItems?.nodes || []) {
          const pid = normalizeId(li.product?.id);
          if (!pid) continue;
          bump(revenue, date, pid, parseFloat(li.discountedTotalSet?.shopMoney?.amount) || 0);
          if (!perOrderSeen.has(pid)) {
            perOrderSeen.add(pid);
            bump(orders, date, pid, 1);
          }
        }
      }
      pages += 1;
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      if (after && pages >= 40) after = null;
    } while (after);

    return { orders, revenue };
  }, { ttlMs: 6 * 60 * 60 * 1000 });
}

// ---------------------------------------------------------------------------
// First-party fallbacks when GA4 is not configured: the view beacon keeps a
// per-day counter already; ATC comes from cart item timestamps.
// ---------------------------------------------------------------------------
async function getBeaconDailyMaps(db, days) {
  const since = dateRange(days)[0];
  const views = new Map();
  try {
    const rows = await db.collection('product_events').aggregate([
      { $match: { d: { $gte: since } } },
      { $group: { _id: { d: '$d', pid: '$pid' }, c: { $sum: '$v' } } }
    ]).toArray();
    for (const r of rows) {
      const date = r._id.d;
      const pid = String(r._id.pid);
      if (!views.has(date)) views.set(date, new Map());
      views.get(date).set(pid, (views.get(date).get(pid) || 0) + r.c);
    }
  } catch (_) { /* collection may not exist */ }

  const atc = new Map();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  for (const coll of ['carts', 'abandoned_carts']) {
    try {
      const rows = await db.collection(coll).aggregate([
        { $unwind: '$items' },
        { $match: { 'items.productId': { $ne: null }, 'items.addedAt': { $gte: cutoff } } },
        {
          $group: {
            _id: {
              d: { $dateToString: { format: '%Y-%m-%d', date: '$items.addedAt', timezone: 'Asia/Kolkata' } },
              pid: '$items.productId'
            },
            c: { $sum: 1 }
          }
        }
      ], { allowDiskUse: true }).toArray();
      for (const r of rows) {
        const date = r._id.d;
        const pid = normalizeId(r._id.pid);
        if (!pid) continue;
        if (!atc.has(date)) atc.set(date, new Map());
        atc.get(date).set(pid, (atc.get(date).get(pid) || 0) + r.c);
      }
    } catch (_) { /* best effort */ }
  }
  return { views, atc };
}

// ---------------------------------------------------------------------------
// The snapshot pass — upserts one doc per day of the trailing window.
// ---------------------------------------------------------------------------
/**
 * Snapshot ONE collection's daily top-vs-rest history.
 *
 * Keyed by (ruleId, collectionHandle, date) rather than (ruleId, date) so the
 * GLOBAL rule can report on collections it covers but does not own — it has no
 * collection of its own, which is why its Performance tab was empty. A
 * per-collection rule simply passes its own collection and behaves as before.
 *
 * The only per-collection cost here is scanCollection: the GA4 daily maps and
 * the Shopify daily orders are fetched once and shared by every collection in
 * the same pass, which is what makes checking an extra collection cheap.
 */
async function snapshotStatsFor(fastify, target, { days = DEFAULT_DAYS, waitForSkuIndex = false } = {}) {
  const db = fastify.mongo.db;
  const { ruleId, collectionId, collectionHandle, liveVersionId = null } = target;
  if (!collectionId) return { days: 0, skipped: 'no-collection' };

  const skuIndex = isGa4Configured()
    ? await getSkuIndex({ wait: waitForSkuIndex }).catch(() => null)
    : null;

  const [products, ga4Daily, moneyDaily] = await Promise.all([
    scanCollection(collectionId),
    getGa4DailyMaps(skuIndex, days),
    getDailyOrderMaps(days)
  ]);
  const engagement = ga4Daily || await getBeaconDailyMaps(db, days);

  // The scan is in the collection's current order; slice(0, TOP_N) IS the top
  // rows as shoppers see them today. Non-live products are invisible anyway.
  const live = products.filter((p) => p.status === 'ACTIVE' && p.published !== false);
  const topIds = live.slice(0, TOP_N).map((p) => normalizeId(p.id));
  const restIds = live.slice(TOP_N).map((p) => normalizeId(p.id));

  const today = istToday();
  const yesterday = istDateOf(Date.now() - 24 * 60 * 60 * 1000);
  const col = db.collection('smart_sort_stats');

  const sumFor = (ids, byDateMap, date) => {
    const m = byDateMap.get(date);
    if (!m) return 0;
    let total = 0;
    for (const pid of ids) total += m.get(pid) || 0;
    return total;
  };

  let written = 0;
  for (const date of dateRange(days)) {
    const bucket = (ids) => ({
      views: sumFor(ids, engagement.views, date),
      atc: sumFor(ids, engagement.atc, date),
      orders: sumFor(ids, moneyDaily.orders, date),
      revenue: Math.round(sumFor(ids, moneyDaily.revenue, date))
    });

    const $set = {
      ruleId: String(ruleId),
      collectionHandle,
      // Stored so the admin can act on the collection (watch it, open it)
      // straight from a stats row, without another lookup by handle.
      collectionId,
      date,
      windowDays: 1,
      topN: TOP_N,
      products: live.length,
      top: bucket(topIds),
      rest: bucket(restIds),
      sources: { engagement: ga4Daily ? 'ga4' : 'beacon', money: 'shopify' },
      updatedAt: new Date()
    };
    // Only today's doc is stamped with what is live NOW; older days keep the
    // stamp they were given on their own day (or none, when backfilled).
    if (date === today) $set.liveVersionId = liveVersionId || null;

    await col.updateOne(
      { ruleId: $set.ruleId, collectionHandle: $set.collectionHandle, date },
      {
        $set,
        $setOnInsert: {
          // A doc created for a day before yesterday is a reconstruction: the
          // engagement numbers are real, but the top-vs-rest split uses the
          // current order because the historical order was not recorded.
          ...(date < yesterday ? { backfilled: true, liveVersionId: null } : {}),
          ...(date !== today && date >= yesterday ? { liveVersionId: liveVersionId || null } : {})
        }
      },
      { upsert: true }
    );
    written += 1;
  }
  return { days: written, source: ga4Daily ? 'ga4' : 'beacon', collectionHandle, products: live.length };
}

// A rule's OWN collection. The global rule has none, so it reports nothing
// here — its numbers come from the watched collections below instead.
async function snapshotStatsForRule(fastify, rule, opts = {}) {
  if (!rule.collectionId) return { days: 0, skipped: 'global' };
  return snapshotStatsFor(fastify, {
    ruleId: String(rule._id),
    collectionId: rule.collectionId,
    collectionHandle: rule.collectionHandle,
    liveVersionId: rule.liveVersionId
  }, opts);
}

/**
 * ANY collection, filed under `rule`'s stats. This is what lets the global
 * rule answer "how is this collection doing" for something it orders but does
 * not own. `collection` is { id, handle } straight from the picker.
 */
async function snapshotStatsForCollection(fastify, rule, collection, opts = {}) {
  if (!collection || !collection.id || !collection.handle) {
    return { days: 0, skipped: 'no-collection' };
  }
  return snapshotStatsFor(fastify, {
    ruleId: String(rule._id),
    collectionId: collection.id,
    collectionHandle: collection.handle,
    liveVersionId: rule.liveVersionId
  }, opts);
}

// Nightly pass. Failures are per-collection: one broken scan must not cost the
// others their day of data.
//
// Watched collections are refreshed too, and ONLY watched ones — opening a
// collection in the Performance tab to look at it must not quietly commit the
// shop to a scan of it every night forever. Watching is the explicit opt-in.
async function snapshotAllStats(fastify) {
  const rules = await fastify.mongo.db.collection('smart_sort_rules')
    .find({ enabled: true }).toArray();
  let collections = 0;
  for (const rule of rules) {
    try {
      const r = await snapshotStatsForRule(fastify, rule, { waitForSkuIndex: true });
      if (r.days) collections += 1;
    } catch (err) {
      console.error(`[SmartSortStats] Snapshot failed for "${rule.collectionHandle}":`, err.message);
    }
    for (const watched of rule.watchedCollections || []) {
      try {
        const r = await snapshotStatsForCollection(fastify, rule, watched, { waitForSkuIndex: true });
        if (r.days) collections += 1;
      } catch (err) {
        console.error(`[SmartSortStats] Watched snapshot failed for "${watched && watched.handle}":`, err.message);
      }
    }
  }
  if (collections) console.log(`[SmartSortStats] Daily snapshot done for ${collections} collection(s)`);
}

module.exports = {
  snapshotStatsFor,
  snapshotStatsForRule,
  snapshotStatsForCollection,
  snapshotAllStats,
  TOP_N,
  DEFAULT_DAYS
};
