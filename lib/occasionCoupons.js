/**
 * Birthday / anniversary coupons.
 *
 * Staff tag a normal Product Discounts rule (dashboard → Product Discounts)
 * with an occasion — "birthday" or "anniversary". The rule is created, edited
 * and synced to Shopify exactly like every other code discount
 * (lib/shopifyDiscounts.js); what this module adds is WHO may use it.
 *
 * A customer's window opens LEAD_DAYS before their date and lasts VALID_DAYS
 * in total, i.e. 7 days before → 7 days after. That window is expressed as
 * Shopify's own "specific customers" selection on the discount: the scheduler
 * (lib/occasionCouponScheduler.js) adds customer ids as windows open and
 * removes them as they close, so ONE coupon code serves every customer and
 * the entitlement list is the only thing that moves.
 *
 * The dates live on the Shopify customer as lucira_profile.date_of_birth /
 * lucira_profile.anniversary_date (written by POST /api/customer/reward/
 * profile-complete from My Account → Rewards), always as YYYY-MM-DD because
 * the form uses <input type="date">. Anything else is ignored and counted.
 *
 * Our own cart never sees Shopify's customer selection — /api/cart/coupon/
 * validate and the checkout's re-validation both price a code from
 * codeDiscountNodeByCode, which says nothing about who may use it — so
 * entitlementError() below is what stops a shared birthday code from working
 * for everyone. It checks the customer's own date, not the synced list, so a
 * customer whose window opened since the last nightly run is never refused.
 */

const { shopifyAdminFetch } = require('./shopify');
const {
  updateDiscountCustomers,
  activateShopifyDiscount,
  deactivateShopifyDiscount,
} = require('./shopifyDiscounts');

// The coupon opens 7 days before the date and runs for 14 days in total
// (so: 7 before, the day itself, 6 after). Fixed by the campaign, not
// per-rule — the amount, minimum and product scope stay staff-editable on
// the rule itself.
const LEAD_DAYS = 7;
const VALID_DAYS = 14;

