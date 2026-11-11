/**
 * Birthday / Anniversary WebEngage Milestone Events
 *
 * Emits WebEngage events at T-21, T-14, T-7, T-3, and T-day for every Shopify
 * customer with a saved Birthday or Anniversary date, forwarding batched
 * payloads to a GCP Cloud Function webhook (GCP_OCCASION_WEBENGAGE_WEBHOOK_URL).
 *
 * Deduplicated in MongoDB (`occasion_webengage_events`) by
 * `${customerId}:${occasion}:${occurrenceYear}:${milestone}` so catch-up runs
 * or manual triggers never double-send the same milestone in the same year,
 * while transient GCP failures remain eligible for retry.
 */

const { fetchWithRetry } = require('./helpers');
const {
  OCCASIONS,
  LEAD_DAYS,
  VALID_DAYS,
  DAY_MS,
  istTodayUtc,
  describeRule,
  scanOccasionCustomers,
} = require('./occasionCoupons');

const MILESTONES = [
  { daysBefore: 21, milestone: 'T-21' },
  { daysBefore: 14, milestone: 'T-14' },
  { daysBefore: 7, milestone: 'T-7' },
  { daysBefore: 3, milestone: 'T-3' },
  { daysBefore: 0, milestone: 'T-day' },
];

const EVENT_NAMES = {
  birthday: 'birthday_reminder',
  anniversary: 'anniversary_reminder',
};

const COLLECTION = 'occasion_webengage_events';
const BATCH_SIZE = 25;
const DEFAULT_GCP_WEBHOOK_URL = 'https://birthday-anniversary-events-385594025448.asia-south1.run.app';

/**
 * Normalize raw phone numbers to canonical E.164 (+91XXXXXXXXXX for India),
 * matching the WebEngage `cuid` standard in lucira-frontend/src/lib/phone.js.
 */
function toE164(phone) {
  if (!phone) return '';
  const str = String(phone).trim();
  if (!str) return '';

  if (str.startsWith('+') && !str.startsWith('+91') && !str.startsWith('+0')) {
    const clean = str.replace(/[^\d]/g, '');
    if (clean.length >= 8 && clean.length <= 15) return `+${clean}`;
  }

  let digits = str.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  while (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.slice(2);
    while (digits.startsWith('0')) digits = digits.slice(1);
  }

  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  return '';
}

