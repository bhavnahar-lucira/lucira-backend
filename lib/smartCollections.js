/**
 * Smart Collection Sort Engine
 *
 * Orders the products of ONE Shopify collection from percentage-slot rules
 * built in lucira-admin (Mongo `smart_sort_rules`), then WRITES that order
 * into Shopify itself: the collection's sortOrder is switched to MANUAL and
 * the sequence is pushed with collectionReorderProducts. The storefront is
 * headless but reads collections in their default order, so a pushed sequence
 * propagates everywhere with no frontend change. Only collections that have a
 * rule here are ever touched — everything else keeps its Shopify ordering.
 *
 * A rule reads:
 *
 *   slots    - ordered percentage claims on the collection, e.g.
 *              "First 20% -> in stock, ranked by views (30d)",
 *              "Next 10% -> ranked by add-to-carts (30d)".
 *              Sizes are % of the collection's VISIBLE product count; slots
 *              draw top-down from whatever the earlier slots left, so a
 *              product appears exactly once. A slot that matches fewer
 *              products than its size passes the deficit on — no gaps.
 *   remainderSortBy - how everything unclaimed is ordered after the slots.
 *              The special key "current" keeps their existing relative order,
 *              which also minimises the number of Shopify moves.
 *   pinned   - hand-picked products that occupy the very first positions.
 *   removed  - products pushed to the END. A smart collection's membership is
 *              owned by Shopify rules, so "remove" here means demote — the
 *              admin UI says "move to end" for exactly that reason.
 *   positions - hand-placed products at an EXACT position, curated by dragging
 *              tiles in the admin's curate preview. Sparse: only the products
 *              actually moved by hand are listed, so fixing one position
 *              leaves the rest of the collection automated.
 *   settings.oosToEnd - unbuyable products skip the slots and sit at the end
 *              (still before `removed` and non-live products).
 *
 * Final order: pinned -> slot 1..n -> remainder -> out-of-stock tail (when
 * oosToEnd) -> removed -> non-live products (DRAFT/unpublished — invisible on
 * the storefront anyway, parked last so they never soak up a slot). Hand-placed
 * positions are spliced into that sequence last, so an explicit human decision
 * beats every automatic one.
 *
 * The attribute registry, condition evaluator, comparators, scans and metric
 * maps are all shared with lib/recommendations.js — same vocabulary, same
 * data sources (GA4 / beacon for views+ATC, Shopify for money).
 *
 * Exports:
 *   computeOrderForRule(fastify, rule)      - pure compute, no writes
 *   previewSmartRule(fastify, rule)         - dry run, admin preview shape
 *   runSmartRule(fastify, rule, trigger)    - ensure MANUAL + push the order
 *   getProductInsights(fastify, productId)  - everything about one product
 *   searchProductsForInsights(query)        - insights search box
 *   SMART_SORT_KEYS                         - sort vocabulary for the admin
 *   runningSmartRules                       - in-process guard behind run 409s
 */

const { shopifyAdminFetch } = require('./shopify');
const { getServerCache, stableCacheKey } = require('./cache');
const { getMetricMaps } = require('./recoSignals');
const {
  ATTRIBUTES,
  SORT_KEYS,
  attrValue,
  scanCollection,
  evalConditions,
  buildComparator,
  getPopularityMaps,
  popularityCountFor,
  normalizeId
} = require('./recommendations');

const MAX_RUN_ERRORS = 20;
const MOVE_BATCH_SIZE = 250;        // collectionReorderProducts hard cap per call
const JOB_POLL_MS = 1500;
const JOB_POLL_MAX = 40;            // ~60s per chunk before giving up

// The GLOBAL rule: one ordering strategy applied to every collection that has
// no rule of its own. Reserved handle so the unique index on collectionHandle
// allows exactly one; collectionId is null.
const ALL_COLLECTIONS_HANDLE = '__all_collections__';
const isGlobalRule = (rule) => rule && rule.collectionHandle === ALL_COLLECTIONS_HANDLE;
// A store-wide pass over ~1000 collections runs for a long time; progress is
// heartbeaten onto the run doc so the stale-run guard can tell "still going"
// from "crashed".
const GLOBAL_PASS_MAX_MS = 6 * 60 * 60 * 1000;

const runningSmartRules = new Set();

// Product ids travel as GIDs everywhere in the engine; rule fields curated in
// the admin may carry either shape.
const toGid = (id) => (String(id).startsWith('gid://') ? String(id) : 'gid://shopify/Product/' + normalizeId(id));

// Sort vocabulary for slot ranking. Source-relative keys (best match, price
// proximity) need a "product being viewed" and mean nothing for a whole
// collection, so they are dropped; "current" (keep Shopify's existing order)
// is added because it is the cheapest possible remainder — zero moves.
const SMART_SORT_KEYS = Object.fromEntries(
  Object.entries(SORT_KEYS).filter(([key]) => !['score', 'price_proximity'].includes(key))
);
SMART_SORT_KEYS.current = { label: 'Current Shopify order' };
// The Kimonix-style blend: several metrics, each with a weight, rank-combined
// into one 0-100 score per product. The weights live ON the sortBy entry
// ({ key: 'weighted', weights: { views_7d: 45, atc_7d: 35, ... } }).
SMART_SORT_KEYS.weighted = { label: 'Balanced score (weighted mix)', weighted: true };

