/**
 * GA4 Data API adapter (dependency-free)
 *
 * WHY: the storefront is headless (Next.js on Vercel), so Shopify's own web
 * analytics is blind to it (~468 sessions/30d recorded vs real traffic). The
 * behavioral source of truth is Google Analytics, which already receives the
 * full ecommerce event set through GTM (see lucira-frontend/src/lib/gtm.js).
 * This adapter reads per-product behavior straight from GA4's items report:
 * view_item / add_to_cart / purchase counts by item id.
 *
 * Auth: Google service account, JWT-bearer OAuth flow, signed with Node's
 * built-in crypto (RS256) — no npm dependency, matching this repo's rule of
 * not adding deps (no deploy tooling for dependency changes on Hostinger).
 *
 * SETUP (until these exist, isGa4Configured() is false and callers fall back
 * to the first-party beacon + cart data):
 *   1. Google Cloud console -> create a service account, download JSON key.
 *   2. GA4 Admin -> property Access Management -> add the service account
 *      email as Viewer.
 *   3. .env:
 *        GA4_PROPERTY_ID=123456789
 *        GA4_SERVICE_ACCOUNT_JSON=<the raw JSON key, single line>
 *      (or GA4_SERVICE_ACCOUNT_FILE=/path/to/key.json)
 */

const crypto = require('crypto');
const fs = require('fs');
const { getServerCache } = require('./cache');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

