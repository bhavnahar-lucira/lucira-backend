/**
 * Product Events Routes (Fastify)
 *
 * First-party per-product event counters. The storefront is headless, so
 * Shopify web analytics never sees it; GA4 sees everything but is only
 * queryable once service-account credentials exist (lib/ga4.js). This beacon
 * is the always-on fallback and real-time cross-check: the PDP fires one
 * fire-and-forget POST per product view (all traffic, anonymous included) and
 * it lands here as a daily counter.
 *
 * Storage: `product_events` docs { pid: "9024474218714", d: "2026-08-25",
 * v: <views>, atc: <add-to-carts> } — one doc per product per IST day,
 * $inc-upserted. ~2.7k products x 90 days worst case stays tiny.
 */

async function routes(fastify, options) {
  const eventsCol = fastify.mongo.db.collection('product_events');

  // House pattern (routes/admin.js): indexes fire-and-forget at plugin load.
  eventsCol.createIndex({ pid: 1, d: 1 }, { unique: true }).catch(console.error);
  eventsCol.createIndex({ d: 1 }).catch(console.error);

  const normalizeId = (id) => {
    const m = String(id || '').match(/\d+/g);
    return m ? m[m.length - 1] : '';
  };

  // IST calendar date — windows must cut on the store's day, not UTC's.
  const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // POST /api/products/track-view  { productId }
  // Also accepts { type: "atc" } so the cart flow can reuse the same counter.
  fastify.post('/track-view', async (request, reply) => {
    const { productId, type } = request.body || {};
    const pid = normalizeId(productId);
    if (!pid) return reply.code(400).send({ error: 'productId is required' });

    const field = type === 'atc' ? 'atc' : 'v';
    try {
      await eventsCol.updateOne(
        { pid, d: istToday() },
        { $inc: { [field]: 1 } },
        { upsert: true }
      );
      return { success: true };
    } catch (err) {
      // A racing upsert can trip the unique index once; the retry always lands.
      if (err && err.code === 11000) {
        await eventsCol.updateOne({ pid, d: istToday() }, { $inc: { [field]: 1 } });
        return { success: true };
      }
      console.error('[ProductEvents] track-view failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/products/track-view/status — since-when + volume, for the admin
  // dashboard's "data availability" banner.
  fastify.get('/track-view/status', async (request, reply) => {
    try {
      const first = await eventsCol.find().sort({ d: 1 }).limit(1).toArray();
      const totals = await eventsCol.aggregate([
        { $group: { _id: null, views: { $sum: '$v' }, atc: { $sum: '$atc' } } }
      ]).toArray();
      return {
        success: true,
        trackingSince: first[0]?.d || null,
        totalViews: totals[0]?.views || 0,
        totalAtc: totals[0]?.atc || 0
      };
    } catch (err) {
      console.error('[ProductEvents] status failed:', err.message);
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
