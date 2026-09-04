/**
 * Variant SKU -> product id index, persisted in Mongo.
 *
 * WHY IT MOVED OUT OF recoSignals.js
 * ----------------------------------
 * GA4's dominant item_id for view_item / add_to_cart on this store is the
 * variant SKU ("LJ-CH0018-18YGPG-16"), not a Shopify id, so views cannot be
 * attributed to products without this lookup. Building it means walking the
 * whole catalogue: ~99k variants, 398 pages at 250/page.
 *
 * It used to live in a module-level variable, which meant:
 *   - every process restart rebuilt all 398 pages from scratch, and
 *   - index.js listens with `exclusive:false`, so EVERY worker built its own
 *     copy simultaneously — N x 398 requests against one shared cost bucket.
 * On a dev box with frequent restarts that alone saturated the bucket and
 * threw `Throttled`, which then crashed the server (the build was an
 * unhandled floating promise).
 *
 * Now the index is written to Mongo once and read back on boot, so a restart
 * costs ZERO Shopify requests. A rebuild happens at most once per TTL, under a
 * cross-worker lease, in the governor's `background` lane — it yields to
 * shopper traffic and can never starve an interactive request.
 *
 * Storage layout in `shopify_sku_index`:
 *   { _id: 'meta',   builtAt, size, parts, source }
 *   { _id: 'part:0', part: 0, skus: [...], pids: [...] }   (parallel arrays)
 * Chunked because ~99k entries in a single document is a few MB; parallel
 * arrays keep it compact and well clear of the 16MB document ceiling.
 */

const { shopifyAdminFetch } = require('./shopify');

const COLLECTION = 'shopify_sku_index';
const LEASE_KEY = 'sku_index_lease';
const CHUNK_SIZE = 25000;

const PAGE_SIZE = 250;                    // cheapest per record: 24 pts / 250 variants
const MAX_PAGES = 600;                    // 150k variants ceiling
const TTL_MS = Number(process.env.SKU_INDEX_TTL_MS) || 24 * 60 * 60 * 1000;
const LEASE_MS = Number(process.env.SKU_INDEX_LEASE_MS) || 30 * 60 * 1000;

const VARIANT_SKU_QUERY = `
  query recoVariantSkus($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { sku product { id } }
    }
  }
`;

const normalizeId = (id) => {
  const m = String(id || '').match(/\d+/g);
  return m ? m[m.length - 1] : '';
};

// Set once at boot by index.js so the existing call sites keep their signature.
let _db = null;
const attachSkuIndexStore = (db) => { _db = db; };

let _mem = { value: null, builtAt: 0, loading: null, building: null };

// ---------------------------------------------------------------------------
// Mongo persistence
// ---------------------------------------------------------------------------
async function loadFromMongo(db) {
  const col = db.collection(COLLECTION);
  const meta = await col.findOne({ _id: 'meta' });
  if (!meta || !meta.builtAt) return null;

  const age = Date.now() - new Date(meta.builtAt).getTime();
  const parts = await col.find({ _id: { $ne: 'meta' } }).sort({ part: 1 }).toArray();

  const map = new Map();
  for (const doc of parts) {
    const skus = doc.skus || [];
    const pids = doc.pids || [];
    for (let i = 0; i < skus.length; i++) map.set(skus[i], pids[i]);
  }
  if (!map.size) return null;

  return { map, builtAt: new Date(meta.builtAt).getTime(), stale: age >= TTL_MS, source: meta.source };
}

async function saveToMongo(db, map, source) {
  const col = db.collection(COLLECTION);
  const skus = [...map.keys()];

  const ops = [];
  let part = 0;
  for (let i = 0; i < skus.length; i += CHUNK_SIZE, part++) {
    const slice = skus.slice(i, i + CHUNK_SIZE);
    ops.push({
      replaceOne: {
        filter: { _id: 'part:' + part },
        replacement: { part, skus: slice, pids: slice.map((s) => map.get(s)) },
        upsert: true,
      }
    });
  }

  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  // Drop chunks left over from a larger previous build.
  await col.deleteMany({ _id: { $ne: 'meta' }, part: { $gte: part } });
  await col.replaceOne(
    { _id: 'meta' },
    { builtAt: new Date(), size: map.size, parts: part, source },
    { upsert: true }
  );
}

// ---------------------------------------------------------------------------
// Cross-worker lease — same atomic pattern as lib/recoScheduler.js. Without it,
// N workers sharing the port each run the full 398-page scan at once.
// ---------------------------------------------------------------------------
async function acquireLease(db) {
  const now = new Date();
  try {
    await db.collection('settings').findOneAndUpdate(
      {
        key: LEASE_KEY,
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $lte: now } }
        ]
      },
      { $set: { expiresAt: new Date(now.getTime() + LEASE_MS), pid: process.pid, updatedAt: now } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false; // another worker holds it
    throw err;
  }
}

const releaseLease = (db) =>
  db.collection('settings').updateOne({ key: LEASE_KEY }, { $set: { expiresAt: new Date(0) } }).catch(() => {});

