/**
 * Checkout funnel report — PDP view -> ATC click -> added -> cart -> checkout
 * -> shipping -> pay now -> purchase, read from GA4 with Shopify orders as the
 * exact purchase count.
 *
 * Which GA4 signal backs each stage (verified against property 478308692):
 *   view_item          productView dataLayer push on the PDP
 *   atc_click          promoClick creative_name "add to cart cta" — GA4 stores
 *                      promoClick as select_promotion, so it is read through
 *                      the item-promotion dimensions. promo_id names the button:
 *                      "header sticky cta" / "pdp page cta" / "bottom sticky cta".
 *                      It fires BEFORE the login gate, so atc_click vs
 *                      add_to_cart is the cost of the guest login wall.
 *   add_to_cart        addToCart push, only after the item is really in the cart
 *   view_cart          cart page
 *   begin_checkout     "Proceed to checkout" (fires on shipping page mount; its
 *                      companion "Begin checkout cta" promoClick is 1:1 with it)
 *   add_shipping_info  "Continue to payment" click on the shipping page
 *   add_payment_info   "Pay now" click on the payment page
 *   purchase           success page — UNDER-COUNTS (headless checkout loses
 *                      some), so Shopify website orders are returned alongside.
 *
 * "clicks" = event count, "sessions" = sessions in which the event fired.
 * Sessions are distinct counts: they are never summed across days or buttons,
 * every total is its own GA4 query.
 */

const { ga4RunReport, isGa4Configured } = require('./ga4');
const { shopifyAdminRestFetch } = require('./shopify');
const { getServerCache, invalidateCache } = require('./cache');

const FUNNEL_EVENTS = [
  'view_item',
  'add_to_cart',
  'view_cart',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'purchase',
];

const ATC_CREATIVE = 'add to cart cta';

// Session-scoped dimensions the breakdown table can split by. All of them are
// compatible with both the event report and the item-promotion report.
const BREAKDOWNS = {
  channel: 'sessionDefaultChannelGroup',
  sourceMedium: 'sessionSourceMedium',
  campaign: 'sessionCampaignName',
  device: 'deviceCategory',
  city: 'city',
  newVsReturning: 'newVsReturning',
  landingPage: 'landingPage',
};

// Same app filter as GET /api/admin/orders: the headless storefront app, plus
// blank app_id (admin/manual). 283870494721 is the Gokwik theme checkout.
const WEBSITE_APP_ID = '307193511937';

const eventFilter = {
  filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_EVENTS } },
};
const atcFilter = {
  filter: {
    fieldName: 'itemPromotionCreativeName',
    stringFilter: { matchType: 'EXACT', value: ATC_CREATIVE },
  },
};

const num = (v) => Number(v) || 0;
const gaDate = (raw) => (raw && raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw);
const emptyStage = () => ({ clicks: 0, sessions: 0 });

function eventReport(range, dims) {
  return ga4RunReport({
    dateRanges: [range],
    dimensions: [...dims.map((name) => ({ name })), { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'sessions' }],
    dimensionFilter: eventFilter,
    limit: 10000,
  });
}

function atcReport(range, dims) {
  return ga4RunReport({
    dateRanges: [range],
    dimensions: dims.map((name) => ({ name })),
    metrics: [{ name: 'itemsClickedInPromotion' }, { name: 'sessions' }],
    dimensionFilter: atcFilter,
    limit: 10000,
  });
}

// rows of [...dims, eventName] -> Map<dimKey, {stageKey: {clicks, sessions}}>
function foldEvents(data, dimCount, keyOf = (vals) => vals.join('|')) {
  const out = new Map();
  for (const row of data.rows || []) {
    const vals = (row.dimensionValues || []).map((d) => d.value);
    const key = dimCount ? keyOf(vals.slice(0, dimCount)) : '';
    const ev = vals[dimCount];
    if (!out.has(key)) out.set(key, {});
    out.get(key)[ev] = { clicks: num(row.metricValues[0].value), sessions: num(row.metricValues[1].value) };
  }
  return out;
}

function foldAtc(data, dimCount, keyOf = (vals) => vals.join('|')) {
  const out = new Map();
  for (const row of data.rows || []) {
    const vals = (row.dimensionValues || []).map((d) => d.value);
    const key = dimCount ? keyOf(vals.slice(0, dimCount)) : '';
    out.set(key, { clicks: num(row.metricValues[0].value), sessions: num(row.metricValues[1].value) });
  }
  return out;
}

function stagesFrom(events = {}, atc) {
  const s = { atc_click: atc || emptyStage() };
  for (const ev of FUNNEL_EVENTS) s[ev] = events[ev] || emptyStage();
  return s;
}

