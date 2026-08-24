/**
 * "From the Same Collection" Recommendation Engine
 *
 * Replaces the retired Shopify Flow that maintained custom.matching_product.
 * Per-collection rule configs (Mongo `reco_rules`, managed from lucira-admin)
 * describe ordered slot blocks; this engine computes up to 16 recommended
 * products per product and writes them to the PRODUCT metafield
 * custom.from_the_same_collection_headless (type list.product_reference,
 * validation list.max=16 — a write of more than 16 references FAILS, so the
 * cap is enforced here unconditionally).
 *
 * Exports:
 *   computeForRule(fastify, rule, options)   - pure compute, no writes
 *   previewForRule(fastify, rule, opts)      - dry run in the API contract's preview shape
 *   runRule(fastify, rule, trigger, opts)    - full run: reco_runs bookkeeping + metafield writes
 *   getPopularityMaps(fastify)               - shared social-proof count maps
 *   runningRules                             - in-process Set backing the run-now 409
 */

const { shopifyAdminFetch } = require('./shopify');
const { getServerCache, stableCacheKey } = require('./cache');

const METAFIELD_NAMESPACE = 'custom';
const METAFIELD_KEY = 'from_the_same_collection_headless';
const METAFIELD_TYPE = 'list.product_reference';

const MAX_RECOMMENDATIONS = 16;       // metafield validation list.max=16 — never write more
const WRITE_BATCH_SIZE = 25;          // metafieldsSet accepts up to 25 metafields per call
const MAX_RUN_ERRORS = 20;            // errors kept on a reco_runs doc

// Admin GraphQL cost model: each product node below costs ~6 points (product
// object + featuredImage + priceRangeV2 + minVariantPrice + 2 metafields).
// At 250/page a page would cost ~1,500 points and be REJECTED outright — the
// single-query max cost is 1,000 — so we page at 100 (~600 points/page) and
// let fetchWithRetry absorb any 429 throttling between pages.
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 100;           // 10k product cap, same spirit as lib/storeAvailability.js
const SCAN_TTL_MS = 10 * 60 * 1000;   // preview and run share the scan for 10 minutes

// Baseline hygiene: junk products that must never be recommended (or receive
// recommendations) — internal test/customer-order/insurance line items.
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
// Popularity signal
//
// Real Mongo counts, copied from routes/products.js social-proof (there is NO
// server-side product-view log — orders/carts/wishlists are the only signals).
// The getServerCache keys are THE SAME ones products.js uses so the two
// features share one cached computation.
// ---------------------------------------------------------------------------

// Social-proof counts must reflect the REAL store DB (where interactions
// accumulate). In production the primary Mongo connection already targets it;
// in local dev the primary connection points at a near-empty local DB, so we
// lazily read the real store via MONGODB_URI (mirrors routes/products.js).
let _popularityDbPromise = null;
async function getPopularityDb(fastify) {
  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev || !process.env.MONGODB_URI) return fastify.mongo.db;
  try {
    if (!_popularityDbPromise) {
      const { MongoClient } = require('mongodb');
      _popularityDbPromise = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
        .connect()
        .then((client) => client.db());
    }
    return await _popularityDbPromise;
  } catch (err) {
    console.warn(`[Reco] Could not reach store DB for popularity, using primary connection: ${err.message}`);
    _popularityDbPromise = null;
    return fastify.mongo.db;
  }
}

async function getPopularityMaps(fastify) {
  const db = await getPopularityDb(fastify);

  // Fold a list of {_id: <rawProductId>, c} rows into a numeric-id -> count map,
  // merging any mixed id formats (GID vs numeric) that reduce to the same product.
  const foldRows = (rows) => {
    const map = {};
    for (const r of rows) {
      const nid = normalizeId(r._id);
      if (nid) map[nid] = (map[nid] || 0) + r.c;
    }
    return map;
  };

  // Count DISTINCT documents (carts / wishlists) containing each product, so a
  // single cart listing a product in two sizes counts once.
  const buildDistinctDocCountMap = async (collectionName) => {
    const rows = await db.collection(collectionName).aggregate([
      { $unwind: "$items" },
      { $match: { "items.productId": { $ne: null } } },
      { $group: { _id: { doc: "$_id", pid: "$items.productId" } } },
      { $group: { _id: "$_id.pid", c: { $sum: 1 } } }
    ], { allowDiskUse: true }).toArray();
    return foldRows(rows);
  };

  // Orders: count each order once per product (distinct) from
  // shopifyPayload.line_items[].product_id, successful orders only.
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
    getServerCache("social-proof:orders", buildOrderCountMap, { ttlMs: 30 * 60 * 1000, maxEntries: 10 }),
    getServerCache("social-proof:cart", () => buildDistinctDocCountMap('abandoned_carts'), { ttlMs: 15 * 60 * 1000, maxEntries: 10 }),
    getServerCache("social-proof:wishlist", () => buildDistinctDocCountMap('wishlists'), { ttlMs: 15 * 60 * 1000, maxEntries: 10 }),
  ]);

  return { orderMap, cartMap, wishlistMap };
}

