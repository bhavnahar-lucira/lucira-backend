async function routes(fastify, options) {
  fastify.get("/", async (request, reply) => {
    try {
      const pincode = request.query.pincode?.trim();

      if (!pincode || !/^\d{6}$/.test(pincode)) {
        return reply.code(400).send({
          success: false,
          error: "Invalid PIN Code",
        });
      }

      const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 5000);

      const response = await fetch(
        `https://api.postalpincode.in/pincode/${pincode}`,
        {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
          },
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(
          `India Post API responded with status ${response.status}`
        );
      }

      const data = await response.json();

      reply.header(
        "Cache-Control",
        "public, max-age=86400"
      );

      return data;
    } catch (error) {
      fastify.log.error(error);

      return reply.code(500).send({
        success: false,
        error: "Unable to fetch pincode details",
      });
    }
  });
}

module.exports = routes;