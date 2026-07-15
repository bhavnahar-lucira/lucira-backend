/**
 * Store Locations Routes (Fastify)
 */

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const collection = db.collection('stores');
  const { shopifyAdminFetch } = require('../lib/shopify');

  // GET /api/stores
  // Only return stores that are active on Shopify. Inactive locations (e.g. a
  // deactivated Lajpat Nagar) are still synced into Mongo with isActive: false,
  // so they must be filtered out here. { $ne: false } also keeps any legacy
  // records that predate the isActive field.
  fastify.get('/', async () => {
    const stores = await collection.find({ isActive: { $ne: false } }).toArray();
    return { success: true, stores };
  });

  // POST /api/stores/sync-shopify
  fastify.post('/sync-shopify', async (request, reply) => {
    try {
      const query = 'query { locations(first: 50) { edges { node { id name isActive address { address1 address2 city zip country province phone } metafields(first: 20) { edges { node { key value namespace } } } } } } }';
      
      const data = await shopifyAdminFetch(query);
      const locations = data?.locations?.edges || [];

      if (locations.length === 0) return { success: true, message: 'No locations found', count: 0 };

      const processedStores = locations.map(({ node: loc }) => {
        const metafields = {};
        loc.metafields?.edges?.forEach(({ node: m }) => {
          metafields[m.key] = m.value;
        });

        return {
          shopifyId: loc.id,
          name: loc.name,
          isActive: loc.isActive,
          address: (loc.address.address1 || '') + ' ' + (loc.address.address2 || '') + ', ' + (loc.address.city || '') + ', ' + (loc.address.province || '') + ' - ' + (loc.address.zip || ''),
          zip: loc.address.zip,
          phone: loc.address.phone || metafields.phone || '',
          latitude: parseFloat(metafields.latitude || 0),
          longitude: parseFloat(metafields.longitude || 0),
          mapLink: metafields.store_location || metafields.map_link || metafields.maplink || '',
          image: metafields.image_url || metafields.image || '',
          updatedAt: new Date()
        };
      });

      // Upsert all stores
      for (const store of processedStores) {
        await collection.updateOne(
          { shopifyId: store.shopifyId },
          { $set: store },
          { upsert: true }
        );
      }

      return { success: true, message: 'Stores synced from Shopify', count: processedStores.length };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
