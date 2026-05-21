/**
 * Customer Routes (Fastify)
 * Handles profile, avatar, dashboard stats, coins, etc.
 */

const { shopifyAdminFetch } = require('../lib/shopify');

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const avatarCollection = db.collection('customer_avatars');
  const coinsCollection = db.collection('customer_coins');

  // GET /api/customer/profile/avatar
  fastify.get('/profile/avatar', async (request, reply) => {
    // Usually we'd get the userId from a session/cookie
    // For now, return a placeholder or look up by a query param if provided
    const { userId } = request.query;
    if (!userId) return { avatar: null };

    const record = await avatarCollection.findOne({ userId });
    return { avatar: record?.avatarUrl || null };
  });

  // POST /api/customer/profile/avatar
  fastify.post('/profile/avatar', async (request, reply) => {
    const data = await request.file();
    // Logic to upload to Shopify or S3 and save to MongoDB
    // For now, return a success placeholder
    return { success: true, url: "https://via.placeholder.com/150" };
  });

  // GET /api/customer/dashboard-stats
  fastify.get('/dashboard-stats', async (request, reply) => {
    return {
      points: 450,
      orders: 2,
      wishlist: 5
    };
  });

  // GET /api/customer/nector-coins
  fastify.get('/nector-coins', async (request, reply) => {
    return { balance: 450, history: [] };
  });

  // GET /api/customer/profile
  fastify.get('/profile', async (request, reply) => {
    // This is often used as a session check.
    return { 
      success: true, 
      customer: { id: "gid://shopify/Customer/0", firstName: "User", lastName: "", email: "", phone: "" } 
    };
  });

  // GET /api/customer/orders
  fastify.get('/orders', async (request, reply) => {
    return { success: true, orders: [] };
  });

  // PATCH /api/customer/profile
  fastify.patch('/profile', async (request, reply) => {
    const { firstName, lastName, phone } = request.body;
    // Update Shopify Customer
    return { success: true };
  });

  // GET /api/customer/referral
  fastify.get('/referral', async (request, reply) => {
    return { referralCode: "LUCIRA123", stats: { totalReferrals: 0, earned: 0 } };
  });

  // GET /api/customer/returns
  fastify.get('/returns', async (request, reply) => {
    return { returns: [] };
  });
}

module.exports = routes;
