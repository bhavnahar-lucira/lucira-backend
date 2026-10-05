/**
 * GyFTR EPAY gift-card routes (Fastify).
 *
 * Thin proxy in front of lib/gyftr.js — MID/TID/keys/secret/category never
 * leave the server. The frontend only ever sees mobile numbers, OTPs, and
 * plain figures out of the decrypted GyFTR response.
 *
 * All 7 endpoints from the manual are implemented:
 *   generateOtp, getWalletBalance, loadWallet, rechargeWallet,
 *   walletRedemption, refunds, getWalletTxnStatus
 *
 * walletRedemption and refunds are intentionally NOT wired into any
 * frontend button yet:
 *  - refunds: the manual itself (section 13) says the reversal feature
 *    "should not be enabled/given on billing machine to avoid fraud from
 *    operations point of view" — this must stay an admin/server-side-only
 *    operation, never a customer-facing control.
 *  - walletRedemption: actually debiting a customer's gift card has to be
 *    tied into the real order-completion pipeline (routes/checkout.js's
 *    price re-verification), not fired standalone from a UI button — see
 *    project memory for the full reasoning.
 * Both routes exist and work; nothing currently calls them from a browser.
 */

const crypto = require('crypto');
const { MID, TID, callGyftr, GyftrConfigError, GyftrApiError } = require('../../lib/gyftr');
const { repriceItems } = require('../../lib/cartPricing');
const { computeGyftrCategoryBreakdown } = require('../../lib/gyftrCategory');

const DEFAULT_SOURCE = 'W'; // Website — this integration doesn't cover POS.

// Lucira's 3 wallet categories (architecture decision, 20 Aug 2026) — passed
// as-is to GyFTR's CATEGORY param, comma-separated per manual section 9.1.
// Used as the fallback when no cart is supplied (see resolveCartCategories).
const WALLET_CATEGORIES = 'DIAMOND_JEWELLERY,PLAIN_JEWELLERY,GOLD_COINS';
const ALL_CATEGORIES = WALLET_CATEGORIES.split(',');

function normalizeMobile(mobile = '') {
  return String(mobile || '').replace(/\D/g, '').slice(-10);
}

/**
 * Restricts the CATEGORY value sent to GyFTR down to only the categories
 * actually present in the current cart (9 Sep 2026 request) — e.g. a cart
 * with only a gold coin should only ever send CATEGORY=GOLD_COINS, not all
 * 3. Classifies via the same ornaverse.material_type rules used everywhere
 * else in this integration (lib/gyftrCategory.js), after re-pricing the
 * items to attach materialType/productType (lib/cartPricing.js).
 *
 * Falls back to all 3 categories when no cart is given, or when nothing in
 * it classifies — never silently sends an empty CATEGORY.
 */
async function resolveCartCategories(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { categories: ALL_CATEGORIES, source: 'fallback-no-cart' };
  }
  const { items: repricedItems } = await repriceItems(items);
  const breakdown = computeGyftrCategoryBreakdown(repricedItems);
  const present = ALL_CATEGORIES.filter((cat) => breakdown[cat] > 0);
  if (present.length === 0) {
    return { categories: ALL_CATEGORIES, source: 'fallback-unclassified-cart' };
  }
  return { categories: present, source: 'cart' };
}