// popularity count = orders*3 + carts + wishlists
const popularityCountFor = (maps, gid) => {
  const nid = normalizeId(gid);
  if (!nid) return 0;
  return (maps.orderMap[nid] || 0) * 3 + (maps.cartMap[nid] || 0) + (maps.wishlistMap[nid] || 0);
};

// ---------------------------------------------------------------------------
// Collection scan (Admin GraphQL, paginated, cached 10 min so preview and run
// share it — pagination loop imitates lib/storeAvailability.js)
// ---------------------------------------------------------------------------

const COLLECTION_SCAN_QUERY = `
  query recoCollectionScan($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          status
          createdAt
          totalInventory
          tracksInventory
          publishedOnCurrentPublication
          featuredImage { url }
          priceRangeV2 { minVariantPrice { amount } }
          stoneType: metafield(namespace: "custom", key: "stone_type") { value }
          current: metafield(namespace: "custom", key: "from_the_same_collection_headless") { value }
        }
      }
    }
  }
`;

async function scanCollection(collectionId) {
  return getServerCache(
    stableCacheKey(['reco-collection-scan', collectionId]),
    async () => {
      const products = [];
      let after = null;
      let pages = 0;

      do {
        const data = await shopifyAdminFetch(COLLECTION_SCAN_QUERY, {
          id: collectionId,
          first: SCAN_PAGE_SIZE,
          after
        });
        const page = data?.collection?.products;
        if (!page) break;

        for (const node of page.nodes || []) {
          if (!node?.id) continue;
          products.push({
            id: node.id,
            title: node.title || '',
            handle: node.handle || '',
            status: node.status,
            createdAt: node.createdAt ? new Date(node.createdAt).getTime() : 0,
            totalInventory: Number(node.totalInventory) || 0,
            tracksInventory: node.tracksInventory !== false,
            published: node.publishedOnCurrentPublication !== false,
            image: node.featuredImage?.url || null,
            price: parseFloat(node.priceRangeV2?.minVariantPrice?.amount) || 0,
            stoneType: node.stoneType?.value || null,
            currentValue: node.current?.value || null
          });
        }

        pages += 1;
        after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
        if (after && pages >= SCAN_MAX_PAGES) after = null;
      } while (after);

      console.log(`[Reco] Scanned collection ${collectionId}: ${products.length} products (${pages} pages)`);
      return products;
    },
    { ttlMs: SCAN_TTL_MS, maxEntries: 50 }
  );
}

