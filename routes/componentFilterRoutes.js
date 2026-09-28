/**
 * Shared routes for a component-filter page (routes/diamondShape.js,
 * routes/gemstone.js). Mounted under the page's prefix:
 *
 *   GET  /status?refresh=1      coverage summary + every product's state
 *   POST /definition            create whichever metafield definitions are missing
 *   POST /sync/product {ref}    sync ONE product (id, GID, admin/storefront URL, handle or SKU)
 *   POST /sync/all              background sync of every product that needs it
 *   GET  /schedule              the automatic sync schedule
 *   PUT  /schedule              { enabled, syncMode: daily|weekly, syncWeekday, scheduleTime: 'HH:MM' IST }
 *   GET  /runs                  last 20 global runs (newest first)
 *   GET  /runs/:id              one run, for progress polling
 *
 * The engine is lib/componentFilters.js; the job, run lock and schedule are
 * lib/filterScheduler.js. Runs are stored in Mongo so the admin can poll
 * progress and see history.
 */

function createFilterRoutes(engine, scheduler) {
  return async function routes(fastify) {
    const { ObjectId } = fastify.mongo;
    const db = fastify.mongo.db;
    const runs = db.collection(scheduler.RUNS);
    scheduler.ensureRunIndexes(db).catch(console.error);

    const fail = (reply, err) => {
      console.error(`[${engine.tag}]`, err);
      return reply.code(err.statusCode || 500).send({ success: false, error: err.message || 'Failed' });
    };

    fastify.get('/status', async (request, reply) => {
      try {
        const force = request.query.refresh === '1' || request.query.refresh === 'true';
        const [definitions, scan, lastRun, schedule] = await Promise.all([
          engine.getDefinitions(),
          engine.scanCatalog({ force, priority: 'interactive' }),
          runs.find({}).sort({ startedAt: -1 }).limit(1).next(),
          scheduler.getSchedule(db),
        ]);
        return {
          success: true,
          definitions,
          scannedAt: new Date(scan.at),
          summary: engine.summarize(scan.rows),
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
        return { success: true, ...(await engine.ensureDefinitions()) };
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post('/sync/product', async (request, reply) => {
      try {
        const result = await engine.syncProduct(request.body?.ref);
        return { success: !result.errors.length, ...result };
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post('/sync/all', async (request, reply) => {
      try {
        // Not awaited past the lock: the admin polls GET /runs/:id.
        return { success: true, run: await scheduler.startGlobalSync(db, 'manual') };
      } catch (err) {
        if (err.statusCode === 409) return reply.code(409).send({ success: false, error: err.message, run: err.run });
        return fail(reply, err);
      }
    });

    fastify.get('/schedule', async (request, reply) => {
      try {
        return { success: true, schedule: await scheduler.getSchedule(db) };
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.put('/schedule', async (request, reply) => {
      try {
        return { success: true, schedule: await scheduler.saveSchedule(db, request.body || {}) };
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
  };
}

module.exports = createFilterRoutes;
