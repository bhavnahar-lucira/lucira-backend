/**
 * Server-only: print a website (ECommSales, document 77) invoice from
 * Ornaverse as a PDF, for the customer's "Download Invoice" button.
 *
 * Why a cookie session and not the bearer token in lib/ornaverse.js:
 * Ornaverse's ~/Print/Render (FastReport) does not accept the OAuth bearer
 * token — on LIVE it 302s to /Account/Login. It only works with a real
 * ASP.NET cookie session, the same one Ornaverse's own web client and the
 * Lucira POS use. So this logs in with ORN_USERNAME / ORN_PASSWORD (the
 * account must have 2FA disabled), keeps the cookie jar in memory, and
 * logs in again by itself when Ornaverse expires it.
 *
 * Flow (same calls as the POS's InvoiceReportButton, then one more):
 *   POST /Print/Render {key, opt:{transaction_id}, reportFile, reportFolder}
 *        → FastReport viewer HTML carrying a reportId
 *   GET  /_fr/preview.exportReport?reportId=…&exportFormat=pdf
 *        → the finished PDF (every page)
 *
 * The cookie session never leaves this server: customers only ever get
 * the finished PDF bytes.
 */

const { ornaverseFetch } = require('./ornaverse');

const ECOMM_SALES_DOCUMENT_ID = 77;
const INVOICE_REPORT_KEY = 'MarketPlace.MarketPlaceInvoice';
// 109 = "New Invoice Format" (Common/MarketPlace_Invoice With Header.frx) on LIVE.
const DEFAULT_REPORT_ID = 109;
const REPORT_CACHE_MS = 60 * 60 * 1000;
// Per Ornaverse call. A render + PDF export takes ~1-2s on LIVE; this only
// bounds a hung connection so a customer's request can't sit for minutes.
const FETCH_TIMEOUT_MS = 20 * 1000;

function baseUrl() {
  const explicit = process.env.ORN_PRINT_BASE_URL;
  const fromToken = (process.env.ORN_TOKEN_URL || '').replace(/\/connect\/token\/?$/, '');
  return (explicit || fromToken).replace(/\/+$/, '');
}

// ── Cookie jar helpers ──────────────────────────────────────────────────────

function parseSetCookies(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const pairs = new Map();
  let csrf = null;
  for (const entry of raw) {
    for (const chunk of String(entry).split(/,(?=[^;=]+?=)/)) {
      const pair = chunk.split(';')[0].trim();
      if (!pair || !pair.includes('=')) continue;
      const [name, ...rest] = pair.split('=');
      pairs.set(name.trim(), pair);
      if (name.trim() === 'CSRF-TOKEN') csrf = rest.join('=');
    }
  }
  return { pairs, csrf };
}

function withTimeout(options = {}) {
  return { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' };
}

// ── Session ─────────────────────────────────────────────────────────────────

let session = null;      // { jar: Map, csrf, at }
let loginInFlight = null; // de-dupes concurrent logins

async function login() {
  const { ORN_USERNAME, ORN_PASSWORD } = process.env;
  if (!ORN_USERNAME || !ORN_PASSWORD) {
    throw new Error('Ornaverse print login missing (ORN_USERNAME / ORN_PASSWORD).');
  }
  const base = baseUrl();

  // 1. Login page → antiforgery cookie + CSRF token (a bare POST 400s).
  const page = await fetch(`${base}/Account/Login`, withTimeout({ method: 'GET' }));
  const { pairs: pagePairs, csrf: pageCsrf } = parseSetCookies(page);

  // 2. JSON login, same contract as Ornaverse's own LoginPage.js.
  const res = await fetch(`${base}/Account/Login`, withTimeout({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: [...pagePairs.values()].join('; '),
      ...(pageCsrf ? { 'X-CSRF-TOKEN': pageCsrf } : {}),
    },
    body: JSON.stringify({ username: ORN_USERNAME, password: ORN_PASSWORD }),
  }));
  const { pairs: authPairs, csrf: authCsrf } = parseSetCookies(res);
  if (authPairs.size === 0) {
    let detail = '';
    try { const body = await res.json(); detail = body?.Error?.Message || body?.Error?.Code || ''; } catch { /* empty body */ }
    throw new Error(`Ornaverse print login failed${detail ? ': ' + detail : ''} (HTTP ${res.status}).`);
  }

  const jar = new Map(pagePairs);
  for (const [k, v] of authPairs) jar.set(k, v);

  // 3. The pre-login CSRF pair is bound to the anonymous identity — fetch a
  //    fresh one with the auth cookies attached, or Print/Render 400s.
  const authed = await fetch(`${base}/`, withTimeout({
    method: 'GET',
    headers: { Cookie: [...jar.values()].join('; ') },
  }));
  const { pairs: authedPairs, csrf: authedCsrf } = parseSetCookies(authed);
  for (const [k, v] of authedPairs) jar.set(k, v);

  session = { jar, csrf: authedCsrf || authCsrf || pageCsrf || null, at: Date.now() };
  return session;
}

