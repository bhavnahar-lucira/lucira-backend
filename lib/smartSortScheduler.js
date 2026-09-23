/**
 * Smart Collection Sort Scheduler
 *
 * Scheduled (per-rule, IST) re-sync of collection product orders to Shopify.
 * Each rule picks its own cadence: daily at a time, weekly on a weekday at a
 * time, or manual — no schedule at all, for a collection that should be sorted
 * once and then left alone.
 * Deliberately a COPY of lib/recoScheduler.js's dependency-free pattern
 * (self-rearming setTimeout, window-based due check, Mongo lease) rather than
 * a generalisation of it: the reco scheduler guards a live production
 * feature, and sharing mutable module state between the two for the sake of
 * fewer lines is a worse trade than 150 duplicated, boring ones. Same tick
 * maths, own collections (`smart_sort_rules` / `smart_sort_runs`) and own
 * lease key. Started AFTER fastify.listen, next to startRecoScheduler.
 */

const {
  runSmartRule, runGlobalRule, isGlobalRule, runningSmartRules, syncModeOf, syncWeekdayOf
} = require('./smartCollections');
const { publishDraft, applyRevert } = require('./smartSortVersions');
const { snapshotAllStats } = require('./smartSortStats');

const TICK_MS = 60 * 1000;
// Nightly performance snapshot, late enough that the day's numbers are in.
const STATS_MINUTE = 23 * 60 + 30;
const LEASE_MS = 5 * 60 * 1000;
const RERUN_GUARD_MS = 10 * 60 * 1000;
const STALE_RUNNING_MS = 15 * 60 * 1000;

let timer = null;
let stopped = false;
let lastTickMinute = null;

// India has no DST, so an IST wall-clock time maps to exactly one instant at a
// fixed offset — the scheduled slot below can be built by string, with no
// timezone library and no drift twice a year.
const IST_OFFSET = '+05:30';

const istParts = () => {
  const now = new Date();
  const hhmm = now.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const bits = hhmm.split(':');
  const rawHour = parseInt(bits[0], 10);
  const m = parseInt(bits[1], 10);
  const h = rawHour === 24 ? 0 : rawHour;
  const pad = (n) => String(n).padStart(2, '0');
  // The IST calendar date, and the weekday read off it. Going through the
  // 'YYYY-MM-DD' string and getUTCDay is deliberate: reading getDay() off the
  // raw Date would give the weekday in the SERVER's timezone, which is a
  // different day for several hours either side of IST midnight.
  const date = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  return { hhmm: pad(h) + ':' + pad(m), minute: h * 60 + m, date, weekday };
};

// The instant a rule's IST wall-clock time falls on a given IST date.
const scheduledInstant = (istDate, hhmm) => {
  const t = Date.parse(istDate + 'T' + hhmm + ':00' + IST_OFFSET);
  return Number.isFinite(t) ? new Date(t) : null;
};

const toMinute = (hhmm) => {
  const bits = String(hhmm || '').split(':');
  const h = parseInt(bits[0], 10);
  const m = parseInt(bits[1], 10);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
};

// True when `target` falls in (prev, now] on a 1440-minute circular clock.
const isDue = (target, prev, now) => {
  if (target === null) return false;
  if (prev === null) return target === now;
  if (prev === now) return false;
  return prev < now ? (target > prev && target <= now) : (target > prev || target <= now);
};

/**
 * Is this rule owed a sync on this tick?
 *
 *   manual  - never. The one-time sort: "Sync now" is the only thing that
 *             pushes an order, so the collection stays exactly as it was left.
 *   daily   - its scheduleTime landed in the window since the last tick.
 *   weekly  - the same, but only on syncWeekday (IST).
 *
 * MISSED-RUN CATCH-UP. The window check alone only ever fires on the single
 * tick that straddles the scheduled minute, so a restart across that minute
 * skipped the run entirely — a day for a daily rule, and a whole WEEK for a
 * weekly one, which is what made this worth fixing. So a rule is also due when
 * its slot for TODAY has passed and nothing has run since that slot.
 *
 * The floor is `lastRunAt || createdAt`, and the createdAt half is load-bearing:
 * a rule created at 10:00 with a 02:30 schedule has no lastRunAt, and without
 * that floor the next tick would "catch up" on a slot from before the rule
 * existed — syncing a brand-new rule the moment it is saved, which is exactly
 * what creating a rule is not supposed to do.
 *
 * Catch-up is confined to the current IST day. A weekly rule that misses its
 * whole day waits for next week rather than syncing on the wrong weekday.
 */
