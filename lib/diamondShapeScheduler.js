/**
 * Diamond Shape Filter — the global sync job and its schedule.
 *
 * New products arrive every day, so the dashboard's "Sync all" can also run on
 * its own: daily or weekly at an IST time, configured on the dashboard and
 * stored in `settings { key: 'diamond_shape_schedule' }`. A scheduled run is
 * EXACTLY the manual one (same function, trigger: 'schedule'): rescan, then
 * write the shape for products that are missing it or hold a different value.
 * Nothing is ever deleted.
 *
 * Same shape as lib/recoScheduler.js and lib/smartSortScheduler.js — a
 * self-rearming 60s setTimeout, dependency-free — and the due-check and IST
 * maths come from lib/syncCadence.js (including missed-run catch-up after a
 * restart across the scheduled minute).
 *
 * Two guards, because index.js listens with exclusive:false and every worker
 * runs this timer:
 *   1. The slot claim — a compare-and-set on the schedule doc's lastRunAt, so
 *      only one worker fires a given slot.
 *   2. The run lock — a partial unique index on diamond_shape_runs.lock, set
 *      while a run is going, so a scheduled run and a manual "Sync all" can
 *      never overlap either, on any worker.
 *
 * Exports: startGlobalSync, getSchedule, saveSchedule,
 *          startDiamondShapeScheduler, stopDiamondShapeScheduler
 */

const shape = require('./diamondShape');
const { SYNC_MODES, istParts, isRuleDue, reapAbandonedRuns } = require('./syncCadence');

const RUNS = 'diamond_shape_runs';
const SCHEDULE_KEY = 'diamond_shape_schedule';
const LOCK = 'global';
const TICK_MS = 60 * 1000;
// A run whose heartbeat is older than this was left by a dead process. A full
// run is ~30s of scan plus ~1s per 25 writes, and heartbeats on every chunk.
const STALE_RUN_MS = 10 * 60 * 1000;

const DEFAULT_SCHEDULE = {
  enabled: false,
  syncMode: 'daily',
  syncWeekday: 1,
  // After the 02:30 smart-sort pass (~40 min) and the reco rules, so it never
  // queues behind them in the governor's background lane.
  scheduleTime: '05:00',
};

class RunInProgressError extends Error {
  constructor(run) {
    super('A global sync is already running');
    this.statusCode = 409;
    this.run = run;
  }
}

// ---------------------------------------------------------------------------
// The job

async function ensureRunIndexes(db) {
  const runs = db.collection(RUNS);
  await runs.createIndex({ startedAt: -1 });
  await runs.createIndex({ lock: 1 }, { unique: true, partialFilterExpression: { lock: LOCK } });
}

/**
 * Start a global sync in the background. Resolves with the run doc as soon as
 * the lock is held; the work continues detached and heartbeats into the doc.
 * Throws RunInProgressError when another run (manual or scheduled, any worker)
 * holds the lock.
 */
async function startGlobalSync(db, trigger = 'manual') {
  const runs = db.collection(RUNS);

  // A lock left by a dead process is released first, so it cannot block
  // every future run.
  await runs.updateMany(
    { lock: LOCK, heartbeatAt: { $lte: new Date(Date.now() - STALE_RUN_MS) } },
    {
      $set: { status: 'failed', error: 'Abandoned — the process running it stopped', finishedAt: new Date() },
      $unset: { lock: '' },
    }
  );

  const now = new Date();
  const run = {
    lock: LOCK,
    trigger,
    status: 'running',
    phase: 'scanning',
    startedAt: now,
    heartbeatAt: now,
    total: 0,
    done: 0,
    written: 0,
    errors: [],
  };
  try {
    const { insertedId } = await runs.insertOne(run);
    run._id = insertedId;
  } catch (err) {
    if (err && err.code === 11000) throw new RunInProgressError(await runs.findOne({ lock: LOCK }));
    throw err;
  }

  execute(runs, run._id).catch((err) => console.error('[DiamondShape] global sync crashed', err));
  return run;
}

async function execute(runs, runId) {
  const set = (fields, unset) =>
    runs.updateOne({ _id: runId }, { $set: { ...fields, heartbeatAt: new Date() }, ...(unset ? { $unset: unset } : {}) });
  try {
    const definition = await shape.ensureDefinition();
    // Always a fresh scan: a cached one could miss products added since.
    const scan = await shape.scanCatalog({ force: true });
    const before = shape.summarize(scan.rows);
    await set({ phase: 'writing', definitionCreated: definition.created, before, total: before.needsSync });

    const result = await shape.applyRows(scan.rows, {
      onProgress: (p) => set({ done: p.done, written: p.written }),
    });

    await set({
      status: result.errors.length ? 'completed_with_errors' : 'completed',
      phase: 'done',
      done: result.total,
      written: result.written,
      errors: result.errors.slice(0, 50),
      errorCount: result.errors.length,
      after: shape.summarize(scan.rows),
      finishedAt: new Date(),
    }, { lock: '' });
  } catch (err) {
    console.error('[DiamondShape] global sync failed', err);
    await set({ status: 'failed', phase: 'done', error: err.message, finishedAt: new Date() }, { lock: '' });
  }
}

// ---------------------------------------------------------------------------
// The schedule