// BASELINE HYGIENE (always, before any block).
const passesHygiene = (p) => {
  if (p.status !== 'ACTIVE') return false;
  if (p.published === false) return false;
  if (JUNK_TITLE_RE.test(p.title)) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Scoring
//
// attributePriority order gives weights (len - idx, first = heaviest).
// Normalized attribute scores in [0,1]:
//   price        = 1 - min(1, |cp-sp|/sp)
//   collection   = 1 (always same-collection today; flag kept for the future)
//   inventory    = totalInventory > 0 ? 1 : 0
//   popularity   = count / maxCountInPool (0 when maxCount = 0)
//   diamond_type = stoneType equal (both non-null) ? 1 : 0
// Tie-break: newest createdAt first.
// ---------------------------------------------------------------------------

const buildWeights = (attributePriority) => {
  const list = Array.isArray(attributePriority) ? attributePriority : [];
  const weights = {};
  list.forEach((attr, idx) => { weights[attr] = list.length - idx; });
  return weights;
};

const weightedScore = (source, cand, weights, popByGid, maxPop) => {
  let score = 0;
  if (weights.price) {
    const sp = source.price;
    const priceScore = sp > 0
      ? 1 - Math.min(1, Math.abs(cand.price - sp) / sp)
      : (cand.price === sp ? 1 : 0);
    score += weights.price * priceScore;
  }
  if (weights.collection) score += weights.collection;
  if (weights.inventory && cand.totalInventory > 0) score += weights.inventory;
  if (weights.popularity && maxPop > 0) {
    score += weights.popularity * ((popByGid.get(cand.id) || 0) / maxPop);
  }
  if (weights.diamond_type && cand.stoneType && source.stoneType && cand.stoneType === source.stoneType) {
    score += weights.diamond_type;
  }
  return score;
};

// Fill the rule's blocks IN ORDER for one source product, then backfill.
// Returns slot details (for preview) plus the flat ordered pick list (for the
// metafield write). `pool` must already be hygiene-filtered and exclude source.
const computeSlotsForProduct = (source, pool, rule, popByGid, maxPop) => {
  const weights = buildWeights(rule.attributePriority);

  // Precompute this source's weighted score for every candidate once — the
  // sorts below reuse it instead of recomputing inside comparators.
  const scores = new Map();
  for (const cand of pool) {
    scores.set(cand.id, weightedScore(source, cand, weights, popByGid, maxPop));
  }

  const byScore = (a, b) =>
    (scores.get(b.id) - scores.get(a.id)) || (b.createdAt - a.createdAt);
  const byPopularity = (a, b) =>
    ((popByGid.get(b.id) || 0) - (popByGid.get(a.id) || 0)) ||
    (scores.get(b.id) - scores.get(a.id)) ||
    (b.createdAt - a.createdAt);

  const picked = [];
  const pickedIds = new Set();
  const slots = [];
  const blocks = Array.isArray(rule.blocks) ? rule.blocks : [];

  blocks.forEach((block, blockIndex) => {
    const size = Math.min(Number(block.size) || 0, MAX_RECOMMENDATIONS - picked.length);
    const conditions = block.conditions || {};

    let survivors = pool.filter((cand) => {
      if (pickedIds.has(cand.id)) return false;
      // sameCollection: always true within this pool (flag kept for future
      // cross-collection support).
      if (conditions.priceBandPercent != null) {
        const band = (Number(conditions.priceBandPercent) / 100) * source.price;
        if (Math.abs(cand.price - source.price) > band) return false;
      }
      if (conditions.inStock && !(cand.totalInventory > 0)) return false;
      if (conditions.diamondTypeMatch &&
          !(cand.stoneType && source.stoneType && cand.stoneType === source.stoneType)) {
        return false;
      }
      return true;
    });

    let chosen;
    if (conditions.popularity) {
      // The popularity filter only requires count > 0; when that would empty
      // the block, fall back to ranking ALL survivors by popularity.
      const withPop = survivors.filter((cand) => (popByGid.get(cand.id) || 0) > 0);
      chosen = (withPop.length ? withPop : survivors).sort(byPopularity).slice(0, size);
    } else {
      chosen = survivors.sort(byScore).slice(0, size);
    }

    for (const cand of chosen) {
      picked.push(cand);
      pickedIds.add(cand.id);
    }

    slots.push({ blockIndex, blockLabel: block.label || '', products: chosen });
  });

  // backfill: fill under-filled slots from leftover ranked candidates so 16
  // are always attempted (when the rule opts in).
  let backfillPicks = [];
  if (rule.backfill !== false && picked.length < MAX_RECOMMENDATIONS) {
    backfillPicks = pool
      .filter((cand) => !pickedIds.has(cand.id))
      .sort(byScore)
      .slice(0, MAX_RECOMMENDATIONS - picked.length);
    for (const cand of backfillPicks) {
      picked.push(cand);
      pickedIds.add(cand.id);
    }
  }

  return {
    slots,
    backfillPicks,
    picks: picked.slice(0, MAX_RECOMMENDATIONS).map((p) => p.id), // cap at 16 ALWAYS
    totalFilled: Math.min(picked.length, MAX_RECOMMENDATIONS)
  };
};

// ---------------------------------------------------------------------------
// computeForRule — the shared compute step (NO writes)
//
// options:
//   productId  - gid or numeric: compute only that product (404-style error if
//                it is not an eligible member of the collection)
//   limit      - compute only the first N eligible source products
//   excludeIds - Set of product GIDs owned by a higher-priority rule; those
//                products are skipped as SOURCES (they can still appear as
//                candidates in other products' slots)
// ---------------------------------------------------------------------------
async function computeForRule(fastify, rule, options = {}) {
  const [allProducts, popMaps] = await Promise.all([
    scanCollection(rule.collectionId),
    getPopularityMaps(fastify)
  ]);

  const eligible = allProducts.filter(passesHygiene);

  const popByGid = new Map();
  for (const p of eligible) popByGid.set(p.id, popularityCountFor(popMaps, p.id));

  let sources = eligible;
  if (options.productId) {
    const wanted = normalizeId(options.productId);
    const found = eligible.find((p) => normalizeId(p.id) === wanted);
    if (!found) {
      const err = new Error('Product not found among the eligible products of this collection');
      err.statusCode = 404;
      throw err;
    }
    sources = [found];
  } else if (options.excludeIds && options.excludeIds.size) {
    sources = sources.filter((p) => !options.excludeIds.has(p.id));
  }
  if (options.limit) sources = sources.slice(0, options.limit);

  const results = [];
  for (const source of sources) {
    const pool = eligible.filter((p) => p.id !== source.id);
    const maxPop = pool.reduce((m, p) => Math.max(m, popByGid.get(p.id) || 0), 0);
    results.push({ source, ...computeSlotsForProduct(source, pool, rule, popByGid, maxPop) });

    // The compute is synchronous CPU work; yield periodically so a large
    // collection run does not starve the event loop for live requests.
    if (results.length % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  return { results, popByGid, scannedCount: allProducts.length, eligibleCount: eligible.length };
}

// ---------------------------------------------------------------------------
// previewForRule — DRY RUN, no writes, contract preview shape
// ---------------------------------------------------------------------------
async function previewForRule(fastify, rule, { productId, limit } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 12);

  const { results, popByGid } = await computeForRule(fastify, rule, {
    productId: productId || null,
    limit: productId ? 1 : cappedLimit
  });

  const toPreviewProduct = (cand) => ({
    id: cand.id,
    title: cand.title,
    handle: cand.handle,
    image: cand.image,
    price: cand.price,
    inStock: cand.totalInventory > 0,
    popularity: popByGid.get(cand.id) || 0,
    stoneType: cand.stoneType
  });

  return results.map(({ source, slots, backfillPicks, totalFilled }) => ({
    source: {
      id: source.id,
      title: source.title,
      handle: source.handle,
      image: source.image,
      price: source.price
    },
    slots: [
      ...slots.map((slot) => ({
        blockIndex: slot.blockIndex,
        blockLabel: slot.blockLabel,
        products: slot.products.map(toPreviewProduct)
      })),
      // Backfill picks are surfaced as one extra trailing slot so the admin
      // preview shows everything that would be written, not just the blocks.
      ...(backfillPicks.length ? [{
        blockIndex: (rule.blocks || []).length,
        blockLabel: 'Backfill',
        products: backfillPicks.map(toPreviewProduct)
      }] : [])
    ],
    totalFilled
  }));
}

// ---------------------------------------------------------------------------
// Multi-rule ownership: products that also belong to a configured collection
// whose rule has HIGHER priority are owned by that rule — this rule's run
// must skip them. Implemented cheaply by reusing the cached collection scans.
// ---------------------------------------------------------------------------
async function getOwnedByHigherPriority(fastify, rule) {
  const owned = new Set();
  const higher = await fastify.mongo.db.collection('reco_rules').find({
    enabled: true,
    priority: { $gt: rule.priority || 0 },
    _id: { $ne: rule._id }
  }).toArray();

  for (const other of higher) {
    if (!other.collectionId) continue;
    try {
      const products = await scanCollection(other.collectionId);
      for (const p of products) owned.add(p.id);
    } catch (err) {
      // Best effort: an unreadable higher-priority collection must not kill
      // this run — worst case this run also writes products that rule owns,
      // and the next run of the higher-priority rule reclaims them.
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
// ---------------------------------------------------------------------------
async function runRule(fastify, rule, trigger, opts = {}) {
  const db = fastify.mongo.db;
  const runsCol = db.collection('reco_runs');
  const rulesCol = db.collection('reco_rules');
  const ruleKey = String(rule._id);

  if (runningRules.has(ruleKey)) {
    throw new Error('A run for this rule is already in progress');
  }
  runningRules.add(ruleKey);

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
  const pushError = (msg) => { if (errors.length < MAX_RUN_ERRORS) errors.push(msg); };

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
        toWrite.push({ ownerId: r.source.id, picks });
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
            // userError field paths look like ["metafields", "3", "value"] —
            // map them back to batch indices so only the rejected products
            // count as failed; unmappable errors fail the whole batch.
            const failedIdx = new Set();
            for (const ue of userErrors) {
              const idx = Array.isArray(ue.field) ? parseInt(ue.field[1], 10) : NaN;
              if (Number.isInteger(idx) && idx >= 0 && idx < batch.length) failedIdx.add(idx);
              pushError(`metafieldsSet: ${ue.message} (${(ue.field || []).join('.')})`);
            }
            const failedCount = failedIdx.size || batch.length;
            stats.failed += failedCount;
            stats.written += batch.length - failedCount;
          } else {
            stats.written += batch.length;
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
  computeForRule,
  previewForRule,
  runRule,
  getPopularityMaps,
  runningRules
};
