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
 *   1. Compute the current IST minute-of-day.
 *   2. Find enabled rules whose scheduleTime falls in the WINDOW since the last
 *      tick, not just rules matching the current minute exactly. A run over a
 *      big collection takes many minutes; with exact matching, every rule
 *      scheduled during that stretch silently missed its slot for the day.
 *   3. For each due rule, check no other worker is mid-run (reco_runs), then
 *      acquire a Mongo lease — index.js listens with exclusive:false, so
 *      several workers may share the port and every one runs this timer. The
 *      lease (settings doc keyed { key:'reco_scheduler_lease', ruleId } with a
 *      5-minute expiresAt, claimed via a findOneAndUpdate upsert backed by a
 *      partial unique index) guarantees at most one worker runs a given rule.
 *   4. Fire the winners DETACHED so a long run never stalls the tick loop.
 * The whole tick is wrapped in try/catch so a failure never kills the timer.
 */

const { runRule, runningRules } = require('./recommendations');

const TICK_MS = 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const RERUN_GUARD_MS = 10 * 60 * 1000;
const STALE_RUNNING_MS = 15 * 60 * 1000; // matches routes/recommendations.js

let timer = null;
let stopped = false;
let lastTickMinute = null; // IST minute-of-day at the previous tick

const istParts = () => {
  const hhmm = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const bits = hhmm.split(':');
  const rawHour = parseInt(bits[0], 10);
  const m = parseInt(bits[1], 10);
  // Some older ICU builds render midnight as "24:00"; normalise so a "00:xx"
  // rule still fires.
  const h = rawHour === 24 ? 0 : rawHour;
  const pad = (n) => String(n).padStart(2, '0');
  return { hhmm: pad(h) + ':' + pad(m), minute: h * 60 + m };
};

const toMinute = (hhmm) => {
  const bits = String(hhmm || '').split(':');
  const h = parseInt(bits[0], 10);
  const m = parseInt(bits[1], 10);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
};

// True when `target` falls in (prev, now] on a 1440-minute circular clock, so a
// tick gap (long run, event-loop stall, restart) still catches every scheduled
// minute instead of skipping the day.
const isDue = (target, prev, now) => {
  if (target === null) return false;
  if (prev === null) return target === now;
  if (prev === now) return false;
  return prev < now ? (target > prev && target <= now) : (target > prev || target <= now);
};

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

// A crashed worker leaves its reco_runs doc on status:"running" forever. The
// stale window already unblocks new runs; this also closes the orphan so the
// admin Runs table stops showing a run that will never finish.
async function reapStaleRuns(runsCol, ruleKey) {
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS);
  try {
    await runsCol.updateMany(
      { ruleId: ruleKey, status: 'running', startedAt: { $lte: staleCutoff } },
      {
        $set: { status: 'failed', finishedAt: new Date() },
        $push: { errors: 'Run abandoned (worker restarted or crashed)' }
      }
    );
  } catch (err) {
    console.error('[RecoScheduler] Stale run reap failed:', err.message);
  }
}

async function tick(fastify) {
  try {
    const db = fastify.mongo.db;
    const runsCol = db.collection('reco_runs');
    const { hhmm, minute } = istParts();
    const prev = lastTickMinute;
    lastTickMinute = minute;

    const cutoff = new Date(Date.now() - RERUN_GUARD_MS);
    const candidates = await db.collection('reco_rules').find({
      enabled: true,
      $or: [{ lastRunAt: null }, { lastRunAt: { $lt: cutoff } }]
    }).sort({ priority: -1 }).toArray();

    const due = candidates.filter((r) => isDue(toMinute(r.scheduleTime), prev, minute));

    for (const rule of due) {
      const ruleKey = String(rule._id);
      if (runningRules.has(ruleKey)) continue;

      await reapStaleRuns(runsCol, ruleKey);

      // Another worker may be mid-run for this rule (its in-process Set is not
      // visible here); the run-now route applies the same check.
      const activeRun = await runsCol.findOne({
        ruleId: ruleKey,
        status: 'running',
        startedAt: { $gt: new Date(Date.now() - STALE_RUNNING_MS) }
      });
      if (activeRun) {
        console.log(`[RecoScheduler] Run already in progress elsewhere for "${rule.collectionHandle}" — skipping`);
        continue;
      }

      const acquired = await acquireLease(db, ruleKey);
      if (!acquired) {
        console.log(`[RecoScheduler] Lease held elsewhere for "${rule.collectionHandle}" — skipping`);
        continue;
      }

      console.log(`[RecoScheduler] ${hhmm} IST — running rule "${rule.collectionHandle}"`);
      // Detached: awaiting here would stall the tick loop for the whole run, and
      // every rule scheduled inside that window would miss its slot for the day.
      runRule(fastify, rule, 'schedule').catch((err) => {
        console.error(`[RecoScheduler] Scheduled run failed for "${rule.collectionHandle}":`, err.message);
      });
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
async function startRecoScheduler(fastify) {
  if (timer) return; // idempotent
  stopped = false;

  // Partial unique index backing the lease's atomic claim. Partial so it only
  // constrains lease docs — the rest of the shared `settings` collection is
  // untouched. AWAITED, not fire-and-forget: without the index the upsert's
  // insert never trips 11000, every worker "wins" the lease, and the multi-
  // worker guard silently degrades to no guard at all.
  try {
    await fastify.mongo.db.collection('settings').createIndex(
      { key: 1, ruleId: 1 },
      { unique: true, partialFilterExpression: { key: 'reco_scheduler_lease' } }
    );
  } catch (err) {
    console.error('[RecoScheduler] NOT STARTED — the lease index could not be created, so ' +
      'concurrent workers could run the same rule. Fix the index, then restart:', err.message);
    return;
  }

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
