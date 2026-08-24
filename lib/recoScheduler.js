/**
 * Recommendation Scheduler
 *
 * Daily (per-rule, IST) refresh of the "From the Same Collection" metafields.
 *
 * WHY a self-rearming setTimeout and not node-cron: adding a dependency needs
 * a Hostinger deploy step and this repo has none today — no scheduler infra
 * exists anywhere in the codebase, so this timer is deliberately dependency-
 * free. It starts AFTER the server listens (never during plugin registration,
 * which must finish inside pluginTimeout).
 *
 * Every 60s tick:
 *   1. Compute the current IST HH:mm.
 *   2. Find enabled rules whose scheduleTime matches AND whose lastRunAt is
 *      null or older than 10 minutes (so the two-or-three ticks that can land
 *      inside the same minute don't re-fire a finished run).
 *   3. For each due rule, acquire a Mongo lease FIRST — index.js listens with
 *      exclusive:false, so several workers may share the port and every one
 *      of them runs this timer. The lease (settings doc keyed
 *      { key:'reco_scheduler_lease', ruleId } with a 5-minute expiresAt,
 *      claimed via a single findOneAndUpdate upsert backed by a partial
 *      unique index) guarantees at most one worker runs a given rule.
 *   4. Run the winners sequentially with trigger "schedule".
 * The whole tick is wrapped in try/catch so a failure never kills the timer.
 */

const { runRule, runningRules } = require('./recommendations');

const TICK_MS = 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const RERUN_GUARD_MS = 10 * 60 * 1000;

let timer = null;
let stopped = false;

const istNowHHmm = () => new Date().toLocaleTimeString('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

// Multi-worker guard. Atomic: if the lease doc exists unexpired, the filter
// misses and the upsert's insert trips the partial unique index (11000) —
// another worker holds it. If it is absent or expired, this worker claims it.
async function acquireLease(db, ruleId) {
  const now = new Date();
  try {
    await db.collection('settings').findOneAndUpdate(
      {
        key: 'reco_scheduler_lease',
        ruleId,
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
    if (err && err.code === 11000) return false;
    throw err;
  }
}

async function tick(fastify) {
  try {
    const db = fastify.mongo.db;
    const nowHHmm = istNowHHmm();
    const cutoff = new Date(Date.now() - RERUN_GUARD_MS);

    const due = await db.collection('reco_rules').find({
      enabled: true,
      scheduleTime: nowHHmm,
      $or: [{ lastRunAt: null }, { lastRunAt: { $lt: cutoff } }]
    }).sort({ priority: -1 }).toArray();

    for (const rule of due) {
      const ruleKey = String(rule._id);
      if (runningRules.has(ruleKey)) continue;

      const acquired = await acquireLease(db, ruleKey);
      if (!acquired) {
        console.log(`[RecoScheduler] Lease held elsewhere for "${rule.collectionHandle}" — skipping`);
        continue;
      }

      console.log(`[RecoScheduler] ${nowHHmm} IST — running rule "${rule.collectionHandle}"`);
      try {
        await runRule(fastify, rule, 'schedule');
      } catch (err) {
        console.error(`[RecoScheduler] Scheduled run failed for "${rule.collectionHandle}":`, err.message);
      }
    }
  } catch (err) {
    console.error('[RecoScheduler] Tick error:', err);
  } finally {
    if (!stopped) {
      timer = setTimeout(() => tick(fastify), TICK_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

// Call AFTER fastify.listen succeeds (mongo is registered and ready by then).
function startRecoScheduler(fastify) {
  if (timer) return; // idempotent
  stopped = false;

  // Partial unique index backing the lease's atomic claim. Partial so it only
  // constrains lease docs — the rest of the shared `settings` collection is
  // untouched. Fire-and-forget at startup, house pattern (routes/admin.js).
  fastify.mongo.db.collection('settings').createIndex(
    { key: 1, ruleId: 1 },
    { unique: true, partialFilterExpression: { key: 'reco_scheduler_lease' } }
  ).catch(console.error);

  timer = setTimeout(() => tick(fastify), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[RecoScheduler] Started — checking every 60s for due rules (IST)');
}

// Exported for the shutdown path. The timer is unref'd and closeGracefully
// exits the process anyway, so wiring this into index.js is optional — it
// exists so a clean stop is one call away (and for tests).
function stopRecoScheduler() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { startRecoScheduler, stopRecoScheduler };