// Ornaverse's cookies carry no expiry of their own and it ends idle sessions
// server-side, so don't trust a jar older than this — logging in again is
// ~0.5s and saves the customer's first click from hitting a dead session.
const SESSION_MAX_AGE_MS = 15 * 60 * 1000;

async function getSession(forceNew = false) {
  if (session && !forceNew && Date.now() - session.at < SESSION_MAX_AGE_MS) return session;
  if (!loginInFlight) {
    loginInFlight = login().finally(() => { loginInFlight = null; });
  }
  return loginInFlight;
}

function isLoggedOut(res, text) {
  const location = res.headers.get('location') || '';
  if (res.status >= 300 && res.status < 400 && /\/Account\/Login/i.test(location)) return true;
  if (res.status === 401) return true;
  // Confirmed on LIVE (12 Nov 2026): once the auth ticket has expired,
  // Print/Render does NOT redirect to the login page — the antiforgery check
  // runs first and answers 400 with an EMPTY body (same as a stale CSRF
  // token). Treat that as "session gone" so we log in again, instead of
  // failing every download until the backend restarts.
  if (res.status === 400 && typeof text === 'string' && text.trim() === '') return true;
  return typeof text === 'string' && /<title>\s*Login to your account\s*<\/title>/i.test(text);
}

/** Fetch with the cookie session; logs in again once if Ornaverse expired it. */
async function sessionFetch(path, options = {}, { binary = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const res = await fetch(`${baseUrl()}${path}`, withTimeout({
      ...options,
      headers: {
        ...(options.headers || {}),
        Cookie: [...s.jar.values()].join('; '),
        ...(s.csrf ? { 'X-CSRF-TOKEN': s.csrf } : {}),
      },
    }));
    // Keep any cookies Ornaverse rotates (sliding expiry).
    const { pairs, csrf } = parseSetCookies(res);
    for (const [k, v] of pairs) s.jar.set(k, v);
    if (csrf) s.csrf = csrf;

    const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    const text = binary ? (body.length < 4096 ? body.toString('utf8') : '') : body;
    if (isLoggedOut(res, text)) {
      session = null;
      if (attempt === 0) continue;
      throw new Error('Ornaverse print session was rejected after a fresh login.');
    }
    return { res, body };
  }
  throw new Error('Ornaverse print session unavailable.');
}

// ── Report format ───────────────────────────────────────────────────────────

let reportCache = { at: 0, report: null };

async function getInvoiceReport() {
  if (reportCache.report && Date.now() - reportCache.at < REPORT_CACHE_MS) return reportCache.report;
  const wantedId = Number(process.env.ORN_WEB_INVOICE_REPORT_ID) || DEFAULT_REPORT_ID;
  const data = await ornaverseFetch('/Services/Administration/DocumentReports/List', 'POST', {
    document_id: ECOMM_SALES_DOCUMENT_ID,
    is_disabled: false,
  });
  const reports = data?.Entities || [];
  const report = reports.find((r) => Number(r.report_id) === wantedId)
    || reports.find((r) => r.report_key === INVOICE_REPORT_KEY && /invoice/i.test(r.report_name || ''));
  if (!report) throw new Error(`No invoice print format configured for document ${ECOMM_SALES_DOCUMENT_ID}.`);
  reportCache = { at: Date.now(), report };
  return report;
}

// ── Invoice lookup ──────────────────────────────────────────────────────────

