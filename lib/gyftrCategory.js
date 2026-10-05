/**
 * Shared GyFTR wallet category classification/allocation logic.
 *
 * Extracted out of routes/checkout.js so routes/gyftr/index.js can reuse the
 * exact same rules for the balance display (getWalletBalance's category
 * breakdown is derived client-cart-side, not from GyFTR itself — see that
 * route's comments) without a second, drifting copy of this logic.
 */

const GYFTR_GOLDCOIN_VARIANT_ID = "gid://shopify/ProductVariant/47661824082138";
const GYFTR_INSURANCE_VARIANT_ID = "gid://shopify/ProductVariant/47709366026458";

// The 3 wallet categories, as a single source of truth — anywhere that calls
// GyFTR's getWalletBalance MUST pass CATEGORY (18 Sep 2026: confirmed live
// that omitting it now returns CODE 204 "Parameters are mandatory"; this is
// the inverse of an earlier finding when GyFTR briefly tolerated/required no
// category — GyFTR's behavior has shifted more than once, so this constant
// exists precisely so a future shift only needs updating in one place).
const ALL_CATEGORIES = ['DIAMOND_JEWELLERY', 'PLAIN_JEWELLERY', 'GOLD_COINS'];

/**
 * Classifies a cart line item into one of Lucira's 3 GyFTR wallet
 * categories, per the exact rule set given (25 Aug 2026), sourced from the
 * `ornaverse.material_type` product metafield + Shopify's built-in product
 * Type — both populated onto repriced cart items by lib/cartPricing.js's
 * repriceItems() (extended to fetch them in its existing variant query).
 *
 *   DIAMOND_JEWELLERY — materialType contains "Diamond"
 *   PLAIN_JEWELLERY   — materialType is exactly "Plain Gold"
 *   GOLD_COINS        — materialType is "Plain Gold" AND productType is "Gold Coin"
 *
 * Validated against the real product dump (25 Aug 2026, 2937 SKUs): all 8
 * Type="Gold Coin" products have materialType="Plain Gold", so the GOLD_COINS
 * check is evaluated first. 4 products in that dump (materialType "Platinum",
 * "Platinum & Gold", "Gold & Gemstone") match none of the 3 rules — per
 * explicit instruction, those (and anything else unmatched, e.g. a line
 * whose materialType didn't resolve) are excluded from category allocation
 * entirely: this returns null, and computeGyftrCategoryBreakdown skips it.
 */
function classifyGyftrCategory(item) {
  const vId = String(item.variantId || "");
  if (vId === GYFTR_INSURANCE_VARIANT_ID) return null;

  // BYJ (build-your-jewelry) parent/group placeholder lines carry no price
  // of their own — the assembled BYJ line is what's actually priced.
  if (item.properties?.['_byj_parent'] || (item.properties?.['_byj_group_id'] && !item.properties?.['_byj_preview'])) {
    return null;
  }

  const materialType = String(item.materialType || "").trim().toLowerCase();
  const productType = String(item.productType || item.type || item.product_type || "").trim().toLowerCase();

  // Cheap, reliable fast-path for the one hardcoded gold-coin variant this
  // codebase already tracks elsewhere (free-gift branches in cartPricing.js
  // return the item unmodified, without materialType attached).
  if (vId === GYFTR_GOLDCOIN_VARIANT_ID) return "GOLD_COINS";

  if (!materialType) return null;

  const isPlainGold = materialType === "plain gold";
  if (isPlainGold && productType === "gold coin") return "GOLD_COINS";
  if (materialType.includes("diamond")) return "DIAMOND_JEWELLERY";
  if (isPlainGold) return "PLAIN_JEWELLERY";
  return null;
}

/** Category-wise subtotal of a cart, using the same finalPrice/price fallback the rest of the codebase uses. */
function computeGyftrCategoryBreakdown(items) {
  const totals = { DIAMOND_JEWELLERY: 0, PLAIN_JEWELLERY: 0, GOLD_COINS: 0 };
  for (const item of items || []) {
    const category = classifyGyftrCategory(item);
    if (!category) continue;
    totals[category] += Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1);
  }
  return totals;
}

/**
 * Splits an amount across the 3 categories, proportional to each category's
 * share of the cart subtotal, capped so no category is allocated more than
 * it actually contains. Any rounding remainder (from 2dp truncation) folds
 * into the largest share so the parts sum exactly to `amount`.
 *
 * Used two ways:
 *  - checkout.js: splitting a wallet-REDEEM amount, for GyFTR's own
 *    AMOUNT_DETAILS field (must sum to the real debited amount).
 *  - routes/gyftr/index.js: splitting the wallet's TOTAL BALANCE, purely for
 *    display — GyFTR itself can't return a real per-category balance for
 *    this account (confirmed live, every category returns BALANCE 0), so
 *    this produces an estimate of how the balance would break down if
 *    redeemed against the current cart. Never sent back to GyFTR.
 */
function allocateGyftrAmountByCategory(amount, items) {
  const totals = computeGyftrCategoryBreakdown(items);
  const grandTotal = totals.DIAMOND_JEWELLERY + totals.PLAIN_JEWELLERY + totals.GOLD_COINS;
  if (grandTotal <= 0 || !(amount > 0)) return [];

  const shares = Object.keys(totals)
    .filter((c) => totals[c] > 0)
    .map((c) => ({ category: c, amount: Math.min(totals[c], (totals[c] / grandTotal) * amount) }));

  const allocated = shares.reduce((sum, s) => sum + s.amount, 0);
  const remainder = Math.round((amount - allocated) * 100) / 100;
  if (remainder !== 0 && shares.length > 0) {
    shares.sort((a, b) => b.amount - a.amount)[0].amount += remainder;
  }

  // Round FIRST, then drop zero rows: a category whose true share rounds to
  // 0.00 (e.g. a ₹100 coin in a ₹69k cart on a ₹1 redemption) must not be
  // sent — GyFTR rejects a 0.00 AMOUNT_DETAILS entry with "Values of
  // parameters are not in proper format" (confirmed live 21 Sep 2026). The
  // remainder was already folded into the largest share above, so dropping
  // zero rows never changes the total.
  return shares
    .map((s) => ({ category: s.category, amount: Math.round(s.amount * 100) / 100 }))
    .filter((s) => s.amount > 0);
}

module.exports = {
  GYFTR_GOLDCOIN_VARIANT_ID,
  GYFTR_INSURANCE_VARIANT_ID,
  ALL_CATEGORIES,
  classifyGyftrCategory,
  computeGyftrCategoryBreakdown,
  allocateGyftrAmountByCategory,
};
