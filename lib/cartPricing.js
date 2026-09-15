/**
 * Cart Pricing (shared)
 *
 * Cart line prices used to be frozen at add-to-cart time, while the Razorpay
 * amount was rebuilt from live DI-GoldPrice rates when the draft order was
 * created. Any metal-rate update between those two moments surfaced as a gap
 * between the total on screen and the amount actually charged.
 *
 * Both paths now run through repriceItems(), so the cart shows exactly what the
 * draft order will bill. Keep it that way: any pricing rule added here must
 * apply to the cart and the checkout at the same time.
 */

const { shopifyAdminFetch, getShopPricingData } = require('./shopify');
const { calculatePriceBreakup } = require('./priceEngine');
const { getServerCache, stableCacheKey, invalidateCache } = require('./cache');
const FREE_GIFT_OFFER_CACHE_KEY = stableCacheKey(["free-gift-tiers"]);

const INSURANCE_VARIANT_ID = "gid://shopify/ProductVariant/47709366026458";


// Variant configs only change when a merchant edits a product, but the cart and
// the checkout have to agree on them to the rupee. Reading one cached snapshot
// keeps two independent Shopify reads from returning different configs mid-flow.
const VARIANT_PRICING_TTL_MS = 5 * 60 * 1000;

// Short TTL (vs. the 5min variant-pricing cache) so a staff edit in the dashboard
// — adding a tier, swapping a gift, disabling the offer — takes effect quickly
// without hitting Mongo on every cart read.
const FREE_GIFT_TIERS_TTL_MS = 60 * 1000;

function normalizeVariantId(variantId = "") {
  const value = String(variantId || "").trim();
  if (!value) return "";
  return value.includes("gid://shopify/ProductVariant/")
    ? value
    : `gid://shopify/ProductVariant/${value}`;
}



// `extraVariantIds` carries the current spend-gift tiers' variant IDs (see
// getFreeGiftOffer below). Kept as a parameter rather than read internally here
// so this stays a plain sync check — callers fetch the tier list once per request.
function isFreeGiftVariant(variantId = "", extraVariantIds = []) {
  return extraVariantIds.includes(variantId);
}

// A scheduled-but-not-yet-started or already-ended tier can't grant a NEW
// claim, but its variant still counts for isFreeGiftVariant recognition
// (an already-claimed line from while it was live must keep pricing at ₹0)
// — so this is only consulted at the eligibility check, not at recognition.
function isTierLive(tier, now = Date.now()) {
  if (tier.startsAt && new Date(tier.startsAt).getTime() > now) return false;
  if (tier.endsAt && new Date(tier.endsAt).getTime() < now) return false;
  return true;
}

// Whether a cart with this diamond total/quantity clears the tier's own
// trigger. `triggerType` defaults to "amount" so tiers saved before this
// field existed keep behaving exactly as they did (spend-based only).
function tierTriggerMet(tier, { diamondTotal = 0, diamondQuantity = 0 } = {}) {
  if (tier.triggerType === "quantity") {
    return diamondQuantity >= (Number(tier.minQuantity) || 0);
  }
  return diamondTotal >= (Number(tier.min) || 0);
}

// The Shopify draft-order line discount to apply for a granted gift.
// `rewardType` defaults to "free" for the same backward-compat reason as
// tierTriggerMet. Shopify draft orders price a line at its real
// originalUnitPrice and then apply a discount on top — so this returns a
// discount descriptor {value, valueType}, not a final price; checkout.js
// always sets originalUnitPrice from the variant's live Shopify price first,
// so a percentage/amount-off reward can never be computed off a stale or
// staff-entered "worth" value.
function giftLineDiscount(tier) {
  if (tier.rewardType === "percentage") {
    return { value: Math.min(100, Math.max(0, Number(tier.rewardPercentage) || 0)), valueType: "PERCENTAGE" };
  }
  if (tier.rewardType === "amount_off") {
    return { value: Math.max(0, Number(tier.rewardAmountOff) || 0), valueType: "FIXED_AMOUNT" };
  }
  return { value: 100, valueType: "PERCENTAGE" };
}