// Metrics a weight can be put on: every numeric, directional sort key plus
// "newest". Explicitly NOT price_asc/price_desc (a direction, not a quantity)
// and not current/weighted themselves.
const WEIGHTABLE_KEYS = Object.keys(SMART_SORT_KEYS).filter(
  (k) => !['current', 'weighted', 'price_asc', 'price_desc'].includes(k)
);

// One metric's raw value for the blend. Mirrors buildComparator's keyValue for
// the keys the blend accepts.
function metricValue(key, p, ctx) {
  if (key === 'newest') return p.createdAt || 0;
  if (key === 'popularity') return ctx.popCache.get(p.id) || 0;
  return Number(attrValue(key, p, ctx)) || 0;
}

// ---------------------------------------------------------------------------
// The weighted blend. RANK-normalized, not min-max: one viral product would
// otherwise flatten everyone else's contribution on that metric to ~0.
// Ties share their average rank so the hundreds of products with zero views
// stay tied instead of being ordered by scan position. Result: 0..1 per
// product, where 1 means "best in this pool on every weighted metric".
// ---------------------------------------------------------------------------
function weightedScores(pool, weights, ctx) {
  const scores = new Map(pool.map((p) => [p.id, 0]));
  const entries = Object.entries(weights || {})
    .filter(([k, w]) => WEIGHTABLE_KEYS.includes(k) && Number(w) > 0);
  if (!entries.length || pool.length < 2) return scores;

  const totalWeight = entries.reduce((a, [, w]) => a + Number(w), 0);
  for (const [key, w] of entries) {
    const share = Number(w) / totalWeight;
    const vals = pool.map((p) => ({ id: p.id, v: metricValue(key, p, ctx) }));
    vals.sort((a, b) => a.v - b.v);
    let i = 0;
    while (i < vals.length) {
      let j = i;
      while (j + 1 < vals.length && vals[j + 1].v === vals[i].v) j += 1;
      const norm = ((i + j) / 2) / (vals.length - 1); // 0 = worst, 1 = best
      for (let t = i; t <= j; t++) scores.set(vals[t].id, scores.get(vals[t].id) + share * norm);
      i = j + 1;
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Current live order of a collection — a cheap id-only scan, NOT the cached
// product scan: the run must diff against what Shopify holds RIGHT NOW, and
// the shared scan cache can be up to 10 minutes stale.
// ---------------------------------------------------------------------------
const ORDER_SCAN_QUERY = `
  query smartSortOrderScan($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      id
      handle
      sortOrder
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

async function fetchLiveOrder(collectionId) {
  const ids = [];
  let after = null;
  let sortOrder = null;
  let pages = 0;
  do {
    const data = await shopifyAdminFetch(ORDER_SCAN_QUERY, { id: collectionId, first: 250, after });
    const coll = data?.collection;
    if (!coll) throw new Error('Collection not found in Shopify: ' + collectionId);
    sortOrder = coll.sortOrder;
    for (const node of coll.products?.nodes || []) if (node?.id) ids.push(node.id);
    pages += 1;
    after = coll.products?.pageInfo?.hasNextPage ? coll.products.pageInfo.endCursor : null;
    if (after && pages >= 40) after = null; // 10k products, far above reality
  } while (after);
  return { ids, sortOrder };
}

// ---------------------------------------------------------------------------
// Compute context — same ingredients as the reco engine's, minus everything
// source-product related.
// ---------------------------------------------------------------------------
async function buildSmartContext(fastify, rule) {
  const [products, popMaps, metrics] = await Promise.all([
    scanCollection(rule.collectionId),
    getPopularityMaps(fastify),
    getMetricMaps(fastify, { waitForSkuIndex: false }).catch((err) => {
      console.error('[SmartSort] Metric maps unavailable, using zeros:', err.message);
      const empty = () => ({ d3: new Map(), d7: new Map(), d30: new Map() });
      return { views: empty(), atc: empty(), orders: empty(), revenue: empty(), sources: {}, viewsTrackingSince: null };
    })
  ]);

  // in_collection conditions need the referenced collections' membership sets.
  const collectionSets = new Map();
  const condCollectionIds = new Set();
  for (const slot of rule.slots || []) {
    for (const c of slot.conditions || []) {
      if (ATTRIBUTES[c.attr]?.kind === 'collection' && c.value) condCollectionIds.add(String(c.value));
    }
  }
  for (const cid of condCollectionIds) {
    try {
      const prods = await scanCollection(cid);
      collectionSets.set(cid, new Set(prods.map((p) => p.id)));
    } catch (err) {
      console.warn(`[SmartSort] in_collection scan failed for ${cid}: ${err.message}`);
      collectionSets.set(cid, new Set());
    }
  }

  const popCache = new Map();
  let maxPop = 0;
  for (const p of products) {
    const c = popularityCountFor(popMaps, p.id);
    popCache.set(p.id, c);
    if (c > maxPop) maxPop = c;
  }

  return {
    products,
    byId: new Map(products.map((p) => [p.id, p])),
    collectionSets,
    popCache,
    maxPop,
    metrics,
    avgCache: new Map(),
    currentPool: products,
    collectionPool: products,
    catalogPool: products
  };
}

// Sort a pool by a slot's sortBy. "current" keeps the existing collection
// order (the scan is already in collection order, so the original index IS
// the current position). "weighted" blends several metrics into one score —
// returned alongside the order so the preview can show WHY a tile ranks.
function rankPool(pool, sortBy, ctx, indexOf) {
  const first = sortBy && sortBy[0];
  const key = first && first.key;
  if (!key || key === 'current') {
    return {
      sorted: [...pool].sort((a, b) => (indexOf.get(a.id) || 0) - (indexOf.get(b.id) || 0)),
      scores: null
    };
  }
  if (key === 'weighted') {
    const scores = weightedScores(pool, first.weights, ctx);
    const mul = first.dir === 'asc' ? -1 : 1;
    const sorted = [...pool].sort((a, b) =>
      ((scores.get(b.id) || 0) - (scores.get(a.id) || 0)) * mul ||
      (indexOf.get(a.id) || 0) - (indexOf.get(b.id) || 0));
    return { sorted, scores };
  }
  return { sorted: [...pool].sort(buildComparator(sortBy, null, new Map(), ctx)), scores: null };
}

// ---------------------------------------------------------------------------
// Hand-placed positions — the LAST step of the ordering.
//
// `rule.positions` is a SPARSE list of { id, position } curated by hand in the
// admin's curate preview (drag a tile, or type a position). Only the products
// actually moved by hand are listed: everything else keeps the order the slots
// computed, so fixing one position does not freeze the whole collection.
//
// Semantics, deliberately simple so the admin can predict it exactly:
//   - placements apply in ascending position order;
//   - each is spliced into index position-1 of the list built so far (clamped
//     to the end), stepping past any earlier placement already sitting there,
//     so two products claiming the same position land at N and N+1 in the
//     order they were curated;
//   - an id no longer in the collection is ignored, not an error.
//
// lucira-admin/src/app/(protected)/dashboard/smart-collection/_shared.js
// carries the SAME function so the admin can show a drag instantly without a
// round trip. The two must agree exactly — change both together.
// ---------------------------------------------------------------------------
function applyManualPositions(ordered, positions) {
  const list = Array.isArray(positions) ? positions : [];
  if (!list.length) return { ordered, placements: new Map() };

  const present = new Set(ordered.map((p) => p.id));
  const seen = new Set();
  const wanted = [];
  list.forEach((entry, seq) => {
    const id = entry && entry.id ? toGid(entry.id) : null;
    const position = Math.round(Number(entry && entry.position));
    if (!id || !present.has(id) || seen.has(id)) return;
    if (!Number.isFinite(position) || position < 1) return;
    seen.add(id);
    wanted.push({ id, position, seq });
  });
  if (!wanted.length) return { ordered, placements: new Map() };

  wanted.sort((a, b) => a.position - b.position || a.seq - b.seq);

  const byId = new Map(ordered.map((p) => [p.id, p]));
  const out = ordered.filter((p) => !seen.has(p.id));
  const done = new Set();
  for (const w of wanted) {
    let idx = Math.max(0, Math.min(w.position - 1, out.length));
    while (idx < out.length && done.has(out[idx].id)) idx += 1;
    out.splice(idx, 0, byId.get(w.id));
    done.add(w.id);
  }

  return { ordered: out, placements: new Map(wanted.map((w) => [w.id, w.position])) };
}

// ---------------------------------------------------------------------------
// computeOrderForRule — the whole ordering, NO writes.
//
// Returns { ordered, assignments, ctx, summary } where `ordered` is the full
// product list in final order and `assignments` maps product id -> the reason
// it sits where it does (pinned / slot label / remainder / oos / removed /
// hidden).
// ---------------------------------------------------------------------------
async function computeOrderForRule(fastify, rule) {
  const ctx = await buildSmartContext(fastify, rule);
  const { products } = ctx;

  const indexOf = new Map(products.map((p, i) => [p.id, i]));
  const assignments = new Map();
  const assign = (p, tag) => { if (!assignments.has(p.id)) assignments.set(p.id, tag); };

  const removedSet = new Set((rule.removed || []).map(toGid));
  const oosToEnd = rule.settings?.oosToEnd !== false;

  // Non-live products (DRAFT / unpublished) are invisible on the storefront —
  // they never earn a slot and are parked at the very end.
  const live = [];
  const hidden = [];
  for (const p of products) (p.status === 'ACTIVE' && p.published !== false ? live : hidden).push(p);

  // 1) Pins — first positions, in the order they were pinned.
  const pinned = [];
  for (const gid of (rule.pinned || []).map(toGid)) {
    const p = ctx.byId.get(gid);
    if (p && !removedSet.has(gid) && !assignments.has(gid) && live.includes(p)) {
      pinned.push(p);
      assign(p, { kind: 'pinned', label: 'Pinned' });
    }
  }

  // 2) The working pool: live, not pinned, not removed; out-of-stock split off
  //    when the guardrail is on.
  let pool = live.filter((p) => !assignments.has(p.id) && !removedSet.has(p.id));
  let oosTail = [];
  if (oosToEnd) {
    oosTail = pool.filter((p) => !p.buyable);
    pool = pool.filter((p) => p.buyable);
  }

  // Slot sizes are % of the collection's visible (live) product count — "first
  // 20% of a 100-product collection" reads as 20 products, whatever else is
  // pinned or demoted.
  const sizingBase = live.length;

  // 3) Slots, top-down over the remaining pool.
  const slotFill = [];
  const slotProducts = [];
  (rule.slots || []).forEach((slot, i) => {
    const size = Math.max(0, Math.round(((Number(slot.sizePercent) || 0) / 100) * sizingBase));
    const label = slot.label || `Slot ${i + 1}`;
    ctx.currentPool = pool; // scopes above/below-average to what is left
    const survivors = pool.filter((p) => evalConditions(p, null, slot.conditions || [], ctx));
    const { sorted, scores } = rankPool(survivors, slot.sortBy, ctx, indexOf);
    const chosen = sorted.slice(0, size);
    for (const p of chosen) {
      assign(p, {
        kind: 'slot', slotIndex: i, label,
        ...(scores ? { score: Math.round((scores.get(p.id) || 0) * 100) } : {})
      });
    }
    const chosenIds = new Set(chosen.map((p) => p.id));
    pool = pool.filter((p) => !chosenIds.has(p.id));
    slotProducts.push(chosen);
    slotFill.push({ label, sizePercent: Number(slot.sizePercent) || 0, size, matched: survivors.length, filled: chosen.length });
  });

  // 4) Remainder — everything the slots left, in the chosen fallback order.
  ctx.currentPool = pool;
  const { sorted: remainder, scores: remainderScores } = rankPool(pool, rule.remainderSortBy, ctx, indexOf);
  for (const p of remainder) {
    assign(p, {
      kind: 'remainder', label: 'Remaining',
      ...(remainderScores ? { score: Math.round((remainderScores.get(p.id) || 0) * 100) } : {})
    });
  }

  // 5) Tails.
  const removed = [];
  for (const gid of removedSet) {
    const p = ctx.byId.get(gid);
    if (p && !assignments.has(gid)) { removed.push(p); assign(p, { kind: 'removed', label: 'Moved to end' }); }
  }
  for (const p of oosTail) assign(p, { kind: 'oos', label: 'Out of stock' });
  for (const p of hidden) assign(p, { kind: 'hidden', label: 'Not live' });

  // 6) The automated order, then the hand-placed overrides on top of it. Both
  //    are reported: the admin shows where a product WOULD sit without the
  //    hand placement, and re-applies drags locally from the same base.
  const autoOrdered = [...pinned, ...slotProducts.flat(), ...remainder, ...oosTail, ...removed, ...hidden];
  const autoIndexOf = new Map(autoOrdered.map((p, i) => [p.id, i]));
  const { ordered, placements } = applyManualPositions(autoOrdered, rule.positions);

  return {
    ordered,
    assignments,
    indexOf,
    autoIndexOf,
    placements,
    ctx,
    summary: {
      totalProducts: products.length,
      liveProducts: live.length,
      pinned: pinned.length,
      removed: removed.length,
      outOfStock: oosTail.length,
      hidden: hidden.length,
      handPlaced: placements.size,
      slotFill
    }
  };
}

// ---------------------------------------------------------------------------
// Move planning — replay Shopify's sequential-move semantics over a simulated
// list so only positions that actually change cost a move.
// ---------------------------------------------------------------------------
function planMoves(currentIds, targetIds) {
  const targetSet = new Set(targetIds);
  // Products that joined the collection after our scan keep their spot; they
  // get placed properly on the next run.
  const sim = currentIds.filter((id) => targetSet.has(id));
  const simSet = new Set(sim);
  const target = targetIds.filter((id) => simSet.has(id));

  const moves = [];
  for (let i = 0; i < target.length; i++) {
    if (sim[i] === target[i]) continue;
    const j = sim.indexOf(target[i], i);
    if (j === -1) continue;
    sim.splice(j, 1);
    sim.splice(i, 0, target[i]);
    // UInt64 scalar — serialized as a string.
    moves.push({ id: target[i], newPosition: String(i) });
  }
  return moves;
}

// ---------------------------------------------------------------------------
// Shopify writes
// ---------------------------------------------------------------------------
const ENSURE_MANUAL_MUTATION = `
  mutation smartSortEnsureManual($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id sortOrder }
      userErrors { field message }
    }
  }
`;

const REORDER_MUTATION = `
  mutation smartSortReorder($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const JOB_QUERY = `
  query smartSortJob($id: ID!) {
    job(id: $id) { id done }
  }
`;

async function waitForJob(jobId) {
  for (let i = 0; i < JOB_POLL_MAX; i++) {
    const data = await shopifyAdminFetch(JOB_QUERY, { id: jobId });
    if (data?.job?.done !== false) return true;
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Every collection in the store — the global rule's work list. Cached 1h;
// membership changes don't need to be fresher than the daily pass.
// ---------------------------------------------------------------------------
const ALL_COLLECTIONS_QUERY = `
  query smartSortAllCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title sortOrder productsCount { count } }
    }
  }
`;

async function listAllCollections() {
  return getServerCache('smart-sort:all-collections', async () => {
    const out = [];
    let after = null;
    let pages = 0;
    do {
      const data = await shopifyAdminFetch(ALL_COLLECTIONS_QUERY, { first: 250, after });
      const page = data?.collections;
      if (!page) break;
      for (const node of page.nodes || []) {
        out.push({
          id: node.id,
          handle: node.handle,
          title: node.title,
          sortOrder: node.sortOrder,
          productsCount: node.productsCount?.count ?? 0
        });
      }
      pages += 1;
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      if (after && pages >= 20) after = null; // 5k collections, far above reality
    } while (after);
    console.log(`[SmartSort] Collection list: ${out.length} collections (${pages} pages)`);
    return out;
  }, { ttlMs: 60 * 60 * 1000 });
}

// ---------------------------------------------------------------------------
// The write path for ONE collection: compute, ensure MANUAL, push the moves.
// Shared by the per-collection sync and the global pass.
// ---------------------------------------------------------------------------
async function pushOrderForCollection(fastify, rule, { onWarn } = {}) {
  const [{ ordered }, liveOrder] = await Promise.all([
    computeOrderForRule(fastify, rule),
    fetchLiveOrder(rule.collectionId)
  ]);
  const out = { totalProducts: liveOrder.ids.length, moves: 0, chunks: 0, sortOrderChanged: false };

  // The order can only be written to a MANUAL collection. Switching a smart
  // (automated) collection to MANUAL is allowed and keeps its rules; Shopify
  // simply stops re-sorting it, which is exactly what we want.
  if (liveOrder.sortOrder !== 'MANUAL') {
    const data = await shopifyAdminFetch(ENSURE_MANUAL_MUTATION, {
      input: { id: rule.collectionId, sortOrder: 'MANUAL' }
    });
    const userErrors = data?.collectionUpdate?.userErrors || [];
    if (userErrors.length) {
      throw new Error('Could not switch the collection to manual sorting: ' + userErrors.map((e) => e.message).join('; '));
    }
    out.sortOrderChanged = true;
  }

  const moves = planMoves(liveOrder.ids, ordered.map((p) => p.id));
  out.moves = moves.length;

  for (let i = 0; i < moves.length; i += MOVE_BATCH_SIZE) {
    const batch = moves.slice(i, i + MOVE_BATCH_SIZE);
    const data = await shopifyAdminFetch(REORDER_MUTATION, { id: rule.collectionId, moves: batch });
    const userErrors = data?.collectionReorderProducts?.userErrors || [];
    if (userErrors.length) {
      throw new Error('Shopify rejected the reorder: ' + userErrors.map((e) => e.message).join('; '));
    }
    out.chunks += 1;
    const jobId = data?.collectionReorderProducts?.job?.id;
    // Moves are applied sequentially; a later chunk builds on the earlier one,
    // so each chunk's async job must finish before the next is sent.
    if (jobId && i + MOVE_BATCH_SIZE < moves.length) {
      const done = await waitForJob(jobId);
      if (!done && onWarn) onWarn('Reorder job did not report completion in time; later chunks may have applied out of order');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// previewSmartRule — DRY RUN. The full computed order with per-product
// metrics, slot attribution and old->new movement, so the admin sees exactly
// what a sync would push before anything is written.
// ---------------------------------------------------------------------------
async function previewSmartRule(fastify, rule) {
  const { ordered, assignments, indexOf, autoIndexOf, placements, ctx, summary } = await computeOrderForRule(fastify, rule);

  const m = (group, win, p) => ctx.metrics[group][win].get(normalizeId(p.id)) || 0;
  const products = ordered.map((p, newIndex) => {
    const tag = assignments.get(p.id) || { kind: 'remainder', label: 'Remaining' };
    const oldIndex = indexOf.get(p.id) ?? newIndex;
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      image: p.image,
      price: p.price,
      compareAtPrice: p.compareAtPrice || 0,
      // Buyable and stocked are DIFFERENT things in this catalogue: most
      // variants sit at inventoryQuantity 0 with inventoryPolicy CONTINUE, so
      // they are purchasable made-to-order. Both are reported; the admin
      // labels them apart instead of calling everything "in stock".
      inStock: p.buyable,
      inventory: p.totalInventory,
      tracksInventory: p.tracksInventory !== false,
      status: p.status,
      position: newIndex + 1,
      oldPosition: oldIndex + 1,
      delta: oldIndex - newIndex, // positive = moved up
      // Where the rules alone would have put it — the admin re-applies a drag
      // over this order, so a dragged tile never disagrees with the engine.
      autoPosition: (autoIndexOf.get(p.id) ?? newIndex) + 1,
      handPlaced: placements.has(p.id),
      handPosition: placements.get(p.id) ?? null,
      kind: tag.kind,
      slotLabel: tag.label,
      slotIndex: tag.slotIndex ?? null,
      // Present only when the placing rule ranked by the weighted blend:
      // 0-100, "how good is this product across the blend's metrics".
      score: tag.score ?? null,
      metrics: {
        views30: m('views', 'd30', p),
        atc30: m('atc', 'd30', p),
        orders30: m('orders', 'd30', p),
        revenue30: Math.round(m('revenue', 'd30', p)),
        popularity: ctx.popCache.get(p.id) || 0
      }
    };
  });

  const movesCount = products.filter((p) => p.delta !== 0).length;
  return {
    products,
    summary: { ...summary, movesCount },
    metricSources: { ...(ctx.metrics.sources || {}), skuIndexPending: ctx.metrics.skuIndexPending === true }
  };
}

// ---------------------------------------------------------------------------
// runSmartRule — the real sync: ensure MANUAL, push the order in chunks,
// poll each chunk's job, bookkeep in `smart_sort_runs`.
// ---------------------------------------------------------------------------
async function runSmartRule(fastify, rule, trigger, opts = {}) {
  const db = fastify.mongo.db;
  const runsCol = db.collection('smart_sort_runs');
  const rulesCol = db.collection('smart_sort_rules');
  const ruleKey = String(rule._id);

  if (!opts.preAcquired) {
    if (runningSmartRules.has(ruleKey)) throw new Error('A sync for this collection is already in progress');
    runningSmartRules.add(ruleKey);
  }

  const startedAt = new Date();
  const runDoc = {
    ruleId: ruleKey,
    collectionHandle: rule.collectionHandle,
    trigger,
    status: 'running',
    startedAt,
    finishedAt: null,
    totalProducts: 0,
    moves: 0,
    chunks: 0,
    sortOrderChanged: false,
    errors: [],
    durationMs: null
  };
  if (opts.runId) runDoc._id = opts.runId;

  const stats = { totalProducts: 0, moves: 0, chunks: 0, sortOrderChanged: false };
  const errors = [];
  const pushError = (msg) => { if (errors.length < MAX_RUN_ERRORS) errors.push(String(msg).slice(0, 300)); };

  try {
    const inserted = await runsCol.insertOne(runDoc);
    const runId = runDoc._id || inserted.insertedId;
    console.log(`[SmartSort] Sync started (${trigger}) for "${rule.collectionHandle}" — runId ${runId}`);

    try {
      const result = await pushOrderForCollection(fastify, rule, { onWarn: pushError });
      stats.totalProducts = result.totalProducts;
      stats.moves = result.moves;
      stats.chunks = result.chunks;
      stats.sortOrderChanged = result.sortOrderChanged;

      const finishedAt = new Date();
      await runsCol.updateOne(
        { _id: runId },
        { $set: { status: 'completed', finishedAt, durationMs: finishedAt - startedAt, ...stats, errors } }
      );
      await rulesCol.updateOne(
        { _id: rule._id },
        { $set: { lastRunAt: finishedAt, lastRunStats: { ...stats }, lastRunFailed: false, updatedAt: finishedAt } }
      );
      console.log(`[SmartSort] Sync completed for "${rule.collectionHandle}":`, JSON.stringify(stats));
      return { runId, ...stats };
    } catch (err) {
      console.error(`[SmartSort] Sync failed for "${rule.collectionHandle}":`, err);
      pushError(err.message);
      const finishedAt = new Date();
      const runId = runDoc._id || inserted.insertedId;
      await runsCol.updateOne(
        { _id: runId },
        { $set: { status: 'failed', finishedAt, durationMs: finishedAt - startedAt, ...stats, errors } }
      ).catch(console.error);
      // lastRunFailed drives the red chip on the rule card — a failed sync
      // must be visible without opening the Activity modal.
      await rulesCol.updateOne(
        { _id: rule._id },
        { $set: { lastRunAt: finishedAt, lastRunStats: { ...stats }, lastRunFailed: true, updatedAt: finishedAt } }
      ).catch(console.error);
      throw err;
    }
  } finally {
    runningSmartRules.delete(ruleKey);
  }
}

// ---------------------------------------------------------------------------
// runGlobalRule — the store-wide pass: apply ONE ordering strategy to every
// collection that has no rule of its own.
//
// Sequential on purpose: Shopify's cost bucket refills at a fixed rate, and a
// thousand parallel scans would only trade throughput for 429 storms. Most
// collections cost one scan and zero moves (planMoves pushes only changed
// positions), so a full nightly pass is long but cheap. Progress heartbeats
// onto the run doc every few collections so the admin can watch it and the
// stale-run guard can tell "still going" from "crashed".
// ---------------------------------------------------------------------------
async function runGlobalRule(fastify, rule, trigger, opts = {}) {
  const db = fastify.mongo.db;
  const runsCol = db.collection('smart_sort_runs');
  const rulesCol = db.collection('smart_sort_rules');
  const ruleKey = String(rule._id);

  if (!opts.preAcquired) {
    if (runningSmartRules.has(ruleKey)) throw new Error('A global pass is already in progress');
    runningSmartRules.add(ruleKey);
  }

  const startedAt = new Date();
  const stats = {
    collectionsTotal: 0, collectionsDone: 0, collectionsFailed: 0, collectionsSkipped: 0,
    totalProducts: 0, moves: 0, chunks: 0, sortOrderChanged: 0
  };
  const errors = [];
  const pushError = (msg) => { if (errors.length < MAX_RUN_ERRORS) errors.push(String(msg).slice(0, 300)); };

  const runDoc = {
    ruleId: ruleKey,
    collectionHandle: rule.collectionHandle,
    global: true,
    trigger,
    status: 'running',
    startedAt,
    heartbeatAt: startedAt,
    finishedAt: null,
    ...stats,
    errors: [],
    durationMs: null
  };
  if (opts.runId) runDoc._id = opts.runId;

  try {
    const inserted = await runsCol.insertOne(runDoc);
    const runId = runDoc._id || inserted.insertedId;
    console.log(`[SmartSort] GLOBAL pass started (${trigger}) — runId ${runId}`);

    try {
      const [all, ownRules] = await Promise.all([
        listAllCollections(),
        rulesCol.find({ _id: { $ne: rule._id } }).project({ collectionId: 1 }).toArray()
      ]);
      // Per-collection rules own their collections — the global rule never
      // touches them. Empty collections have nothing to order.
      const owned = new Set(ownRules.map((r) => r.collectionId).filter(Boolean));
      const targets = all.filter((c) => !owned.has(c.id) && c.productsCount > 0);
      stats.collectionsTotal = targets.length;
      stats.collectionsSkipped = all.length - targets.length;

      for (const c of targets) {
        if (Date.now() - startedAt.getTime() > GLOBAL_PASS_MAX_MS) {
          pushError(`Safety cap: pass stopped after 6h with ${stats.collectionsDone} of ${targets.length} collections done`);
          break;
        }
        try {
          const r = await pushOrderForCollection(
            fastify,
            { ...rule, collectionId: c.id, collectionHandle: c.handle, collectionTitle: c.title },
            { onWarn: pushError }
          );
          stats.totalProducts += r.totalProducts;
          stats.moves += r.moves;
          stats.chunks += r.chunks;
          if (r.sortOrderChanged) stats.sortOrderChanged += 1;
        } catch (err) {
          stats.collectionsFailed += 1;
          pushError(`${c.handle}: ${err.message}`);
        }
        stats.collectionsDone += 1;

        if (stats.collectionsDone % 10 === 0) {
          await runsCol.updateOne({ _id: runId },
            { $set: { ...stats, heartbeatAt: new Date(), errors } }).catch(() => {});
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      const finishedAt = new Date();
      await runsCol.updateOne(
        { _id: runId },
        { $set: { status: 'completed', finishedAt, heartbeatAt: finishedAt, durationMs: finishedAt - startedAt, ...stats, errors } }
      );
      await rulesCol.updateOne(
        { _id: rule._id },
        // A pass that lost some collections still "completed" — the card chip
        // should flag it, so partial failure counts as failed too.
        { $set: { lastRunAt: finishedAt, lastRunStats: { ...stats }, lastRunFailed: stats.collectionsFailed > 0, updatedAt: finishedAt } }
      );
      console.log('[SmartSort] GLOBAL pass completed:', JSON.stringify(stats));
      return { runId, ...stats };
    } catch (err) {
      console.error('[SmartSort] GLOBAL pass failed:', err);
      pushError(err.message);
      const finishedAt = new Date();
      const runId = runDoc._id || inserted.insertedId;
      await runsCol.updateOne(
        { _id: runId },
        { $set: { status: 'failed', finishedAt, durationMs: finishedAt - startedAt, ...stats, errors } }
      ).catch(console.error);
      await rulesCol.updateOne(
        { _id: rule._id },
        { $set: { lastRunAt: finishedAt, lastRunStats: { ...stats }, lastRunFailed: true, updatedAt: finishedAt } }
      ).catch(console.error);
      throw err;
    }
  } finally {
    runningSmartRules.delete(ruleKey);
  }
}

// ---------------------------------------------------------------------------
// Product insights — everything the team needs about ONE product to decide
// where it belongs: Shopify facts, GA/beacon engagement across all windows,
// exact money, and recent orders.
// ---------------------------------------------------------------------------
const INSIGHT_SEARCH_QUERY = `
  query smartSortInsightSearch($query: String!) {
    products(first: 8, query: $query) {
      nodes {
        id
        title
        handle
        status
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount } }
        variants(first: 1) { nodes { sku } }
      }
    }
  }
`;

async function searchProductsForInsights(q) {
  const clean = q.replace(/["\\]/g, '').trim();
  const attempts = [clean, `sku:${clean}*`];
  for (const query of attempts) {
    const data = await shopifyAdminFetch(INSIGHT_SEARCH_QUERY, { query });
    const nodes = data?.products?.nodes || [];
    if (nodes.length) {
      return nodes.map((n) => ({
        id: n.id,
        title: n.title,
        handle: n.handle,
        status: n.status,
        image: n.featuredImage?.url || null,
        price: parseFloat(n.priceRangeV2?.minVariantPrice?.amount) || 0,
        sku: n.variants?.nodes?.[0]?.sku || null
      }));
    }
  }
  return [];
}

const INSIGHT_DETAIL_QUERY = `
  query smartSortInsightDetail($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      vendor
      productType
      tags
      createdAt
      publishedAt
      onlineStoreUrl
      totalInventory
      tracksInventory
      featuredImage { url }
      priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
      compareAtPriceRange { minVariantCompareAtPrice { amount } }
      variants(first: 50) {
        nodes { id title sku price inventoryQuantity availableForSale }
      }
      collections(first: 30) { nodes { id title handle } }
      stoneType: metafield(namespace: "custom", key: "stone_type") { value }
      shopForCustom: metafield(namespace: "custom", key: "shop_for") { value }
      shopForOrna: metafield(namespace: "ornaverse", key: "shop_for") { value }
    }
  }
`;

const INSIGHT_ORDERS_QUERY = `
  query smartSortInsightOrders($query: String!) {
    orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        createdAt
        displayFinancialStatus
        lineItems(first: 25) {
          nodes {
            quantity
            sku
            product { id }
            discountedTotalSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

async function getProductInsights(fastify, productId) {
  const gid = String(productId).startsWith('gid://')
    ? productId
    : 'gid://shopify/Product/' + normalizeId(productId);

  const [detailData, popMaps, metrics] = await Promise.all([
    shopifyAdminFetch(INSIGHT_DETAIL_QUERY, { id: gid }),
    getPopularityMaps(fastify),
    getMetricMaps(fastify, { waitForSkuIndex: false }).catch(() => null)
  ]);

  const node = detailData?.product;
  if (!node) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    return Promise.reject(err);
  }

  const pid = normalizeId(node.id);
  const win = (group, w) => (metrics ? (metrics[group][w].get(pid) || 0) : 0);
  const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

  const windows = ['d3', 'd7', 'd30'].map((w, i) => {
    const views = win('views', w);
    const atc = win('atc', w);
    const orders = win('orders', w);
    return {
      days: [3, 7, 30][i],
      views,
      atc,
      orders,
      revenue: Math.round(win('revenue', w)),
      atcRate: rate(atc, views),
      viewToOrderRate: rate(orders, views)
    };
  });

  // Recent orders — best effort: the order search index answers `sku:`.
  let recentOrders = [];
  const primarySku = (node.variants?.nodes || []).map((v) => v.sku).find(Boolean);
  if (primarySku) {
    try {
      const cleanSku = primarySku.replace(/["\\]/g, '');
      const data = await shopifyAdminFetch(INSIGHT_ORDERS_QUERY, { query: `sku:${cleanSku}* status:any` });
      recentOrders = (data?.orders?.nodes || []).map((o) => {
        const mine = (o.lineItems?.nodes || []).filter((li) => normalizeId(li.product?.id) === pid);
        return {
          name: o.name,
          createdAt: o.createdAt,
          financialStatus: o.displayFinancialStatus,
          quantity: mine.reduce((a, li) => a + (li.quantity || 0), 0),
          amount: Math.round(mine.reduce((a, li) => a + (parseFloat(li.discountedTotalSet?.shopMoney?.amount) || 0), 0))
        };
      }).filter((o) => o.quantity > 0);
    } catch (err) {
      console.warn('[SmartSort] Recent orders lookup failed:', err.message);
    }
  }

  // Which smart-sort rules cover this product (by collection membership —
  // the product's own collections list makes this a cheap intersection).
  const collectionIds = new Set((node.collections?.nodes || []).map((c) => c.id));
  const rules = await fastify.mongo.db.collection('smart_sort_rules').find({}).toArray();
  const smartRules = rules
    .filter((r) => collectionIds.has(r.collectionId))
    .map((r) => ({ _id: r._id, collectionTitle: r.collectionTitle, collectionHandle: r.collectionHandle, enabled: r.enabled !== false }));

  const price = parseFloat(node.priceRangeV2?.minVariantPrice?.amount) || 0;
  const compareAt = parseFloat(node.compareAtPriceRange?.minVariantCompareAtPrice?.amount) || 0;

  return {
    product: {
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      live: Boolean(node.onlineStoreUrl),
      vendor: node.vendor || '',
      productType: node.productType || '',
      tags: node.tags || [],
      createdAt: node.createdAt,
      publishedAt: node.publishedAt,
      image: node.featuredImage?.url || null,
      price,
      compareAtPrice: compareAt,
      discountPercent: compareAt > price && compareAt > 0 ? Math.round(((compareAt - price) / compareAt) * 100) : 0,
      totalInventory: Number(node.totalInventory) || 0,
      buyable: (node.variants?.nodes || []).some((v) => v.availableForSale === true)
        || Number(node.totalInventory) > 0
        || node.tracksInventory === false,
      stoneType: node.stoneType?.value || null,
      shopFor: node.shopForCustom?.value || node.shopForOrna?.value || null,
      variants: (node.variants?.nodes || []).map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        price: parseFloat(v.price) || 0,
        inventoryQuantity: v.inventoryQuantity,
        availableForSale: v.availableForSale === true
      })),
      collections: (node.collections?.nodes || []).map((c) => ({ id: c.id, title: c.title, handle: c.handle }))
    },
    windows,
    popularity: popularityCountFor(popMaps, node.id),
    recentOrders,
    smartRules,
    metricSources: metrics
      ? { ...(metrics.sources || {}), skuIndexPending: metrics.skuIndexPending === true }
      : { views: 'unavailable', atc: 'unavailable' }
  };
}

module.exports = {
  computeOrderForRule,
  applyManualPositions,
  previewSmartRule,
  runSmartRule,
  runGlobalRule,
  listAllCollections,
  getProductInsights,
  searchProductsForInsights,
  planMoves,
  SMART_SORT_KEYS,
  WEIGHTABLE_KEYS,
  ALL_COLLECTIONS_HANDLE,
  isGlobalRule,
  runningSmartRules
};