/**
 * Posted, non-cancelled website invoices for one Shopify order.
 * document_status 1 = active; 2 = cancelled (each cancelled one on LIVE has
 * a status-1 replacement). Matches marketplace_order_id (the Shopify order
 * id) first, then falls back to marketplace_order_no (the Shopify order
 * number) for the older invoices that were created without the id. An
 * order number alone is weak proof, so such a match must also agree with the
 * Shopify order total (within 1%) before it is offered to the customer.
 */
async function findInvoicesForOrder({ shopifyOrderId, orderNumber, orderTotal }) {
  const list = async (filter) => {
    const data = await ornaverseFetch('/Services/MarketPlace/Invoice/List', 'POST', {
      Take: 20,
      Skip: 0,
      EqualityFilter: filter,
    });
    return data?.Entities || [];
  };

  let rows = shopifyOrderId ? await list({ marketplace_order_id: Number(shopifyOrderId) }) : [];
  if (rows.length === 0 && orderNumber) {
    const total = Number(orderTotal);
    rows = (await list({ marketplace_order_no: String(orderNumber) }))
      .filter((r) => !r.marketplace_order_id || String(r.marketplace_order_id) === String(shopifyOrderId))
      .filter((r) => Number.isFinite(total) && total > 0
        && Math.abs(Number(r.net_amount) - total) <= Math.max(2, total * 0.01));
  }

  return rows
    .filter((r) => Number(r.document_status) === 1)
    .map((r) => ({
      transactionId: r.transaction_id,
      documentNo: r.document_no,
      documentDate: r.document_date,
      netAmount: r.net_amount,
    }))
    .sort((a, b) => new Date(b.documentDate) - new Date(a.documentDate));
}

/**
 * Batch version for the orders list: ONE Ornaverse call for up to ~20 Shopify
 * order ids (`marketplace_order_id IN [...]`, ~150ms on LIVE). Returns a Map of
 * String(shopifyOrderId) → { documentNo, documentDate } for the latest posted,
 * non-cancelled invoice. Only exact id matches — the legacy order-number
 * fallback stays on the single-order lookup above.
 */
async function findInvoicesForOrders(shopifyOrderIds) {
  const ids = [...new Set((shopifyOrderIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const result = new Map();
  if (ids.length === 0) return result;

  const data = await ornaverseFetch('/Services/MarketPlace/Invoice/List', 'POST', {
    Take: Math.min(ids.length * 3, 200),
    Skip: 0,
    Criteria: [['marketplace_order_id'], 'in', [ids]],
  });
  for (const r of data?.Entities || []) {
    if (Number(r.document_status) !== 1 || !r.marketplace_order_id) continue;
    const key = String(r.marketplace_order_id);
    const prev = result.get(key);
    if (!prev || new Date(r.document_date) > new Date(prev.documentDate)) {
      result.set(key, { documentNo: r.document_no, documentDate: r.document_date });
    }
  }
  return result;
}

// ── Render ──────────────────────────────────────────────────────────────────

/** Renders one ECommSales invoice and returns the PDF as a Buffer. */
async function renderInvoicePdf(transactionId) {
  const report = await getInvoiceReport();

  const { res, body: html } = await sessionFetch('/Print/Render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      key: report.report_key || INVOICE_REPORT_KEY,
      opt: JSON.stringify({ transaction_id: Number(transactionId) }),
      reportFile: report.report_file || '',
      reportFolder: report.report_folder || '',
      reportSubFolder: report.report_sub_folder || '',
    }).toString(),
  });

  if (html.trim() === 'An error occurred while generating the report') {
    throw new Error('Ornaverse could not generate this invoice (template error).');
  }
  if (res.status >= 400) throw new Error(`Ornaverse Print/Render failed (HTTP ${res.status}).`);

  const reportId = (html.match(/reportId=([0-9a-f]+)/) || [])[1];
  if (!reportId) throw new Error('Ornaverse Print/Render returned no report id.');

  const { res: pdfRes, body: pdf } = await sessionFetch(
    `/_fr/preview.exportReport?reportId=${reportId}&exportFormat=pdf`,
    { method: 'GET' },
    { binary: true },
  );
  if (pdfRes.status !== 200 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`Ornaverse PDF export failed (HTTP ${pdfRes.status}).`);
  }
  return pdf;
}

module.exports = {
  findInvoicesForOrder,
  findInvoicesForOrders,
  renderInvoicePdf,
  getInvoiceReport,
};
