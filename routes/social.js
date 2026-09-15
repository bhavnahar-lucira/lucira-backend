/**
 * Social and Newsletter Routes (Fastify)
 */

const { shopifyAdminFetch } = require('../lib/shopify');

const INSTAGRAM_ACCESS_TOKEN = "IGAAVJNIZC9IvtBZAFpuQ05oZAEJNeUh2RU80MUxGbENadVZAObF93MEhmOENDNTQ3RXBwZA3pIQXZAhZAFN5UzZAQVklaOEYySm80Ym5WUFFPX2FwVndSSF9uTTRXZA3Itc1BQcDdua2xNYURma2I3TDZAhNnlnaWNfTDNFbGQxTVlYTGQ2cwZDZD";

async function routes(fastify, options) {
  
  // GET /api/instagram
  fastify.get('/instagram', async (request, reply) => {
    try {
      const response = await fetch(`https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url,permalink,thumbnail_url,timestamp&access_token=${INSTAGRAM_ACCESS_TOKEN}&limit=30`);
      if (!response.ok) return reply.code(response.status).send({ error: "Failed to fetch Instagram" });
      const data = await response.json();
      return data.data.map(item => ({
        id: item.id,
        image: item.media_type === "VIDEO" ? item.thumbnail_url : item.media_url,
        mediaUrl: item.media_url,
        isVideo: item.media_type === "VIDEO",
        caption: item.caption || "",
        permalink: item.permalink,
        timestamp: item.timestamp
      }));
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/newsletter
  fastify.post('/newsletter', async (request, reply) => {
    const { email } = request.body;
    if (!email) return reply.code(400).send({ error: "Email required" });

    const mutation = `mutation customerCreate($input: CustomerInput!) { customerCreate(input: $input) { customer { id email } userErrors { field message } } }`;
    const variables = { input: { email, emailMarketingConsent: { marketingOptInLevel: "SINGLE_OPT_IN", marketingState: "SUBSCRIBED" }, tags: ["newsletter"] } };

    try {
      const data = await shopifyAdminFetch(mutation, variables);
      if (data.customerCreate.userErrors?.length > 0) {
        const emailTaken = data.customerCreate.userErrors.find(err => err.message.toLowerCase().includes("email has already been taken"));
        if (emailTaken) return { success: true, message: "Already subscribed" };
        return reply.code(400).send({ error: data.customerCreate.userErrors[0].message });
      }
      return { success: true, message: "Subscribed successfully" };
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });
}

module.exports = routes;