// Paid, non-cancelled website orders in [start, end] (IST calendar days).
async function fetchWebsiteOrders(start, end) {
  const orders = [];
  let sinceId = 0;
  for (let page = 0; page < 20; page++) {
    const params = {
      status: 'any',
      financial_status: 'paid,partially_paid',
      limit: 250,
      created_at_min: `${start}T00:00:00+05:30`,
      created_at_max: `${end}T23:59:59+05:30`,
      fields: 'id,created_at,app_id,cancelled_at,cancel_reason,total_price,note_attributes',
    };
    if (sinceId) params.since_id = sinceId;
    const { data } = await shopifyAdminRestFetch('orders.json', params);
    const batch = data.orders || [];
    orders.push(...batch);
    if (batch.length < 250) break;
    sinceId = Math.max(...batch.map((o) => o.id));
  }
  return orders.filter((o) => {
    const appId = String(o.app_id || '');
    const cancelled = !!o.cancelled_at || !!o.cancel_reason;
    return (appId === WEBSITE_APP_ID || appId === '' || appId === 'null') && !cancelled;
  });
}

function summariseOrders(orders) {
  const daily = {};
  const gateways = {};
  let revenue = 0;
  for (const o of orders) {
    // created_at is already in the shop timezone (IST), so the date prefix is
    // the IST calendar day — the same bucketing GA4 uses for this property.
    const day = String(o.created_at).slice(0, 10);
    const amount = num(o.total_price);
    revenue += amount;
    daily[day] = daily[day] || { orders: 0, revenue: 0 };
    daily[day].orders += 1;
    daily[day].revenue += amount;
    const gw = (o.note_attributes || []).find((a) => a.name === 'payment_gateway')?.value || 'Other';
    gateways[gw] = gateways[gw] || { orders: 0, revenue: 0 };
    gateways[gw].orders += 1;
    gateways[gw].revenue += amount;
  }
  return { orders: orders.length, revenue: Math.round(revenue), daily, gateways };
}

async function safeOrders(start, end) {
  try {
    return summariseOrders(await fetchWebsiteOrders(start, end));
  } catch (err) {
    console.error('[Funnel] Shopify orders unavailable:', err.message);
    return null;
  }
}

function shiftDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function previousRange(start, end) {
  const len = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;
  return { startDate: shiftDays(start, -len), endDate: shiftDays(start, -1) };
}

// The checkout pages themselves (page_view based). Reaching a page and clicking
// its CTA are different things — /checkout/cart is opened by ~2x the sessions
// that fire view_cart — so the page card reports both.
const CHECKOUT_PAGES = ['/checkout/cart', '/checkout/shipping', '/checkout/payment', '/success'];

async function buildPages(range) {
  const data = await ga4RunReport({
    dateRanges: [range],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'userEngagementDuration' }, { name: 'totalUsers' }],
    dimensionFilter: { filter: { fieldName: 'pagePath', inListFilter: { values: CHECKOUT_PAGES } } },
  });
  const out = {};
  for (const path of CHECKOUT_PAGES) out[path] = { views: 0, sessions: 0, users: 0, engagementSec: 0 };
  for (const row of data.rows || []) {
    const m = row.metricValues.map((v) => num(v.value));
    out[row.dimensionValues[0].value] = { views: m[0], sessions: m[1], engagementSec: m[2], users: m[3] };
  }
  return out;
}

// Sum of each event's `value` param (cart value in INR) — the money passing
// through each step. Repeated events (Pay now retries) repeat their value, so
// the page divides by event count to get an average cart value.
async function buildValues(range) {
  const data = await ga4RunReport({
    dateRanges: [range],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventValue' }, { name: 'eventCount' }],
    dimensionFilter: eventFilter,
  });
  const out = {};
  for (const row of data.rows || []) {
    out[row.dimensionValues[0].value] = { value: Math.round(num(row.metricValues[0].value)), count: num(row.metricValues[1].value) };
  }
  return out;
}

// Per product: ATC clicks (promo_name is the product title) joined by name to
// the GA4 item metrics. Shows which products attract clicks but never get
// added, and which get added but stall at checkout.
const NON_PRODUCT_ITEMS = new Set(['Insurance']);

