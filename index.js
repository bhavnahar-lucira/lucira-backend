const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { clearAllCache } = require('./lib/cache');
const fastify = require('fastify')({
  ignoreTrailingSlash: true,
  pluginTimeout: 30000,
  logger: true,
  bodyLimit: 10485760
});

// Register Plugins
fastify.register(require('@fastify/cors'), {
  origin: true,
  credentials: true,
  methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']
});

fastify.register(require('@fastify/mongodb'), {
  forceClose: true,
  url: process.env.MONGODB_URI
});

fastify.register(require('@fastify/multipart'), {
  limits: {
    fileSize: 5242880 // 5MB
  }
});

// Health Check
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Route Registration
fastify.register(require('./routes/cart'), { prefix: '/api/cart' });
fastify.register(require('./routes/wishlist'), { prefix: '/api/wishlist' });
fastify.register(require('./routes/pincodes'), { prefix: '/api/pincodes' });
fastify.register(require('./routes/settings'), { prefix: '/api/settings' });
fastify.register(require('./routes/stores'), { prefix: '/api/stores' });
fastify.register(require('./routes/shopify'), { prefix: '/api/shopify' });
fastify.register(require('./routes/admin'), { prefix: '/api/admin' });
fastify.register(require('./routes/collection'), { prefix: '/api/collection' });
fastify.register(require('./routes/products'), { prefix: '/api/products' });
fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
fastify.register(require('./routes/customer'), { prefix: '/api/customer' });
fastify.register(require('./routes/reviews'), { prefix: '/api/reviews' });
fastify.register(require('./routes/webhooks'), { prefix: '/api/webhooks' });
// Global API group (no sub-prefix beyond /api)
fastify.register(async (instance) => {
  instance.register(require('./routes/promotions'));
  instance.register(require('./routes/rates'));
  instance.register(require('./routes/social'));
  instance.register(require('./routes/checkout'));
}, { prefix: '/api' });

// Cache Clearing Endpoint
fastify.get('/api/clear-cache', async (request, reply) => {
  clearAllCache();
  console.log("🧹 Fastify cache cleared via API");
  return { success: true, message: "Backend cache cleared" };
});

// Start Server
const start = async () => {
  try {
    const port = process.env.PORT || 8080;
    const host = process.env.HOST || '0.0.0.0';
    fastify.addHook('onRequest', async (request, reply) => { console.log('▶ [' + request.method + '] ' + request.url); });
    await fastify.listen({ port, host });
    console.log(`🚀 Lucira Fastify Backend running at http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