/** Must be awaited at boot: without the index the lease upsert never trips
 *  11000 and every worker "wins", silently degrading to no guard at all. */
async function ensureSkuIndexIndexes(db) {
  await db.collection('settings').createIndex(
    { key: 1 },
    { unique: true, partialFilterExpression: { key: LEASE_KEY } }
  );
}

// ---------------------------------------------------------------------------
// The scan itself — every page in the governor's background lane.
// ---------------------------------------------------------------------------
async function scanVariants() {
  const map = new Map();
  let after = null;
  let pages = 0;
  const startedAt = Date.now();

  do {
    const data = await shopifyAdminFetch(
      VARIANT_SKU_QUERY,
      { first: PAGE_SIZE, after },
      { priority: 'background' }
    );
    const page = data?.productVariants;
    if (!page) break;

    for (const node of page.nodes || []) {
      const sku = (node.sku || '').trim();
      const pid = normalizeId(node.product?.id);
      if (sku && pid) map.set(sku.toUpperCase(), pid);
    }

    pages += 1;
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    if (after && pages >= MAX_PAGES) {
      console.warn(`[SkuIndex] hit the ${MAX_PAGES}-page ceiling — some SKUs are unmapped`);
      after = null;
    }
  } while (after);

  console.log(
    `[SkuIndex] built: ${map.size} variant SKUs (${pages} pages, ${Math.round((Date.now() - startedAt) / 1000)}s)`
  );
  return map;
}

async function rebuild(db) {
  const leased = db ? await acquireLease(db).catch(() => true) : true;
  if (!leased) {
    console.log('[SkuIndex] another worker is rebuilding — skipping');
    // Let the winner finish, then read its result rather than duplicating ~9.5k
    // cost points of scanning.
    await new Promise((r) => setTimeout(r, 60000));
    const loaded = db ? await loadFromMongo(db).catch(() => null) : null;
    if (loaded?.map?.size) {
      _mem = { value: loaded.map, builtAt: loaded.builtAt, loading: null, building: null };
      return loaded.map;
    }
    return _mem.value;
  }

  try {
    const map = await scanVariants();
    if (db && map.size) {
      await saveToMongo(db, map, 'paged').catch((err) =>
        console.error('[SkuIndex] built but could not persist:', err.message));
    }
    return map;
  } finally {
    if (db) await releaseLease(db);
  }
}

// ---------------------------------------------------------------------------
// Public entry point. Contract is unchanged from the old recoSignals version:
// `wait:false` never blocks a user-facing request, returning whatever is on
// hand (possibly null) while the build continues in the background.
// ---------------------------------------------------------------------------
async function getSkuIndex({ wait = true, db = null } = {}) {
  const store = db || _db;
  const fresh = _mem.value && (Date.now() - _mem.builtAt) < TTL_MS;
  if (fresh) return _mem.value;

  // Cold process: try Mongo before Shopify. This is the restart fast path —
  // it turns 398 Admin requests into one Mongo read.
  if (!_mem.value && store) {
    if (!_mem.loading) {
      _mem.loading = loadFromMongo(store)
        .then((loaded) => {
          if (loaded?.map?.size) {
            _mem = { ..._mem, value: loaded.map, builtAt: loaded.builtAt, loading: null };
            console.log(
              `[SkuIndex] loaded ${loaded.map.size} SKUs from Mongo ` +
              `(${Math.round((Date.now() - loaded.builtAt) / 60000)}m old${loaded.stale ? ', stale — refreshing' : ''}) ` +
              '— 0 Shopify requests'
            );
          }
          _mem.loading = null;
          return loaded;
        })
        .catch((err) => {
          _mem.loading = null;
          console.error('[SkuIndex] Mongo read failed, falling back to a Shopify scan:', err.message);
          return null;
        });
    }
    const loaded = await _mem.loading;
    // A fresh persisted copy is all we need.
    if (loaded?.map?.size && !loaded.stale) return loaded.map;
  }

  if (!_mem.building) {
    _mem.building = rebuild(store)
      .then((map) => {
        if (map && map.size) _mem = { value: map, builtAt: Date.now(), loading: null, building: null };
        else _mem.building = null;
        return map;
      })
      .catch((err) => {
        _mem.building = null;
        throw err;
      });
  }

  // Stale-while-revalidate: serve the stale copy instantly, let the rebuild run.
  if (!wait) {
    if (_mem.building) _mem.building.catch(() => {}); // never an unhandled rejection
    return _mem.value;
  }
  return _mem.building;
}

function skuIndexStatus() {
  return {
    loaded: !!_mem.value,
    size: _mem.value ? _mem.value.size : 0,
    builtAt: _mem.builtAt ? new Date(_mem.builtAt).toISOString() : null,
    ageMinutes: _mem.builtAt ? Math.round((Date.now() - _mem.builtAt) / 60000) : null,
    ttlMinutes: Math.round(TTL_MS / 60000),
    rebuilding: !!_mem.building,
  };
}

module.exports = {
  getSkuIndex,
  attachSkuIndexStore,
  ensureSkuIndexIndexes,
  skuIndexStatus,
  VARIANT_SKU_QUERY,
};
