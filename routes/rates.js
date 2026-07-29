/**
 * Metal Rates Routes (Fastify)
 */

const { shopifyStorefrontFetch, shopifyAdminFetch } = require('../lib/shopify');

// ── Gold single source of truth: gold_rate_history metaobject ────────────────
// The "current" gold rate is the history entry flagged is_current_rate = true
// (newest by date as a fallback). Yesterday is the newest non-current entry.
// We query ONLY gold_rate_history (no gold_rates_global) so an inaccessible /
// missing type can never fail the whole query. Self-contained fetch with the
// RW Storefront token (falling back to the plain token) so it doesn't depend on
// lib/shopify's token-selection heuristics. Cached briefly.
let _goldRatesCache = { data: null, ts: 0 };
const GOLD_CACHE_MS = 60 * 1000;

async function fetchGoldHistoryDirect() {
  const rawStore = process.env.SHOPIFY_STORE || 'luciraonline';
  const domain = rawStore.includes('.') ? rawStore : rawStore + '.myshopify.com';
  const token =
    process.env.SHOPIFY_RW_STOREFRONT_TOKEN ||
    process.env.STOREFRONT_TOKEN ||
    process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!token) throw new Error('No Storefront token configured');

  const query = `query {
    history: metaobjects(type: "gold_rate_history", first: 250) {
      nodes {
        rate_date: field(key: "rate_date") { value }
        rate_24k: field(key: "rate_24k") { value }
        rate_22k: field(key: "rate_22k") { value }
        rate_18k: field(key: "rate_18k") { value }
        rate_14k: field(key: "rate_14k") { value }
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

async function getGoldRatesFromShopify() {
  if (_goldRatesCache.data && Date.now() - _goldRatesCache.ts < GOLD_CACHE_MS) {
    return _goldRatesCache.data;
  }
  const nodes = await fetchGoldHistoryDirect();
  const hist = nodes
    .map((n) => ({
      date: n.rate_date && n.rate_date.value,
      r24: n.rate_24k && n.rate_24k.value,
      r22: n.rate_22k && n.rate_22k.value,
      r18: n.rate_18k && n.rate_18k.value,
      r14: n.rate_14k && n.rate_14k.value,
      cur: n.is_current && n.is_current.value,
    }))
    .filter((h) => h.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  const current = hist.find((h) => h.cur === 'true') || hist[0] || null;
  const yest = hist.find((h) => h !== current) || null;
  const result = {
    gold_price_24k: (current && current.r24) || null,
    gold_price_22k: (current && current.r22) || null,
    gold_price_18k: (current && current.r18) || null,
    gold_price_14k: (current && current.r14) || null,
    gold_price_24k_yesterday: (yest && yest.r24) || null,
  };
  _goldRatesCache = { data: result, ts: Date.now() };
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
