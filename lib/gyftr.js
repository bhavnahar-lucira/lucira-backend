/**
 * GyFTR EPAY merchant API client.
 *
 * Encryption follows section 15 of the GyFTR_EPay_Merchant_API manual:
 * AES-256-GCM, output format `iv.encryptedData.authTag` (each base64), 12-byte IV.
 *
 * Base URL and endpoint names are as given directly by Aakash (21 Aug 2026):
 * https://brandpts.gyftr.net/api/merchant-services/<endpointName>, exact
 * casing (e.g. "getWalletBalance", "generateOtp") — no guessing this time.
 */

const crypto = require('crypto');

const BASE_URL = (process.env.GYFTR_BASE_URL || '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.GYFTR_API_KEY || '').trim();
const ACCESS_KEY = (process.env.GYFTR_ACCESS_KEY || '').trim();
const SECRET_KEY = (process.env.GYFTR_SECRET_KEY || '').trim();
const MID = (process.env.GYFTR_MID || '').trim();
const TID = (process.env.GYFTR_TID || '').trim();
const CATEGORY = (process.env.GYFTR_CATEGORY || '').trim();

// Manual section 19 FAQ: average response time 5-7s, max 30s.
const REQUEST_TIMEOUT_MS = 30000;

// The manual (section 16) documents "200" as the success code. GyFTR's
// staging server was observed live returning "00" for a real SUCCESS
// response on 24 Aug 2026, so this was pinned to '00' — but on 9 Sep 2026 a
// genuine {CODE:'200', MESSAGE:'SUCCESS.'} generateOtp response came back
// (and was being misreported as a failure under the '00'-only check).
// GyFTR's success code isn't stable/predictable for this account, so both
// observed values are now accepted rather than betting on just one again.
const RESPONSE_CODE_SUCCESS_VALUES = new Set(['00', '200']);

class GyftrConfigError extends Error {}
class GyftrApiError extends Error {
  constructor(message, { code, raw } = {}) {
    super(message);
    this.name = 'GyftrApiError';
    this.code = code;
    this.raw = raw;
  }
}

function assertConfigured() {
  if (!BASE_URL || !API_KEY || !ACCESS_KEY || !SECRET_KEY || !MID || !TID) {
    throw new GyftrConfigError('GyFTR credentials are not fully configured (check GYFTR_* env vars)');
  }
}

/** AES-256-GCM encrypt, per manual 15.2. */
function encryptPayload(payload) {
  const key = Buffer.from(SECRET_KEY, 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag().toString('base64');

  return [iv.toString('base64'), encrypted, authTag].join('.');
}

/** AES-256-GCM decrypt, per manual 15.4. */
function decryptPayload(encPayload) {
  const key = Buffer.from(SECRET_KEY, 'utf8');
  const [ivB64, data, tagB64] = String(encPayload || '').split('.');
  if (!ivB64 || !data || !tagB64) {
    throw new GyftrApiError('Malformed encrypted response from GyFTR');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  let decrypted = decipher.update(data, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

/**
 * Calls a GyFTR endpoint (exact-cased resource name, e.g. "getWalletBalance")
 * with an already-built plain payload object. Encrypts the request, decrypts
 * the response, and returns the decrypted JSON body (which still carries
 * GyFTR's own CODE/MESSAGE fields).
 */
async function callGyftr(endpointName, payload) {
  assertConfigured();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const url = `${BASE_URL}/${endpointName}`;
  const headers = {
    'Content-Type': 'application/json',
    'api-key': API_KEY,
    'access-key': ACCESS_KEY,
  };
  const encryptedData = encryptPayload(payload);
  console.log(`[gyftr] -> POST ${url}`);
  console.log('[gyftr] -> headers:', headers);
  console.log('[gyftr] -> plain payload (pre-encryption):', payload);
  // CATEGORY-bearing fields called out explicitly, on top of the full
  // payload dump above — whichever of these the endpoint actually carries
  // (CATEGORY for generateOtp/getWalletBalance/loadWallet/rechargeWallet,
  // AMOUNT_DETAILS for walletRedemption, REFUND_DETAILS for refunds).
  const categoryFields = {
    ...(payload.CATEGORY !== undefined ? { CATEGORY: payload.CATEGORY } : {}),
    ...(payload.AMOUNT_DETAILS !== undefined ? { AMOUNT_DETAILS: payload.AMOUNT_DETAILS } : {}),
    ...(payload.REFUND_DETAILS !== undefined ? { REFUND_DETAILS: payload.REFUND_DETAILS } : {}),
  };
  console.log(`[gyftr] -> category fields for ${endpointName}:`, Object.keys(categoryFields).length ? categoryFields : '(none on this endpoint)');
  console.log('[gyftr] -> encrypted payload:', encryptedData);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: encryptedData }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new GyftrApiError(`GyFTR request to ${endpointName} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new GyftrApiError(`GyFTR request to ${endpointName} failed: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  console.log(`[gyftr] <- HTTP ${res.status} ${res.statusText}`);
  console.log('[gyftr] <- response headers:', Object.fromEntries(res.headers.entries()));

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new GyftrApiError(`GyFTR returned a non-JSON response (HTTP ${res.status})`);
  }

  console.log('[gyftr] <- raw response body:', body);

  // Manual section 18: timeouts/validation failures can come back as plain
  // {CODE, MESSAGE} instead of an encrypted "data" envelope.
  const decrypted = body?.data ? decryptPayload(body.data) : body;

  console.log('[gyftr] <- decrypted/final response body:', decrypted);

  if (!RESPONSE_CODE_SUCCESS_VALUES.has(decrypted.CODE)) {
    throw new GyftrApiError(decrypted.MESSAGE || `GyFTR error (code ${decrypted.CODE})`, {
      code: decrypted.CODE,
      raw: decrypted,
    });
  }

  return decrypted;
}

module.exports = {
  MID,
  TID,
  CATEGORY,
  callGyftr,
  encryptPayload,
  decryptPayload,
  GyftrConfigError,
  GyftrApiError,
};