async function buildProducts(range, limit = 30) {
  const [promo, adds] = await Promise.all([
    ga4RunReport({
      dateRanges: [range],
      dimensions: [{ name: 'itemPromotionName' }],
      metrics: [{ name: 'itemsClickedInPromotion' }],
      dimensionFilter: atcFilter,
      orderBys: [{ metric: { metricName: 'itemsClickedInPromotion' }, desc: true }],
      limit,
    }),
    ga4RunReport({
      dateRanges: [range],
      dimensions: [{ name: 'itemName' }],
      metrics: [{ name: 'itemsAddedToCart' }],
      orderBys: [{ metric: { metricName: 'itemsAddedToCart' }, desc: true }],
      limit,
    }),
  ]);
  const clicks = new Map((promo.rows || []).map((r) => [r.dimensionValues[0].value, num(r.metricValues[0].value)]));
  const names = [...new Set([...clicks.keys(), ...(adds.rows || []).map((r) => r.dimensionValues[0].value)])]
    .filter((n) => n && n !== '(not set)' && !NON_PRODUCT_ITEMS.has(n));
  if (!names.length) return [];

  const items = await ga4RunReport({
    dateRanges: [range],
    dimensions: [{ name: 'itemName' }],
    metrics: [{ name: 'itemsViewed' }, { name: 'itemsAddedToCart' }, { name: 'itemsCheckedOut' }, { name: 'itemsPurchased' }],
    dimensionFilter: { filter: { fieldName: 'itemName', inListFilter: { values: names } } },
    limit: names.length,
  });
  const byName = new Map((items.rows || []).map((r) => [r.dimensionValues[0].value, r.metricValues.map((v) => num(v.value))]));
  return names.map((name) => {
    const m = byName.get(name) || [0, 0, 0, 0];
    return { name, views: m[0], atcClicks: clicks.get(name) || 0, added: m[1], checkedOut: m[2], purchased: m[3] };
  }).sort((a, b) => b.atcClicks - a.atcClicks || b.added - a.added);
}

async function buildSummary(range) {
  const [ev, atc, atcByCta] = await Promise.all([
    eventReport(range, []),
    atcReport(range, []),
    atcReport(range, ['itemPromotionId']),
  ]);
  const totals = stagesFrom(foldEvents(ev, 0).get(''), foldAtc(atc, 0).get(''));
  const ctas = {};
  for (const [cta, v] of foldAtc(atcByCta, 1)) ctas[cta] = v;
  return { totals, ctas };
}

async function buildDaily(range) {
  const [ev, atc] = await Promise.all([eventReport(range, ['date']), atcReport(range, ['date'])]);
  const evMap = foldEvents(ev, 1, (v) => gaDate(v[0]));
  const atcMap = foldAtc(atc, 1, (v) => gaDate(v[0]));
  const days = [];
  for (let d = range.startDate; d <= range.endDate; d = shiftDays(d, 1)) {
    days.push({ date: d, stages: stagesFrom(evMap.get(d), atcMap.get(d)) });
  }
  return days;
}

async function buildBreakdown(range, dimension, maxRows = 40) {
  const [ev, atc] = await Promise.all([eventReport(range, [dimension]), atcReport(range, [dimension])]);
  const evMap = foldEvents(ev, 1);
  const atcMap = foldAtc(atc, 1);
  const keys = new Set([...evMap.keys(), ...atcMap.keys()]);
  const rows = [...keys].map((key) => ({ key, stages: stagesFrom(evMap.get(key), atcMap.get(key)) }));
  // Rank by funnel entry (ATC-click sessions), then product views.
  rows.sort((a, b) =>
    b.stages.atc_click.sessions - a.stages.atc_click.sessions ||
    b.stages.view_item.sessions - a.stages.view_item.sessions);
  return { rows: rows.slice(0, maxRows), totalRows: rows.length };
}

/**
 * Full report for the admin Checkout Funnel page. Cached 10 min per
 * (range, breakdown) — GA4 itself lags a few hours, and the page re-requests
 * on every filter change.
 */
async function getCheckoutFunnel({ start, end, breakdown = 'channel', fresh = false }) {
  if (!isGa4Configured()) throw new Error('GA4 is not configured on the backend');
  const dimension = BREAKDOWNS[breakdown] || BREAKDOWNS.channel;
  const range = { startDate: start, endDate: end };
  const prev = previousRange(start, end);

  const cacheKey = `funnel:${start}:${end}:${dimension}`;
  if (fresh) invalidateCache(cacheKey);
  return getServerCache(cacheKey, async () => {
    const [current, previous, daily, breakdownRows, devices, orders, prevOrders, pages, prevPages, values, products] = await Promise.all([
      buildSummary(range),
      buildSummary(prev),
      buildDaily(range),
      buildBreakdown(range, dimension),
      dimension === BREAKDOWNS.device ? null : buildBreakdown(range, BREAKDOWNS.device, 5),
      safeOrders(start, end),
      safeOrders(prev.startDate, prev.endDate),
      buildPages(range),
      buildPages(prev),
      buildValues(range),
      buildProducts(range),
    ]);
    return {
      range: { start, end },
      previousRange: { start: prev.startDate, end: prev.endDate },
      totals: current.totals,
      previousTotals: previous.totals,
      ctas: current.ctas,
      previousCtas: previous.ctas,
      daily,
      breakdown: { key: breakdown in BREAKDOWNS ? breakdown : 'channel', dimension, ...breakdownRows },
      devices: (devices || breakdownRows).rows,
      orders,
      previousOrders: prevOrders,
      pages,
      previousPages: prevPages,
      values,
      products,
      generatedAt: new Date().toISOString(),
    };
  }, { ttlMs: 10 * 60 * 1000 });
}

module.exports = { getCheckoutFunnel, BREAKDOWNS };
