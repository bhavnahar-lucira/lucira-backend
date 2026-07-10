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


  fastify.get('/local-rates', async (request, reply) => {
    try {
      const db = fastify.mongo.db;
      const rates = await db.collection('rates').findOne({ _id: 'global-rates' });
      
      if (!rates) {
        return {};
      }

      return rates;
    } catch (error) {
      return reply.code(500).send({ error: 'Failed to fetch local rates' });
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