/**
 * The staff-configurable spend-gift tiers (dashboard: Silver Bracelet / Free
 * Gift Tiers page) — { enabled, tiers: [{ min, giftVariantId, ... }] }. Each
 * tier is a "spend >= min, get this variant free" rule; the highest min a
 * cart clears is the one that applies (see checkout.js's eligibility check).
 * Doc-absent defaults reproduce the single hardcoded offer this replaced.
 */
async function getFreeGiftOffer(db) {
  if (!db) return { enabled: true, tiers: [] };
  return getServerCache(
    FREE_GIFT_OFFER_CACHE_KEY,
    async () => {
      const settings = await db.collection("settings").findOne({ key: "silver_bracelet_offer" });
      const rawTiers = Array.isArray(settings?.tiers) ? settings.tiers : null;
      const tiers = rawTiers ?? [];
      return {
        enabled: settings?.enabled ?? true,
        tiers: tiers
          .map((t) => ({ ...t, giftVariantId: normalizeVariantId(t.giftVariantId), min: Number(t.min) || 0 }))
          .filter((t) => t.giftVariantId),
      };
    },
    { ttlMs: FREE_GIFT_TIERS_TTL_MS, maxEntries: 10 }
  );
}

// Called after a dashboard save (settings.js) so the new tiers apply to the
// very next cart read instead of waiting out FREE_GIFT_TIERS_TTL_MS.
function invalidateFreeGiftOfferCache() {
  invalidateCache(FREE_GIFT_OFFER_CACHE_KEY);
}

const PRODUCT_DISCOUNTS_CACHE_KEY = "product_discounts_cache";
const PRODUCT_DISCOUNTS_TTL_MS = 60000;

async function getProductDiscounts(db) {
  if (!db) return [];
  return getServerCache(
    PRODUCT_DISCOUNTS_CACHE_KEY,
    async () => {
      const settings = await db.collection("settings").findOne({ key: "product_discounts_rules" });
      const rawDiscounts = Array.isArray(settings?.discounts) ? settings.discounts : [];
      return rawDiscounts.filter(d => {
        // Only return currently active discounts. The dashboard's Deactivate
        // button (DELETE /product-discounts/:id) sets active: false but keeps
        // the rule around for Reactivate — without this check it would keep
        // silently discounting carts after being "deactivated".
        if (d.active === false) return false;
        const now = Date.now();
        if (d.startsAt && new Date(d.startsAt).getTime() > now) return false;
        if (d.endsAt && new Date(d.endsAt).getTime() < now) return false;
        return true;
      });
    },
    { ttlMs: PRODUCT_DISCOUNTS_TTL_MS, maxEntries: 10 }
  );
}

function invalidateProductDiscountsCache() {
  invalidateCache(PRODUCT_DISCOUNTS_CACHE_KEY);
}

// A rule's `excludedCollections` (dashboard: "Exclusions") are carve-outs from
// whatever it applies to — a line in any of them never takes the discount,
// even when it also sits in a selected collection. Shopify's discount model
// has no exclusion field, so this is only ever honoured here and in
// cart.js's /coupon/validate; nothing about it round-trips through Shopify.
// Compared on the numeric tail, so a rule holding a bare id still matches a
// GID coming off the product (and vice versa) — the picker stores GIDs today,
// but a silent miss here would quietly hand out an excluded discount.
function collectionKey(id) {
  return String(id || '').split('/').pop();
}

function isExcludedFromRule(rule, collectionIds = []) {
  const excluded = (rule.excludedCollections || []).map((c) => collectionKey(c.id)).filter(Boolean);
  if (excluded.length === 0) return false;
  return collectionIds.some((id) => excluded.includes(collectionKey(id)));
}