/** Format a Date in WebEngage REST API v1 format: yyyy-MM-ddTHH:mm:ss+0530 (IST). */
function formatWebEngageTime(date = new Date()) {
  const istMs = date.getTime() + 330 * 60 * 1000;
  const ist = new Date(istMs);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}` +
    `T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+0530`
  );
}

/**
 * Return milestone details if `dateStr` (YYYY-MM-DD) hits T-21, T-14, T-7, T-3,
 * or T-day relative to `todayUtc`, else null. Years either side are checked so
 * early-January dates match their December T-21/T-14/T-7 milestones.
 */
function matchOccasionMilestone(dateStr, todayUtc = istTodayUtc()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  const thisYear = new Date(todayUtc).getUTCFullYear();
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const occurrence = Date.UTC(year, month, day);
    const diffDays = Math.round((occurrence - todayUtc) / DAY_MS);
    const hit = MILESTONES.find((item) => item.daysBefore === diffDays);
    if (hit) {
      return {
        milestone: hit.milestone,
        daysBefore: hit.daysBefore,
        occurrenceYear: year,
        occurrenceDate: new Date(occurrence).toISOString().slice(0, 10),
        windowOpensAt: new Date(occurrence - LEAD_DAYS * DAY_MS).toISOString().slice(0, 10),
        windowValidTill: new Date(occurrence + (VALID_DAYS - LEAD_DAYS - 1) * DAY_MS).toISOString().slice(0, 10),
      };
    }
  }
  return null;
}

const extractNumericCustomerId = (id) => {
  const raw = String(id || '').trim();
  return raw.includes('/') ? raw.split('/').pop() : raw;
};

async function ensureOccasionEventIndexes(db) {
  await db.collection(COLLECTION).createIndex({ dedupKey: 1 }, { unique: true, name: 'dedupKey_unique' });
  await db.collection(COLLECTION).createIndex({ status: 1, updatedAt: -1 }, { name: 'status_updatedAt' });
}

async function loadOccasionRuleInfo(db) {
  const doc = await db.collection('settings').findOne({ key: 'product_discounts_rules' });
  const rules = doc?.discounts || [];
  const infoByKind = {};

  for (const kind of Object.keys(OCCASIONS)) {
    const rule = rules.find(
      (r) =>
        r.occasion === kind &&
        r.method === 'code' &&
        (r.active !== false || r.occasionAutoPaused === true)
    );
    if (rule) {
      const { title, condition } = describeRule(rule);
      infoByKind[kind] = {
        coupon_code: rule.title || '',
        coupon_active: true,
        discount_title: title,
        discount_condition: condition,
      };
    } else {
      infoByKind[kind] = {
        coupon_code: '',
        coupon_active: false,
        discount_title: '',
        discount_condition: '',
      };
    }
  }
  return infoByKind;
}

function buildEventPayload({ node, kind, date, match, ruleInfo, eventTime }) {
  const eventName = EVENT_NAMES[kind];
  if (!eventName) return null;

  const userId = toE164(node.phone) || toE164(node.defaultAddress?.phone);
  if (!userId) return null;

  const customerId = extractNumericCustomerId(node.id);
  const dedupKey = `${customerId}:${kind}:${match.occurrenceYear}:${match.milestone}`;

  return {
    dedupKey,
    userId,
    eventName,
    eventTime,
    eventData: {
      occasion: kind,
      occasion_label: OCCASIONS[kind]?.label || kind,
      milestone: match.milestone,
      days_before: match.daysBefore,
      occurrence_date: match.occurrenceDate,
      occurrence_year: match.occurrenceYear,
      occasion_date: date,
      window_opens_at: match.windowOpensAt,
      window_valid_till: match.windowValidTill,
      in_coupon_window: match.daysBefore <= LEAD_DAYS,
      coupon_code: ruleInfo?.coupon_code || '',
      coupon_active: Boolean(ruleInfo?.coupon_active),
      discount_title: ruleInfo?.discount_title || '',
      discount_condition: ruleInfo?.discount_condition || '',
      customer_id: customerId,
      first_name: node.firstName || '',
      last_name: node.lastName || '',
      customer_name: node.displayName || `${node.firstName || ''} ${node.lastName || ''}`.trim(),
      email: node.email || '',
      phone: userId,
      source: 'lucira-backend-occasion-scheduler',
    },
    meta: {
      customerId,
      occasion: kind,
      milestone: match.milestone,
      daysBefore: match.daysBefore,
      occurrenceYear: match.occurrenceYear,
      occurrenceDate: match.occurrenceDate,
    },
  };
}

/**
 * Collector passed to `scanOccasionCustomers` so the nightly scan gathers
 * T-21/14/7/3/0 candidates in the same single Shopify traversal.
 */
function createMilestoneCollector(todayUtc = istTodayUtc()) {
  const candidates = [];
  const onDateMatch = ({ node, kind, date }) => {
    const match = matchOccasionMilestone(date, todayUtc);
    if (match) candidates.push({ node, kind, date, match });
  };
  return { onDateMatch, candidates };
}

async function persistDispatchResults(db, entries) {
  if (!entries.length) return;
  const now = new Date();
  const ops = entries.map(({ payload, ok, error }) => ({
    updateOne: {
      filter: { dedupKey: payload.dedupKey },
      update: {
        $set: {
          dedupKey: payload.dedupKey,
          userId: payload.userId,
          eventName: payload.eventName,
          ...payload.meta,
          status: ok ? 'sent' : 'failed',
          ...(ok ? { sentAt: now, lastError: null } : { lastError: String(error || 'Unknown error').slice(0, 500) }),
          updatedAt: now,
        },
        $inc: { attempts: 1 },
        $setOnInsert: { createdAt: now },
      },
      upsert: true,
    },
  }));
  await db.collection(COLLECTION).bulkWrite(ops, { ordered: false });
}

async function dispatchOccasionEvents(db, candidates, { dryRun = false } = {}) {
  const ruleInfoByKind = await loadOccasionRuleInfo(db);
  const eventTime = formatWebEngageTime();

  let skippedNoPhone = 0;
  const deduped = new Map();
  for (const item of candidates) {
    const payload = buildEventPayload({
      ...item,
      ruleInfo: ruleInfoByKind[item.kind],
      eventTime,
    });
    if (!payload) {
      skippedNoPhone++;
      continue;
    }
    if (!deduped.has(payload.dedupKey)) deduped.set(payload.dedupKey, payload);
  }

  const allPayloads = Array.from(deduped.values());
  const webhookUrl = String(
    process.env.GCP_OCCASION_WEBENGAGE_WEBHOOK_URL || DEFAULT_GCP_WEBHOOK_URL
  ).trim();
  if (!allPayloads.length) {
    return {
      configured: Boolean(webhookUrl),
      dryRun,
      matched: 0,
      alreadySent: 0,
      sent: 0,
      failed: 0,
      skippedNoPhone,
    };
  }

  const keys = allPayloads.map((p) => p.dedupKey);
  const alreadySentDocs = await db
    .collection(COLLECTION)
    .find({ dedupKey: { $in: keys }, status: 'sent' }, { projection: { dedupKey: 1 } })
    .toArray();
  const sentSet = new Set(alreadySentDocs.map((d) => d.dedupKey));
  const pending = allPayloads.filter((p) => !sentSet.has(p.dedupKey));

  if (dryRun) {
    return {
      configured: Boolean(webhookUrl),
      dryRun: true,
      matched: allPayloads.length,
      alreadySent: sentSet.size,
      pending: pending.length,
      skippedNoPhone,
      events: pending.map(({ dedupKey, userId, eventName, eventTime: et, eventData }) => ({
        dedupKey,
        userId,
        eventName,
        eventTime: et,
        eventData,
      })),
    };
  }

  if (!webhookUrl) {
    if (pending.length) {
      console.warn(
        `[OccasionEvents] GCP_OCCASION_WEBENGAGE_WEBHOOK_URL is not set — ${pending.length} WebEngage event(s) not dispatched`
      );
    }
    return {
      configured: false,
      dryRun: false,
      matched: allPayloads.length,
      alreadySent: sentSet.size,
      sent: 0,
      failed: 0,
      skippedUnconfigured: pending.length,
      skippedNoPhone,
    };
  }

  await ensureOccasionEventIndexes(db);

  const headers = { 'Content-Type': 'application/json' };
  const secret = String(process.env.GCP_OCCASION_WEBHOOK_SECRET || '').trim();
  if (secret) headers['x-webhook-secret'] = secret;

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({
      events: batch.map(({ dedupKey, userId, eventName, eventTime: et, eventData }) => ({
        dedupKey,
        userId,
        eventName,
        eventTime: et,
        eventData,
      })),
    });

    try {
      const res = await fetchWithRetry(webhookUrl, { method: 'POST', headers, body }, 2, 1000);
      const rawText = await res.text().catch(() => '');
      let parsed = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch (_) {}

      if (!res.ok) {
        const errMsg = `GCP HTTP ${res.status}: ${rawText.slice(0, 200)}`;
        await persistDispatchResults(
          db,
          batch.map((payload) => ({ payload, ok: false, error: errMsg }))
        );
        failed += batch.length;
        continue;
      }

      if (parsed && (Array.isArray(parsed.sent) || Array.isArray(parsed.failed))) {
        const sentKeys = new Set(parsed.sent || []);
        const failedMap = new Map((parsed.failed || []).map((f) => [f.dedupKey, f.error || 'WebEngage error']));
        const entries = batch.map((payload) => {
          if (failedMap.has(payload.dedupKey)) {
            failed++;
            return { payload, ok: false, error: failedMap.get(payload.dedupKey) };
          }
          if (sentKeys.size === 0 || sentKeys.has(payload.dedupKey)) {
            sent++;
            return { payload, ok: true };
          }
          failed++;
          return { payload, ok: false, error: 'Missing from GCP sent list' };
        });
        await persistDispatchResults(db, entries);
      } else {
        sent += batch.length;
        await persistDispatchResults(
          db,
          batch.map((payload) => ({ payload, ok: true }))
        );
      }
    } catch (err) {
      await persistDispatchResults(
        db,
        batch.map((payload) => ({ payload, ok: false, error: err.message }))
      );
      failed += batch.length;
    }
  }

  console.log(
    `[OccasionEvents] Dispatched — matched: ${allPayloads.length}, alreadySent: ${sentSet.size}, ` +
      `sent: ${sent}, failed: ${failed}, skippedNoPhone: ${skippedNoPhone}`
  );

  return {
    configured: true,
    dryRun: false,
    matched: allPayloads.length,
    alreadySent: sentSet.size,
    sent,
    failed,
    skippedNoPhone,
  };
}

/** Standalone scan + dispatch for manual/admin runs without modifying coupon rules. */
async function runOccasionEventsSync(db, { dryRun = false } = {}) {
  const todayUtc = istTodayUtc();
  const { onDateMatch, candidates } = createMilestoneCollector(todayUtc);
  await scanOccasionCustomers(Object.keys(OCCASIONS), todayUtc, { onDateMatch });
  return dispatchOccasionEvents(db, candidates, { dryRun });
}

module.exports = {
  MILESTONES,
  EVENT_NAMES,
  COLLECTION,
  DEFAULT_GCP_WEBHOOK_URL,
  toE164,
  formatWebEngageTime,
  matchOccasionMilestone,
  createMilestoneCollector,
  dispatchOccasionEvents,
  runOccasionEventsSync,
  ensureOccasionEventIndexes,
};

/* ------------------------------------------------------------------ *
 * Self-check: node lib/occasionEvents.js
 * ------------------------------------------------------------------ */
if (require.main === module) {
  const assert = require('assert');
  const day = (iso) => Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));

  // E.164 normalization
  assert.strictEqual(toE164('9876543210'), '+919876543210');
  assert.strictEqual(toE164('09876543210'), '+919876543210');
  assert.strictEqual(toE164('+91 98765-43210'), '+919876543210');
  assert.strictEqual(toE164('919876543210'), '+919876543210');
  assert.strictEqual(toE164('1234567890'), ''); // must start with 6-9 for India
  assert.strictEqual(toE164('+14155552671'), '+14155552671');

  // Milestones around 2026-06-20
  assert.strictEqual(matchOccasionMilestone('1990-06-20', day('2026-05-29')), null, 'T-22 does not fire');
  assert.strictEqual(matchOccasionMilestone('1990-06-20', day('2026-05-30')).milestone, 'T-21');
  assert.strictEqual(matchOccasionMilestone('1990-06-20', day('2026-06-06')).milestone, 'T-14');
  assert.strictEqual(matchOccasionMilestone('1990-06-20', day('2026-06-13')).milestone, 'T-7');
  assert.strictEqual(matchOccasionMilestone('1990-06-20', day('2026-06-17')).milestone, 'T-3');
  assert.strictEqual(matchOccasionMilestone('1990-06-20', day('2026-06-20')).milestone, 'T-day');
  assert.strictEqual(matchOccasionMilestone('1990-06-20', day('2026-06-21')), null, 'T+1 does not fire');

  // Year boundary wrap: Jan 5 birthday on Dec 15 -> T-21 for occurrenceYear 2027
  const wrap = matchOccasionMilestone('1992-01-05', day('2026-12-15'));
  assert.strictEqual(wrap.milestone, 'T-21');
  assert.strictEqual(wrap.occurrenceYear, 2027);
  assert.strictEqual(wrap.occurrenceDate, '2027-01-05');
  assert.strictEqual(wrap.windowOpensAt, '2026-12-15');
  assert.strictEqual(wrap.windowValidTill, '2027-01-11');

  // Leap day in non-leap year rolls to Mar 1
  const leap = matchOccasionMilestone('2000-02-29', day('2025-02-22'));
  assert.strictEqual(leap.milestone, 'T-7');
  assert.strictEqual(leap.occurrenceDate, '2025-03-01');

  // WebEngage time format
  assert.match(formatWebEngageTime(new Date('2026-11-11T09:50:38Z')), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0530$/);

  // Payload builder
  const payload = buildEventPayload({
    node: {
      id: 'gid://shopify/Customer/999',
      firstName: 'Asha',
      lastName: 'Rao',
      displayName: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9876543210',
    },
    kind: 'birthday',
    date: '1992-01-05',
    match: wrap,
    ruleInfo: {
      coupon_code: 'BIRTHDAY500',
      coupon_active: true,
      discount_title: 'Flat ₹500 off*',
      discount_condition: 'No minimum purchase required',
    },
    eventTime: '2026-12-15T03:15:00+0530',
  });
  assert.strictEqual(payload.dedupKey, '999:birthday:2027:T-21');
  assert.strictEqual(payload.userId, '+919876543210');
  assert.strictEqual(payload.eventName, 'birthday_reminder');
  assert.strictEqual(payload.eventData.in_coupon_window, true);
  assert.strictEqual(payload.eventData.coupon_code, 'BIRTHDAY500');

  console.log('occasionEvents self-check OK');
}

