/**
 * Metal Rates Routes (Fastify)
 */

const { shopifyStorefrontFetch } = require('../lib/shopify');

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

  fastify.get('/platinum-rates', async (request, reply) => {
    // Reuse gold rates logic or specific if different
    return fastify.inject({ method: 'GET', url: '/gold-rates' });
  });

  fastify.get('/silver-rates', async (request, reply) => {
    return fastify.inject({ method: 'GET', url: '/gold-rates' });
  });
}

module.exports = routes;
