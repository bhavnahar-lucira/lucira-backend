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

const { runSmartRule, runGlobalRule, isGlobalRule, runningSmartRules } = require('./smartCollections');
const { syncModeOf } = require('./syncCadence');
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

// The clock maths, the cadence vocabulary and the due-check live in
// lib/syncCadence.js, shared with lib/recoScheduler.js. Only the mutable tick
// state below stays local to this scheduler.
const {
  istParts, isRuleDue, isDue, reapAbandonedRuns
} = require('./syncCadence');

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

  await reapAbandonedRuns(fastify.mongo.db, 'smart_sort_runs', STALE_RUNNING_MS, 'SmartSortScheduler');

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
