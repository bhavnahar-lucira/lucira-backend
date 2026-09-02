const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { clearAllCache } = require('./lib/cache');
const { startRecoScheduler } = require('./lib/recoScheduler');
const { startSmartSortScheduler } = require('./lib/smartSortScheduler');

const fastify = require('fastify')({
  ignoreTrailingSlash: true,
  pluginTimeout: 30000,
  logger: true,
  bodyLimit: 10485760, // 10MB
  trustProxy: true
});

// ======================
// Plugins
// ======================

fastify.register(require('@fastify/cors'), {
  origin: true,
  credentials: true,
  methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']
});

const mongoUri = process.env.NODE_ENV === 'development' 
  ? (process.env.LOCAL_MONGODB_URI || process.env.MONGODB_URI) 
  : process.env.MONGODB_URI;

fastify.register(require('@fastify/mongodb'), {
  url: mongoUri,
  // @fastify/mongodb defaults this to 7500ms, which is tight for an Atlas
  // replica set: the driver has to reach a seed, do TLS, learn the topology and
  // find a primary — several round trips. On a slow link that overran the
  // budget and startup died with ReplicaSetNoPrimary (all nodes "Unknown",
  // commonWireVersion 0) even though the cluster was healthy. 30s is the
  // MongoDB driver's own default and costs nothing when the network is fine.
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30000)
});

fastify.register(require('@fastify/multipart'), {
  limits: {
    fileSize: 5242880 // 5MB
  }
});

// ======================
// Health Check
// ======================

fastify.get('/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    pid: process.pid
  };
});

// ======================
// Request Logger
// ======================

fastify.addHook('onRequest', async (request) => {
  console.log(`▶ [${process.pid}] ${request.method} ${request.url}`);
});

// ======================
// Routes
// ======================

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
fastify.register(require('./routes/schemes'), { prefix: '/api/customer/schemes' });
fastify.register(require('./routes/schemes-payment'), { prefix: '/api/schemes' });
fastify.register(require('./routes/reviews'), { prefix: '/api/reviews' });
fastify.register(require('./routes/webhooks'), { prefix: '/api/webhooks' });
fastify.register(require('./routes/pincodeLookup'), { prefix: '/api/pincode' });
fastify.register(require('./routes/nitro'), { prefix: '/api/nitro' });
fastify.register(require('./routes/searchAnalytics'), { prefix: '/api/analytics/search' });
fastify.register(require('./routes/recommendations'), { prefix: '/api/recommendations' });
fastify.register(require('./routes/smartCollections'), { prefix: '/api/smart-collections' });
fastify.register(require('./routes/productEvents'), { prefix: '/api/products' });

// Global /api routes
fastify.register(async (instance) => {
  instance.register(require('./routes/promotions'));
  instance.register(require('./routes/rates'));
  instance.register(require('./routes/social'));
  instance.register(require('./routes/checkout'));
}, { prefix: '/api' });

// ======================
// Cache Clear API
// ======================

fastify.get('/api/clear-cache', async () => {
  clearAllCache();

  console.log('🧹 Fastify cache cleared');

  return {
    success: true,
    message: 'Backend cache cleared'
  };
});

// ======================
// Graceful Shutdown
// ======================

const closeGracefully = async (signal) => {
  console.log(`⚠️ Received ${signal}. Closing server gracefully...`);

  try {
    await fastify.close();
    console.log('✅ Fastify closed successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error while closing Fastify:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => closeGracefully('SIGINT'));
process.on('SIGTERM', () => closeGracefully('SIGTERM'));

// ======================
// Start Server
// ======================

const start = async () => {
  try {
    const port = process.env.PORT || 8080;
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({
      port,
      host,
      exclusive: false
    });

    console.log(
      `🚀 Lucira Backend running at http://${host}:${port} | PID: ${process.pid}`
    );

    await startRecoScheduler(fastify);
    await startSmartSortScheduler(fastify);

  } catch (err) {
    console.error('❌ STARTUP ERROR');
    console.error(err);

    fastify.log.error(err);

    process.exit(1);
  }
};

start();