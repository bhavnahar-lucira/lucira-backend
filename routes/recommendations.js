/**
 * Recommendation Rules Routes (Fastify) — "From the Same Collection"
 *
 * CRUD for per-collection rule configs (Mongo `reco_rules`, managed from
 * lucira-admin), dry-run previews, manual runs, and run history. The engine
 * itself lives in lib/recommendations.js; the daily scheduler in
 * lib/recoScheduler.js. Registered in index.js under /api/recommendations.
 */

const { shopifyAdminFetch } = require('../lib/shopify');
const { previewForRule, runRule, runningRules } = require('../lib/recommendations');

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
      if (typeof body.collectionId !== 'string' || !body.collectionId.startsWith('gid://shopify/Collection/')) {
        return 'collectionId must be a Shopify Collection GID (gid://shopify/Collection/...)';
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
    if (!partial || has('blocks')) {
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
    return null;
  };

  const normalizeBlocks = (blocks) => blocks.map((b) => ({
    size: Number(b.size),
    label: b.label || '',
    conditions: b.conditions || {}
  }));

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
        blocks: normalizeBlocks(body.blocks),
        backfill: body.backfill !== undefined ? body.backfill : true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastRunStats: null
      };

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
        'priority', 'scheduleTime', 'attributePriority', 'blocks', 'backfill'
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

    // Acknowledge immediately, then continue in this handler (webhooks.js shape).
    const runId = new ObjectId();
    reply.code(200).send({ success: true, runId: String(runId) });

    try {
      await runRule(fastify, rule, 'manual', { runId });
    } catch (err) {
      // Already logged and bookkept (reco_runs status:"failed") inside runRule.
      console.error('[Reco] Manual run failed:', err.message);
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
