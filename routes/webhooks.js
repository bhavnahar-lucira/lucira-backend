/**
 * Webhooks Route (Fastify)
 */
const { clearAllCache } = require('../lib/cache');

async function routes(fastify, options) {

  // POST /api/webhooks/shopify/products
  fastify.post('/shopify/products', async (request, reply) => {
    // 1. Acknowledge Shopify Webhook immediately
    reply.code(200).send({ success: true, message: "Webhook received" });

    const payload = request.body || {};
    const handle = payload.handle || null;

    console.log(`[Webhook] Product created/updated: ${handle || "unknown"}`);

    try {
      // 2. Clear all backend caches (prices, configs, collection counts, etc.)
      clearAllCache();
      console.log(`[Webhook] Backend caches cleared for product: ${handle}`);

      // 3. Trigger Next.js Frontend Revalidation
      const frontendUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
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
