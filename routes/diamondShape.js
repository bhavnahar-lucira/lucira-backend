/**
 * Diamond Shape Filter routes — /api/diamond-shape
 *
 *   GET  /status?refresh=1      coverage summary + every product's state
 *   POST /definition            create the custom.diamond_shape_filter definition if missing
 *   POST /sync/product {ref}    sync ONE product (id, GID, admin/storefront URL, handle or SKU)
 *   POST /sync/all              background sync of every product that needs it
 *   GET  /schedule              the automatic sync schedule
 *   PUT  /schedule              { enabled, syncMode: daily|weekly, syncWeekday, scheduleTime: 'HH:MM' IST }
 *   GET  /runs                  last 20 global runs (newest first)
 *   GET  /runs/:id              one run, for progress polling
 *
 * The engine lives in lib/diamondShape.js; the global job, its run lock and
 * the schedule in lib/diamondShapeScheduler.js. Runs are stored in Mongo
 * `diamond_shape_runs` so the admin can poll progress and see history.
 */

const shape = require('../lib/diamondShape');
const { startGlobalSync, getSchedule, saveSchedule, ensureRunIndexes } = require('../lib/diamondShapeScheduler');

async function routes(fastify) {
  const { ObjectId } = fastify.mongo;
  const runs = fastify.mongo.db.collection('diamond_shape_runs');
  ensureRunIndexes(fastify.mongo.db).catch(console.error);

  const fail = (reply, err) => {
    console.error('[DiamondShape]', err);
    return reply.code(err.statusCode || 500).send({ success: false, error: err.message || 'Failed' });
  };

  fastify.get('/status', async (request, reply) => {
    try {
      const force = request.query.refresh === '1' || request.query.refresh === 'true';
      const [definition, scan, lastRun, schedule] = await Promise.all([
        shape.getDefinition(),
        shape.scanCatalog({ force, priority: 'interactive' }),
        runs.find({}).sort({ startedAt: -1 }).limit(1).next(),
        getSchedule(fastify.mongo.db),
      ]);
      return {
        success: true,
        definition,
        scannedAt: new Date(scan.at),
        summary: shape.summarize(scan.rows),
        shapeNames: shape.SHAPE_NAMES,
        products: scan.rows,
        lastRun,
        schedule,
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post('/definition', async (request, reply) => {
    try {
      return { success: true, definition: await shape.ensureDefinition() };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post('/sync/product', async (request, reply) => {
    try {
      const result = await shape.syncProduct(request.body?.ref);
      return { success: !result.errors.length, ...result };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post('/sync/all', async (request, reply) => {
    try {
      // Not awaited past the lock: the admin polls GET /runs/:id.
      return { success: true, run: await startGlobalSync(fastify.mongo.db, 'manual') };
    } catch (err) {
      if (err.statusCode === 409) return reply.code(409).send({ success: false, error: err.message, run: err.run });
      return fail(reply, err);
    }
  });

  fastify.get('/schedule', async (request, reply) => {
    try {
      return { success: true, schedule: await getSchedule(fastify.mongo.db) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.put('/schedule', async (request, reply) => {
    try {
      return { success: true, schedule: await saveSchedule(fastify.mongo.db, request.body || {}) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get('/runs', async (request, reply) => {
    try {
      return { success: true, runs: await runs.find({}).sort({ startedAt: -1 }).limit(20).toArray() };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get('/runs/:id', async (request, reply) => {
    try {
      if (!ObjectId.isValid(request.params.id)) return reply.code(400).send({ success: false, error: 'Bad run id' });
      const run = await runs.findOne({ _id: new ObjectId(request.params.id) });
      if (!run) return reply.code(404).send({ success: false, error: 'Run not found' });
      return { success: true, run };
    } catch (err) {
      return fail(reply, err);
    }
  });
}

module.exports = routes;
