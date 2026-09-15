/**
 * Shopify Admin API cost governor.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shopify's Admin GraphQL API is not rate limited by request count — it is a
 * leaky bucket of calculated *cost points*. This shop (Advanced plan) has a
 * 4,000-point bucket that refills at 200 points/sec. Every response reports the
 * shop-wide truth in `extensions.cost.throttleStatus`.
 *
 * When the bucket empties, Shopify answers with HTTP **200** and a `Throttled`
 * entry in the GraphQL `errors` array — NOT a 429. Transport-level retry
 * helpers never see it, which is how a background SKU-index build used to take
 * the whole server down (see the unhandledRejection guard in index.js).
 *
 * WHAT IT DOES
 * ------------
 *   1. Mirrors the bucket locally and re-syncs from `throttleStatus` on every
 *      response, so the estimate is never more than one request stale. This
 *      also makes it correct across workers: index.js listens with
 *      `exclusive:false`, so several processes share one shop bucket, and the
 *      server's number already accounts for all of them (and for the other
 *      apps installed on the store, one of which runs its own bulk jobs).
 *   2. Reserves a query's estimated cost BEFORE dispatch and, when the bucket
 *      is short, sleeps exactly `(need - available) / restoreRate` seconds
 *      instead of firing a request that is certain to be throttled.
 *   3. Learns each operation's real cost from `requestedQueryCost` — the number
 *      Shopify admits on — so estimates are exact after its first call.
 *   4. Splits traffic into two lanes. `interactive` (the default — cart,
 *      checkout, auth, product pages) may spend the bucket down to zero and is
 *      always dispatched first. `background` (catalogue scans, SKU index,
 *      schedulers) is only dispatched while the bucket sits above a reserve
 *      floor, and runs at low concurrency. A shopper therefore never queues
 *      behind a 400-page scan: the scan is what yields, not the checkout.
 *
 * Dependency-free on purpose, matching lib/recoScheduler.js — this repo has no
 * scheduler/queue library and adding one needs a Hostinger deploy step.
 */

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Advanced plan defaults. Both are overwritten by the first live
// `throttleStatus` we see, so a plan change needs no code change.
const DEFAULT_MAX = num(process.env.SHOPIFY_BUCKET_MAX, 4000);
const DEFAULT_RESTORE = num(process.env.SHOPIFY_RESTORE_RATE, 200);

// Background work is held back unless the bucket is at least this full, so
// interactive traffic always finds headroom. 0.4 => background pauses below
// 1,600 of 4,000 points and lets it refill.
const BG_FLOOR_RATIO = Math.min(0.9, Math.max(0, Number(process.env.SHOPIFY_BG_FLOOR_RATIO) || 0.4));

const MAX_CONCURRENT = num(process.env.SHOPIFY_MAX_CONCURRENT, 4);
const BG_MAX_CONCURRENT = num(process.env.SHOPIFY_BG_MAX_CONCURRENT, 2);