const publicSchedule = (doc) => {
  const s = { ...DEFAULT_SCHEDULE, ...(doc || {}) };
  return {
    enabled: Boolean(s.enabled),
    syncMode: s.syncMode === 'weekly' ? 'weekly' : 'daily',
    syncWeekday: s.syncWeekday,
    scheduleTime: s.scheduleTime,
    lastRunAt: s.lastRunAt || null,
    lastRunId: s.lastRunId || null,
    updatedAt: s.updatedAt || null,
  };
};

async function getSchedule(db) {
  return publicSchedule(await db.collection('settings').findOne({ key: SCHEDULE_KEY }));
}

async function saveSchedule(db, input = {}) {
  const current = await getSchedule(db);
  const next = { ...current };

  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.syncMode !== undefined) {
    if (!['daily', 'weekly'].includes(input.syncMode)) {
      throw Object.assign(new Error(`syncMode must be daily or weekly (got ${input.syncMode})`), { statusCode: 400 });
    }
    next.syncMode = input.syncMode;
  }
  if (input.syncWeekday !== undefined) {
    const d = Number(input.syncWeekday);
    if (!Number.isInteger(d) || d < 0 || d > 6) throw Object.assign(new Error('syncWeekday must be 0-6'), { statusCode: 400 });
    next.syncWeekday = d;
  }
  if (input.scheduleTime !== undefined) {
    // toMinute alone accepts "25:99" — it parses, it does not range-check.
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.scheduleTime))) {
      throw Object.assign(new Error('scheduleTime must be HH:MM (IST)'), { statusCode: 400 });
    }
    next.scheduleTime = input.scheduleTime;
  }

  const now = new Date();
  await db.collection('settings').updateOne(
    { key: SCHEDULE_KEY },
    {
      $set: {
        enabled: next.enabled,
        syncMode: next.syncMode,
        syncWeekday: next.syncWeekday,
        scheduleTime: next.scheduleTime,
        // Every save re-arms the catch-up floor. Without it, turning the
        // schedule on at 10:00 with a 05:00 slot would "catch up" on today's
        // slot and sync the moment it was saved.
        armedAt: now,
        updatedAt: now,
      },
      $setOnInsert: { key: SCHEDULE_KEY, createdAt: now },
    },
    { upsert: true }
  );
  return getSchedule(db);
}

// ---------------------------------------------------------------------------
// The timer

let timer = null;
let stopped = false;
let lastTickMinute = null;

async function tick(fastify) {
  try {
    const db = fastify.mongo.db;
    const ist = istParts();
    const prev = lastTickMinute;
    lastTickMinute = ist.minute;

    const doc = await db.collection('settings').findOne({ key: SCHEDULE_KEY });
    if (!doc || !doc.enabled) return;

    // Floor for catch-up = the later of the last scheduled run and the last save.
    const floors = [doc.lastRunAt, doc.armedAt, doc.createdAt].filter(Boolean).map((d) => new Date(d).getTime());
    const rule = {
      syncMode: SYNC_MODES.includes(doc.syncMode) ? doc.syncMode : 'daily',
      syncWeekday: doc.syncWeekday,
      scheduleTime: doc.scheduleTime,
      lastRunAt: floors.length ? new Date(Math.max(...floors)) : null,
    };
    if (!isRuleDue(rule, prev, ist.minute, ist)) return;

    // Claim the slot: compare-and-set on the lastRunAt we just read, so of all
    // the workers ticking this minute exactly one moves it.
    const claimed = await db.collection('settings').updateOne(
      { key: SCHEDULE_KEY, lastRunAt: doc.lastRunAt ?? null },
      { $set: { lastRunAt: new Date() } }
    );
    if (!claimed.modifiedCount) return;

    try {
      const run = await startGlobalSync(db, 'schedule');
      await db.collection('settings').updateOne({ key: SCHEDULE_KEY }, { $set: { lastRunId: run._id } });
      console.log(`[DiamondShapeScheduler] ${ist.hhmm} IST — started scheduled sync ${run._id}`);
    } catch (err) {
      if (err instanceof RunInProgressError) {
        console.log('[DiamondShapeScheduler] a sync is already running — scheduled slot skipped');
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('[DiamondShapeScheduler] Tick error:', err);
  } finally {
    if (!stopped) {
      timer = setTimeout(() => tick(fastify), TICK_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

// Call AFTER fastify.listen succeeds.
async function startDiamondShapeScheduler(fastify) {
  if (timer) return;
  stopped = false;
  try {
    // AWAITED: without the unique lock index two workers could both "start" a run.
    await ensureRunIndexes(fastify.mongo.db);
  } catch (err) {
    console.error('[DiamondShapeScheduler] NOT STARTED — the run lock index could not be created:', err.message);
    return;
  }
  await reapAbandonedRuns(fastify.mongo.db, RUNS, STALE_RUN_MS, 'DiamondShapeScheduler');
  // A reaped run is failed but still holds the lock field; release it.
  await fastify.mongo.db.collection(RUNS).updateMany({ lock: LOCK, status: { $ne: 'running' } }, { $unset: { lock: '' } });

  timer = setTimeout(() => tick(fastify), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[DiamondShapeScheduler] Started — checking every 60s (IST)');
}

function stopDiamondShapeScheduler() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = {
  RunInProgressError,
  ensureRunIndexes,
  startGlobalSync,
  getSchedule,
  saveSchedule,
  startDiamondShapeScheduler,
  stopDiamondShapeScheduler,
};