const OCCASIONS = {
  birthday: { metafieldKey: 'date_of_birth', label: 'Birthday' },
  anniversary: { metafieldKey: 'anniversary_date', label: 'Anniversary' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

const isOccasion = (kind) => Object.prototype.hasOwnProperty.call(OCCASIONS, kind);

/** Today in IST, as a UTC midnight timestamp — the store's clock, not the server's. */
function istTodayUtc(now = new Date()) {
  const [d, m, y] = now
    .toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' })
    .split('/')
    .map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * The open window around this year's occurrence of `dateStr`, or null when the
 * date is unusable or today falls outside it. Years either side are tried too,
 * so a 2 January birthday still opens on 26 December.
 */
function occasionWindow(dateStr, todayUtc = istTodayUtc()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  const thisYear = new Date(todayUtc).getUTCFullYear();
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    // 29 February in a common year rolls to 1 March, which is what Date does
    // for us here and is the kinder reading for the customer.
    const occurrence = Date.UTC(year, month, day);
    const start = occurrence - LEAD_DAYS * DAY_MS;
    const end = start + VALID_DAYS * DAY_MS;
    if (todayUtc >= start && todayUtc < end) {
      return { start: new Date(start), end: new Date(end - DAY_MS), occurrence: new Date(occurrence) };
    }
  }
  return null;
}

const isInOccasionWindow = (dateStr, todayUtc = istTodayUtc()) => !!occasionWindow(dateStr, todayUtc);

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

/**
 * Occasion-tagged rules that can actually be synced. A rule the scheduler
 * itself paused (occasionAutoPaused — nobody was in a window) is included, so
 * it can be brought back when someone is.
 */
async function occasionRules(db, ruleId = null) {
  const doc = await db.collection('settings').findOne({ key: 'product_discounts_rules' });
  return (doc?.discounts || []).filter(
    (r) =>
      isOccasion(r.occasion) &&
      r.method === 'code' &&
      r.shopifyDiscountId &&
      (!ruleId || r.id === ruleId) &&
      (r.active !== false || r.occasionAutoPaused === true)
  );
}

/** The ₹ value / minimum of a rule, phrased the way /coupons/active phrases it. */
function describeRule(rule) {
  const title =
    rule.discountType === 'percentage'
      ? `${rule.discountValue}% off*`
      : `Flat ₹${rule.discountValue} off*`;

  let condition = 'No minimum purchase required';
  if (rule.minRequirement === 'amount' && rule.minRequirementValue > 0) {
    condition = `On Purchase above ₹${Number(rule.minRequirementValue).toLocaleString('en-IN')}/-`;
  } else if (rule.minRequirement === 'quantity' && rule.minRequirementValue > 0) {
    const n = rule.minRequirementValue;
    condition = `Minimum ${n} item${n > 1 ? 's' : ''} in cart`;
  }
  return { title, condition };
}

/* ------------------------------------------------------------------ *
 * Reading the dates off Shopify
 * ------------------------------------------------------------------ */

const CUSTOMER_OCCASIONS_QUERY = `
  query CustomerOccasions($id: ID!) {
    customer(id: $id) {
      displayName
      email
      birthday: metafield(namespace: "lucira_profile", key: "date_of_birth") { value }
      birthdayAlt: metafield(namespace: "custom", key: "birthday") { value }
      anniversary: metafield(namespace: "lucira_profile", key: "anniversary_date") { value }
      anniversaryAlt: metafield(namespace: "custom", key: "anniversary") { value }
      marital: metafield(namespace: "lucira_profile", key: "marital_status") { value }
    }
  }
`;

const SCAN_QUERY = `
  query OccasionCustomers($after: String) {
    customers(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        displayName
        email
        birthday: metafield(namespace: "lucira_profile", key: "date_of_birth") { value }
        birthdayAlt: metafield(namespace: "custom", key: "birthday") { value }
        anniversary: metafield(namespace: "lucira_profile", key: "anniversary_date") { value }
        anniversaryAlt: metafield(namespace: "custom", key: "anniversary") { value }
        marital: metafield(namespace: "lucira_profile", key: "marital_status") { value }
      }
    }
  }
`;

/**
 * The Rewards form only asks for an anniversary once "Married" is picked, and
 * switching back to Unmarried clears the field — so an explicit non-married
 * status beats whatever date is on the record. (The profile save now clears
 * the metafield too; this also covers records written before it did.)
 * A customer with no status at all — an older signup — keeps their date.
 */
const anniversaryAllowed = (maritalStatus) => {
  const value = String(maritalStatus || '').trim().toLowerCase();
  return !value || value === 'married';
};

/**
 * The date a customer's window is measured from.
 *
 * Two places hold these dates. `lucira_profile.*` is what the customer typed
 * in My Account → Rewards; `custom.birthday` / `custom.anniversary` are the
 * Shopify-side fields (admin edits, CRM imports) and are the only source for
 * a customer who has never logged in — they're scanned all the same, so those
 * customers get their coupon too. The customer's own entry wins when both
 * exist.
 *
 * A Shopify `date` metafield stores YYYY-MM-DD and a `date_time` one appends a
 * time, so the first ten characters are taken and anything else is ignored
 * rather than guessed at.
 */
const pickDate = (...values) => {
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  return '';
};

// Carts and checkouts carry the customer id in whichever shape the client
// sent — bare numeric or a gid.
const toCustomerGid = (id) => {
  const raw = String(id || '').trim();
  if (!raw) return null;
  return raw.includes('gid://') ? raw : `gid://shopify/Customer/${raw}`;
};

/**
 * One customer's two dates, plus who they are — the name and email are what
 * the dashboard's eligible-customer list shows. Empty strings for a customer
 * that has neither date.
 */
async function customerOccasionDates(customerId) {
  const customerGid = toCustomerGid(customerId);
  if (!customerGid) return { birthday: '', anniversary: '' };
  const data = await shopifyAdminFetch(CUSTOMER_OCCASIONS_QUERY, { id: customerGid });
  const customer = data?.customer || {};
  return {
    name: customer.displayName || '',
    email: customer.email || '',
    birthday: pickDate(customer.birthday?.value, customer.birthdayAlt?.value),
    anniversary: anniversaryAllowed(customer.marital?.value)
      ? pickDate(customer.anniversary?.value, customer.anniversaryAlt?.value)
      : '',
  };
}

/**
 * Every customer currently inside a window, by occasion, as
 * { id, name, email, date, validTill } — the dashboard lists them, so the
 * sweep carries who they are, not just how many.
 *
 * ponytail: a full customer scan (~40 Admin pages at 10k customers), run once
 * a night in the governor's background lane and only when an occasion rule
 * exists. If the customer base outgrows that, mirror the two dates into Mongo
 * on profile save and read them from there instead — the rest of this file
 * does not care where the dates came from.
 */
async function scanOccasionCustomers(kinds, todayUtc = istTodayUtc()) {
  const wanted = kinds.filter(isOccasion);
  const eligible = Object.fromEntries(wanted.map((k) => [k, []]));
  if (!wanted.length) return eligible;

  let after = null;
  let pages = 0;
  let scanned = 0;
  let unparseable = 0;

  do {
    const data = await shopifyAdminFetch(SCAN_QUERY, { after }, { priority: 'background' });
    const conn = data?.customers;
    if (!conn) break;

    for (const node of conn.nodes || []) {
      scanned++;
      for (const kind of wanted) {
        // lucira_profile first, then the Shopify-side custom.* field — see pickDate.
        const raw = node[kind]?.value || node[`${kind}Alt`]?.value;
        if (!raw) continue;
        const value = pickDate(node[kind]?.value, node[`${kind}Alt`]?.value);
        if (!value) {
          unparseable++;
          continue;
        }
        if (kind === 'anniversary' && !anniversaryAllowed(node.marital?.value)) continue;
        const window = occasionWindow(value, todayUtc);
        if (window) {
          eligible[kind].push({
            id: node.id,
            name: node.displayName || '',
            email: node.email || '',
            date: value,
            validTill: window.end.toISOString().slice(0, 10),
          });
        }
      }
    }

    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (after);

  console.log(
    `[OccasionCoupons] Scanned ${scanned} customers over ${pages} pages — ` +
      wanted.map((k) => `${k}: ${eligible[k].length}`).join(', ') +
      (unparseable ? ` (${unparseable} unreadable date${unparseable > 1 ? 's' : ''})` : '')
  );

  return eligible;
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

async function persistRule(db, ruleId, fields) {
  await db.collection('settings').updateOne(
    { key: 'product_discounts_rules', 'discounts.id': ruleId },
    { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`discounts.$.${k}`, v])) }
  );
}

/**
 * Bring every occasion rule's Shopify customer selection in line with today's
 * windows. Safe to run repeatedly — it only sends the difference.
 *
 * With nobody in a window the rule is DEACTIVATED rather than emptied: a code
 * discount whose customer selection is cleared falls back to "all customers",
 * which would hand a birthday coupon to the whole store. The stored id list is
 * left alone while paused (it is inert — the discount is off) and is diffed
 * away on the run that reactivates it.
 */
async function syncOccasionCoupons(db, { ruleId = null } = {}) {
  const rules = await occasionRules(db, ruleId);
  if (!rules.length) return { rules: 0, added: 0, removed: 0 };

  const eligible = await scanOccasionCustomers([...new Set(rules.map((r) => r.occasion))]);

  let added = 0;
  let removed = 0;

  for (const rule of rules) {
    // The detailed records are what the dashboard lists; the id array stays
    // the thing diffed against Shopify and appended to mid-cycle.
    const wantCustomers = eligible[rule.occasion] || [];
    const want = wantCustomers.map((c) => c.id);
    const had = Array.isArray(rule.occasionCustomerIds) ? rule.occasionCustomerIds : [];

    try {
      if (!want.length) {
        if (rule.active !== false) {
          const result = await deactivateShopifyDiscount(rule.shopifyDiscountId, 'code');
          await persistRule(db, rule.id, {
            active: false,
            occasionAutoPaused: true,
            endsAt: result.endsAt ?? rule.endsAt ?? null,
            occasionSyncedAt: new Date().toISOString(),
            occasionEligibleCount: 0,
            occasionCustomers: [],
          });
          console.log(`[OccasionCoupons] "${rule.title}" paused — no ${rule.occasion} windows open today`);
        } else {
          await persistRule(db, rule.id, {
            occasionSyncedAt: new Date().toISOString(),
            occasionEligibleCount: 0,
            occasionCustomers: [],
          });
        }
        continue;
      }

      const wantSet = new Set(want);
      const hadSet = new Set(had);
      const toAdd = want.filter((id) => !hadSet.has(id));
      const toRemove = had.filter((id) => !wantSet.has(id));

      if (toAdd.length || toRemove.length) {
        await updateDiscountCustomers(rule.shopifyDiscountId, { add: toAdd, remove: toRemove });
        added += toAdd.length;
        removed += toRemove.length;
      }

      const fields = {
        occasionCustomerIds: want,
        occasionCustomers: wantCustomers,
        occasionSyncedAt: new Date().toISOString(),
        occasionEligibleCount: want.length,
        occasionSyncError: null,
      };

      // Reactivate only what this job paused — a discount staff switched off
      // stays off.
      if (rule.occasionAutoPaused === true) {
        const result = await activateShopifyDiscount(rule.shopifyDiscountId, 'code');
        fields.active = true;
        fields.occasionAutoPaused = false;
        fields.endsAt = result.endsAt ?? null;
      }

      await persistRule(db, rule.id, fields);
      console.log(
        `[OccasionCoupons] "${rule.title}" — ${want.length} customer(s) in window ` +
          `(+${toAdd.length} / -${toRemove.length})`
      );
    } catch (err) {
      console.error(`[OccasionCoupons] Sync failed for "${rule.title}":`, err.message);
      await persistRule(db, rule.id, { occasionSyncError: err.message, occasionSyncedAt: new Date().toISOString() });
    }
  }

  return { rules: rules.length, added, removed };
}

/* ------------------------------------------------------------------ *
 * Per-customer entitlement
 * ------------------------------------------------------------------ */

/**
 * The occasion coupons this customer can use right now, ready for the account
 * page. Each carries the date its window closes so the card can say so.
 */
async function customerOccasionCoupons(db, customerGid) {
  const rules = await occasionRules(db);
  if (!rules.length) return [];

  const dates = await customerOccasionDates(customerGid);
  const todayUtc = istTodayUtc();

  return rules
    .map((rule) => {
      const window = occasionWindow(dates[rule.occasion], todayUtc);
      if (!window) return null;
      const { title, condition } = describeRule(rule);
      return {
        code: rule.title,
        occasion: rule.occasion,
        occasionLabel: OCCASIONS[rule.occasion].label,
        title,
        condition,
        validTill: window.end.toISOString().slice(0, 10),
        // A window that opened since the last nightly sync is honoured by our
        // own cart immediately (entitlementError reads the same dates), and
        // grantCustomer below catches Shopify up.
        granted: !rule.occasionAutoPaused && (rule.occasionCustomerIds || []).includes(customerGid),
        ruleId: rule.id,
        // What the dashboard's eligible list needs if this view is what grants
        // them. Stripped from the response by the route.
        grantDetails: {
          name: dates.name || '',
          email: dates.email || '',
          date: dates[rule.occasion],
          validTill: window.end.toISOString().slice(0, 10),
        },
      };
    })
    .filter(Boolean);
}

/**
 * Add one customer to a rule's Shopify selection mid-cycle, so the entitlement
 * Shopify knows about matches the one we just honoured. Fire-and-forget: the
 * nightly sync would pick them up anyway.
 */
async function grantCustomer(db, ruleId, customerId, details = null) {
  const customerGid = toCustomerGid(customerId);
  const [rule] = await occasionRules(db, ruleId);
  if (!rule || !customerGid) return false;

  const alreadyListed = (rule.occasionCustomerIds || []).includes(customerGid);
  if (alreadyListed && !rule.occasionAutoPaused) return false;

  if (!alreadyListed) await updateDiscountCustomers(rule.shopifyDiscountId, { add: [customerGid] });

  const set = {};
  // The coupon parks itself deactivated while no window is open (see
  // syncOccasionCoupons). This customer's window just opened, so switch it
  // back on — otherwise the code we are about to show them is refused by
  // Shopify as expired.
  if (rule.occasionAutoPaused) {
    const result = await activateShopifyDiscount(rule.shopifyDiscountId, 'code');
    set['discounts.$.active'] = true;
    set['discounts.$.occasionAutoPaused'] = false;
    set['discounts.$.endsAt'] = result.endsAt ?? null;
  }

  // $addToSet, not a whole-list rewrite: the nightly sweep may be running.
  await db.collection('settings').updateOne(
    { key: 'product_discounts_rules', 'discounts.id': ruleId },
    {
      $addToSet: {
        'discounts.$.occasionCustomerIds': customerGid,
        // Keeps the dashboard's eligible list in step with the id array when
        // someone is granted between sweeps.
        ...(details && !alreadyListed
          ? { 'discounts.$.occasionCustomers': { id: customerGid, ...details } }
          : {}),
      },
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(details && !alreadyListed ? { $inc: { 'discounts.$.occasionEligibleCount': 1 } } : {}),
    }
  );
  return true;
}

/**
 * Why this customer may not use this code, or null when they may (including
 * when the code is not an occasion coupon at all).
 *
 * Called from /api/cart/coupon/validate and from the checkout's final
 * re-validation — Shopify's own customer selection is invisible to both,
 * since they price a code through codeDiscountNodeByCode.
 *
 * `customer` may be a gid or a function returning one, so a caller that would
 * need a Shopify round-trip to identify the shopper only pays for it when the
 * code turns out to be an occasion coupon.
 */
async function entitlementError(db, code, customer) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;

  const doc = await db.collection('settings').findOne({ key: 'product_discounts_rules' });
  const rule = (doc?.discounts || []).find(
    (d) => isOccasion(d.occasion) && String(d.title || '').trim().toUpperCase() === wanted
  );
  if (!rule) return null;

  const customerGid = toCustomerGid(typeof customer === 'function' ? await customer() : customer);
  const label = OCCASIONS[rule.occasion].label.toLowerCase();
  if (!customerGid) return `Please sign in to use your ${label} coupon.`;

  const dates = await customerOccasionDates(customerGid);
  if (!dates[rule.occasion]) {
    return `Add your ${label} date in My Account → Rewards to use this coupon.`;
  }
  const window = occasionWindow(dates[rule.occasion]);
  if (!window) {
    return `This coupon is only valid around your ${label} — ${LEAD_DAYS} days before and after.`;
  }

  const details = {
    name: dates.name || '',
    email: dates.email || '',
    date: dates[rule.occasion],
    validTill: window.end.toISOString().slice(0, 10),
  };
  grantCustomer(db, rule.id, customerGid, details).catch((err) =>
    console.error('[OccasionCoupons] Mid-cycle grant failed:', err.message)
  );
  return null;
}