function isRuleDue(rule, prev, now, ist) {
  const mode = syncModeOf(rule);
  if (mode === 'manual') return false;

  const target = toMinute(rule.scheduleTime);
  if (target === null) return false;
  if (mode === 'weekly' && syncWeekdayOf(rule) !== ist.weekday) return false;

  if (isDue(target, prev, now)) return true;

  if (now < target) return false;
  const slot = scheduledInstant(ist.date, rule.scheduleTime);
  if (!slot) return false;
  const floor = rule.lastRunAt || rule.createdAt;
  return Boolean(floor) && new Date(floor) < slot;
}

async function acquireLease(db, ruleId) {
  const now = new Date();
  try {
    await db.collection('settings').findOneAndUpdate(
      {
        key: 'smart_sort_scheduler_lease',
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

async function reapStaleRuns(runsCol, ruleKey) {
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS);
  try {
    await runsCol.updateMany(
      { ruleId: ruleKey, status: 'running', startedAt: { $lte: staleCutoff } },
      {
        $set: { status: 'failed', finishedAt: new Date() },
        $push: { errors: 'Sync abandoned (worker restarted or crashed)' }
      }
    );
  } catch (err) {
    console.error('[SmartSortScheduler] Stale run reap failed:', err.message);
  }
}

/**
 * Clear runs left "running" by a worker that died.
 *
 * The per-rule reaper below only fires when that rule next comes due, so a
 * crashed store-wide pass sat in the admin showing RUNNING for fifteen hours
 * after its process was gone (22 Sep 2026). Sweeping once at startup makes the
 * list honest as soon as the backend is back.
 *
 * Keyed on the HEARTBEAT, not startedAt: a healthy global pass legitimately
 * runs for forty minutes and heartbeats every ten collections, so it is never
 * mistaken for dead — which matters because index.js listens with
 * `exclusive: false` and another worker may genuinely be mid-pass right now.
 * Runs with no heartbeat at all (per-collection syncs, which take seconds)
 * fall back to startedAt.
 */
async function reapAbandonedRuns(db) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  try {
    const res = await db.collection('smart_sort_runs').updateMany(
      {
        status: 'running',
        $or: [
          { heartbeatAt: { $lte: cutoff } },
          { heartbeatAt: { $exists: false }, startedAt: { $lte: cutoff } },
          { heartbeatAt: null, startedAt: { $lte: cutoff } }
        ]
      },
      {
        $set: { status: 'failed', finishedAt: new Date() },
        $push: { errors: 'Abandoned — the worker stopped without finishing (cleared at startup)' }
      }
    );
    if (res.modifiedCount) {
      console.log(`[SmartSortScheduler] Cleared ${res.modifiedCount} abandoned run(s) left by a stopped worker`);
    }
  } catch (err) {
    console.error('[SmartSortScheduler] Abandoned-run sweep failed:', err.message);
  }
}

async function tick(fastify) {
  try {
    const db = fastify.mongo.db;
    const runsCol = db.collection('smart_sort_runs');
    const ist = istParts();
    const { hhmm, minute } = ist;
    const prev = lastTickMinute;
    lastTickMinute = minute;

    const cutoff = new Date(Date.now() - RERUN_GUARD_MS);
    const candidates = await db.collection('smart_sort_rules').find({
      enabled: true,
      $or: [{ lastRunAt: null }, { lastRunAt: { $lt: cutoff } }]
    }).toArray();

    const due = candidates.filter((r) => isRuleDue(r, prev, minute, ist));

    for (const rule of due) {
      const ruleKey = String(rule._id);
      if (runningSmartRules.has(ruleKey)) continue;

      await reapStaleRuns(runsCol, ruleKey);

      const activeRun = await runsCol.findOne({
        ruleId: ruleKey,
        status: 'running',
        startedAt: { $gt: new Date(Date.now() - STALE_RUNNING_MS) }
      });
      if (activeRun) {
        console.log(`[SmartSortScheduler] Sync already in progress elsewhere for "${rule.collectionHandle}" — skipping`);
        continue;
      }

      const acquired = await acquireLease(db, ruleKey);
      if (!acquired) {
        console.log(`[SmartSortScheduler] Lease held elsewhere for "${rule.collectionHandle}" — skipping`);
        continue;
      }

      console.log(`[SmartSortScheduler] ${hhmm} IST — syncing "${rule.collectionHandle}" (${syncModeOf(rule)})`);
      // Detached: a long sync must never stall the tick loop. The global rule
      // gets the store-wide pass.
      const runner = isGlobalRule(rule) ? runGlobalRule : runSmartRule;
      runner(fastify, rule, 'schedule').catch((err) => {
        console.error(`[SmartSortScheduler] Scheduled sync failed for "${rule.collectionHandle}":`, err.message);
      });
    }

    // ---- Scheduled draft publishes ("goes live at ...") ----
    const now = new Date();
    const duePublishes = await db.collection('smart_sort_rules')
      .find({ 'draft.goLiveAt': { $lte: now } }).toArray();
    for (const rule of duePublishes) {
      const acquired = await acquireLease(db, String(rule._id) + ':publish');
      if (!acquired) continue; // another worker owns this publish
      console.log(`[SmartSortScheduler] ${hhmm} IST — publishing the scheduled draft for "${rule.collectionHandle}"`);
      publishDraft(fastify, rule, { trigger: 'schedule', sync: true }).catch((err) => {
        console.error(`[SmartSortScheduler] Scheduled publish failed for "${rule.collectionHandle}":`, err.message);
      });
    }

    // ---- Scheduled reverts ("back to the old order after the sale") ----
    const dueReverts = await db.collection('smart_sort_rules')
      .find({ 'scheduledRevert.at': { $lte: now } }).toArray();
    for (const rule of dueReverts) {
      const acquired = await acquireLease(db, String(rule._id) + ':revert');
      if (!acquired) continue;
      console.log(`[SmartSortScheduler] ${hhmm} IST — applying the scheduled revert for "${rule.collectionHandle}"`);
      applyRevert(fastify, rule).catch((err) => {
        console.error(`[SmartSortScheduler] Scheduled revert failed for "${rule.collectionHandle}":`, err.message);
      });
    }

    // ---- Nightly performance snapshot ----
    if (isDue(STATS_MINUTE, prev, minute)) {
      snapshotAllStats(fastify).catch((err) =>
        console.error('[SmartSortScheduler] Nightly stats snapshot failed:', err.message));
    }
  } catch (err) {
    console.error('[SmartSortScheduler] Tick error:', err);
  } finally {
    if (!stopped) {
      timer = setTimeout(() => tick(fastify), TICK_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

// Call AFTER fastify.listen succeeds. The lease index is shared with the reco
// scheduler ({ key, ruleId } partial-unique per key) — but partial indexes
// filter on a FIXED expression, so this scheduler needs its own, keyed to its
// own lease value, or the upsert's insert never trips 11000 and every worker
// "wins" the lease.
async function startSmartSortScheduler(fastify) {
  if (timer) return; // idempotent
  stopped = false;

  try {
    await fastify.mongo.db.collection('settings').createIndex(
      { key: 1, ruleId: 1 },
      {
        unique: true,
        name: 'smart_sort_scheduler_lease_unique',
        partialFilterExpression: { key: 'smart_sort_scheduler_lease' }
      }
    );
  } catch (err) {
    console.error('[SmartSortScheduler] NOT STARTED — the lease index could not be created, so ' +
      'concurrent workers could sync the same collection. Fix the index, then restart:', err.message);
    return;
  }

  await reapAbandonedRuns(fastify.mongo.db);

  timer = setTimeout(() => tick(fastify), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[SmartSortScheduler] Started — checking every 60s for due collection syncs (IST)');
}

function stopSmartSortScheduler() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { startSmartSortScheduler, stopSmartSortScheduler };