// Alphanumeric, well under the manual's 55-char PORDERID cap (section 17).
function generatePorderId() {
  return `LJ${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
}

function handleGyftrError(err, reply, extra = {}) {
  if (err instanceof GyftrConfigError) {
    console.error('[gyftr]', err.message);
    return reply.code(500).send({ error: 'GyFTR is not configured on this server', ...extra });
  }
  if (err instanceof GyftrApiError) {
    return reply.code(err.code ? 422 : 502).send({
      error: err.message,
      gyftrCode: err.code || null,
      ...extra,
    });
  }
  return reply.code(500).send({ error: err.message || 'Unexpected GyFTR error', ...extra });
}

async function routes(fastify, options) {
  // POST /api/gyftr/generate-otp  { mobile }
  fastify.post('/generate-otp', async (request, reply) => {
    try {
      const mobile = normalizeMobile(request.body?.mobile);
      if (mobile.length !== 10) {
        return reply.code(400).send({ error: 'A valid 10-digit mobile number is required' });
      }

      const requestPayload = {
        MOBILE: mobile,
        MID,
        TID,
        SOURCE: DEFAULT_SOURCE,
      };
      try {
        const result = await callGyftr('generateOtp', requestPayload);
        return { success: true, message: result.MESSAGE, debugRequestPayload: requestPayload };
      } catch (err) {
        return handleGyftrError(err, reply, { debugRequestPayload: requestPayload });
      }
    } catch (err) {
      return handleGyftrError(err, reply);
    }
  });

  // POST /api/gyftr/balance  { mobile, otp? }
  //
  // OTP is optional per explicit request (25 Aug 2026) — the manual
  // (section 9.1) marks OTP as Required, but GyFTR's live server accepts
  // an empty OTP for this MID.
  fastify.post('/balance', async (request, reply) => {
    try {
      const mobile = normalizeMobile(request.body?.mobile);
      const otp = String(request.body?.otp || '').trim();
      if (mobile.length !== 10) {
        return reply.code(400).send({ error: 'A valid 10-digit mobile number is required' });
      }

      // Balance intentionally shows ALL 3 categories always (9 Sep 2026),
      // unlike loadWallet/rechargeWallet which restrict CATEGORY to what's
      // actually in the cart — a balance check should show everything the
      // customer has, not just what they're about to buy right now.
      const categories = ALL_CATEGORIES;
      console.log(`[gyftr] getWalletBalance categories: ${categories.join(',')} (always all 3)`);

      const requestPayload = {
        MOBILE: mobile,
        MID,
        TID,
        SOURCE: DEFAULT_SOURCE,
        OTP: otp,
        CATEGORY: categories.join(','),
      };
      try {
        const result = await callGyftr('getWalletBalance', requestPayload);
        const totalBalance = Number(result.TOTAL_BALANCE ?? result.BALANCE ?? 0);

        // Real per-category balance, straight from GyFTR itself — one call
        // per category (each queried individually; re-verified 4 Sep 2026
        // that this isn't a comma-parsing quirk). Whatever GyFTR actually
        // answers is used as-is, including 0 — no estimation. Sequenced
        // after the total call (not fired concurrently with it) to stay
        // under the manual's 3 req/sec cap (section 18).
        const categorySettled = await Promise.allSettled(
          categories.map((cat) => callGyftr('getWalletBalance', { ...requestPayload, CATEGORY: cat }))
        );

        const balanceDetails = categories.map((cat, i) => {
          const settled = categorySettled[i];
          if (settled.status === 'rejected') {
            console.warn(`[gyftr] getWalletBalance CATEGORY=${cat} failed: ${settled.reason?.message}`);
            return { CATEGORY: cat, BALANCE: '0.00' };
          }
          const catBalance = Number(settled.value.TOTAL_BALANCE ?? settled.value.BALANCE ?? 0);
          return { CATEGORY: cat, BALANCE: catBalance.toFixed(2) };
        });

        console.log(`[gyftr] getWalletBalance real per-category balance: ${JSON.stringify(balanceDetails)}`);

        return {
          success: true,
          totalBalance,
          balanceDetails,
          debugRequestPayload: requestPayload,
          debugRawGyftrResponse: result,
        };
      } catch (err) {
        return handleGyftrError(err, reply, { debugRequestPayload: requestPayload });
      }
    } catch (err) {
      return handleGyftrError(err, reply);
    }
  });

  // POST /api/gyftr/vouchers  { mobile, otp }
  // loadWallet — list vouchers mapped to a mobile number. Manual section 10:
  // OTP is required here (unlike balance, we haven't seen this one accept
  // an empty OTP live yet).
  fastify.post('/vouchers', async (request, reply) => {
    try {
      const mobile = normalizeMobile(request.body?.mobile);
      const otp = String(request.body?.otp || '').trim();
      if (mobile.length !== 10 || !otp) {
        return reply.code(400).send({ error: 'mobile and otp are required' });
      }

      const { categories, source: categorySource } = await resolveCartCategories(request.body?.items);
      const requestPayload = {
        MOBILE: mobile,
        MID,
        TID,
        OTP: otp,
        SOURCE: DEFAULT_SOURCE,
        CATEGORY: categories.join(','),
      };
      console.log(`[gyftr] loadWallet categories resolved from ${categorySource}: ${categories.join(',')}`);
      try {
        const result = await callGyftr('loadWallet', requestPayload);
        return {
          success: true,
          vouchers: result.VOUCHERDATA || [],
          debugRequestPayload: requestPayload,
          debugRawGyftrResponse: result,
        };
      } catch (err) {
        return handleGyftrError(err, reply, { debugRequestPayload: requestPayload });
      }
    } catch (err) {
      return handleGyftrError(err, reply);
    }
  });

  // POST /api/gyftr/recharge  { mobile, voucherNumber, voucherType? }
  // rechargeWallet — add a voucher's value into the customer's ePay balance.
  // Manual section 11: does NOT list OTP as a param, so none is sent.
  fastify.post('/recharge', async (request, reply) => {
    try {
      const mobile = normalizeMobile(request.body?.mobile);
      const voucherNumber = String(request.body?.voucherNumber || '').trim();
      const voucherType = request.body?.voucherType === 'E' ? 'E' : 'P'; // P=Plain, E=Encrypted

      if (mobile.length !== 10 || !voucherNumber) {
        return reply.code(400).send({ error: 'mobile and voucherNumber are required' });
      }

      const porderId = generatePorderId();
      const { categories, source: categorySource } = await resolveCartCategories(request.body?.items);
      const requestPayload = {
        MOBILE: mobile,
        MID,
        TID,
        PORDERID: porderId,
        VOUCHERNUMBER: voucherNumber,
        VOUCHERTYPE: voucherType,
        SOURCE: DEFAULT_SOURCE,
        CATEGORY: categories.join(','),
      };
      console.log(`[gyftr] rechargeWallet categories resolved from ${categorySource}: ${categories.join(',')}`);
      try {
        const result = await callGyftr('rechargeWallet', requestPayload);
        return {
          success: true,
          porderId,
          txnId: result.TXNID,
          balance: Number(result.BALANCE || 0),
          balanceDetails: result.BALANCE_DETAILS || [],
          debugRequestPayload: requestPayload,
          debugRawGyftrResponse: result,
        };
      } catch (err) {
        return handleGyftrError(err, reply, { debugRequestPayload: requestPayload, porderId });
      }
    } catch (err) {
      return handleGyftrError(err, reply);
    }
  });

  // POST /api/gyftr/redeem  { mobile, otp, amount, billNo, billValue, amountDetails: [{category, amount}] }
  //
  // NOT called from any frontend button — see file header. Exists so the
  // real order-completion flow can call it once that integration is built.
  // Manual note (section 12): uniqueness is MID+PORDERID — retries on
  // timeout must reuse the same porderId (pass it back in) rather than
  // minting a new one, and use /status to check what actually happened.
  fastify.post('/redeem', async (request, reply) => {
    try {
      const mobile = normalizeMobile(request.body?.mobile);
      const otp = String(request.body?.otp || '').trim();
      const amount = Number(request.body?.amount || 0);
      const billNo = String(request.body?.billNo || '').trim();
      const billValue = Number(request.body?.billValue || 0);
      const amountDetails = Array.isArray(request.body?.amountDetails) ? request.body.amountDetails : [];
      const porderId = String(request.body?.porderId || '').trim() || generatePorderId();

      if (mobile.length !== 10 || amount <= 0 || !billNo || billValue <= 0 || amountDetails.length === 0) {
        return reply.code(400).send({ error: 'mobile, amount, billNo, billValue and amountDetails are required' });
      }

      const requestPayload = {
        MOBILE: mobile,
        MID,
        TID,
        PORDERID: porderId,
        AMOUNT: amount.toFixed(2),
        AMOUNT_DETAILS: amountDetails.map((d) => ({
          CATEGORY: d.category,
          AMOUNT: Number(d.amount || 0).toFixed(2),
        })),
        OTP: otp,
        SOURCE: DEFAULT_SOURCE,
        BILLNO: billNo,
        BILLVALUE: billValue.toFixed(2),
      };
      console.log(`[gyftr] walletRedemption AMOUNT_DETAILS: ${JSON.stringify(requestPayload.AMOUNT_DETAILS)}`);
      try {
        const result = await callGyftr('walletRedemption', requestPayload);
        return {
          success: true,
          porderId,
          txnId: result.TXNID,
          txnDate: result.TXNDATE,
          availableBalance: Number(result.AVAILABLE_BALANCE ?? result.BALANCE ?? 0),
          amountDetails: result.AMOUNT_DETAILS || [],
          debugRequestPayload: requestPayload,
          debugRawGyftrResponse: result,
        };
      } catch (err) {
        // Always hand back porderId on failure — the caller needs it to
        // poll /status if this was a timeout, per the manual's mandate.
        return handleGyftrError(err, reply, { debugRequestPayload: requestPayload, porderId });
      }
    } catch (err) {
      return handleGyftrError(err, reply);
    }
  });

  // POST /api/gyftr/refund  { drTxnId?, drOrderId?, amount, actionType?, mobile?, billNo?, billValue?, desc?, refundDetails: [{category, amount}] }
  //
  // NOT called from any frontend button — see file header. Admin/server-side
  // use only. actionType: REFUND (full/partial), VOID (same-day real-time
  // void), CREDITNOTE. Manual note: VOID needs DBT_TXNID or DBT_ORDERID and
  // is only valid same day, otherwise GyFTR treats it as a REFUND.
  fastify.post('/refund', async (request, reply) => {
    try {
      const drTxnId = String(request.body?.drTxnId || '').trim();
      const drOrderId = String(request.body?.drOrderId || '').trim();
      const amount = Number(request.body?.amount || 0);
      const actionType = ['REFUND', 'VOID', 'CREDITNOTE'].includes(request.body?.actionType)
        ? request.body.actionType
        : 'REFUND';
      const refundDetails = Array.isArray(request.body?.refundDetails) ? request.body.refundDetails : [];

      if ((!drTxnId && !drOrderId) || amount <= 0) {
        return reply.code(400).send({ error: 'drTxnId or drOrderId, and amount, are required' });
      }

      const porderId = generatePorderId();
      const requestPayload = {
        MOBILE: normalizeMobile(request.body?.mobile),
        MID,
        TID,
        SOURCE: DEFAULT_SOURCE,
        DBT_TXNID: drTxnId,
        PORDERID: porderId,
        DBT_ORDERID: drOrderId,
        REFUND_AMOUNT: amount.toFixed(2),
        REFUND_DETAILS: refundDetails.map((d) => ({
          CATEGORY: d.category,
          AMOUNT: Number(d.amount || 0).toFixed(2),
        })),
        // Manual's JSON example uses "ACTION_TYPE"; its field table calls it
        // "ACTIONTYPE" — inconsistent doc. Going with the literal example key.
        ACTION_TYPE: actionType,
        DESC: String(request.body?.desc || ''),
      };
      console.log(`[gyftr] refunds REFUND_DETAILS: ${JSON.stringify(requestPayload.REFUND_DETAILS)}`);
      try {
        const result = await callGyftr('refunds', requestPayload);
        return {
          success: true,
          porderId,
          txnId: result.TXNID,
          availableBalance: Number(result.AVAILABLE_BALANCE || 0),
          amountDetails: result.AMOUNT_DETAILS || [],
          debugRequestPayload: requestPayload,
          debugRawGyftrResponse: result,
        };
      } catch (err) {
        return handleGyftrError(err, reply, { debugRequestPayload: requestPayload, porderId });
      }
    } catch (err) {
      return handleGyftrError(err, reply);
    }
  });

  // POST /api/gyftr/status  { porderId, txnId?, txnType? }
  // getWalletTxnStatus — mandatory per manual section 18 to check what
  // actually happened after a timeout/handshake failure on redeem/recharge.
  fastify.post('/status', async (request, reply) => {
    try {
      const porderId = String(request.body?.porderId || '').trim();
      const txnId = String(request.body?.txnId || '').trim();
      const txnType = ['CREDIT', 'DEBIT', 'REFUND'].includes(request.body?.txnType)
        ? request.body.txnType
        : 'DEBIT';

      if (!porderId) {
        return reply.code(400).send({ error: 'porderId is required' });
      }

      const requestPayload = {
        MID,
        TID,
        SOURCE: DEFAULT_SOURCE,
        TXNID: txnId,
        PORDERID: porderId,
        TXN_TYPE: txnType,
      };
      try {
        const result = await callGyftr('getWalletTxnStatus', requestPayload);
        return {
          success: true,
          txnId: result.TXNID,
          amount: result.AMOUNT,
          amountDetails: result.AMOUNT_DETAILS || [],
          billNo: result.BILLNO,
          billValue: result.BILLVALUE,
          txnDate: result.TXNDATE,
          debugRequestPayload: requestPayload,
          debugRawGyftrResponse: result,
        };
      } catch (err) {
        return handleGyftrError(err, reply, { debugRequestPayload: requestPayload });
      }
    } catch (err) {
      return handleGyftrError(err, reply);
    }
  });
}

module.exports = routes;
