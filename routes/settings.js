/**
 * Settings Routes (Fastify)
 */

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('settings');

  // GET /api/settings/gold-coin
  fastify.get('/gold-coin', async (request, reply) => {
    const { shopifyAdminFetch } = require('../lib/shopify');
    const settings = await collection.findOne({ key: 'gold_coin_offer' });

    let shopifyProduct = null;
    const variantId = "gid://shopify/ProductVariant/47661824082138"; // 100mg Gold Coin

    try {
      const query = `
        query getVariant($id: ID!) {
          node(id: $id) {
            ... on ProductVariant {
              id
              title
              price
              image {
                url
              }
              product {
                id
                title
                featuredImage {
                  url
                }
              }
            }
          }
        }
      `;
      const data = await shopifyAdminFetch(query, { id: variantId });
      if (data?.node) {
        shopifyProduct = {
          title: data.node.product.title,
          variantTitle: data.node.title,
          price: data.node.price,
          image: data.node.image?.url || data.node.product.featuredImage?.url
        };
      }
    } catch (err) {
      fastify.log.error('Error fetching gold coin from Shopify: ' + err.message);
    }

    return {
      enabled: settings?.enabled ?? false,
      threshold: settings?.threshold ?? 20000,
      message: settings?.message || "Complimentary Gold Coin available",
      shopifyProduct
    };
  });

  // POST /api/settings/gold-coin
  fastify.post('/gold-coin', async (request, reply) => {
    const { enabled, threshold, message } = request.body;
    await collection.updateOne(
      { key: 'gold_coin_offer' },
      { $set: { enabled, threshold: parseInt(threshold), message, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/settings/silver-bracelet
  // Mirrors /gold-coin so the cart's free-gift widget (FreeGiftReward) and the
  // checkout-time validation read one admin-tunable doc instead of a constant.
  // Shape is a list of spend tiers (min value -> gift), not a single threshold,
  // so staff can add more gifts beyond the one Diamond Bracelet offer without a
  // deploy. getFreeGiftOffer (shared with checkout.js/cartPricing.js) owns the
  // doc-absent default, so this route and the security checks can never disagree
  // about what the "no doc written yet" state actually is.
  fastify.get('/silver-bracelet', async (request, reply) => {
    const { getFreeGiftOffer } = require('../lib/cartPricing');
    return getFreeGiftOffer(fastify.mongo.db);
  });

  // POST /api/settings/silver-bracelet
  fastify.post('/silver-bracelet', async (request, reply) => {
    const { enabled, tiers } = request.body;
    if (!Array.isArray(tiers)) {
      return reply.code(400).send({ error: 'tiers must be an array' });
    }
    const cleanDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    const cleanTiers = tiers.map((t) => ({
      id: t.id || `tier_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: String(t.title || '').trim(),
      enabled: t.enabled !== false,
      // "amount" (spend >= min) or "quantity" (item count >= minQuantity) —
      // see tierTriggerMet in lib/cartPricing.js for how checkout enforces this.
      triggerType: t.triggerType === 'quantity' ? 'quantity' : 'amount',
      min: parseInt(t.min) || 0,
      minQuantity: parseInt(t.minQuantity) || 0,
      // "free" (100% off), "percentage", or "amount_off" — see
      // giftLineDiscount in lib/cartPricing.js for how checkout applies this.
      rewardType: ['percentage', 'amount_off'].includes(t.rewardType) ? t.rewardType : 'free',
      rewardPercentage: Math.min(100, Math.max(0, parseFloat(t.rewardPercentage) || 0)),
      rewardAmountOff: Math.max(0, parseInt(t.rewardAmountOff) || 0),
      giftVariantId: String(t.giftVariantId || '').trim(),
      giftProductId: String(t.giftProductId || '').trim(),
      giftTitle: String(t.giftTitle || '').trim(),
      giftWorthValue: parseInt(t.giftWorthValue) || 0,
      giftImage: String(t.giftImage || '').trim(),
      bannerImage: String(t.bannerImage || '').trim(),
      bannerText: String(t.bannerText || '').trim(),
      // Off means claiming this gift clears any redeemed Lucira coins,
      // which is how the gift offer has always behaved.
      coinsApplicable: Boolean(t.coinsApplicable),
      // Off means claiming this gift removes an applied coupon (and applying
      // a coupon removes this gift) — the long-standing exclusive behavior.
      combineCoupons: Boolean(t.combineCoupons),
      startsAt: cleanDate(t.startsAt),
      endsAt: cleanDate(t.endsAt),
    }));
    await collection.updateOne(
      { key: 'silver_bracelet_offer' },
      { $set: { enabled: !!enabled, tiers: cleanTiers, updatedAt: new Date() } },
      { upsert: true }
    );
    // Without this, a staff save wouldn't be reflected in the cart/checkout
    // for up to a minute (getFreeGiftOffer's cache TTL) — bad "did it save?"
    // experience for a form whose entire point is instant, code-free updates.
    const { invalidateFreeGiftOfferCache } = require('../lib/cartPricing');
    invalidateFreeGiftOfferCache();
    return { success: true };
  });

  // GET /api/settings/announcements
  fastify.get('/announcements', async () => {
    const settings = await fastify.mongo.db.collection('announcements').findOne({ key: 'global_settings' });
    return {
      announcements: settings?.announcements || [],
      isVisible: settings?.isVisible ?? true
    };
  });

  // POST /api/settings/announcements
  fastify.post('/announcements', async (request, reply) => {
    const { announcements, isVisible } = request.body;
    await fastify.mongo.db.collection('announcements').updateOne(
      { key: 'global_settings' },
      { $set: { announcements, isVisible, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/settings/hero-banners
  fastify.get('/hero-banners', async () => {
    const settings = await collection.findOne({ key: 'hero_banners' });
    // Provide some default banners if none exist so the frontend doesn't break
    const defaultBanners = [
      { id: "1", type: "image", name: "Baarish", alt: "Baarish", url: "/collections/jewelry", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Baarish-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Baarish-Mobile.jpg" },
      { id: "2", type: "image", name: "9KT", alt: "9KT Collection", url: "/collections/9kt-collection", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-9KT-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-9KT-Mobile.jpg" },
      { id: "3", type: "image", name: "Solitaire", alt: "Solitaire Twist Ring", url: "/products/round-diamond-solitaire-twist-ring", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Solitaire-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Solitaire-Mobile.jpg" }
    ];
    return {
      banners: settings?.banners || defaultBanners
    };
  });

  // POST /api/settings/hero-banners
  fastify.post('/hero-banners', async (request, reply) => {
    const { banners } = request.body;
    if (!Array.isArray(banners)) {
      return reply.code(400).send({ error: 'banners must be an array' });
    }
    await collection.updateOne(
      { key: 'hero_banners' },
      { $set: { banners, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/settings/scheme-offer
  fastify.get('/scheme-offer', async (request, reply) => {
    const settings = await collection.findOne({ key: 'scheme_offer' });
    return {
      enabled: settings?.enabled ?? true,
      intervals: settings?.intervals || [
        { min: 3000, max: 4500, giftValue: 5000, label: "Free Gift Worth 5k" },
        { min: 5000, max: 19000, giftValue: 10000, label: "Free Gift Worth 10k" }
      ]
    };
  });

  // POST /api/settings/scheme-offer
  fastify.post('/scheme-offer', async (request, reply) => {
    const { enabled, intervals } = request.body;
    await collection.updateOne(
      { key: 'scheme_offer' },
      { $set: { enabled, intervals, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });
  // GET /api/settings/product-discounts
  fastify.get('/product-discounts', async (request, reply) => {
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    return {
      discounts: settings?.discounts || []
    };
  });

  // POST /api/settings/product-discounts
  fastify.post('/product-discounts', async (request, reply) => {
    const { discounts } = request.body;
    if (!Array.isArray(discounts)) {
      return reply.code(400).send({ error: 'discounts must be an array' });
    }

    // Clean and validate the data
    const cleanDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };

    const cleanDiscounts = discounts.map(d => ({
      id: d.id || `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: String(d.title || '').trim(),
      method: ['code', 'automatic'].includes(d.method) ? d.method : 'automatic',
      discountType: ['percentage', 'fixed_amount'].includes(d.discountType) ? d.discountType : 'percentage',
      discountValue: Math.max(0, parseFloat(d.discountValue) || 0),
      appliesTo: ['specific_collections', 'specific_products'].includes(d.appliesTo) ? d.appliesTo : 'specific_collections',
      selectedCollections: Array.isArray(d.selectedCollections) ? d.selectedCollections : [],
      selectedProducts: Array.isArray(d.selectedProducts) ? d.selectedProducts : [],
      minRequirement: ['none', 'amount', 'quantity'].includes(d.minRequirement) ? d.minRequirement : 'none',
      minRequirementValue: Math.max(0, parseFloat(d.minRequirementValue) || 0),
      startsAt: cleanDate(d.startsAt),
      endsAt: cleanDate(d.endsAt),
      showInDrawer: Boolean(d.showInDrawer),
      isFeatured: Boolean(d.isFeatured),
      offerLabel: d.offerLabel === 'discount' ? 'discount' : 'bank_offer',
      active: d.active !== false,
      editable: d.editable !== false,
      origin: d.origin || 'dashboard',
    }));

    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: cleanDiscounts, updatedAt: new Date() } },
      { upsert: true }
    );

    // Invalidate the cache in cartPricing if we decide to cache this
    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    return { success: true };
  });

  // POST /api/settings/product-discounts/:id
  // Dashboard "Save & sync" — upserts one rule locally AND pushes it to
  // Shopify via lib/shopifyDiscounts.js, so a rule created/edited here always
  // has a real Shopify discount (code) or automatic promotion backing it.
  // cart.js/checkout.js validate coupon codes straight against Shopify, and
  // the storefront's "Saving Zone" drawer only lists rules that made it here.
  fastify.post('/product-discounts/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body || {};

    const cleanDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };

    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    const previousRule = existingDiscounts.find((d) => d.id === id) || null;

    const rule = {
      id,
      title: String(body.title || '').trim(),
      // Falls back to 'code', not 'automatic': the dashboard no longer offers a
      // method picker, so a request arriving without one is a code discount.
      // Defaulting to automatic here would mint rules the UI cannot represent.
      method: ['code', 'automatic'].includes(body.method) ? body.method : 'code',
      discountType: ['percentage', 'fixed_amount'].includes(body.discountType) ? body.discountType : 'percentage',
      discountValue: Math.max(0, parseFloat(body.discountValue) || 0),
      appliesTo: ['specific_collections', 'specific_products'].includes(body.appliesTo) ? body.appliesTo : 'specific_collections',
      selectedCollections: Array.isArray(body.selectedCollections) ? body.selectedCollections : [],
      selectedProducts: Array.isArray(body.selectedProducts) ? body.selectedProducts : [],
      minRequirement: ['none', 'amount', 'quantity'].includes(body.minRequirement) ? body.minRequirement : 'none',
      minRequirementValue: Math.max(0, parseFloat(body.minRequirementValue) || 0),
      startsAt: cleanDate(body.startsAt),
      endsAt: cleanDate(body.endsAt),
      showInDrawer: Boolean(body.showInDrawer),
      isFeatured: Boolean(body.isFeatured),
      // Which label the drawer/banner ticket's spine shows for this rule.
      offerLabel: body.offerLabel === 'discount' ? 'discount' : (previousRule?.offerLabel === 'discount' ? 'discount' : 'bank_offer'),
      // Staff-controlled stacking rules. Off means today's behaviour:
      // applying this discount clears any redeemed Lucira coins, and
      // Shopify refuses to combine it with another discount.
      coinsApplicable: Boolean(body.coinsApplicable),
      combineCoupons: Boolean(body.combineCoupons),
      shopifyDiscountId: previousRule?.shopifyDiscountId || null,
    };

    const { createOrUpdateCodeDiscount, createOrUpdateAutomaticDiscount } = require('../lib/shopifyDiscounts');
    const pushToShopify = (targetRule, targetPrevious) =>
      targetRule.method === 'code'
        ? createOrUpdateCodeDiscount(targetRule, targetPrevious)
        : createOrUpdateAutomaticDiscount(targetRule, targetPrevious);

    let shopifyResult;
    try {
      shopifyResult = await pushToShopify(rule, previousRule);
    } catch (err) {
      // A stored shopifyDiscountId can go stale (the discount was deleted
      // directly in Shopify admin, or — for automatic discounts — expired
      // and got garbage-collected) — Shopify then rejects the update with
      // "Discount does not exist" rather than a typed not-found error. Retry
      // once as a fresh create instead of surfacing a dead end to the dashboard.
      const isStale = rule.shopifyDiscountId && /does not exist/i.test(err.message || '');
      if (isStale) {
        fastify.log.warn(`Stale shopifyDiscountId ${rule.shopifyDiscountId} for "${rule.title}" — recreating in Shopify`);
        rule.shopifyDiscountId = null;
        try {
          shopifyResult = await pushToShopify(rule, null);
        } catch (retryErr) {
          fastify.log.error('Shopify discount sync failed (retry): ' + retryErr.message);
          return reply.code(502).send({ error: 'Failed to sync discount to Shopify', message: retryErr.message });
        }
      } else {
        fastify.log.error('Shopify discount sync failed: ' + err.message);
        return reply.code(502).send({ error: 'Failed to sync discount to Shopify', message: err.message });
      }
    }

    const savedDiscount = {
      ...rule,
      shopifyDiscountId: shopifyResult.shopifyDiscountId,
      active: shopifyResult.status === 'ACTIVE',
      editable: true,
      origin: 'dashboard',
      lastSyncedAt: new Date().toISOString(),
      resolvedCollectionsCount: shopifyResult.resolvedCollections.length,
      resolvedProductsCount: shopifyResult.resolvedProducts.length,
    };

    const nextDiscounts = previousRule
      ? existingDiscounts.map((d) => (d.id === id ? savedDiscount : d))
      : [savedDiscount, ...existingDiscounts];

    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } },
      { upsert: true }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    return { discount: savedDiscount };
  });

  // DELETE /api/settings/product-discounts/:id
  // "Deactivate" — pauses the discount in Shopify (discountCodeDeactivate /
  // discountAutomaticDeactivate) so it stops applying immediately, but keeps
  // the local rule around (edit + reactivate later) rather than deleting it.
  fastify.delete('/product-discounts/:id', async (request, reply) => {
    const { id } = request.params;
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    const rule = existingDiscounts.find((d) => d.id === id);
    if (!rule) return reply.code(404).send({ error: 'Discount not found' });

    let shopifyEndsAt = rule.endsAt;
    if (rule.shopifyDiscountId) {
      const { deactivateShopifyDiscount } = require('../lib/shopifyDiscounts');
      try {
        const result = await deactivateShopifyDiscount(rule.shopifyDiscountId, rule.method);
        // Shopify implements deactivate by setting its own endsAt to "now" —
        // mirror that locally so the record doesn't quietly disagree with
        // Shopify about why this rule is inactive.
        shopifyEndsAt = result.endsAt ?? shopifyEndsAt;
      } catch (err) {
        fastify.log.error('Shopify discount deactivate failed: ' + err.message);
        return reply.code(502).send({ error: 'Failed to deactivate discount in Shopify', message: err.message });
      }
    }

    const updatedRule = { ...rule, active: false, endsAt: shopifyEndsAt };
    const nextDiscounts = existingDiscounts.map((d) => (d.id === id ? updatedRule : d));
    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    // Returning the updated record (not just {success:true}) so the
    // dashboard's local state picks up the corrected endsAt too — otherwise
    // it keeps whatever stale endsAt it had in memory and resends that on
    // the next Save & Sync, undoing this.
    return { success: true, discount: updatedRule };
  });

  // POST /api/settings/product-discounts/:id/reactivate
  fastify.post('/product-discounts/:id/reactivate', async (request, reply) => {
    const { id } = request.params;
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    const rule = existingDiscounts.find((d) => d.id === id);
    if (!rule) return reply.code(404).send({ error: 'Discount not found' });

    let shopifyEndsAt = rule.endsAt;
    if (rule.shopifyDiscountId) {
      const { activateShopifyDiscount } = require('../lib/shopifyDiscounts');
      try {
        const result = await activateShopifyDiscount(rule.shopifyDiscountId, rule.method);
        // Activating clears Shopify's own endsAt back to null — without
        // mirroring that here, the next "Save & Sync" would resend whatever
        // stale (now-past) endsAt this record still had locally and
        // immediately re-expire the discount it was just reactivated.
        shopifyEndsAt = result.endsAt ?? null;
      } catch (err) {
        fastify.log.error('Shopify discount activate failed: ' + err.message);
        return reply.code(502).send({ error: 'Failed to reactivate discount in Shopify', message: err.message });
      }
    }

    const updatedRule = { ...rule, active: true, endsAt: shopifyEndsAt };
    const nextDiscounts = existingDiscounts.map((d) => (d.id === id ? updatedRule : d));
    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    // Returning the updated record (not just {success:true}) so the
    // dashboard's local state picks up the corrected endsAt too — otherwise
    // it keeps whatever stale endsAt it had in memory and resends that on
    // the next Save & Sync, undoing this exact reactivation.
    return { success: true, discount: updatedRule };
  });

  // PATCH /api/settings/product-discounts/:id/drawer
  // Dashboard-only flag — controls whether this rule appears in the
  // storefront's "Saving Zone" drawer (see cart.js: GET /coupons/active).
  // No Shopify call: the discount already exists there either way.
  fastify.patch('/product-discounts/:id/drawer', async (request, reply) => {
    const { id } = request.params;
    const { showInDrawer, isFeatured, coinsApplicable, combineCoupons, offerLabel } = request.body || {};
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    if (!existingDiscounts.some((d) => d.id === id)) {
      return reply.code(404).send({ error: 'Discount not found' });
    }

    const nextDiscounts = existingDiscounts.map((d) => {
      if (d.id === id) {
        const update = { ...d };
        if (showInDrawer !== undefined) update.showInDrawer = Boolean(showInDrawer);
        if (isFeatured !== undefined) update.isFeatured = Boolean(isFeatured);
        if (coinsApplicable !== undefined) update.coinsApplicable = Boolean(coinsApplicable);
        if (combineCoupons !== undefined) update.combineCoupons = Boolean(combineCoupons);
        // Which label the drawer/banner ticket's spine shows — "BANK OFFER"
        // (the metal-split additional-% rules) or a plain "DISCOUNT". Purely
        // cosmetic, same as the flags above: no Shopify call needed.
        if (offerLabel !== undefined) update.offerLabel = offerLabel === 'discount' ? 'discount' : 'bank_offer';
        return update;
      }
      return d;
    });
    
    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    return { success: true };
  });

  // POST /api/settings/product-discounts/sync
  // Pulls every code/automatic discount from Shopify (lib/shopifyDiscounts.js)
  // and merges it into the local rules list, matched by shopifyDiscountId. A
  // rule this dashboard already owns (origin: 'dashboard') keeps its own
  // editable/showInDrawer state on re-sync — only genuinely Shopify-native
  // discounts (created directly in Shopify admin) land as read-only.
  fastify.post('/product-discounts/sync', async (request, reply) => {
    const { fetchAllShopifyDiscounts } = require('../lib/shopifyDiscounts');

    try {
      const shopifyDiscounts = await fetchAllShopifyDiscounts();
      const settings = await collection.findOne({ key: 'product_discounts_rules' });
      const existingDiscounts = settings?.discounts || [];
      const nextDiscounts = [...existingDiscounts];

      let created = 0;
      let updated = 0;

      for (const sd of shopifyDiscounts) {
        // Bxgy / free-shipping discounts aren't representable in our rule
        // shape (no discountType/discountValue/appliesTo) — skip them, same
        // as the dashboard only ever creates Basic code/automatic discounts.
        if (!sd.editable) continue;

        const existingIndex = nextDiscounts.findIndex((d) => d.shopifyDiscountId === sd.shopifyDiscountId);
        const existing = existingIndex >= 0 ? nextDiscounts[existingIndex] : null;
        const isDashboardOwned = existing?.origin === 'dashboard';

        const merged = {
          id: existing?.id || `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          shopifyDiscountId: sd.shopifyDiscountId,
          title: sd.title,
          method: sd.method,
          discountType: sd.discountType,
          discountValue: sd.discountValue,
          appliesTo: sd.appliesTo,
          selectedCollections: sd.selectedCollections,
          selectedProducts: sd.selectedProducts,
          minRequirement: sd.minRequirement,
          minRequirementValue: sd.minRequirementValue,
          startsAt: sd.startsAt,
          endsAt: sd.endsAt,
          active: sd.shopifyStatus === 'ACTIVE',
          showInDrawer: existing?.showInDrawer || false,
          isFeatured: existing?.isFeatured || false,
          // Dashboard-only stacking flags. Shopify knows nothing about them, so
          // like the two above they have to be carried across a re-sync — a
          // plain rebuild from `sd` would silently reset every rule's
          // "Lucira Coins applicable" / "Combine coupons" to off.
          coinsApplicable: existing?.coinsApplicable || false,
          combineCoupons: existing?.combineCoupons || false,
          offerLabel: existing?.offerLabel === 'discount' ? 'discount' : 'bank_offer',
          // Editability is a structural property of the Shopify discount type
          // (DiscountCodeBasic/DiscountAutomaticBasic — the only types our
          // mutations support), not of who happened to create it. The loop
          // above already skipped anything sd.editable is false for, so
          // everything reaching here genuinely can be edited from here —
          // gating this on origin instead made every Shopify-native discount
          // (the vast majority of the catalog) permanently read-only.
          editable: true,
          origin: isDashboardOwned ? 'dashboard' : 'shopify',
          lastSyncedAt: new Date().toISOString(),
          // selectedCollections/selectedProducts just above came straight from
          // Shopify's own live customerGets.items, so right after a sync they
          // ARE what's resolved by construction — leaving these two off (as
          // this object used to) meant the dashboard's "0 products resolved"
          // warning fired on every re-synced rule regardless of its real state.
          resolvedCollectionsCount: sd.selectedCollections?.length || 0,
          resolvedProductsCount: sd.selectedProducts?.length || 0,
        };

        if (existingIndex >= 0) {
          nextDiscounts[existingIndex] = merged;
          updated++;
        } else {
          nextDiscounts.push(merged);
          created++;
        }
      }

      // A discount deleted directly in Shopify admin (not just deactivated —
      // deactivated ones still come back from fetchAllShopifyDiscounts with
      // shopifyStatus !== 'ACTIVE') stops appearing in the fetched list
      // entirely. Drop any local record that's still pointing at a
      // shopifyDiscountId no longer live, so the dashboard can't keep
      // showing/managing a discount that no longer exists to sync against.
      // Built from the full unfiltered list (not just sd.editable ones) so a
      // Bxgy/FreeShipping discount — which we never store locally anyway —
      // can't be mistaken for "deleted" here.
      const liveShopifyIds = new Set(shopifyDiscounts.map((sd) => sd.shopifyDiscountId));
      const beforeDelete = nextDiscounts.length;
      const survivingDiscounts = nextDiscounts.filter(
        (d) => !d.shopifyDiscountId || liveShopifyIds.has(d.shopifyDiscountId)
      );
      const removed = beforeDelete - survivingDiscounts.length;

      await collection.updateOne(
        { key: 'product_discounts_rules' },
        { $set: { discounts: survivingDiscounts, updatedAt: new Date() } },
        { upsert: true }
      );

      const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
      invalidateProductDiscountsCache();

      return reply.send({ success: true, created, updated, removed });
    } catch (err) {
      fastify.log.error('Product discount sync failed: ' + err.message);
      return reply.code(500).send({ error: 'Sync failed', message: err.message });
    }
  });
}

module.exports = routes;
