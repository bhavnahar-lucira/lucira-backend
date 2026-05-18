/**
 * Promotions & UI Content Routes (Fastify)
 */

async function routes(fastify, options) {
  const db = fastify.mongo.db;

  fastify.get('/announcements', async () => {
    const settings = await db.collection('announcements').findOne({ key: 'global_settings' });
    return { announcements: settings?.announcements || [], isVisible: settings?.isVisible ?? true };
  });

  fastify.get('/home-reviews', async () => {
    const reviews = await db.collection('home_reviews').find({ isVisible: true }).limit(10).toArray();
    return { reviews };
  });

  fastify.get('/curated-looks', async () => {
    const looks = await db.collection('curated_looks').find({}).toArray();
    return { success: true, looks: looks.map(l => ({ ...l, id: l._id, image: l.image || '' })) };
  });

  fastify.post('/curated-looks', async (request, reply) => {
    const looks = request.body;
    if (!Array.isArray(looks)) return reply.code(400).send({ error: 'Array expected' });
    await db.collection('curated_looks').deleteMany({});
    if (looks.length > 0) {
      const cleanLooks = looks.map(l => {
        const { _id, id, ...rest } = l;
        return {
          name: l.name || '',
          image: l.image || '',
          assetName: l.assetName || '',
          href: l.href || '',
          hotspots: l.hotspots || [],
          updatedAt: new Date()
        };
      });
      await db.collection('curated_looks').insertMany(cleanLooks);
    }
    return { success: true };
  });

  fastify.get('/styled-videos', async () => {
    const videos = await db.collection('styled_videos').find({}).toArray();
    return { success: true, videos: videos.map(v => ({ ...v, id: v._id, video: v.video || '' })) };
  });

  fastify.post('/styled-videos', async (request, reply) => {
    const videos = request.body;
    if (!Array.isArray(videos)) return reply.code(400).send({ error: 'Array expected' });
    await db.collection('styled_videos').deleteMany({});
    if (videos.length > 0) {
      const cleanVideos = videos.map(v => {
        const { _id, id, ...rest } = v;
        return {
          video: v.video || '',
          products: v.products || [],
          totalPrice: v.totalPrice || '?0',
          updatedAt: new Date()
        };
      });
      await db.collection('styled_videos').insertMany(cleanVideos);
    }
    return { success: true };
  });
}

module.exports = routes;