// Merchandising/SEO tagging on this store routinely puts a product in
// 15-20+ collections, so a small collections(first: N) here would silently
// drop collection-targeted automatic discounts for any product whose
// matching collection isn't in the arbitrary first N — 250 is Shopify's
// connection max, so appliesTo: "specific_collections" sees all of them.
const VARIANT_PRICING_QUERY = `
  query getVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
        price
        product {
          id
          collections(first: 250) {
            nodes {
              id
            }
          }
        }
      }
    }
  }
`;

async function fetchVariantPricing(variantIds = []) {
  const uniqueIds = [...new Set(variantIds.filter(Boolean))].sort();
  if (!uniqueIds.length) return {};

  return getServerCache(
    stableCacheKey(["variant-pricing", uniqueIds]),
    async () => {
      const data = await shopifyAdminFetch(VARIANT_PRICING_QUERY, { ids: uniqueIds });
      const map = {};
      (data?.nodes || []).forEach((variant) => {
        if (variant?.id) map[variant.id] = variant;
      });
      return map;
    },
    { ttlMs: VARIANT_PRICING_TTL_MS, maxEntries: 500 }
  );
}

function calculateCartTotal(items = []) {
  return (items || []).reduce(
    (sum, item) =>
      sum + Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1),
    0
  );
}

