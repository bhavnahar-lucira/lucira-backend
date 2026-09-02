/**
 * Settings Routes (Fastify)
 */

const SHOPIFY_CDN = 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files';

// Defaults for GET /api/settings/plp-banners — copied verbatim from the
// constants that used to live in the storefront's CollectionPageClient.js
// (CUSTOM_COLLECTION_BANNERS, PLAIN_GOLD_HANDLES/PLAIN_GOLD_BANNER_IMAGE, the
// heroBannerSrc handle-ternary, and INPAGE_BANNERS). Until the `plp_banners`
// doc is saved once from the dashboard, the PLP renders exactly as before.
const PLP_BANNER_DEFAULTS = {
  topBanner: {
    default: {
      desktopImage: `${SHOPIFY_CDN}/Offer-Mobile1.jpg?v=1787998995`,
      mobileImage: `${SHOPIFY_CDN}/Offer-Mobile1.jpg?v=1787998995`,
      alt: 'Offers',
    },
    overrides: [
      // Full-width creatives that replace the default pink layout.
      { id: 'ov_eterna', handles: ['eterna'], layout: 'fullwidth', alt: 'Embrace',
        desktopImage: `${SHOPIFY_CDN}/Embrace_Banner_Desktop_PLP_jpg.jpg?v=1783673522`,
        mobileImage: `${SHOPIFY_CDN}/Embrace_Banner_Mobile_PLP_jpg.jpg?v=1783673523` },
      { id: 'ov_hexa', handles: ['hexa'], layout: 'fullwidth', alt: 'Hexa',
        desktopImage: `${SHOPIFY_CDN}/Hexa-Desktop.jpg?v=1783767788`,
        mobileImage: `${SHOPIFY_CDN}/Hexa-Mobile.jpg?v=1783767788` },
      { id: 'ov_cotton_candy', handles: ['cotton-candy'], layout: 'fullwidth', alt: 'Cotton Candy',
        desktopImage: `${SHOPIFY_CDN}/CC-Desktop.jpg?v=1783767788`,
        mobileImage: `${SHOPIFY_CDN}/CC-Mobile.jpg?v=1783767788` },
      { id: 'ov_sports', handles: ['sports-collection'], layout: 'fullwidth', alt: 'On The Move',
        desktopImage: `${SHOPIFY_CDN}/OTM-Desktop.jpg?v=1783767788`,
        mobileImage: `${SHOPIFY_CDN}/OTM-Mobile.jpg?v=1783767788` },
      // Plain-gold sub-collections share one strip creative.
      { id: 'ov_plain_gold', layout: 'strip', alt: 'Gold Jewellery Offer',
        handles: ['gold-jewelry', 'gold-rings', 'gold-chains', 'gold-earrings', 'gold-bracelets', 'gold-necklaces', 'gold-coins'],
        desktopImage: `${SHOPIFY_CDN}/Offer-Gold_jpg_44047036-a66f-4e34-8332-f226a6d24073.jpg`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Gold_jpg_44047036-a66f-4e34-8332-f226a6d24073.jpg` },
      { id: 'ov_earrings', handles: ['earrings'], layout: 'strip', alt: 'Earrings Offer',
        desktopImage: `${SHOPIFY_CDN}/Offer-Mobile-Product-3_f6e49a5f-f9a3-4af7-9fca-c9bce18aa4c4.jpg`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Mobile-Product-3_f6e49a5f-f9a3-4af7-9fca-c9bce18aa4c4.jpg` },
      { id: 'ov_all_earrings', handles: ['all-earrings'], layout: 'strip', alt: 'Earrings Offer',
        desktopImage: `${SHOPIFY_CDN}/Offer-Mobile-Product1_jpg.jpg?v=1787210650`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Mobile-Product1_jpg.jpg?v=1787210650` },
      { id: 'ov_bestsellers', handles: ['bestsellers'], layout: 'strip', alt: 'Bestsellers Offer',
        desktopImage: `${SHOPIFY_CDN}/Offer-Mobile-Product_8ddc9bb5-09ff-46f1-bf24-e3b1b5172a80.jpg`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Mobile-Product_8ddc9bb5-09ff-46f1-bf24-e3b1b5172a80.jpg` },
    ],
  },
  // Cards injected into the product grid (after the 6th product, then every 10),
  // shown in order, cycling. Creative B is still the TODO(banner) placeholder.
  inpageBanners: [
    { id: 'ip_a', src: `${SHOPIFY_CDN}/Desktop-Inpage_3_eaa604a9-de30-4c5c-be84-ab17a0812a15.jpg`, alt: 'Promo', href: '/collections/rakhi' },
    { id: 'ip_b', src: `${SHOPIFY_CDN}/Desktop-Inpage_3_eaa604a9-de30-4c5c-be84-ab17a0812a15.jpg`, alt: 'Promo', href: '/collections/rakhi' },
  ],
};

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('settings');

  // Fire-and-forget ISR revalidation after a PLP-banner save, so edits show up
  // on the storefront within seconds instead of waiting out the 24h `revalidate`
  // window. Fires the wildcard `collections` call (covers the shared default
  // banner, which affects every collection page) plus a per-handle call for
  // each overridden collection (reliable even where the wildcard form isn't).
  // Never throws.
  const revalidateCollections = async (value) => {
    const frontendUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const endpoint = `${frontendUrl}/api/revalidate`;
    const post = (body) => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});

    const handles = [...new Set(
      (value?.topBanner?.overrides || []).flatMap((o) => o.handles || [])
    )];
    try {
      await Promise.all([
        post({ type: 'collections' }),
        ...handles.map((h) => post({ type: 'collection', handle: h })),
      ]);
      fastify.log.info(`[PLP Banners] Triggered revalidation (all collections + ${handles.length} handles)`);
    } catch (err) {
      fastify.log.error('[PLP Banners] Revalidation ping failed: ' + err.message);
    }
  };

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

  // GET /api/settings/plp-banners
  // Drives the collection/PLP top banner (global default + per-collection
  // overrides) and the in-grid promo banners. Falls back to PLP_BANNER_DEFAULTS
  // so the storefront renders identically before the first save.
  fastify.get('/plp-banners', async () => {
    const settings = await collection.findOne({ key: 'plp_banners' });
    const stored = settings?.value;
    return {
      topBanner: {
        default: stored?.topBanner?.default || PLP_BANNER_DEFAULTS.topBanner.default,
        overrides: Array.isArray(stored?.topBanner?.overrides)
          ? stored.topBanner.overrides
          : PLP_BANNER_DEFAULTS.topBanner.overrides,
      },
      inpageBanners: Array.isArray(stored?.inpageBanners)
        ? stored.inpageBanners
        : PLP_BANNER_DEFAULTS.inpageBanners,
    };
  });

  // POST /api/settings/plp-banners
  fastify.post('/plp-banners', async (request, reply) => {
    const { topBanner, inpageBanners } = request.body || {};
    if (!topBanner || typeof topBanner !== 'object' || Array.isArray(topBanner)) {
      return reply.code(400).send({ error: 'topBanner must be an object' });
    }
    if (!Array.isArray(topBanner.overrides)) {
      return reply.code(400).send({ error: 'topBanner.overrides must be an array' });
    }
    if (!Array.isArray(inpageBanners)) {
      return reply.code(400).send({ error: 'inpageBanners must be an array' });
    }

    const str = (v) => String(v || '').trim();
    const value = {
      topBanner: {
        default: {
          desktopImage: str(topBanner.default?.desktopImage),
          mobileImage: str(topBanner.default?.mobileImage),
          alt: str(topBanner.default?.alt),
        },
        overrides: topBanner.overrides.map((o, i) => ({
          id: str(o.id) || `ov_${Date.now()}_${i}`,
          handles: Array.isArray(o.handles) ? o.handles.map(str).filter(Boolean) : [],
          layout: o.layout === 'fullwidth' ? 'fullwidth' : 'strip',
          desktopImage: str(o.desktopImage),
          mobileImage: str(o.mobileImage),
          alt: str(o.alt),
        })),
      },
      inpageBanners: inpageBanners.map((b, i) => ({
        id: str(b.id) || `ip_${Date.now()}_${i}`,
        src: str(b.src),
        alt: str(b.alt) || 'Promo',
        href: str(b.href) || '/',
      })),
    };

    await collection.updateOne(
      { key: 'plp_banners' },
      { $set: { value, updatedAt: new Date() } },
      { upsert: true }
    );

    revalidateCollections(value); // fire-and-forget
    return { success: true };
  });

  // ------------------------------------------------------------------
  // Dispatch / delivery-estimate config
  // ------------------------------------------------------------------
  // Drives the "In stock. Estimated dispatch by ..." / "Made to order..."
  // line on the PDP, cart, checkout summary and shipping page (storefront
  // reads it via /lib/utils formatDispatchMessage + the useDispatchInfo hook).
  // DISPATCH_DEFAULTS reproduces the behaviour that used to be hardcoded in
  // the storefront's getEstimatedDispatchDate, so the line renders identically
  // before the first save from the dashboard.
  const DISPATCH_DEFAULTS = {
    enabled: true,
    timezone: 'Asia/Kolkata',
    // A rollover date that lands on a Sunday is bumped to Monday when true.
    excludeSundays: false,
    inStock: {
      label: 'In stock',
      // Orders before this IST time dispatch after `beforeCutoffDays`,
      // orders after it dispatch after `afterCutoffDays`.
      cutoffHour: 12,
      cutoffMinute: 0,
      beforeCutoffDays: 0,
      afterCutoffDays: 1,
      // {date} is replaced with the computed dispatch date (dateFormat).
      template: 'Estimated dispatch by {date}',
      dateFormat: 'MMM D, YYYY',
      // Live countdown to today's cutoff. {countdown} -> "3h 24m",
      // {date} -> the same dispatch date as above.
      timerEnabled: true,
      timerTemplate: 'Order dispatches within {countdown} hrs',
    },
    madeToOrder: {
      label: 'Made to order',
      // Per-product `lead_time` metafield overrides leadDays when present.
      leadDays: 12,
      bufferDays: 3,
      template: 'Estimated dispatch by {date}',
      dateFormat: 'MMM D, YYYY',
      timerEnabled: false,
      timerTemplate: '',
    },
  };

  const clampInt = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const str = (v, fallback) => {
    const s = String(v ?? '').trim();
    return s || fallback;
  };

  const mergeDispatchConfig = (stored) => {
    const s = stored || {};
    const inS = s.inStock || {};
    const mto = s.madeToOrder || {};
    return {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : DISPATCH_DEFAULTS.enabled,
      timezone: str(s.timezone, DISPATCH_DEFAULTS.timezone),
      excludeSundays: Boolean(s.excludeSundays),
      inStock: {
        label: str(inS.label, DISPATCH_DEFAULTS.inStock.label),
        cutoffHour: clampInt(inS.cutoffHour, 0, 23, DISPATCH_DEFAULTS.inStock.cutoffHour),
        cutoffMinute: clampInt(inS.cutoffMinute, 0, 59, DISPATCH_DEFAULTS.inStock.cutoffMinute),
        beforeCutoffDays: clampInt(inS.beforeCutoffDays, 0, 60, DISPATCH_DEFAULTS.inStock.beforeCutoffDays),
        afterCutoffDays: clampInt(inS.afterCutoffDays, 0, 60, DISPATCH_DEFAULTS.inStock.afterCutoffDays),
        template: str(inS.template, DISPATCH_DEFAULTS.inStock.template),
        dateFormat: str(inS.dateFormat, DISPATCH_DEFAULTS.inStock.dateFormat),
        timerEnabled: typeof inS.timerEnabled === 'boolean' ? inS.timerEnabled : DISPATCH_DEFAULTS.inStock.timerEnabled,
        timerTemplate: str(inS.timerTemplate, DISPATCH_DEFAULTS.inStock.timerTemplate),
      },
      madeToOrder: {
        label: str(mto.label, DISPATCH_DEFAULTS.madeToOrder.label),
        leadDays: clampInt(mto.leadDays, 0, 365, DISPATCH_DEFAULTS.madeToOrder.leadDays),
        bufferDays: clampInt(mto.bufferDays, 0, 90, DISPATCH_DEFAULTS.madeToOrder.bufferDays),
        template: str(mto.template, DISPATCH_DEFAULTS.madeToOrder.template),
        dateFormat: str(mto.dateFormat, DISPATCH_DEFAULTS.madeToOrder.dateFormat),
        timerEnabled: typeof mto.timerEnabled === 'boolean' ? mto.timerEnabled : DISPATCH_DEFAULTS.madeToOrder.timerEnabled,
        timerTemplate: str(mto.timerTemplate, DISPATCH_DEFAULTS.madeToOrder.timerTemplate),
      },
    };
  };

  // GET /api/settings/dispatch
  fastify.get('/dispatch', async () => {
    const settings = await collection.findOne({ key: 'dispatch_config' });
    return mergeDispatchConfig(settings?.value);
  });

  // POST /api/settings/dispatch
  fastify.post('/dispatch', async (request, reply) => {
    const value = mergeDispatchConfig(request.body || {});
    await collection.updateOne(
      { key: 'dispatch_config' },
      { $set: { value, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true, value };
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
      // Carve-outs from the selection above. Shopify's discount model can't
      // express an exclusion, so this never round-trips through Shopify —
      // cartPricing/coupon-validate are what honour it.
      excludedCollections: Array.isArray(d.excludedCollections) ? d.excludedCollections : [],
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
      // Carve-outs from the selection above. Shopify has no exclusion field,
      // so this stays local: keep whatever the rule already had when a save
      // arrives without it (e.g. an older dashboard build).
      excludedCollections: Array.isArray(body.excludedCollections)
        ? body.excludedCollections
        : (previousRule?.excludedCollections || []),
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
          // Local-only, like the stacking flags below — Shopify can't store an
          // exclusion, so a re-sync must carry it across or every rule's
          // carve-outs would silently reset to none.
          excludedCollections: existing?.excludedCollections || [],
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
