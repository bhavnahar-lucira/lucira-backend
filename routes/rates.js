/**
 * Metal Rates Routes (Fastify)
 */

const { shopifyStorefrontFetch, shopifyAdminFetch } = require('../lib/shopify');

// ── Metal rates single source of truth: *_rate_history metaobjects ──────────
// The "current" rate is the history entry flagged is_current_rate = true
// (newest by date as a fallback). Yesterday is the newest non-current entry.
// We query ONLY the history type (no *_rates_global) so an inaccessible /
// missing type can never fail the whole query. Self-contained fetch with the
// RW Storefront token (falling back to the plain token) so it doesn't depend on
// lib/shopify's token-selection heuristics. Cached briefly, per metal.
let _goldRatesCache = { data: null, ts: 0 };
let _silverRatesCache = { data: null, ts: 0 };
let _platinumRatesCache = { data: null, ts: 0 };
const RATE_CACHE_MS = 60 * 1000;

async function fetchRateHistoryDirect(metaobjectType, rateKeys) {
  const rawStore = process.env.SHOPIFY_STORE || 'luciraonline';
  const domain = rawStore.includes('.') ? rawStore : rawStore + '.myshopify.com';
  const token =
    process.env.SHOPIFY_RW_STOREFRONT_TOKEN ||
    process.env.STOREFRONT_TOKEN ||
    process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!token) throw new Error('No Storefront token configured');

  const rateFields = rateKeys
    .map((k) => `${k}: field(key: "${k}") { value }`)
    .join('\n        ');
  const query = `query {
    history: metaobjects(type: "${metaobjectType}", first: 250) {
      nodes {
        rate_date: field(key: "rate_date") { value }
        ${rateFields}
        is_current: field(key: "is_current_rate") { value }
      }
    }
  }`;

  const res = await fetch('https://' + domain + '/api/2024-10/graphql.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error('Storefront GraphQL error: ' + JSON.stringify(json.errors).slice(0, 300));
  }
  return (json.data && json.data.history && json.data.history.nodes) || [];
}

