/**
 * Occasion Coupon Scheduler
 *
 * Once a day (IST), opens and closes the birthday/anniversary coupon windows:
 * adds every customer whose date is 7 days out to the Shopify discount's
 * customer selection, and removes everyone whose 14 days are up
 * (lib/occasionCoupons.js does the work).
 *
 * Same dependency-free shape as lib/recoScheduler.js / lib/smartSortScheduler.js
 * — a self-rearming setTimeout started AFTER fastify.listen, with a Mongo lease
 * because index.js listens with exclusive:false and every worker runs this
 * timer. Runs at 03:15 IST, when the Admin API bucket is quiet; the scan is
 * queued in the governor's background lane either way.
 *
 * Also runs shortly after boot if the last run is more than RUN_GAP_MS old, so
 * a deploy at noon doesn't leave today's birthdays waiting until tomorrow.
 */

const { syncOccasionCoupons } = require('./occasionCoupons');

const TICK_MS = 60 * 1000;
const RUN_MINUTE = 3 * 60 + 15; // 03:15 IST
const LEASE_MS = 30 * 60 * 1000;
const RUN_GAP_MS = 12 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;

let timer = null;
let stopped = false;
let lastTickMinute = null;

const istMinute = () => {
  const [h, m] = new Date()
    .toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
    .split(':')
    .map(Number);
  return (h === 24 ? 0 : h) * 60 + m;
};

// True when `target` falls in (prev, now] on a 1440-minute circular clock.
const isDue = (target, prev, now) => {
  if (prev === null) return target === now;
  if (prev === now) return false;
  return prev < now ? target > prev && target <= now : target > prev || target <= now;
};

async function acquireLease(db) {
  const now = new Date();
  try {
    await db.collection('settings').findOneAndUpdate(
      {
        key: 'occasion_coupon_lease',
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $lte: now } }],
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

async function run(fastify, reason) {
  const db = fastify.mongo.db;
  if (!(await acquireLease(db))) {
    console.log('[OccasionCoupons] Lease held by another worker — skipping');
    return;
  }

  console.log(`[OccasionCoupons] Running (${reason})`);
  try {
    const result = await syncOccasionCoupons(db);
    await db
      .collection('settings')
      .updateOne({ key: 'occasion_coupon_lease' }, { $set: { lastRunAt: new Date() } });
    if (result.rules) {
      console.log(`[OccasionCoupons] Done — ${result.rules} rule(s), +${result.added} / -${result.removed} customers`);
    }
  } catch (err) {
    console.error('[OccasionCoupons] Run failed:', err.message);
  }
}

async function tick(fastify) {
  try {
    const now = istMinute();
    const prev = lastTickMinute;
    lastTickMinute = now;
    if (isDue(RUN_MINUTE, prev, now)) await run(fastify, 'daily 03:15 IST');
  } catch (err) {
    console.error('[OccasionCoupons] Tick error:', err);
  } finally {
    if (!stopped) {
      timer = setTimeout(() => tick(fastify), TICK_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

// Call AFTER fastify.listen succeeds. Its own partial-unique lease index:
// a partial index filters on a FIXED expression, so sharing the other
// schedulers' index would mean this upsert never trips 11000 and every worker
// "wins" the lease.
async function startOccasionCouponScheduler(fastify) {
  if (timer) return; // idempotent
  stopped = false;

  try {
    await fastify.mongo.db.collection('settings').createIndex(
      { key: 1 },
      {
        unique: true,
        name: 'occasion_coupon_lease_unique',
        partialFilterExpression: { key: 'occasion_coupon_lease' },
      }
    );
  } catch (err) {
    console.error(
      '[OccasionCoupons] NOT STARTED — the lease index could not be created, so concurrent ' +
        'workers could sync the same discount. Fix the index, then restart:',
      err.message
    );
    return;
  }

  timer = setTimeout(() => tick(fastify), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();

  // Catch-up pass for a deploy that landed after today's slot.
  const boot = setTimeout(async () => {
    try {
      const lease = await fastify.mongo.db.collection('settings').findOne({ key: 'occasion_coupon_lease' });
      const last = lease?.lastRunAt ? new Date(lease.lastRunAt).getTime() : 0;
      if (Date.now() - last > RUN_GAP_MS) await run(fastify, 'catch-up after start');
    } catch (err) {
      console.error('[OccasionCoupons] Catch-up run failed:', err.message);
    }
  }, BOOT_DELAY_MS);
  if (typeof boot.unref === 'function') boot.unref();

  console.log('[OccasionCoupons] Started — birthday/anniversary windows sync daily at 03:15 IST');
}

function stopOccasionCouponScheduler() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { startOccasionCouponScheduler, stopOccasionCouponScheduler };