module.exports = {
  OCCASIONS,
  LEAD_DAYS,
  VALID_DAYS,
  istTodayUtc,
  occasionWindow,
  isInOccasionWindow,
  occasionRules,
  describeRule,
  scanOccasionCustomers,
  syncOccasionCoupons,
  customerOccasionCoupons,
  customerOccasionDates,
  grantCustomer,
  entitlementError,
};

/* ------------------------------------------------------------------ *
 * Self-check: node lib/occasionCoupons.js
 * ------------------------------------------------------------------ */
if (require.main === module) {
  const assert = require('assert');
  const day = (iso) => Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));

  // Birthday 1990-06-20 → open 13 June, last day 26 June.
  assert.strictEqual(isInOccasionWindow('1990-06-20', day('2025-06-12')), false, 'one day too early');
  assert.strictEqual(isInOccasionWindow('1990-06-20', day('2025-06-13')), true, 'opens 7 days before');
  assert.strictEqual(isInOccasionWindow('1990-06-20', day('2025-06-20')), true, 'the day itself');
  assert.strictEqual(isInOccasionWindow('1990-06-20', day('2025-06-26')), true, 'last of the 14 days');
  assert.strictEqual(isInOccasionWindow('1990-06-20', day('2025-06-27')), false, 'closed on day 15');

  // Year wrap, both directions.
  assert.strictEqual(isInOccasionWindow('1988-01-02', day('2025-12-26')), true, 'January date opens in December');
  assert.strictEqual(isInOccasionWindow('1988-12-28', day('2026-01-03')), true, 'December date still open in January');

  // 29 February falls on 1 March in a common year.
  assert.strictEqual(isInOccasionWindow('2000-02-29', day('2025-03-01')), true, 'leap day rolls to 1 March');

  assert.strictEqual(isInOccasionWindow('', day('2025-06-20')), false, 'empty');
  assert.strictEqual(isInOccasionWindow('20/06/1990', day('2025-06-20')), false, 'non-ISO is ignored, never guessed');

  const w = occasionWindow('1990-06-20', day('2025-06-20'));
  assert.strictEqual(w.start.toISOString().slice(0, 10), '2025-06-13');
  assert.strictEqual(w.end.toISOString().slice(0, 10), '2025-06-26');

  // Two date sources: the customer's own entry wins, custom.* fills in for
  // anyone who never logged in, and a date_time value loses its time.
  assert.strictEqual(pickDate('1994-09-15', '2008-09-17'), '1994-09-15', 'lucira_profile wins');
  assert.strictEqual(pickDate('', '2008-09-17'), '2008-09-17', 'falls back to custom.*');
  assert.strictEqual(pickDate(null, '2008-09-17T00:00:00Z'), '2008-09-17', 'date_time is trimmed to the day');
  assert.strictEqual(pickDate('Sep 17, 2008', ''), '', 'a display-formatted value is never guessed at');
  assert.strictEqual(pickDate(), '');

  // The anniversary only counts while the customer says they're married.
  assert.strictEqual(anniversaryAllowed('Married'), true);
  assert.strictEqual(anniversaryAllowed('Unmarried'), false, 'an explicit Unmarried wins over a stale date');
  assert.strictEqual(anniversaryAllowed(''), true, 'older records with no status keep their date');
  assert.strictEqual(anniversaryAllowed(undefined), true);

  // Exactly VALID_DAYS days are open, no more.
  let open = 0;
  for (let i = -10; i < 20; i++) {
    if (isInOccasionWindow('1990-06-20', day('2025-06-20') + i * DAY_MS)) open++;
  }
  assert.strictEqual(open, VALID_DAYS, `${open} open days, expected ${VALID_DAYS}`);

  console.log('occasionCoupons self-check OK');
}