// Shared: newest-first history with the flagged current entry and the newest
// non-current entry ("yesterday").
async function getMetalCurrentAndYesterday(metaobjectType, rateKeys) {
  const nodes = await fetchRateHistoryDirect(metaobjectType, rateKeys);
  const hist = nodes
    .map((n) => {
      const entry = {
        date: n.rate_date && n.rate_date.value,
        cur: n.is_current && n.is_current.value,
      };
      for (const k of rateKeys) entry[k] = n[k] && n[k].value;
      return entry;
    })
    .filter((h) => h.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  const current = hist.find((h) => h.cur === 'true') || hist[0] || null;
  const yest = hist.find((h) => h !== current) || null;
  return { current, yest };
}

async function getGoldRatesFromShopify() {
  if (_goldRatesCache.data && Date.now() - _goldRatesCache.ts < RATE_CACHE_MS) {
    return _goldRatesCache.data;
  }
  const { current, yest } = await getMetalCurrentAndYesterday('gold_rate_history', [
    'rate_24k', 'rate_22k', 'rate_18k', 'rate_14k',
  ]);
  const result = {
    gold_price_24k: (current && current.rate_24k) || null,
    gold_price_22k: (current && current.rate_22k) || null,
    gold_price_18k: (current && current.rate_18k) || null,
    gold_price_14k: (current && current.rate_14k) || null,
    gold_price_24k_yesterday: (yest && yest.rate_24k) || null,
  };
  _goldRatesCache = { data: result, ts: Date.now() };
  return result;
}

// Silver mirror of getGoldRatesFromShopify — silver_rate_history metaobject,
// per-gram 999 / 925 rates.
async function getSilverRatesFromShopify() {
  if (_silverRatesCache.data && Date.now() - _silverRatesCache.ts < RATE_CACHE_MS) {
    return _silverRatesCache.data;
  }
  const { current, yest } = await getMetalCurrentAndYesterday('silver_rate_history', [
    'rate_999', 'rate_925',
  ]);
  const result = {
    silver_price_999: (current && current.rate_999) || null,
    silver_price_925: (current && current.rate_925) || null,
    silver_price_999_yesterday: (yest && yest.rate_999) || null,
  };
  _silverRatesCache = { data: result, ts: Date.now() };
  return result;
}

// Platinum mirror — platinum_rate_history metaobject, per-gram 950 / 900 rates.
async function getPlatinumRatesFromShopify() {
  if (_platinumRatesCache.data && Date.now() - _platinumRatesCache.ts < RATE_CACHE_MS) {
    return _platinumRatesCache.data;
  }
  const { current, yest } = await getMetalCurrentAndYesterday('platinum_rate_history', [
    'rate_950', 'rate_900',
  ]);
  const result = {
    platinum_price_950: (current && current.rate_950) || null,
    platinum_price_900: (current && current.rate_900) || null,
    platinum_price_950_yesterday: (yest && yest.rate_950) || null,
  };
  _platinumRatesCache = { data: result, ts: Date.now() };
  return result;
}

async function routes(fastify, options) {
  // GET /api/gold-rates
  // GET /api/platinum-rates
  // GET /api/silver-rates
  // (They all use the same metal_prices metafield)

  fastify.get('/gold-rates', async (request, reply) => {
    const query = `{ shop { metal_prices: metafield(namespace: "DI-GoldPrice", key: "metal_prices") { value } } }`;
    try {
      const data = await shopifyStorefrontFetch(query);
      if (!data?.shop?.metal_prices?.value) return reply.code(404).send({ error: "Rates not found" });
      return JSON.parse(data.shop.metal_prices.value);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  fastify.get('/local-rates', async (request, reply) => {
    try {
      const db = fastify.mongo.db;
      const rates = (await db.collection('rates').findOne({ _id: 'global-rates' })) || {};

      // Gold is powered from the gold_rate_history metaobject (single source of
      // truth). Silver/platinum keep coming from the dashboard doc above.
      try {
        const gold = await getGoldRatesFromShopify();
        if (gold.gold_price_24k) rates.gold_price_24k = gold.gold_price_24k;
        if (gold.gold_price_22k) rates.gold_price_22k = gold.gold_price_22k;
        if (gold.gold_price_18k) rates.gold_price_18k = gold.gold_price_18k;
        if (gold.gold_price_14k) rates.gold_price_14k = gold.gold_price_14k;
        if (gold.gold_price_24k_yesterday) rates.gold_price_24k_yesterday = gold.gold_price_24k_yesterday;
      } catch (e) {
        console.error('[gold-rate] Shopify fetch FAILED, falling back to dashboard value:', e.message);
        if (request.log) request.log.warn('gold shopify rate fetch failed: ' + e.message);
      }

      // Silver / platinum rate pages read these per-gram keys, sourced from the
      // silver_rate_history / platinum_rate_history metaobjects (same single
      // source of truth as gold). The legacy dashboard keys (silver_price_10g,
      // silver_price_1kg, platinum_price) are deliberately left untouched so
      // every other consumer on the site keeps its current numbers.
      try {
        const silver = await getSilverRatesFromShopify();
        if (silver.silver_price_999) rates.silver_price_999 = silver.silver_price_999;
        if (silver.silver_price_925) rates.silver_price_925 = silver.silver_price_925;
        if (silver.silver_price_999_yesterday) rates.silver_price_999_yesterday = silver.silver_price_999_yesterday;
      } catch (e) {
        console.error('[silver-rate] Shopify fetch FAILED, page falls back to dashboard value:', e.message);
        if (request.log) request.log.warn('silver shopify rate fetch failed: ' + e.message);
      }

      try {
        const platinum = await getPlatinumRatesFromShopify();
        if (platinum.platinum_price_950) rates.platinum_price_950 = platinum.platinum_price_950;
        if (platinum.platinum_price_900) rates.platinum_price_900 = platinum.platinum_price_900;
        if (platinum.platinum_price_950_yesterday) rates.platinum_price_950_yesterday = platinum.platinum_price_950_yesterday;
      } catch (e) {
        console.error('[platinum-rate] Shopify fetch FAILED, page falls back to dashboard value:', e.message);
        if (request.log) request.log.warn('platinum shopify rate fetch failed: ' + e.message);
      }

      return rates;
    } catch (error) {
      return reply.code(500).send({ error: 'Failed to fetch local rates' });
    }
  });

  // GET /api/gold-rate-debug — diagnostic: shows exactly what the gold source
  // returns (or the error), bypassing the cache. Safe, read-only.
  fastify.get('/gold-rate-debug', async (request, reply) => {
    _goldRatesCache = { data: null, ts: 0 }; // force fresh fetch
    try {
      const gold = await getGoldRatesFromShopify();
      return { ok: true, source: 'gold_rate_history metaobject', gold };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: e.message });
    }
  });

  // GET /api/rates - used by dashboard
  fastify.get('/rates', async (request, reply) => {
    try {
      const db = fastify.mongo.db;
      const rates = await db.collection('rates').findOne({ _id: 'global-rates' });

      if (!rates) {
        return {
          gold_price_24k: "",
          gold_price_22k: "",
          silver_price_10g: "",
          silver_price_1kg: "",
          platinum_price: ""
        };
      }

      return rates;
    } catch (error) {
      return reply.code(500).send({ error: 'Failed to fetch rates' });
    }
  });

  // POST /api/rates - used by dashboard to update rates
  fastify.post('/rates', async (request, reply) => {
    try {
      const data = request.body;
      const db = fastify.mongo.db;
      const ratesCollection = db.collection('rates');

      const updateDoc = {
        $set: {
          ...data,
          updatedAt: new Date()
        },
      };

      const options = { upsert: true };
      await ratesCollection.updateOne({ _id: 'global-rates' }, updateDoc, options);

      return { success: true, message: 'Rates updated successfully' };
    } catch (error) {
      console.error('Error saving rates:', error);
      return reply.code(500).send({ error: 'Failed to update rates' });
    }
  });

  fastify.get('/platinum-rates', async (request, reply) => {
    // Reuse gold rates logic or specific if different
    return fastify.inject({ method: 'GET', url: '/gold-rates' });
  });

  fastify.get('/silver-rates', async (request, reply) => {
    return fastify.inject({ method: 'GET', url: '/gold-rates' });
  });
}

module.exports = routes;
