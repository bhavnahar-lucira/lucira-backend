/**
 * Sync cadence — the vocabulary and the "is this rule due?" maths, shared by
 * both schedulers.
 *
 * lib/smartSortScheduler.js and lib/recoScheduler.js remain separate on
 * purpose: each owns its own `lastTickMinute` and its own Mongo lease, and
 * sharing MUTABLE state between two independently-scheduled features would be
 * a bad trade. What is shared here is pure and stateless — clock maths and a
 * predicate — so there is nothing for one scheduler to corrupt for the other,
 * and only one place to get the IST edge cases right.
 *
 * A rule's cadence:
 *   daily   - every day at scheduleTime (IST)
 *   weekly  - once a week, on syncWeekday at scheduleTime (IST)
 *   manual  - never on a schedule; only an explicit run does anything
 *
 * Both fields are optional. Rules written before this existed carry neither,
 * and a missing syncMode reads as 'daily' — exactly what they already did, so
 * no migration anywhere.
 */

const SYNC_MODES = ['daily', 'weekly', 'manual'];
const DEFAULT_SYNC_WEEKDAY = 1; // Monday. 0 = Sunday, matching Date#getDay.

const syncModeOf = (rule) => (SYNC_MODES.includes(rule && rule.syncMode) ? rule.syncMode : 'daily');

const syncWeekdayOf = (rule) => {
  const d = rule && rule.syncWeekday;
  return Number.isInteger(d) && d >= 0 && d <= 6 ? d : DEFAULT_SYNC_WEEKDAY;
};

// India has no DST, so an IST wall-clock time maps to exactly one instant at a
// fixed offset — a scheduled slot can be built by string, with no timezone
// library and no drift twice a year.
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
 * Is this rule owed a run on this tick?
 *
 * MISSED-RUN CATCH-UP. The window check alone only ever fires on the single
 * tick that straddles the scheduled minute, so a restart across that minute
 * skipped the run entirely — a day for a daily rule, and a whole WEEK for a
 * weekly one, which is what made this worth having. So a rule is also due when
 * its slot for TODAY has passed and nothing has run since that slot.
 *
 * The floor is `lastRunAt || createdAt`, and the createdAt half is load-bearing:
 * a rule created at 10:00 with a 02:30 schedule has no lastRunAt, and without
 * that floor the next tick would "catch up" on a slot from before the rule
 * existed — running a brand-new rule the moment it is saved, which is exactly
 * what creating a rule is not supposed to do.
 *
 * Catch-up is confined to the current IST day. A weekly rule that misses its
 * whole day waits for next week rather than running on the wrong weekday.
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

/**
 * Clear runs left "running" by a worker that died.
 *
 * A per-rule reaper only fires when that rule next comes due, so a crashed run
 * can sit in the admin showing RUNNING for hours after its process is gone
 * (observed 22 Sep 2026: fifteen hours). Sweeping once at startup makes the
 * list honest as soon as the backend is back.
 *
 * Keyed on the HEARTBEAT where one exists: a long pass that heartbeats is
 * never mistaken for dead, which matters because index.js listens with
 * `exclusive: false` and another worker may genuinely be mid-run. Runs with no
 * heartbeat fall back to startedAt.
 */
async function reapAbandonedRuns(db, collectionName, staleMs, label) {
  const cutoff = new Date(Date.now() - staleMs);
  try {
    const res = await db.collection(collectionName).updateMany(
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
      console.log(`[${label}] Cleared ${res.modifiedCount} abandoned run(s) left by a stopped worker`);
    }
  } catch (err) {
    console.error(`[${label}] Abandoned-run sweep failed:`, err.message);
  }
}

module.exports = {
  SYNC_MODES,
  DEFAULT_SYNC_WEEKDAY,
  syncModeOf,
  syncWeekdayOf,
  istParts,
  scheduledInstant,
  toMinute,
  isDue,
  isRuleDue,
  reapAbandonedRuns
};
