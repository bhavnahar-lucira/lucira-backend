/**
 * Webhooks Route (Fastify)
 */
const { clearAllCache } = require('../lib/cache');
const crypto = require('crypto');

async function routes(fastify, options) {

  // Custom parser to save raw body for HMAC verification
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
    try {
      req.rawBody = body; // Save raw body for HMAC
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // POST /api/webhooks/shopify/products
  fastify.post('/shopify/products', async (request, reply) => {
    // 1. Verify Shopify HMAC Signature
    const hmacHeader = request.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

    if (secret && hmacHeader && request.rawBody) {
      const generatedHash = crypto
        .createHmac('sha256', secret)
        .update(request.rawBody, 'utf8')
        .digest('base64');
        
      if (generatedHash !== hmacHeader) {
        console.warn(`[Webhook] Invalid HMAC signature! Expected ${hmacHeader}, got ${generatedHash}`);
        return reply.code(401).send({ error: 'Unauthorized webhook' });
      }
    } else if (secret && !hmacHeader) {
      console.warn(`[Webhook] Missing HMAC header in request.`);
      return reply.code(401).send({ error: 'Missing signature' });
    }

    // 2. Acknowledge Shopify Webhook immediately
    reply.code(200).send({ success: true, message: "Webhook received" });

    const payload = request.body || {};
    const handle = payload.handle || null;

    console.log(`[Webhook] Product created/updated: ${handle || "unknown"}`);

    try {
      // 3. Clear all backend memory caches
      clearAllCache();
      console.log(`[Webhook] Backend memory caches cleared for product: ${handle}`);

      // 4. Trigger Next.js Frontend Revalidation
      const frontendUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      const revalidateEndpoint = `${frontendUrl}/api/revalidate`;

      console.log(`[Webhook] Triggering ISR revalidation at: ${revalidateEndpoint}`);

      // We use the global fetch API (Node 18+)
      const response = await fetch(revalidateEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Optional: 'x-revalidate-secret': process.env.REVALIDATE_SECRET
        },
        body: JSON.stringify({ handle })
      });

      if (!response.ok) {
        console.error(`[Webhook] Frontend revalidation failed with status: ${response.status}`);
      } else {
        console.log(`[Webhook] Frontend successfully revalidated for product: ${handle}`);
      }
    } catch (err) {
      console.error("[Webhook] Error during webhook processing:", err);
    }
  });
}

module.exports = routes;
