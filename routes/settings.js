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
}

module.exports = routes;
