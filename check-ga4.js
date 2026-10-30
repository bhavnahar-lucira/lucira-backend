/**
 * GA4 connection checker — run:  node check-ga4.js
 *
 * Confirms the recommendation engine can read per-product behaviour from
 * Google Analytics. Read-only: it runs one report and prints a summary.
 *
 * Needs in .env:
 *   GA4_PROPERTY_ID=478308692
 *   GA4_SERVICE_ACCOUNT_FILE=<path to key.json>   (or GA4_SERVICE_ACCOUNT_JSON=<json>)
 */

require('dotenv').config();
const { isGa4Configured, getGa4Windows, ga4RunReport } = require('./lib/ga4');
const { getSkuIndex } = require('./lib/recoSignals');

const fail = (msg, hint) => {
  console.log('\n  FAILED: ' + msg);
  if (hint) console.log('  -> ' + hint);
  process.exit(1);
};

(async () => {
  console.log('\nGA4 connection check');
  console.log('--------------------');

  const propertyId = process.env.GA4_PROPERTY_ID;
  console.log('  Property ID          : ' + (propertyId || 'MISSING'));
  if (!propertyId) fail('GA4_PROPERTY_ID is not set in .env');

  const hasJson = Boolean(process.env.GA4_SERVICE_ACCOUNT_JSON);
  const hasFile = Boolean(process.env.GA4_SERVICE_ACCOUNT_FILE);
  console.log('  Service account      : ' + (hasFile ? 'from file' : hasJson ? 'from inline JSON' : 'MISSING'));

  if (!isGa4Configured()) {
    fail(
      'service-account credentials are missing or unreadable',
      'Create a service account in Google Cloud, download its JSON key, then set ' +
      'GA4_SERVICE_ACCOUNT_FILE to that path in .env (see secrets/ — already gitignored).'
    );
  }

  // Print the identity so the GA4 access grant can be verified against it.
  try {
    const sa = process.env.GA4_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON)
      : JSON.parse(require('fs').readFileSync(process.env.GA4_SERVICE_ACCOUNT_FILE, 'utf8'));
    console.log('  Service account email: ' + sa.client_email);
    console.log('  (this email must have Viewer access on GA4 property ' + propertyId + ')');
  } catch (err) {
    fail('service-account key file could not be parsed: ' + err.message);
  }

  // Probe first with the raw call so the REAL error survives — getGa4Windows
  // swallows it and returns null by design (the engine must never break when
  // GA4 is down), which would otherwise leave us guessing at the cause.
  console.log('\n  Querying GA4 items report...');
  try {
    await ga4RunReport({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'itemId' }],
      metrics: [{ name: 'itemsViewed' }],
      limit: 1
    });
  } catch (err) {
    const msg = String(err.message || '');
    if (/invalid_grant|Invalid JWT Signature/i.test(msg)) {
      fail(
        'the key in secrets/ga4-service-account.json is no longer valid',
        'This key was deleted in Google Cloud (a rotation). Download the CURRENT key ' +
        'from IAM & Admin -> Service Accounts -> lucira-reco-ga4 -> Keys, and save it over ' +
        'secrets/ga4-service-account.json. No .env or code change needed.'
      );
    }
    if (/PERMISSION_DENIED|sufficient permissions/i.test(msg)) {
      fail(
        'the service account cannot read this GA4 property',
        'Add ' + (process.env.GA4_SERVICE_ACCOUNT_FILE ? 'its client_email' : 'the service account') +
        ' as Viewer: GA4 Admin -> Property access management (property ' + propertyId + ').'
      );
    }
    if (/SERVICE_DISABLED|has not been used in project/i.test(msg)) {
      fail(
        'the Google Analytics Data API is not enabled in the Cloud project',
        'Enable it at console.cloud.google.com/apis/library/analyticsdata.googleapis.com (project lucirajewelry-prod).'
      );
    }
    fail('GA4 request failed: ' + msg.slice(0, 300));
  }

  console.log('  Auth OK — GA4 accepted the key.');

  // Only now pay for the index: GA4's dominant item_id on this store is the
  // variant SKU, so views cannot be attributed to products without it. This
  // is a full catalogue scan (~5 min) — never run it before auth is proven.
  console.log('\n  Building SKU index (GA4 sends variant SKUs as item_id, ~5 min)...');
  const skuIndex = await getSkuIndex();
  console.log('  SKU index: ' + skuIndex.size + ' variant SKUs');

  const windows = await getGa4Windows(skuIndex);
  if (!windows) fail('GA4 returned no data (see the [GA4] error above)');

  const d30 = windows.d30;
  console.log('  OK — products with GA4 activity in the last 30 days: ' + d30.size);

  if (d30.size === 0) {
    console.log('\n  WARNING: connected to GA4, but ZERO item rows came back.');
    console.log('  Diagnosing what GA4 actually receives...');
    try {
      const ev = await ga4RunReport({
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        limit: 25
      });
      const rows = (ev.rows || []).map((r) => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]);
      if (rows.length === 0) {
        console.log('  -> This property received NO events at all in 30 days.');
        console.log('     Double-check the property id (478308692) is the one GTM sends to.');
      } else {
        console.log('\n  Events GA4 is receiving (30d):');
        for (const [name, count] of rows) console.log('    ' + name.padEnd(28) + count);
        const names = rows.map((r) => r[0]);
        const standard = ['view_item', 'add_to_cart', 'purchase'].filter((n) => names.includes(n));
        console.log('');
        if (standard.length === 0) {
          console.log('  -> GA4 is receiving events, but none of the standard ecommerce ones');
          console.log('     (view_item / add_to_cart / purchase). Item-scoped metrics exist only');
          console.log('     for those. The dataLayer pushes custom names (productView, addToCart)');
          console.log('     with a "products" array, so the GTM container must map them to GA4');
          console.log('     ecommerce events with an "items" array where item_id is the numeric');
          console.log('     Shopify product id (gtm.js already computes exactly that).');
        } else {
          console.log('  -> Standard events present: ' + standard.join(', '));
          console.log('     They fire but carry no items[] with item_id — fix that mapping in the');
          console.log('     GTM tag and item metrics will populate.');
        }
        console.log('     Until then the engine keeps using the first-party beacon (already live).');
      }
    } catch (err) {
      console.log('  -> Diagnostic failed: ' + err.message);
    }
    process.exit(0);
  }

  const top = [...d30.entries()].sort((a, b) => b[1].views - a[1].views).slice(0, 5);
  console.log('\n  Top 5 by views (30d):');
  for (const [pid, m] of top) {
    console.log(
      '    ' + pid.padEnd(16) +
      ' views ' + String(m.views).padStart(6) +
      ' | atc ' + String(m.atc).padStart(5) +
      ' | atc rate ' + (m.views > 0 ? ((m.atc / m.views) * 100).toFixed(1) + '%' : '-').padStart(6)
    );
  }

  console.log('\n  The recommendation engine will now use GA4 for views and add-to-carts.');
  console.log('  Restart the backend for it to pick this up.\n');
  process.exit(0);
})().catch((err) => fail(err.message));
