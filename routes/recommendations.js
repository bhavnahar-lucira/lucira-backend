/**
 * Recommendation Rules Routes (Fastify) — "From the Same Collection"
 *
 * CRUD for per-collection rule configs (Mongo `reco_rules`, managed from
 * lucira-admin), dry-run previews, manual runs, and run history. The engine
 * itself lives in lib/recommendations.js; the daily scheduler in
 * lib/recoScheduler.js. Registered in index.js under /api/recommendations.
 */

const { shopifyAdminFetch } = require('../lib/shopify');
const { previewForRule, previewScope, runRule, runningRules, ATTRIBUTES, SORT_KEYS, OPS_BY_KIND, getAttributeOptions } = require('../lib/recommendations');
const { isGa4Configured } = require('../lib/ga4');

const ALLOWED_ATTRIBUTES = ['price', 'collection', 'inventory', 'popularity', 'diamond_type'];
const SCHEDULE_TIME_RE = /^\d{2}:\d{2}$/;
const MAX_TOTAL_SLOTS = 16; // metafield validation list.max=16
// A reco_runs doc stuck in status:"running" past this age is treated as the
// leftover of a crashed worker and no longer blocks new runs.
const STALE_RUNNING_MS = 15 * 60 * 1000;

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const rulesCol = db.collection('reco_rules');
  const runsCol = db.collection('reco_runs');
  const { ObjectId } = fastify.mongo;

  // Background index creation (non-blocking, house pattern: routes/admin.js)
  rulesCol.createIndex({ collectionHandle: 1 }, { unique: true }).catch(console.error);
  runsCol.createIndex({ startedAt: -1 }).catch(console.error);

  const toObjectId = (id) => {
    try { return new ObjectId(id); } catch (_) { return null; }
  };

  // findOneAndUpdate result across driver shapes ({value: doc} vs doc).
  const unwrapFindOneAndUpdate = (result) =>
    (result && result.value !== undefined ? result.value : result);

  // Validates the writable rule fields present in `body`.
  // partial=false (POST): required fields must be present; partial=true (PUT):
  // only fields actually sent are checked. Returns an error string or null.
  const validateRuleBody = (body, { partial } = {}) => {
    if (!body || typeof body !== 'object') return 'Request body is required';
    const has = (k) => body[k] !== undefined;

    if (!partial || has('collectionId')) {
      // collectionId null = a STORE-WIDE rule whose source scope is every
      // product in Shopify. Collection rules at a higher priority reclaim
      // their products from it, which is how a global default gets
      // overridden per collection (see getOwnedByHigherPriority).
      const storeWide = body.collectionId === null;
      if (!storeWide && (typeof body.collectionId !== 'string' || !body.collectionId.startsWith('gid://shopify/Collection/'))) {
        return 'collectionId must be a Shopify Collection GID, or null for a store-wide rule';
      }
    }
    if (!partial || has('collectionHandle')) {
      if (typeof body.collectionHandle !== 'string' || !body.collectionHandle.trim()) {
        return 'collectionHandle is required';
      }
    }
    if (has('enabled') && typeof body.enabled !== 'boolean') {
      return 'enabled must be a boolean';
    }
    if (has('priority') && (typeof body.priority !== 'number' || Number.isNaN(body.priority))) {
      return 'priority must be a number';
    }
    if (!partial || has('scheduleTime')) {
      if (typeof body.scheduleTime !== 'string' || !SCHEDULE_TIME_RE.test(body.scheduleTime)) {
        return 'scheduleTime must be an IST time in HH:mm format';
      }
      const [hh, mm] = body.scheduleTime.split(':').map(Number);
      if (hh > 23 || mm > 59) return 'scheduleTime must be a valid time between 00:00 and 23:59';
    }
    if (!partial || has('attributePriority')) {
      if (!Array.isArray(body.attributePriority) || body.attributePriority.length === 0) {
        return 'attributePriority must be a non-empty array';
      }
      const bad = body.attributePriority.find((a) => !ALLOWED_ATTRIBUTES.includes(a));
      if (bad !== undefined) {
        return `attributePriority contains invalid value "${bad}" (allowed: ${ALLOWED_ATTRIBUTES.join(', ')})`;
      }
    }
    if ((!partial && body.version !== 2 && body.sequences === undefined) || has('blocks')) {
      if (!Array.isArray(body.blocks) || body.blocks.length === 0) {
        return 'blocks must be a non-empty array';
      }
      let total = 0;
      for (const block of body.blocks) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          return 'each block must be an object';
        }
        const size = Number(block.size);
        if (!Number.isInteger(size) || size < 1) return 'each block size must be an integer >= 1';
        total += size;
        if (block.conditions !== undefined &&
            (typeof block.conditions !== 'object' || block.conditions === null || Array.isArray(block.conditions))) {
          return 'block conditions must be an object';
        }
      }
      if (total > MAX_TOTAL_SLOTS) {
        return `block sizes must sum to ${MAX_TOTAL_SLOTS} or less (got ${total})`;
      }
    }
    if (has('backfill') && typeof body.backfill !== 'boolean') {
      return 'backfill must be a boolean';
    }
    // ---- v2 (Tagalys-model) fields ----
    const condError = (cond, where, allowDynamic) => {
      if (!cond || typeof cond !== 'object') return 'each ' + where + ' condition must be an object';
      const def = ATTRIBUTES[cond.attr];
      if (!def) return 'unknown condition attribute "' + cond.attr + '" in ' + where;
      const dynamicOps = ['matches_source', 'within_percent', 'within_amount'];
      const allowed = (OPS_BY_KIND[def.kind] || []).concat(def.matchable ? ['matches_source'] : []);
      if (!allowed.includes(cond.op)) return 'operator "' + cond.op + '" is not valid for ' + cond.attr + ' in ' + where;
      if (!allowDynamic && dynamicOps.includes(cond.op)) {
        return where + ' conditions cannot reference the source product (op "' + cond.op + '")';
      }
      const valueFreeOps = ['matches_source', 'has_any', 'above_average', 'below_average'];
      if (!valueFreeOps.includes(cond.op) && def.kind !== 'boolean' &&
          (cond.value === undefined || cond.value === null || cond.value === '')) {
        return 'condition on ' + cond.attr + ' needs a value';
      }
      return null;
    };
    if (has('version') && body.version !== 2) {
      return 'version must be 2 when provided';
    }
    if (has('source')) {
      if (typeof body.source !== 'object' || body.source === null || Array.isArray(body.source)) {
        return 'source must be an object';
      }
      if (body.source.productIds !== undefined) {
        if (!Array.isArray(body.source.productIds)) return 'source.productIds must be an array';
        const badId = body.source.productIds.find((id) => typeof id !== 'string' || !id.startsWith('gid://shopify/Product/'));
        if (badId !== undefined) return 'source.productIds must contain Shopify Product GIDs';
      }
      for (const cond of body.source.conditions || []) {
        const err = condError(cond, 'source', false);
        if (err) return err;
      }
    }
    if (has('commonConditions')) {
      if (!Array.isArray(body.commonConditions)) return 'commonConditions must be an array';
      for (const cond of body.commonConditions) {
        const err = condError(cond, 'common', true);
        if (err) return err;
      }
    }
    if (has('sequences')) {
      if (!Array.isArray(body.sequences)) return 'sequences must be an array';
      let seqTotal = 0;
      for (const seq of body.sequences) {
        if (!seq || typeof seq !== 'object') return 'each sequence must be an object';
        const size = Number(seq.size);
        if (!Number.isInteger(size) || size < 1) return 'each sequence size must be an integer >= 1';
        seqTotal += size;
        if (seq.pool !== undefined && !['collection', 'catalog'].includes(seq.pool)) {
          return 'sequence pool must be "collection" or "catalog"';
        }
        for (const cond of seq.conditions || []) {
          const err = condError(cond, 'sequence', true);
          if (err) return err;
        }
        for (const sort of seq.sortBy || []) {
          if (!sort || !SORT_KEYS[sort.key]) return 'unknown sort key "' + (sort && sort.key) + '"';
          if (sort.dir !== undefined && !['asc', 'desc'].includes(sort.dir)) return 'sort dir must be asc or desc';
        }
      }
      if (seqTotal > MAX_TOTAL_SLOTS) {
        return 'sequence sizes must sum to ' + MAX_TOTAL_SLOTS + ' or less (got ' + seqTotal + ')';
      }
    }
    if (has('pins')) {
      if (typeof body.pins !== 'object' || body.pins === null || Array.isArray(body.pins)) {
        return 'pins must be an object { global, perProduct }';
      }
      const isGidList = (arr) => Array.isArray(arr) && arr.every((g) => typeof g === 'string' && g.includes('gid://shopify/Product/'));
      if (body.pins.global !== undefined && !isGidList(body.pins.global)) {
        return 'pins.global must be an array of product GIDs';
      }
      if (body.pins.global && body.pins.global.length > MAX_TOTAL_SLOTS) {
        return 'pins.global cannot hold more than ' + MAX_TOTAL_SLOTS + ' products';
      }
      if (body.pins.perProduct !== undefined) {
        if (typeof body.pins.perProduct !== 'object' || Array.isArray(body.pins.perProduct)) {
          return 'pins.perProduct must be an object keyed by product id';
        }
        for (const [pid, list] of Object.entries(body.pins.perProduct)) {
          if (!/^[0-9]+$/.test(pid)) return 'pins.perProduct keys must be numeric product ids (got "' + pid + '")';
          if (!isGidList(list)) return 'pins.perProduct["' + pid + '"] must be an array of product GIDs';
          if (list.length > MAX_TOTAL_SLOTS) return 'pins.perProduct["' + pid + '"] cannot hold more than ' + MAX_TOTAL_SLOTS + ' products';
        }
      }
    }
    if (has('automatedEnabled') && typeof body.automatedEnabled !== 'boolean') {
      return 'automatedEnabled must be a boolean';
    }
    return null;
  };

  const normalizeBlocks = (blocks) => (blocks || []).map((b) => ({
    size: Number(b.size),
    label: b.label || '',
    conditions: b.conditions || {}
  }));

  const normalizeConditions = (conds) => (conds || []).map((c) => ({
    attr: c.attr,
    op: c.op,
    ...(c.value !== undefined ? { value: c.value } : {}),
    // Display-only: the admin shows collection names instead of raw GIDs.
    ...(typeof c.valueLabel === 'string' && c.valueLabel ? { valueLabel: c.valueLabel.slice(0, 120) } : {})
  }));

  const normalizeSequences = (sequences) => (sequences || []).map((sq) => ({
    size: Number(sq.size),
    label: sq.label || '',
    pool: sq.pool === 'catalog' ? 'catalog' : 'collection',
    conditions: normalizeConditions(sq.conditions),
    sortBy: (sq.sortBy || []).map((srt) => ({ key: srt.key, dir: srt.dir === 'asc' ? 'asc' : 'desc' }))
  }));

  const normalizePins = (pins) => ({
    global: (pins && pins.global) || [],
    perProduct: (pins && pins.perProduct) || {}
  });

  // GET /api/recommendations/collections/search?q=<text>
  fastify.get('/collections/search', async (request, reply) => {
    const q = String(request.query.q || '').trim();
    if (!q) return reply.code(400).send({ error: 'q is required' });

    try {
      const data = await shopifyAdminFetch(`
        query searchCollections($query: String!) {
          collections(first: 20, query: $query) {
            nodes {
              id
              handle
              title
              productsCount { count }
            }
          }
        }
      `, { query: `title:*${q.replace(/["\\]/g, '')}*` });

      const collections = (data?.collections?.nodes || []).map((node) => ({
        id: node.id,
        handle: node.handle,
        title: node.title,
        productsCount: node.productsCount?.count ?? 0
      }));

      return { success: true, collections };
    } catch (err) {
      console.error('[Reco] Collection search failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/recommendations/rules
  fastify.get('/rules', async (request, reply) => {
    try {
      const rules = await rulesCol.find({}).sort({ priority: -1, createdAt: 1 }).toArray();
      return { success: true, rules };
    } catch (err) {
      console.error('[Reco] List rules failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/recommendations/rules/:id
  fastify.get('/rules/:id', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const rule = await rulesCol.findOne({ _id });
      if (!rule) return reply.code(404).send({ error: 'Rule not found' });

      return { success: true, rule };
    } catch (err) {
      console.error('[Reco] Get rule failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/recommendations/rules
  fastify.post('/rules', async (request, reply) => {
    try {
      const body = request.body || {};
      const invalid = validateRuleBody(body, { partial: false });
      if (invalid) return reply.code(400).send({ error: invalid });

      const collectionHandle = body.collectionHandle.trim();
      const existing = await rulesCol.findOne({ collectionHandle });
      if (existing) {
        return reply.code(409).send({ error: `A rule for collection "${collectionHandle}" already exists` });
      }

      const now = new Date();
      const rule = {
        collectionId: body.collectionId,
        collectionHandle,
        collectionTitle: body.collectionTitle || '',
        enabled: body.enabled !== undefined ? body.enabled : true,
        priority: body.priority !== undefined ? body.priority : 10,
        scheduleTime: body.scheduleTime,
        attributePriority: body.attributePriority,
        backfill: body.backfill !== undefined ? body.backfill : true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStats: null
      };
      // Legacy v1 shape only when the caller actually sent blocks. A v2 rule
      // carries `sequences` instead and must not be given a phantom blocks
      // array — normalizeRule() would otherwise have two shapes to reconcile.
      if (body.blocks !== undefined) rule.blocks = normalizeBlocks(body.blocks);
      if (body.version === 2 || body.sequences !== undefined) {
        rule.version = 2;
        rule.source = {
          collectionId: rule.collectionId,
          productIds: Array.isArray(body.source && body.source.productIds) ? body.source.productIds : [],
          conditions: normalizeConditions(body.source && body.source.conditions)
        };
        rule.sequences = normalizeSequences(body.sequences);
        rule.commonConditions = normalizeConditions(body.commonConditions);
        rule.pins = normalizePins(body.pins);
        rule.automatedEnabled = body.automatedEnabled !== false;
      }

      const result = await rulesCol.insertOne(rule);
      rule._id = result.insertedId;
      console.log(`[Reco] Rule created for "${collectionHandle}"`);
      return { success: true, rule };
    } catch (err) {
      // Unique index on collectionHandle backs the race the findOne misses.
      if (err && err.code === 11000) {
        return reply.code(409).send({ error: 'A rule for this collection already exists' });
      }
      console.error('[Reco] Create rule failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // PUT /api/recommendations/rules/:id (partial update)
  fastify.put('/rules/:id', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const body = request.body || {};
      const invalid = validateRuleBody(body, { partial: true });
      if (invalid) return reply.code(400).send({ error: invalid });

      const updatable = [
        'collectionId', 'collectionHandle', 'collectionTitle', 'enabled',
        'priority', 'scheduleTime', 'attributePriority', 'blocks', 'backfill',
        'version', 'source', 'sequences', 'pins', 'automatedEnabled', 'commonConditions'
      ];
      const $set = { updatedAt: new Date() };
      for (const field of updatable) {
        if (body[field] !== undefined) $set[field] = body[field];
      }
      if ($set.collectionHandle !== undefined) {
        $set.collectionHandle = String($set.collectionHandle).trim();
        const clash = await rulesCol.findOne({ collectionHandle: $set.collectionHandle, _id: { $ne: _id } });
        if (clash) {
          return reply.code(409).send({ error: `A rule for collection "${$set.collectionHandle}" already exists` });
        }
      }
      if ($set.blocks !== undefined) $set.blocks = normalizeBlocks($set.blocks);
      if ($set.sequences !== undefined) {
        $set.sequences = normalizeSequences($set.sequences);
        $set.version = 2;
      }
      if ($set.source !== undefined) {
        $set.source = {
          collectionId: $set.collectionId || body.source.collectionId || null,
          productIds: Array.isArray(body.source.productIds) ? body.source.productIds : [],
          conditions: normalizeConditions(body.source.conditions)
        };
        $set.version = 2;
      }
      if ($set.pins !== undefined) $set.pins = normalizePins($set.pins);
      if ($set.commonConditions !== undefined) {
        $set.commonConditions = normalizeConditions($set.commonConditions);
        $set.version = 2;
      }
      // Keep source.collectionId mirrored when only the collection changes.
      if ($set.collectionId !== undefined && $set.source === undefined) {
        $set['source.collectionId'] = $set.collectionId;
      }

      const result = await rulesCol.findOneAndUpdate({ _id }, { $set }, { returnDocument: 'after' });
      const rule = unwrapFindOneAndUpdate(result);
      if (!rule) return reply.code(404).send({ error: 'Rule not found' });

      return { success: true, rule };
    } catch (err) {
      if (err && err.code === 11000) {
        return reply.code(409).send({ error: 'A rule for this collection already exists' });
      }
      console.error('[Reco] Update rule failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // DELETE /api/recommendations/rules/:id
  fastify.delete('/rules/:id', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const result = await rulesCol.deleteOne({ _id });
      if (!result.deletedCount) return reply.code(404).send({ error: 'Rule not found' });

      console.log(`[Reco] Rule ${request.params.id} deleted`);
      return { success: true };
    } catch (err) {
      console.error('[Reco] Delete rule failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/recommendations/rules/:id/preview — DRY RUN, no writes
  fastify.post('/rules/:id/preview', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const rule = await rulesCol.findOne({ _id });
      if (!rule) return reply.code(404).send({ error: 'Rule not found' });

      const { productId, limit } = request.body || {};
      const preview = await previewForRule(fastify, rule, { productId, limit });
      return { success: true, preview };
    } catch (err) {
      console.error('[Reco] Preview failed:', err.message);
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  // POST /api/recommendations/rules/:id/run
  // Replies IMMEDIATELY with the runId, then computes async — the
  // reply-then-continue pattern from routes/webhooks.js: a full run can take
  // minutes and must not sit behind the reverse proxy's request timeout.
  fastify.post('/rules/:id/run', async (request, reply) => {
    const _id = toObjectId(request.params.id);
    if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

    let rule;
    try {
      rule = await rulesCol.findOne({ _id });
    } catch (err) {
      console.error('[Reco] Run lookup failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
    if (!rule) return reply.code(404).send({ error: 'Rule not found' });

    // Concurrency guard: in-process Set (this worker) + reco_runs
    // status:"running" check (other workers / restarts). Stale running docs
    // older than STALE_RUNNING_MS come from crashed workers and don't block.
    if (runningRules.has(String(_id))) {
      return reply.code(409).send({ error: 'A run for this rule is already in progress' });
    }
    try {
      const activeRun = await runsCol.findOne({
        ruleId: String(_id),
        status: 'running',
        startedAt: { $gt: new Date(Date.now() - STALE_RUNNING_MS) }
      });
      if (activeRun) {
        return reply.code(409).send({ error: 'A run for this rule is already in progress' });
      }
    } catch (err) {
      console.error('[Reco] Running check failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }

    // Claim the rule SYNCHRONOUSLY (no await between has() and add(), so it is
    // atomic within this worker) before replying. Without it, two near-simultaneous
    // POSTs both clear the checks above and the loser returns a runId that never
    // reaches reco_runs - the admin Runs modal would show nothing for it.
    const ruleKey = String(_id);
    if (runningRules.has(ruleKey)) {
      return reply.code(409).send({ error: "A run for this rule is already in progress" });
    }
    runningRules.add(ruleKey);

    // Acknowledge immediately, then continue in this handler (webhooks.js shape).
    const runId = new ObjectId();
    reply.code(200).send({ success: true, runId: String(runId) });

    try {
      await runRule(fastify, rule, 'manual', { runId, preAcquired: true });
    } catch (err) {
      // Already logged and bookkept (reco_runs status:"failed") inside runRule.
      console.error('[Reco] Manual run failed:', err.message);
    }
  });


  // GET /api/recommendations/attributes — condition registry for the rule
  // editor's dropdowns, plus data-availability so view metrics can be shown
  // honestly (greyed with "collecting since ..." until data exists).
  fastify.get('/attributes', async (request, reply) => {
    try {
      // Real values pulled from Shopify so the editor can offer a dropdown
      // instead of a free-text box — a mistyped value matches nothing and
      // fails silently (a tag typed "bestselllers" matched 0 of 79 products).
      const optionsByAttr = await getAttributeOptions().catch((err) => {
        console.error('[Reco] attribute options unavailable:', err.message);
        return {};
      });
      const attributes = Object.entries(ATTRIBUTES).map(([key, def]) => ({
        key,
        label: def.label,
        group: def.group,
        kind: def.kind,
        matchable: def.matchable === true,
        options: optionsByAttr[key],
        ops: (OPS_BY_KIND[def.kind] || []).concat(def.matchable ? ['matches_source'] : [])
      }));
      const sortKeys = Object.entries(SORT_KEYS).map(([key, defn]) => ({ key, label: defn.label, directional: defn.directional === true }));

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
      console.error('[Reco] Attributes failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/recommendations/preview-draft — live preview of an UNSAVED
  // rule, so the editor can show results while the user is still configuring.
  // Same body as POST /rules; nothing is written. excludeRuleId (when editing)
  // keeps the saved copy of the same rule out of the ownership check.
  fastify.post('/preview-draft', async (request, reply) => {
    try {
      const body = { ...(request.body || {}) };
      // Drafts may not have an identity yet — previewing does not need one.
      if (!body.collectionHandle) body.collectionHandle = '__draft__';
      const invalid = validateRuleBody(body, { partial: false });
      if (invalid) return reply.code(400).send({ error: invalid });

      const rule = {
        collectionId: body.collectionId ?? null,
        collectionHandle: body.collectionHandle,
        collectionTitle: body.collectionTitle || '',
        enabled: true,
        priority: Number(body.priority) || 0,
        scheduleTime: body.scheduleTime,
        attributePriority: body.attributePriority,
        backfill: body.backfill !== false,
        version: 2,
        source: {
          collectionId: body.collectionId ?? null,
          productIds: Array.isArray(body.source && body.source.productIds) ? body.source.productIds : [],
          conditions: normalizeConditions(body.source && body.source.conditions)
        },
        commonConditions: normalizeConditions(body.commonConditions),
        sequences: normalizeSequences(body.sequences),
        pins: normalizePins(body.pins),
        automatedEnabled: body.automatedEnabled !== false
      };
      const excludeId = toObjectId(body.excludeRuleId);
      if (excludeId) rule._id = excludeId;

      const preview = await previewForRule(fastify, rule, {
        limit: Math.min(Math.max(parseInt(body.limit, 10) || 2, 1), 3)
      });
      return { success: true, preview };
    } catch (err) {
      const code = err.statusCode === 404 || err.statusCode === 409 ? err.statusCode : 500;
      if (code === 500) console.error('[Reco] Draft preview failed:', err.message);
      return reply.code(code).send({ error: err.message });
    }
  });

  // POST /api/recommendations/preview-scope — live "products in scope" count
  // for the editor's source tab. Body: { collectionId, conditions }.
  fastify.post('/preview-scope', async (request, reply) => {
    try {
      const { collectionId, conditions } = request.body || {};
      // null collectionId is legitimate: a store-wide rule scopes to the
      // whole catalogue, so only reject a malformed value.
      if (collectionId !== null && collectionId !== undefined &&
          (typeof collectionId !== 'string' || !collectionId.startsWith('gid://shopify/Collection/'))) {
        return reply.code(400).send({ error: 'collectionId must be a Collection GID or null' });
      }
      for (const cond of conditions || []) {
        const def = ATTRIBUTES[cond && cond.attr];
        if (!def) return reply.code(400).send({ error: 'unknown condition attribute "' + (cond && cond.attr) + '"' });
        if (['matches_source', 'within_percent', 'within_amount'].includes(cond.op)) {
          return reply.code(400).send({ error: 'source conditions cannot reference the source product' });
        }
      }
      const scope = await previewScope(fastify, { collectionId: collectionId || null, conditions: conditions || [] });
      return { success: true, ...scope };
    } catch (err) {
      console.error('[Reco] Preview scope failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // PATCH /api/recommendations/rules/:id/pins — quick pin/unpin from the
  // preview modal without resending the whole rule. Body: { global?,
  // perProduct? } — each provided key REPLACES that part of the pins.
  fastify.patch('/rules/:id/pins', async (request, reply) => {
    try {
      const _id = toObjectId(request.params.id);
      if (!_id) return reply.code(400).send({ error: 'Invalid rule id' });

      const invalid = validateRuleBody({ pins: request.body || {} }, { partial: true });
      if (invalid) return reply.code(400).send({ error: invalid });

      const existing = await rulesCol.findOne({ _id });
      if (!existing) return reply.code(404).send({ error: 'Rule not found' });

      const current = (existing.pins && typeof existing.pins === 'object') ? existing.pins : { global: [], perProduct: {} };
      const body = request.body || {};
      const next = {
        global: body.global !== undefined ? body.global : (current.global || []),
        perProduct: { ...(current.perProduct || {}) }
      };
      if (body.perProduct !== undefined) {
        for (const [pid, list] of Object.entries(body.perProduct)) {
          if (Array.isArray(list) && list.length === 0) delete next.perProduct[pid];
          else next.perProduct[pid] = list;
        }
      }

      const result = await rulesCol.findOneAndUpdate(
        { _id },
        { $set: { pins: next, version: 2, updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const rule = unwrapFindOneAndUpdate(result);
      return { success: true, rule };
    } catch (err) {
      console.error('[Reco] Pins update failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/recommendations/runs?ruleId=&limit=20
  fastify.get('/runs', async (request, reply) => {
    try {
      const { ruleId } = request.query;
      const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 20, 1), 100);

      const query = {};
      if (ruleId) query.ruleId = String(ruleId);

      const runs = await runsCol.find(query).sort({ startedAt: -1 }).limit(limit).toArray();
      return { success: true, runs };
    } catch (err) {
      console.error('[Reco] List runs failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