// Used until an operation's real cost is observed. Deliberately pessimistic:
// over-reserving briefly delays a request, under-reserving earns a throttle.
const DEFAULT_QUERY_COST = num(process.env.SHOPIFY_DEFAULT_COST, 160);
const DEFAULT_MUTATION_COST = num(process.env.SHOPIFY_DEFAULT_MUTATION_COST, 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const state = {
  max: DEFAULT_MAX,
  restoreRate: DEFAULT_RESTORE,
  available: DEFAULT_MAX,
  syncedAt: Date.now(),
  inFlight: 0,
  bgInFlight: 0,
  queues: { interactive: [], background: [] },
  costs: new Map(),      // operation name -> last observed actualQueryCost
  pumpTimer: null,
  stats: { dispatched: 0, throttled: 0, peakQueue: 0 },
};

/** Operation name from a GraphQL document, or null when it is anonymous. */
function operationName(query) {
  const m = /(?:^|\s)(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(String(query || ''));
  return m ? m[1] : null;
}

/**
 * Cache key for an operation's learned cost.
 *
 * Most of the hot interactive path (cart, checkout, auth, collection routes)
 * sends ANONYMOUS inline queries — `shopifyAdminFetch(\`query { ... }\`)` — so
 * keying on the operation name alone would leave 16 of the busiest queries
 * permanently on the pessimistic default, over-reserving the bucket for
 * exactly the traffic that must not wait. Anonymous documents are therefore
 * fingerprinted by their whitespace-normalised text instead. Variables are not
 * part of the document, so one fingerprint == one cost profile.
 */
function costKey(query) {
  const named = operationName(query);
  if (named) return named;

  const text = String(query || '').replace(/\s+/g, ' ').trim();
  // djb2 — cheap, no dependency, and collisions only cost a wrong estimate
  // that the next response immediately corrects.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return 'anon:' + (h >>> 0).toString(36);
}

function isMutation(query) {
  return /(?:^|\s)mutation\s/.test(String(query || ''));
}

/** Bucket level right now, extrapolating restore since the last server sync. */
function available() {
  const elapsedSec = (Date.now() - state.syncedAt) / 1000;
  return Math.min(state.max, state.available + elapsedSec * state.restoreRate);
}

/** Adopt the shop-wide truth from a response's extensions.cost. */
function sync(cost) {
  const t = cost && cost.throttleStatus;
  if (!t) return;
  if (Number.isFinite(t.maximumAvailable) && t.maximumAvailable > 0) state.max = t.maximumAvailable;
  if (Number.isFinite(t.restoreRate) && t.restoreRate > 0) state.restoreRate = t.restoreRate;
  if (Number.isFinite(t.currentlyAvailable)) {
    state.available = Math.max(0, t.currentlyAvailable);
    state.syncedAt = Date.now();
  }
}

/**
 * Record what an operation costs, so the next reservation is exact.
 *
 * Deliberately `requestedQueryCost`, NOT `actualQueryCost`. Shopify decides
 * whether to admit a request by comparing `requestedQueryCost` against the
 * bucket, then debits the (often much lower) `actualQueryCost` and refunds the
 * difference. Reserving the actual cost therefore under-reserves and earns
 * avoidable throttles — the 30-day orders scan requests 155 points but is only
 * charged 38, a 4x gap. The bucket LEVEL still comes from throttleStatus in
 * sync(), so nothing is double-counted; only the admission estimate uses this.
 */
function learn(query, cost) {
  if (!cost) return;
  const requested = Number.isFinite(cost.requestedQueryCost) ? cost.requestedQueryCost : cost.actualQueryCost;
  if (!Number.isFinite(requested) || requested <= 0) return;

  const key = costKey(query);
  state.costs.set(key, requested);
  // Unbounded growth is the only risk with fingerprint keys; the catalogue of
  // distinct queries is small, so a generous cap is plenty.
  if (state.costs.size > 500) state.costs.delete(state.costs.keys().next().value);
}

function estimateCost(query) {
  const key = costKey(query);
  const known = state.costs.has(key)
    ? state.costs.get(key)
    : (isMutation(query) ? DEFAULT_MUTATION_COST : DEFAULT_QUERY_COST);
  // A reservation larger than the bucket could never be satisfied and would
  // park the lane forever. Shopify rejects such a query outright anyway, so
  // clamp and let the request go out and fail fast with a real error.
  return Math.min(known, state.max);
}

/** Points a lane must leave untouched. Interactive may drain the bucket. */
const floorFor = (priority) => (priority === 'background' ? state.max * BG_FLOOR_RATIO : 0);

/** ms until `need` points are spendable in this lane, 0 when they already are. */
function waitFor(need, priority) {
  const deficit = need + floorFor(priority) - available();
  if (deficit <= 0) return 0;
  return Math.ceil((deficit / state.restoreRate) * 1000);
}

function concurrencyOk(priority) {
  if (state.inFlight >= MAX_CONCURRENT) return false;
  if (priority === 'background' && state.bgInFlight >= BG_MAX_CONCURRENT) return false;
  return true;
}

/**
 * Dispatch loop. Interactive is drained first and completely; background only
 * gets a slot once no interactive work is waiting, so a burst of shopper
 * traffic instantly pauses every scan without cancelling it.
 */
function pump() {
  if (state.pumpTimer) {
    clearTimeout(state.pumpTimer);
    state.pumpTimer = null;
  }

  let nextWakeMs = Infinity;

  for (const priority of ['interactive', 'background']) {
    const queue = state.queues[priority];
    while (queue.length) {
      if (!concurrencyOk(priority)) break;

      const task = queue[0];
      const wait = waitFor(task.estimate, priority);
      if (wait > 0) {
        // Head-of-line blocks its own lane only; the other lane keeps moving.
        nextWakeMs = Math.min(nextWakeMs, wait);
        break;
      }

      queue.shift();
      run(task);
    }
  }

  if (nextWakeMs !== Infinity) {
    state.pumpTimer = setTimeout(pump, Math.min(nextWakeMs + 25, 15000));
    if (typeof state.pumpTimer.unref === 'function') state.pumpTimer.unref();
  }
}

function run(task) {
  state.inFlight += 1;
  if (task.priority === 'background') state.bgInFlight += 1;
  state.stats.dispatched += 1;

  // Debit optimistically so parallel dispatches in this tick can't both spend
  // the same points; the response's throttleStatus corrects it a moment later.
  state.available = Math.max(0, available() - task.estimate);
  state.syncedAt = Date.now();

  Promise.resolve()
    .then(task.fn)
    .then(task.resolve, task.reject)
    .finally(() => {
      state.inFlight -= 1;
      if (task.priority === 'background') state.bgInFlight -= 1;
      pump();
    });
}

/**
 * Queue one Admin API call.
 *
 * @param {string}   query  GraphQL document (used to name and cost the op)
 * @param {Function} fn     performs the request, resolves with its result
 * @param {object}   [opts]
 * @param {'interactive'|'background'} [opts.priority='interactive']
 */
function schedule(query, fn, options) {
  const priority = (options && options.priority) === 'background' ? 'background' : 'interactive';
  return new Promise((resolve, reject) => {
    state.queues[priority].push({
      fn, resolve, reject, priority,
      estimate: estimateCost(query),
      queuedAt: Date.now(),
    });
    const depth = state.queues.interactive.length + state.queues.background.length;
    if (depth > state.stats.peakQueue) state.stats.peakQueue = depth;
    pump();
  });
}

/**
 * Called when Shopify says THROTTLED anyway (another app drained the bucket
 * between our estimate and the request landing). Returns how long to wait
 * before the retry — from the server's own numbers when it sent them.
 */
function throttleBackoffMs(cost, attempt) {
  state.stats.throttled += 1;
  const t = cost && cost.throttleStatus;
  const requested = cost && cost.requestedQueryCost;

  if (t && Number.isFinite(t.currentlyAvailable) && Number.isFinite(t.restoreRate) && t.restoreRate > 0) {
    sync(cost);
    const need = Number.isFinite(requested) ? requested : DEFAULT_QUERY_COST;
    const deficit = need - t.currentlyAvailable;
    if (deficit > 0) {
      // +15% headroom so a co-tenant app spending in the same window doesn't
      // put us straight back into a throttle.
      const ms = Math.ceil((deficit / t.restoreRate) * 1000 * 1.15);
      return Math.min(Math.max(ms, 250), 30000);
    }
  }
  // No usable throttleStatus: exponential backoff, 1s -> 2s -> 4s -> 8s (30s cap).
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

function stats() {
  return {
    bucket: {
      available: Math.round(available()),
      max: state.max,
      restoreRate: state.restoreRate,
      backgroundFloor: Math.round(state.max * BG_FLOOR_RATIO),
    },
    inFlight: state.inFlight,
    backgroundInFlight: state.bgInFlight,
    queued: {
      interactive: state.queues.interactive.length,
      background: state.queues.background.length,
    },
    dispatched: state.stats.dispatched,
    throttled: state.stats.throttled,
    peakQueue: state.stats.peakQueue,
    learnedCosts: Object.fromEntries(state.costs),
  };
}

module.exports = { schedule, sync, learn, throttleBackoffMs, stats, sleep, operationName };
