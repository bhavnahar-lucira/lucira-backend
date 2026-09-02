/**
 * Smart Collection Sort Routes (Fastify)
 *
 * CRUD for per-collection ordering rules (Mongo `smart_sort_rules`, managed
 * from lucira-admin's Smart Collections page), dry-run previews, manual syncs
 * to Shopify, run history, and the Product Insights lookups. The engine lives
 * in lib/smartCollections.js; the daily scheduler in lib/smartSortScheduler.js.
 * Registered in index.js under /api/smart-collections.
 */

const { shopifyAdminFetch } = require('../lib/shopify');
const { ATTRIBUTES, OPS_BY_KIND, getAttributeOptions } = require('../lib/recommendations');
const {
  previewSmartRule,
  runSmartRule,
  runningSmartRules,
  getProductInsights,
  searchProductsForInsights,
  SMART_SORT_KEYS
} = require('../lib/smartCollections');
const { isGa4Configured } = require('../lib/ga4');

const SCHEDULE_TIME_RE = /^\d{2}:\d{2}$/;
const STALE_RUNNING_MS = 15 * 60 * 1000; // matches routes/recommendations.js

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const rulesCol = db.collection('smart_sort_rules');
  const runsCol = db.collection('smart_sort_runs');
  const { ObjectId } = fastify.mongo;

  rulesCol.createIndex({ collectionHandle: 1 }, { unique: true }).catch(console.error);
  runsCol.createIndex({ startedAt: -1 }).catch(console.error);

  const toObjectId = (id) => {
    try { return new ObjectId(id); } catch (_) { return null; }
  };

  const unwrapFindOneAndUpdate = (result) =>
    (result && result.value !== undefined ? result.value : result);

  // Slot conditions rank a whole collection — there is no "source product",
  // so the dynamic operators are invalid here.
  const DYNAMIC_OPS = ['matches_source', 'within_percent', 'within_amount'];
  const VALUE_FREE_OPS = ['has_any', 'above_average', 'below_average'];

  const condError = (cond, where) => {
    if (!cond || typeof cond !== 'object') return 'each ' + where + ' condition must be an object';
    const def = ATTRIBUTES[cond.attr];
    if (!def) return 'unknown condition attribute "' + cond.attr + '" in ' + where;
    if (DYNAMIC_OPS.includes(cond.op)) {
      return where + ' conditions cannot use "' + cond.op + '" — there is no source product on a collection page';
    }
    if (!(OPS_BY_KIND[def.kind] || []).includes(cond.op)) {
      return 'operator "' + cond.op + '" is not valid for ' + cond.attr + ' in ' + where;
    }
    if (!VALUE_FREE_OPS.includes(cond.op) && def.kind !== 'boolean' &&
        (cond.value === undefined || cond.value === null || cond.value === '')) {
      return 'condition on ' + cond.attr + ' needs a value';
    }
    return null;
  };

  const sortByError = (sortBy, where) => {
    if (sortBy === undefined) return null;
    if (!Array.isArray(sortBy)) return where + ' sortBy must be an array';
    for (const s of sortBy) {
      if (!s || !SMART_SORT_KEYS[s.key]) return 'unknown sort key "' + (s && s.key) + '" in ' + where;
      if (s.dir !== undefined && !['asc', 'desc'].includes(s.dir)) return 'sort dir must be asc or desc';
    }
    return null;
  };

  // A collection far larger than anything in the catalogue; a hand placement
  // beyond the end simply lands last.
  const MAX_HAND_POSITION = 100000;

  const isGidList = (arr) => Array.isArray(arr) && arr.every((g) => typeof g === 'string' && g.includes('gid://shopify/Product/'));

  // Validates the writable rule fields present in `body`. partial=false
  // (POST): required fields must be present; partial=true (PUT): only fields
  // actually sent are checked. Returns an error string or null.
  const validateRuleBody = (body, { partial } = {}) => {
    if (!body || typeof body !== 'object') return 'Request body is required';
    const has = (k) => body[k] !== undefined;

    if (!partial || has('collectionId')) {
      if (typeof body.collectionId !== 'string' || !body.collectionId.startsWith('gid://shopify/Collection/')) {
        return 'collectionId must be a Shopify Collection GID';
      }
    }
    if (!partial || has('collectionHandle')) {
      if (typeof body.collectionHandle !== 'string' || !body.collectionHandle.trim()) {
        return 'collectionHandle is required';
      }
    }
    if (has('enabled') && typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
    if (!partial || has('scheduleTime')) {
      if (typeof body.scheduleTime !== 'string' || !SCHEDULE_TIME_RE.test(body.scheduleTime)) {
        return 'scheduleTime must be an IST time in HH:mm format';
      }
      const [hh, mm] = body.scheduleTime.split(':').map(Number);
      if (hh > 23 || mm > 59) return 'scheduleTime must be a valid time between 00:00 and 23:59';
    }
    if (!partial || has('slots')) {
      if (!Array.isArray(body.slots)) return 'slots must be an array';
      let total = 0;
      for (const slot of body.slots) {
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return 'each slot must be an object';
        const pct = Number(slot.sizePercent);
        if (!Number.isFinite(pct) || pct < 1 || pct > 100) return 'each slot size must be between 1 and 100 percent';
        total += pct;
        for (const cond of slot.conditions || []) {
          const err = condError(cond, 'slot');
          if (err) return err;
        }
        const sErr = sortByError(slot.sortBy, 'slot');
        if (sErr) return sErr;
      }
      if (total > 100) return 'slot percentages must sum to 100 or less (got ' + total + ')';
    }
    if (has('remainderSortBy')) {
      const err = sortByError(body.remainderSortBy, 'remainder');
      if (err) return err;
    }
    if (has('pinned') && !isGidList(body.pinned)) return 'pinned must be an array of product GIDs';
    if (has('removed') && !isGidList(body.removed)) return 'removed must be an array of product GIDs';
    if (has('positions')) {
      if (!Array.isArray(body.positions)) return 'positions must be an array';
      for (const entry of body.positions) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'each hand-placed position must be an object';
        if (typeof entry.id !== 'string' || !entry.id.includes('gid://shopify/Product/')) {
          return 'each hand-placed position needs a product GID';
        }
        const pos = Number(entry.position);
        if (!Number.isInteger(pos) || pos < 1 || pos > MAX_HAND_POSITION) {
          return 'each hand-placed position must be a whole number between 1 and ' + MAX_HAND_POSITION;
        }
      }
    }
    if (has('settings')) {
      if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
        return 'settings must be an object';
      }
      if (body.settings.oosToEnd !== undefined && typeof body.settings.oosToEnd !== 'boolean') {
        return 'settings.oosToEnd must be a boolean';
      }
    }
    return null;
  };

  const normalizeConditions = (conds) => (conds || []).map((c) => ({
    attr: c.attr,
    op: c.op,
    ...(c.value !== undefined ? { value: c.value } : {}),
    ...(typeof c.valueLabel === 'string' && c.valueLabel ? { valueLabel: c.valueLabel.slice(0, 120) } : {})
  }));

  const normalizeSlots = (slots) => (slots || []).map((s) => ({
    sizePercent: Number(s.sizePercent),
    label: s.label || '',
    conditions: normalizeConditions(s.conditions),
    sortBy: (s.sortBy || []).map((srt) => ({ key: srt.key, dir: srt.dir === 'asc' ? 'asc' : 'desc' }))
  }));

  const normalizeSortBy = (sortBy) =>
    (sortBy || []).map((srt) => ({ key: srt.key, dir: srt.dir === 'asc' ? 'asc' : 'desc' }));

  // Hand-placed positions: one entry per product, first entry wins on a
  // duplicate id. Order is preserved — the engine breaks ties between two
  // products claiming the same position by the order they were curated.
  const normalizePositions = (positions) => {
    const out = [];
    const seen = new Set();
    for (const entry of positions || []) {
      const id = entry && entry.id;
      const pos = Math.round(Number(entry && entry.position));
      if (!id || seen.has(id) || !Number.isFinite(pos)) continue;
      seen.add(id);
      out.push({ id: String(id), position: Math.min(MAX_HAND_POSITION, Math.max(1, pos)) });
    }
    return out;
  };

  // Build the rule the engine runs from an unsaved draft body (preview-draft).
  const draftToRule = (body) => ({
    collectionId: body.collectionId,
    collectionHandle: body.collectionHandle || '__draft__',
    collectionTitle: body.collectionTitle || '',
    slots: normalizeSlots(body.slots),
    remainderSortBy: normalizeSortBy(body.remainderSortBy),
    pinned: body.pinned || [],
    removed: body.removed || [],
    positions: normalizePositions(body.positions),
    settings: { oosToEnd: body.settings?.oosToEnd !== false }
  });

  // GET /api/smart-collections/collections/search?q=<text>
  // Same picker the reco module uses, plus each collection's current
  // sortOrder so the editor can say when a sync will switch it to Manual.
  fastify.get('/collections/search', async (request, reply) => {
    const q = String(request.query.q || '').trim();
    if (!q) return reply.code(400).send({ error: 'q is required' });

    try {
      const data = await shopifyAdminFetch(`
        query smartSortSearchCollections($query: String!) {
          collections(first: 20, query: $query) {
            nodes {
              id
              handle
              title
              sortOrder
              productsCount { count }
            }
          }
        }
      `, { query: `title:*${q.replace(/["\\]/g, '')}*` });

      const collections = (data?.collections?.nodes || []).map((node) => ({
        id: node.id,
        handle: node.handle,
        title: node.title,
        sortOrder: node.sortOrder,
        productsCount: node.productsCount?.count ?? 0
      }));

      return { success: true, collections };
    } catch (err) {
      console.error('[SmartSort] Collection search failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/smart-collections/attributes — condition + sort vocabulary for
  // the editor, with the dynamic (source-relative) operators stripped.
  fastify.get('/attributes', async (request, reply) => {
    try {
      const optionsByAttr = await getAttributeOptions().catch((err) => {
        console.error('[SmartSort] attribute options unavailable:', err.message);
        return {};
      });
      const attributes = Object.entries(ATTRIBUTES).map(([key, def]) => ({
        key,
        label: def.label,
        group: def.group,
        kind: def.kind,
        options: optionsByAttr[key],
        ops: (OPS_BY_KIND[def.kind] || []).filter((op) => !DYNAMIC_OPS.includes(op))
      }));
      const sortKeys = Object.entries(SMART_SORT_KEYS).map(([key, defn]) => ({
        key, label: defn.label, directional: defn.directional === true
      }));

      let viewsTrackingSince = null;
      try {
        const first = await db.collection('product_events').find().sort({ d: 1 }).limit(1).toArray();
        viewsTrackingSince = first[0] ? first[0].d : null;
      } catch (_) { /* collection may not exist yet */ }

      return {
        success: true,
        attributes,
        sortKeys,
        availability: {
          ga4Configured: isGa4Configured(),
          viewsTrackingSince,
          viewsSource: isGa4Configured() ? 'ga4' : 'beacon',
          moneySource: 'shopify'
        }
      };
    } catch (err) {
      console.error('[SmartSort] Attributes failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/smart-collections/rules
  fastify.get('/rules', async (request, reply) => {
    try {
      const rules = await rulesCol.find({}).sort({ createdAt: 1 }).toArray();
      return { success: true, rules };
    } catch (err) {
      console.error('[SmartSort] List rules failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/smart-collections/rules
  fastify.post('/rules', async (request, reply) => {
    try {
      const body = request.body || {};
      const invalid = validateRuleBody(body, { partial: false });
      if (invalid) return reply.code(400).send({ error: invalid });

      const collectionHandle = body.collectionHandle.trim();
      const existing = await rulesCol.findOne({ collectionHandle });
      if (existing) {
        return reply.code(409).send({ error: `A smart sort for collection "${collectionHandle}" already exists` });
      }

      const now = new Date();
      const rule = {
        collectionId: body.collectionId,
        collectionHandle,
        collectionTitle: body.collectionTitle || '',
        enabled: body.enabled !== undefined ? body.enabled : true,
        scheduleTime: body.scheduleTime,
        slots: normalizeSlots(body.slots),
        remainderSortBy: normalizeSortBy(body.remainderSortBy),
        pinned: body.pinned || [],
        removed: body.removed || [],
        positions: normalizePositions(body.positions),
        settings: { oosToEnd: body.settings?.oosToEnd !== false },
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStats: null
      };

      const result = await rulesCol.insertOne(rule);
      rule._id = result.insertedId;
      console.log(`[SmartSort] Rule created for "${collectionHandle}"`);
      return { success: true, rule };
    } catch (err) {
      if (err && err.code === 11000) {
        return reply.code(409).send({ error: 'A smart sort for this collection already exists' });
      }
      console.error('[SmartSort] Create rule failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // PUT /api/smart-collections/rules/:id (partial update)
  fastify.put('/rules/:id', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const body = request.body || {};
      const invalid = validateRuleBody(body, { partial: true });
      if (invalid) return reply.code(400).send({ error: invalid });

      const updatable = [
        'collectionId', 'collectionHandle', 'collectionTitle', 'enabled',
        'scheduleTime', 'slots', 'remainderSortBy', 'pinned', 'removed', 'positions', 'settings'
      ];
      const $set = { updatedAt: new Date() };
      for (const field of updatable) {
        if (body[field] !== undefined) $set[field] = body[field];
      }
      if ($set.collectionHandle !== undefined) {
        $set.collectionHandle = String($set.collectionHandle).trim();
        const clash = await rulesCol.findOne({ collectionHandle: $set.collectionHandle, _id: { $ne: _id } });
        if (clash) {
          return reply.code(409).send({ error: `A smart sort for collection "${$set.collectionHandle}" already exists` });
        }
      }
      if ($set.slots !== undefined) $set.slots = normalizeSlots($set.slots);
      if ($set.remainderSortBy !== undefined) $set.remainderSortBy = normalizeSortBy($set.remainderSortBy);
      if ($set.positions !== undefined) $set.positions = normalizePositions($set.positions);
      if ($set.settings !== undefined) $set.settings = { oosToEnd: body.settings?.oosToEnd !== false };

      const result = await rulesCol.findOneAndUpdate({ _id }, { $set }, { returnDocument: 'after' });
      const rule = unwrapFindOneAndUpdate(result);
      if (!rule) return reply.code(404).send({ error: 'Rule not found' });

      return { success: true, rule };
    } catch (err) {
      if (err && err.code === 11000) {
        return reply.code(409).send({ error: 'A smart sort for this collection already exists' });
      }
      console.error('[SmartSort] Update rule failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // DELETE /api/smart-collections/rules/:id — stops managing the collection.
  // The last synced order stays in Shopify (the collection remains MANUAL);
  // nothing is reverted.
  fastify.delete('/rules/:id', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const result = await rulesCol.deleteOne({ _id });
      if (!result.deletedCount) return reply.code(404).send({ error: 'Rule not found' });

      console.log(`[SmartSort] Rule ${request.params.id} deleted`);
      return { success: true };
    } catch (err) {
      console.error('[SmartSort] Delete rule failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/smart-collections/rules/:id/preview — DRY RUN, no writes
  fastify.post('/rules/:id/preview', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const rule = await rulesCol.findOne({ _id });
      if (!rule) return reply.code(404).send({ error: 'Rule not found' });

      const preview = await previewSmartRule(fastify, rule);
      return { success: true, preview };
    } catch (err) {
      console.error('[SmartSort] Preview failed:', err.message);
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  // POST /api/smart-collections/preview-draft — live preview of an UNSAVED
  // rule so the editor can show the computed order while configuring.
  fastify.post('/preview-draft', async (request, reply) => {
    try {
      const body = { ...(request.body || {}) };
      if (!body.collectionHandle) body.collectionHandle = '__draft__';
      if (body.scheduleTime === undefined) body.scheduleTime = '02:30';
      const invalid = validateRuleBody(body, { partial: false });
      if (invalid) return reply.code(400).send({ error: invalid });

      const preview = await previewSmartRule(fastify, draftToRule(body));
      return { success: true, preview };
    } catch (err) {
      console.error('[SmartSort] Draft preview failed:', err.message);
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  // POST /api/smart-collections/rules/:id/run — sync the order to Shopify.
  // Replies IMMEDIATELY with the runId, then continues (webhooks.js shape):
  // a big collection can take minutes of sequential reorder jobs.
  fastify.post('/rules/:id/run', async (request, reply) => {
    const _id = toObjectId(request.params.id);
    if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

    let rule;
    try {
      rule = await rulesCol.findOne({ _id });
    } catch (err) {
      console.error('[SmartSort] Run lookup failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
    if (!rule) return reply.code(404).send({ error: 'Rule not found' });

    if (runningSmartRules.has(String(_id))) {
      return reply.code(409).send({ error: 'A sync for this collection is already in progress' });
    }
    try {
      const activeRun = await runsCol.findOne({
        ruleId: String(_id),
        status: 'running',
        startedAt: { $gt: new Date(Date.now() - STALE_RUNNING_MS) }
      });
      if (activeRun) {
        return reply.code(409).send({ error: 'A sync for this collection is already in progress' });
      }
    } catch (err) {
      console.error('[SmartSort] Running check failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }

    // Claim synchronously before replying (same race guard as the reco route).
    const ruleKey = String(_id);
    if (runningSmartRules.has(ruleKey)) {
      return reply.code(409).send({ error: 'A sync for this collection is already in progress' });
    }
    runningSmartRules.add(ruleKey);

    const runId = new ObjectId();
    reply.code(200).send({ success: true, runId: String(runId) });

    try {
      await runSmartRule(fastify, rule, 'manual', { runId, preAcquired: true });
    } catch (err) {
      console.error('[SmartSort] Manual sync failed:', err.message);
    }
  });

  // GET /api/smart-collections/runs?ruleId=&limit=20
  fastify.get('/runs', async (request, reply) => {
    try {
      const { ruleId } = request.query;
      const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 20, 1), 100);

      const query = {};
      if (ruleId) query.ruleId = String(ruleId);

      const runs = await runsCol.find(query).sort({ startedAt: -1 }).limit(limit).toArray();
      return { success: true, runs };
    } catch (err) {
      console.error('[SmartSort] List runs failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/smart-collections/product-insights/search?q=
  fastify.get('/product-insights/search', async (request, reply) => {
    const q = String(request.query.q || '').trim();
    if (q.length < 2) return reply.code(400).send({ error: 'q must be at least 2 characters' });
    try {
      const products = await searchProductsForInsights(q);
      return { success: true, products };
    } catch (err) {
      console.error('[SmartSort] Insight search failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/smart-collections/product-insights/:productId
  fastify.get('/product-insights/:productId', async (request, reply) => {
    try {
      const insights = await getProductInsights(fastify, request.params.productId);
      return { success: true, ...insights };
    } catch (err) {
      if (err.statusCode !== 404) console.error('[SmartSort] Product insights failed:', err.message);
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });
}

module.exports = routes;