function calculateCartQuantity(items = []) {
  return (items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

/**
 * Re-prices cart lines against the live metal rates and stone slabs.
 *
 * @param items                 cart lines (Mongo cart shape)
 * @param options.dropInvalid   checkout behaviour: drop lines whose variant no
 *                              longer resolves on Shopify or prices at zero.
 *                              The cart keeps them at their stored price instead,
 *                              so a transient Shopify hiccup can never empty a
 *                              customer's cart on a plain read.
 *
 * @returns items          re-priced lines
 * @returns changed        true when any line's price moved
 * @returns diamondTotal   diamond-line value, for gold-coin/pendant eligibility
 * @returns diamondQuantity diamond-line unit count, for quantity-triggered gift tiers
 * @returns removed        lines dropped (only when dropInvalid is set)
 * @param options.db      Mongo db handle — needed to resolve the current
 *                         spend-gift tiers so a claimed gift line is recognized
 *                         and skipped rather than repriced as a paid item.
 *                         Omit only where no gift line can be present.
 * @param options.claimedDiscountIds  Product-discount rule ids the shopper has
 *                         claimed via /api/cart/discount/claim. A rule that's
 *                         "showInDrawer" is claim-gated — it's surfaced (see
 *                         the returned activeDiscounts) but only actually
 *                         discounts matching items once its id is in here.
 *                         Non-drawer automatic rules apply unconditionally.
 * @returns activeDiscounts  drawer-gated automatic rules currently eligible
 *                            for at least one cart line, each as
 *                            { id, title, discountValue, claimed }.
 */
async function repriceItems(items = [], { dropInvalid = false, db = null, claimedDiscountIds = [] } = {}) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) {
    return { items: [], changed: false, diamondTotal: 0, diamondQuantity: 0, removed: [], activeDiscounts: [] };
  }

  const { metalRates, stonePricingDB } = await getShopPricingData();
  const variantMap = await fetchVariantPricing(
    source.map((item) => normalizeVariantId(item.variantId))
  );
  const { tiers: freeGiftTiers } = await getFreeGiftOffer(db);
  const giftVariantIds = freeGiftTiers.map((t) => t.giftVariantId);
  const productDiscounts = await getProductDiscounts(db);

  let changed = false;
  let diamondTotal = 0;
  let diamondQuantity = 0;
  const removed = [];
  const activeDiscountsMap = new Map();

  // Undiscounted unit price for an item, shared by the eligible-subtotal
  // pre-pass below and the main pricing pass so the two can never disagree
  // on what a line is "really" worth.
  const computeRealPrice = (item, variant) => {
    if (variant?.variant_config?.value) {
      try {
        const config = JSON.parse(variant.variant_config.value);
        const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);
        return { realPrice: Number(breakup.total), breakup };
      } catch (e) {
        console.error(`Failed to parse config for variant ${normalizeVariantId(item.variantId)}:`, e.message);
      }
    }
    return { realPrice: Number(variant?.price || 0), breakup: null };
  };

  // A rule's "minimum purchase" is a cart-level threshold (e.g. "min ₹20,000"
  // means the CART's eligible subtotal, not any one line) — Shopify's own
  // automatic discounts work the same way. So before pricing anything, sum
  // each rule's matching lines once, undiscounted, and check the threshold
  // against that aggregate rather than a single line's own price*quantity.
  const ruleEligible = new Map(); // ruleId -> { amount, quantity }
  for (const item of source) {
    const vId = normalizeVariantId(item.variantId);
    if (isFreeGiftVariant(vId, giftVariantIds)) continue;
    const variant = variantMap[vId];
    if (!variant) continue;

    const quantity = Math.max(1, Number(item.quantity || 1));
    const { realPrice } = computeRealPrice(item, variant);
    if (realPrice <= 0) continue;

    const productId = variant?.product?.id || item.productId || item.id;
    const collectionIds = variant?.product?.collections?.nodes?.map(c => c.id) || [];

    for (const rule of productDiscounts) {
      if (rule.method === 'code') continue;
      let matches = false;
      if (rule.appliesTo === "specific_products") {
        matches = rule.selectedProducts?.some(p => p.id === productId);
      } else if (rule.appliesTo === "specific_collections") {
        matches = rule.selectedCollections?.some(c => collectionIds.includes(c.id));
      }
      if (!matches || isExcludedFromRule(rule, collectionIds)) continue;

      const agg = ruleEligible.get(rule.id) || { amount: 0, quantity: 0 };
      agg.amount += realPrice * quantity;
      agg.quantity += quantity;
      ruleEligible.set(rule.id, agg);
    }
  }

  // Helper to evaluate if an item qualifies for a product discount
  const applyProductDiscounts = (basePrice, quantity, variantNode, itemData) => {
    if (!productDiscounts || productDiscounts.length === 0) return basePrice;

    let bestPrice = basePrice;
    const productId = variantNode?.product?.id || itemData?.productId || itemData?.id;
    const collectionIds = variantNode?.product?.collections?.nodes?.map(c => c.id) || [];

    for (const rule of productDiscounts) {
      if (rule.method === 'code') continue; // Only apply automatic discounts here, codes applied at checkout

      let matches = false;
      if (rule.appliesTo === "specific_products") {
        matches = rule.selectedProducts?.some(p => p.id === productId);
      } else if (rule.appliesTo === "specific_collections") {
        matches = rule.selectedCollections?.some(c => collectionIds.includes(c.id));
      }

      if (!matches || isExcludedFromRule(rule, collectionIds)) continue;

      // Check minimum requirements against the cart's eligible subtotal for
      // this rule (see ruleEligible above), not this single line.
      const agg = ruleEligible.get(rule.id) || { amount: 0, quantity: 0 };
      let reqMet = true;
      if (rule.minRequirement === "amount" && agg.amount < rule.minRequirementValue) {
        reqMet = false;
      } else if (rule.minRequirement === "quantity" && agg.quantity < rule.minRequirementValue) {
        reqMet = false;
      }
      if (!reqMet) continue;

      // A drawer-listed or featured automatic discount is claim-gated: it's surfaced as
      // an offer the shopper can grab (the cart's "unlocked" banner), not
      // applied silently. Non-drawer automatic discounts (site-wide sales)
      // still apply unconditionally, same as before this gating existed.
      if (rule.showInDrawer || rule.isFeatured) {
        if (!activeDiscountsMap.has(rule.id)) {
          // Calculate max savings for this rule across the cart based on ruleEligible
          let cartSavings = 0;
          if (rule.discountType === "percentage") {
            cartSavings = agg.amount * (rule.discountValue / 100);
          } else if (rule.discountType === "fixed_amount") {
            cartSavings = Math.min(agg.amount, rule.discountValue);
          }

          activeDiscountsMap.set(rule.id, {
            id: rule.id,
            title: rule.title,
            discountValue: rule.discountValue,
            claimed: claimedDiscountIds.includes(rule.id),
            isFeatured: Boolean(rule.isFeatured),
            cartSavings: cartSavings
          });
        }
        if (!claimedDiscountIds.includes(rule.id)) continue;
      }
      
      // If ANY claim-gated rule is currently claimed, do not apply non-claim-gated rules to prevent stacking
      if (!(rule.showInDrawer || rule.isFeatured) && claimedDiscountIds.length > 0) {
        continue;
      }

      let discountedPrice = basePrice;
      if (rule.discountType === "percentage") {
        discountedPrice = basePrice * (1 - (rule.discountValue / 100));
      } else if (rule.discountType === "fixed_amount") {
        discountedPrice = Math.max(0, basePrice - rule.discountValue);
      }
      if (discountedPrice < bestPrice) {
        bestPrice = discountedPrice;
      }
    }
    return bestPrice;
  };

  const repriced = source
    .map((item) => {
      const vId = normalizeVariantId(item.variantId);

      // Free gifts are granted by the offer rules, not the price engine. The
      // checkout's second pass owns their eligibility and quantity.
      if (isFreeGiftVariant(vId, giftVariantIds)) return item;

      const quantity = Math.max(1, Number(item.quantity || 1));
      const storedPrice = Number(item.finalPrice || item.price || 0);
      const variant = variantMap[vId];

      if (!variant) {
        if (dropInvalid) {
          console.error(`[Security] Rejecting item with invalid variantId: ${vId}`);
          removed.push({ variantId: vId, reason: "variant_not_found" });
          return null;
        }
        return quantity === item.quantity ? item : { ...item, quantity };
      }

      let realPrice = 0;

      if (variant?.variant_config?.value) {
        try {
          const config = JSON.parse(variant.variant_config.value);
          const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);
          const isDiamondItem = Number(breakup.diamond?.final || 0) > 0 ||
            String(item.title || "").toLowerCase().includes("diamond") ||
            String(item.type || item.productType || item.product_type || "").toLowerCase().includes("diamond") ||
            String(item.title || "").toLowerCase().includes("solitaire") ||
            String(item.title || "").toLowerCase().includes("gemstone") ||
            !!item.diamondCharges;

          const isBYJ = Boolean(
            item.properties?.['_byj_group_id'] || 
            item.properties?.['_byj_preview'] || 
            item.properties?.['_byj_parent'] || 
            item.properties?.[' _byj_parent'] || 
            item.tags?.includes('BYJ') || 
            String(item.handle || "").toLowerCase().includes('byj') || 
            String(item.title || "").toLowerCase().includes('byj')
          );

          realPrice = Number(breakup.total);
          const finalDiscountedPrice = applyProductDiscounts(realPrice, quantity, variant, item);

          // Insurance rides along with the order and never earns a free gift.
          if (isDiamondItem && vId !== INSURANCE_VARIANT_ID && !isFreeGiftVariant(vId, giftVariantIds) && !isBYJ) {
            diamondTotal += finalDiscountedPrice * quantity;
            diamondQuantity += quantity;
          }

          if (finalDiscountedPrice !== storedPrice) changed = true;

          return {
            ...item,
            quantity,
            price: realPrice,
            finalPrice: finalDiscountedPrice,
            goldWeight: breakup.metal.weight,
            goldPrice: breakup.metal.cost,
            goldPricePerGram: breakup.metal.rate_per_gram,
            makingCharges: breakup.making_charges.final,
            diamondCharges: breakup.diamond.final,
            gst: breakup.gst.amount,
          };
        } catch (e) {
          console.error(`Failed to parse config for variant ${vId}:`, e.message);
        }
      }

      // Fixed-price lines (insurance, non-configured variants) follow Shopify.
      const shopifyPrice = Number(variant?.price || 0);
      if (shopifyPrice <= 0) {
        if (dropInvalid) {
          console.error(`[Security] Rejecting item with zero price in Shopify: ${vId}`);
          removed.push({ variantId: vId, reason: "zero_price" });
          return null;
        }
        return quantity === item.quantity ? item : { ...item, quantity };
      }

      if (shopifyPrice !== storedPrice) changed = true;

      const isDiamondItem = Number(item.diamondCharges || 0) > 0 ||
        String(item.title || "").toLowerCase().includes("diamond") ||
        String(item.type || item.productType || item.product_type || "").toLowerCase().includes("diamond") ||
        String(item.title || "").toLowerCase().includes("solitaire") ||
        String(item.title || "").toLowerCase().includes("gemstone") ||
        (Array.isArray(item.customAttributes) && item.customAttributes.some(attr => attr.key === "_Diamond Charges" && attr.value));

      const isBYJ = Boolean(
        item.properties?.['_byj_group_id'] || 
        item.properties?.['_byj_preview'] || 
        item.properties?.['_byj_parent'] || 
        item.properties?.[' _byj_parent'] || 
        item.tags?.includes('BYJ') || 
        String(item.handle || "").toLowerCase().includes('byj') || 
        String(item.title || "").toLowerCase().includes('byj')
      );

      realPrice = shopifyPrice;
      const finalDiscountedPrice = applyProductDiscounts(realPrice, quantity, variant, item);

      if (isDiamondItem && vId !== INSURANCE_VARIANT_ID && !isFreeGiftVariant(vId, giftVariantIds) && !isBYJ) {
        diamondTotal += finalDiscountedPrice * quantity;
        diamondQuantity += quantity;
      }
      
      if (finalDiscountedPrice !== storedPrice) changed = true;

      return { ...item, quantity, price: realPrice, finalPrice: finalDiscountedPrice };
    })
    .filter(Boolean);

  // Which rules' exclusions cover each line. The storefront can't know a
  // product's collection memberships on its own, so without this tag the cart
  // keeps advertising an offer ("Additional 3% Off on Plain Gold Products")
  // on a cart made entirely of a collection that rule excludes. Code rules
  // count here too — the featured banner promotes those, and the loops above
  // only look at automatic ones.
  // Recomputed on every pass, never merged: repriced lines get persisted back
  // to the cart doc, so a tag left over from an exclusion staff have since
  // deleted would go on suppressing that offer forever.
  const rulesWithExclusions = (productDiscounts || []).filter(
    (r) => (r.excludedCollections || []).length > 0
  );
  const tagged = repriced.map((item) => {
    const variant = variantMap[normalizeVariantId(item.variantId)];
    const collectionIds = variant?.product?.collections?.nodes?.map(c => c.id) || [];
    const excludedFromRuleIds = rulesWithExclusions
      .filter((r) => isExcludedFromRule(r, collectionIds))
      .map((r) => r.id);

    if (excludedFromRuleIds.length > 0) return { ...item, excludedFromRuleIds };
    if (item.excludedFromRuleIds) {
      const { excludedFromRuleIds: _stale, ...rest } = item;
      return rest;
    }
    return item;
  });

  return { items: tagged, changed, diamondTotal, diamondQuantity, removed, activeDiscounts: [...activeDiscountsMap.values()] };
}

module.exports = {
  repriceItems,
  calculateCartTotal,
  calculateCartQuantity,
  normalizeVariantId,
  isFreeGiftVariant,
  isTierLive,
  tierTriggerMet,
  giftLineDiscount,
  getFreeGiftOffer,
  invalidateFreeGiftOfferCache,
  invalidateProductDiscountsCache,
  INSURANCE_VARIANT_ID,
};
