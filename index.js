require('dotenv').config();
const fastify = require('fastify')({
  ignoreTrailingSlash: true,
  logger: {
    transport: {
      target: 'pino-pretty'
    }
  },
  bodyLimit: 10485760 // 10MB limit for large imports
});

// Register Plugins
fastify.register(require('@fastify/cors'), {
  origin: true,
  credentials: true 
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
fastify.register(require('./routes/promotions'), { prefix: '/api' });
fastify.register(require('./routes/stores'), { prefix: '/api/stores' });
fastify.register(require('./routes/shopify'), { prefix: '/api/shopify' });
fastify.register(require('./routes/admin'), { prefix: '/api/admin' });

// Start Server
const start = async () => {
  try {
    const port = process.env.PORT || 8080;
    const host = process.env.HOST || '127.0.0.1';
    fastify.addHook('onRequest', async (request, reply) => { console.log('▶ [' + request.method + '] ' + request.url); });
    await fastify.listen({ port, host });
    console.log(`🚀 Lucira Fastify Backend running at http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