function loadServiceAccount() {
  try {
    if (process.env.GA4_SERVICE_ACCOUNT_JSON) {
      return JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
    }
    if (process.env.GA4_SERVICE_ACCOUNT_FILE) {
      return JSON.parse(fs.readFileSync(process.env.GA4_SERVICE_ACCOUNT_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[GA4] Service account credentials unreadable:', err.message);
  }
  return null;
}

function isGa4Configured() {
  return Boolean(process.env.GA4_PROPERTY_ID && loadServiceAccount());
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Service-account JWT -> short-lived access token (cached just under 1h).
async function getAccessToken() {
  return getServerCache('ga4:access-token', async () => {
    const sa = loadServiceAccount();
    if (!sa) throw new Error('GA4 service account not configured');

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600
    }));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = b64url(signer.sign(sa.private_key));

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`
      })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(`GA4 token exchange failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data.access_token;
  }, { ttlMs: 50 * 60 * 1000 });
}

/**
 * GA4 item_id -> Shopify PRODUCT id.
 *
 * VERIFIED against the live property (478308692), where THREE id formats
 * coexist because different tags populate item_id differently:
 *   1. variant SKU      "LJ-CH0018-18YGPG-16"   <- dominant for view_item /
 *                                                  add_to_cart (most traffic)
 *   2. sales-channel id "shopify_ZZ_9141315829978_48114041749722"
 *                       i.e. shopify_{country}_{productId}_{variantId}
 *   3. bare product id  "9141315829978"          <- purchase events
 *
 * Two traps, both of which fail SILENTLY (zeros, no error):
 *   - "last numeric run" yields the VARIANT id for format 2, matching nothing.
 *   - the same fallback turns SKU "LJ-CH0018-18YGPG-16" into "16", inventing a
 *     product id that may collide with a real one. So unknown shapes are
 *     DROPPED, never guessed.
 *
 * skuIndex (Map of UPPERCASED sku -> numeric product id) resolves format 1;
 * build it with getSkuIndex() in lib/recoSignals.js. Variant-level rows are
 * summed into their product by the caller — one product's views across all
 * its metal colours and sizes, which is exactly what the engine wants.
 */
function ga4ItemIdToProductId(rawId, skuIndex) {
  const s = String(rawId == null ? '' : rawId).trim();
  if (!s) return '';

  // 2. shopify_{CC}_{productId}_{variantId}
  const feed = s.match(/^shopify_[A-Za-z]{2,3}_(\d+)_(\d+)$/);
  if (feed) return feed[1];

  // 3. bare numeric product id
  if (/^\d+$/.test(s)) return s;

  // gid://shopify/Product/123
  const gid = s.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
  if (gid) return gid[1];

  // 1. variant SKU
  if (skuIndex) {
    const hit = skuIndex.get(s.toUpperCase());
    if (hit) return hit;
  }

  // Unknown shape — drop it rather than guess a wrong product.
  return '';
}

/**
 * Per-item behavior for the trailing `days` window.
 * Returns Map<numericProductId, {views, atc, purchases, revenue}>.
 * Only views and atc are consumed by the engine — orders and revenue always
 * come from Shopify (exact, all channels); purchases/revenue are kept here
 * only for the diagnostics in check-ga4.js.
 */
// One paginated itemId report, restricted to a single event.
async function fetchByEvent(days, eventName, metricName) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const token = await getAccessToken();

  const rows = [];
  let offset = 0;
  const limit = 10000;
  for (let page = 0; page < 6; page++) {
    const res = await fetch(`${DATA_API}/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'itemId' }],
        metrics: [{ name: metricName }],
        // Restrict to the one event that legitimately produces this metric.
        dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: eventName } } },
        limit,
        offset
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`GA4 runReport failed: ${JSON.stringify(data.error || data).slice(0, 200)}`);
    for (const row of data.rows || []) rows.push(row);
    const total = Number(data.rowCount) || 0;
    offset += limit;
    if (offset >= total) break;
  }
  return rows;
}

/**
 * Per-item behaviour for the trailing `days` window.
 * Returns Map<numericProductId, {views, atc}>.
 *
 * Views come ONLY from `view_item` and add-to-carts ONLY from `add_to_cart`,
 * each pinned with an explicit eventName filter. This matters more than it
 * looks: the property also fires `view_item_list` (collection-page
 * impressions) carrying 3.1M item views in 30 days — roughly 6x the 528k real
 * product views. GA4 keeps those in a different metric (`itemsViewedInList`),
 * so the unfiltered read happened to be correct, but one GTM change could
 * start folding listing impressions into product views and inflate every
 * ranking ~7x with no error anywhere. The filter makes that impossible.
 *
 * Orders and revenue are deliberately NOT read from GA4 — Shopify is the exact
 * source for money (GA4 recorded 62 purchase events in 30 days against far
 * more real orders, because a headless checkout does not reliably fire them).
 */
async function fetchItemMetrics(days, skuIndex) {
  const [viewRows, atcRows] = await Promise.all([
    fetchByEvent(days, 'view_item', 'itemsViewed'),
    fetchByEvent(days, 'add_to_cart', 'itemsAddedToCart')
  ]);

  const map = new Map();
  const fold = (rows, key) => {
    for (const row of rows) {
      const nid = ga4ItemIdToProductId(row.dimensionValues?.[0]?.value || '', skuIndex);
      if (!nid) continue;
      const n = Number(row.metricValues?.[0]?.value) || 0;
      if (!n) continue;
      const prev = map.get(nid) || { views: 0, atc: 0 };
      prev[key] += n;
      map.set(nid, prev);
    }
  };
  fold(viewRows, 'views');
  fold(atcRows, 'atc');
  return map;
}

// Cached windows for the rules engine. TTL 1h — nightly runs and previews
// share the same pull; GA4 data itself lags real time by a few hours anyway.
async function getGa4Windows(skuIndex) {
  if (!isGa4Configured()) return null;
  try {
    const [d3, d7, d30] = await Promise.all([
      getServerCache('ga4:items:3d', () => fetchItemMetrics(3, skuIndex), { ttlMs: 60 * 60 * 1000 }),
      getServerCache('ga4:items:7d', () => fetchItemMetrics(7, skuIndex), { ttlMs: 60 * 60 * 1000 }),
      getServerCache('ga4:items:30d', () => fetchItemMetrics(30, skuIndex), { ttlMs: 60 * 60 * 1000 })
    ]);
    return { d3, d7, d30 };
  } catch (err) {
    console.error('[GA4] Falling back to first-party signals:', err.message);
    return null;
  }
}

// Raw report passthrough — used by check-ga4.js to diagnose GTM/GA4 wiring.
async function ga4RunReport(body) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const token = await getAccessToken();
  const res = await fetch(`${DATA_API}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data.error || data).slice(0, 300));
  return data;
}

module.exports = { isGa4Configured, getGa4Windows, ga4RunReport, ga4ItemIdToProductId };
