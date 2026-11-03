/**
 * OptiPhoenix — the Convert.com experiment log on the customer record.
 *
 * Convert (loaded via GTM, production only) keeps the visitor's experiments in
 * localStorage conv_zoho_exp_log. The frontend sends that value in the body of
 * the requests where we already know who the customer is — login, register,
 * checkout — the same way UTMs ride along (see normalizeUtms in
 * routes/checkout.js). It lands on the custom.optiphoenix JSON metafield.
 */

const { shopifyAdminFetch } = require('./shopify');

const MAX_LENGTH = 60000;

// Accept the parsed object or its raw localStorage string. Anything else, or
// anything oversized, is dropped so a crafted body can't write junk.
function normalizeConvExpLog(raw) {
  let log = raw;
  if (typeof log === 'string') {
    try {
      log = JSON.parse(log);
    } catch (_) {
      return null;
    }
  }
  if (!log || typeof log !== 'object' || Array.isArray(log)) return null;
  if (Object.keys(log).length === 0) return null;
  const value = JSON.stringify(log);
  return value.length > MAX_LENGTH ? null : value;
}

// Best-effort: never throws, so callers (login, checkout) can fire and forget.
async function saveOptiPhoenix(customerId, raw) {
  const value = normalizeConvExpLog(raw);
  if (!value || !customerId) return false;

  const ownerId = String(customerId).startsWith('gid://')
    ? String(customerId)
    : `gid://shopify/Customer/${customerId}`;

  try {
    const data = await shopifyAdminFetch(`
      mutation setOptiPhoenix($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `, {
      metafields: [{ ownerId, namespace: 'custom', key: 'optiphoenix', type: 'json', value }],
    });

    const userErrors = data?.metafieldsSet?.userErrors || [];
    if (userErrors.length) {
      console.error('[optiphoenix] metafieldsSet rejected:', userErrors);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[optiphoenix] Failed to save experiment log:', err.message);
    return false;
  }
}

module.exports = { normalizeConvExpLog, saveOptiPhoenix };
