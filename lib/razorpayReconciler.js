/**
 * Razorpay Reconciliation Sweep
 *
 * Backstop for when the Razorpay webhook (routes/webhooks.js POST /api/webhooks/
 * razorpay) never arrives — misconfigured URL, downtime during a deploy, a
 * Razorpay incident. Without this, a webhook outage is once again a silent lost
 * order: money captured, draft order never completed.
 *
 * Every 5 minutes it looks at `razorpay_checkouts` rows that are still PENDING or
 * FAILED and older than 10 minutes, asks Razorpay whether that order has a
 * captured payment, and if so runs the same `finalizeRazorpayCheckout` the
 * webhook and the browser use. That finalizer is idempotent (atomic
 * PENDING/FAILED -> PROCESSING claim), so it is safe for several workers to run
 * this sweep at once — the Mongo lease below just trims redundant Razorpay reads.
 *
 * Mirrors lib/recoScheduler.js: dependency-free self-rearming setTimeout, started
 * after fastify.listen, unref'd so it never holds the process open.
 */

const TICK_MS = 5 * 60 * 1000;
const LEASE_MS = 4 * 60 * 1000;
const MIN_AGE_MS = 10 * 60 * 1000;          // leave very fresh checkouts to the webhook / browser
const STALE_PROCESSING_MS = 15 * 60 * 1000; // a PROCESSING row this old = the worker died mid-finalize
const EXPIRE_MS = 24 * 60 * 60 * 1000;      // unpaid this long -> the customer never paid
const BATCH = 50;

let timer = null;
let stopped = false;

// Best-effort single-worker guard. index.js listens with exclusive:false so every
// worker runs this timer; the partial unique index on `settings` makes the upsert
// insert trip 11000 for all but one. If the index is missing the guard degrades
// to nothing and the finalizer's atomic claim still keeps the work correct.
async function acquireLease(db) {
  const now = new Date();
  try {
    await db.collection('settings').findOneAndUpdate(
      {
        key: 'razorpay_reconciler_lease',
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $lte: now } },
        ],
      },
      { $set: { expiresAt: new Date(now.getTime() + LEASE_MS), pid: process.pid, updatedAt: now } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false;
    console.error('[razorpay-reconcile] lease error:', err.message);
    return true; // degrade to "run anyway" — finalizer is idempotent
  }
}

async function razorpayGet(pathname) {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!keyId || !keySecret) return null;
  const res = await fetch(`https://api.razorpay.com/v1${pathname}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
  });
  if (!res.ok) {
    console.error(`[razorpay-reconcile] GET ${pathname} -> ${res.status}`);
    return null;
  }
  return res.json();
}

async function tick(fastify) {
  try {
    const db = fastify.mongo.db;
    if (!(await acquireLease(db))) return;

    // Required lazily: routes/checkout.js is a Fastify plugin loaded by index.js
    // during registration; by the time this timer first fires it is cached.
    const { finalizeRazorpayCheckout, RAZORPAY_CHECKOUTS_COLLECTION, FINALIZE_MAX_ATTEMPTS } =
      require('../routes/checkout');

    const coll = db.collection(RAZORPAY_CHECKOUTS_COLLECTION);

    // A worker that died between Shopify draftOrderComplete and marking the row
    // COMPLETED leaves it stuck in PROCESSING — which nothing else retries. Flip
    // stale ones back to FAILED so the sweep below re-runs the finalizer (which
    // hits Shopify's "already completed" path, recovers the order, clears cart).
    const reaped = await coll.updateMany(
      { status: 'PROCESSING', updatedAt: { $lte: new Date(Date.now() - STALE_PROCESSING_MS) } },
      {
        $set: { status: 'FAILED', lastError: 'stale PROCESSING reaped by reconciler', updatedAt: new Date() },
        $inc: { attempts: -1 }, // the interrupted attempt is of unknown outcome; don't count it
      }
    );
    if (reaped.modifiedCount) console.warn(`[razorpay-reconcile] reaped ${reaped.modifiedCount} stale PROCESSING row(s)`);

    const rows = await coll
      .find({
        status: { $in: ['PENDING', 'FAILED'] },
        attempts: { $lt: FINALIZE_MAX_ATTEMPTS },
        createdAt: { $lte: new Date(Date.now() - MIN_AGE_MS) },
      })
      .sort({ createdAt: 1 })
      .limit(BATCH)
      .toArray();

    if (!rows.length) return;
    console.log(`[razorpay-reconcile] checking ${rows.length} unfinalized checkout(s)`);

    for (const row of rows) {
      try {
        const data = await razorpayGet(`/orders/${row._id}/payments`);
        const captured = (data?.items || []).find((p) => p.status === 'captured');

        if (captured) {
          console.log(`[razorpay-reconcile] ${row._id} has captured payment ${captured.id} — finalizing`);
          await finalizeRazorpayCheckout(db, {
            razorpayOrderId: row._id,
            razorpayPaymentId: captured.id,
            source: 'reconcile',
            capturedAmount: captured.amount,
          }).catch((e) => console.error(`[razorpay-reconcile] finalize ${row._id}:`, e.message));
        } else if (Date.now() - new Date(row.createdAt).getTime() > EXPIRE_MS) {
          await coll.updateOne(
            { _id: row._id },
            { $set: { status: 'EXPIRED', updatedAt: new Date(), ttlAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } }
          );
          console.log(`[razorpay-reconcile] ${row._id} unpaid after 24h -> EXPIRED`);
        }
      } catch (err) {
        console.error(`[razorpay-reconcile] ${row._id} error:`, err.message);
      }
    }
  } catch (err) {
    console.error('[razorpay-reconcile] tick error:', err);
  } finally {
    if (!stopped) {
      timer = setTimeout(() => tick(fastify), TICK_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

async function ensureIndexes(db) {
  try {
    await db.collection('settings').createIndex(
      { key: 1 },
      { unique: true, partialFilterExpression: { key: 'razorpay_reconciler_lease' }, name: 'razorpay_reconciler_lease_uq' }
    );
  } catch (err) {
    console.warn('[razorpay-reconcile] lease index note:', err.message);
  }

  try {
    await db.collection('razorpay_checkouts').createIndex({ status: 1, createdAt: 1 });
    // TTL: rows carry `ttlAt` only once terminal (COMPLETED / EXPIRED / DEAD), so
    // in-flight checkouts are never expired out from under a retry.
    await db.collection('razorpay_checkouts').createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
  } catch (err) {
    console.warn('[razorpay-reconcile] checkout index note:', err.message);
  }
}

async function startRazorpayReconciler(fastify) {
  if (timer) return; // idempotent
  stopped = false;

  await ensureIndexes(fastify.mongo.db);

  timer = setTimeout(() => tick(fastify), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[razorpay-reconcile] Started — sweeping every 5m for captured-but-unfinalized checkouts');
}

function stopRazorpayReconciler() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { startRazorpayReconciler, stopRazorpayReconciler };
