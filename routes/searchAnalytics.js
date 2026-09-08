module.exports = async function (fastify, options) {
  // Proxy POST /api/analytics/search/start
  fastify.post('/start', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:5000';
      let response;
      for (let i = 0; i < 5; i++) {
        try {
          response = await fetch(`${EXPO_API}/api/analytics/search/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.body || {})
          });
          break;
        } catch (err) {
          if (i === 4) throw err;
          await new Promise(res => setTimeout(res, 300 * Math.pow(2, i) + Math.random() * 100));
        }
      }
      
      const data = await response.json();
      return reply.code(response.status).send(data);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Failed to proxy start search session" });
    }
  });

  // Proxy POST /api/analytics/search/event
  fastify.post('/event', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:5000';
      let response;
      for (let i = 0; i < 5; i++) {
        try {
          response = await fetch(`${EXPO_API}/api/analytics/search/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.body || {})
          });
          break;
        } catch (err) {
          if (i === 4) throw err;
          await new Promise(res => setTimeout(res, 300 * Math.pow(2, i) + Math.random() * 100));
        }
      }
      
      const data = await response.json();
      return reply.code(response.status).send(data);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Failed to proxy search event" });
    }
  });

  // Proxy GET /api/analytics/search/user/:customerId
  fastify.get('/user/:customerId', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:5000';
      let response;
      for (let i = 0; i < 5; i++) {
        try {
          response = await fetch(`${EXPO_API}/api/analytics/search/user/${request.params.customerId}`);
          break;
        } catch (err) {
          if (i === 4) throw err;
          await new Promise(res => setTimeout(res, 300 * Math.pow(2, i) + Math.random() * 100));
        }
      }
      const data = await response.json();
      return reply.code(response.status).send(data);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Failed to proxy user searches" });
    }
  });

  // Proxy GET /api/analytics/search/stats
  fastify.get('/stats', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:5000';
      let response;
      for (let i = 0; i < 5; i++) {
        try {
          response = await fetch(`${EXPO_API}/api/analytics/search/stats`);
          break;
        } catch (err) {
          if (i === 4) throw err;
          await new Promise(res => setTimeout(res, 300 * Math.pow(2, i) + Math.random() * 100));
        }
      }
      const data = await response.json();
      return reply.code(response.status).send(data);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Failed to proxy stats" });
    }
  });

  // Proxy GET /api/analytics/search/:searchId
  fastify.get('/:searchId', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:5000';
      let response;
      for (let i = 0; i < 5; i++) {
        try {
          response = await fetch(`${EXPO_API}/api/analytics/search/${request.params.searchId}`);
          break;
        } catch (err) {
          if (i === 4) throw err;
          await new Promise(res => setTimeout(res, 300 * Math.pow(2, i) + Math.random() * 100));
        }
      }
      const data = await response.json();
      return reply.code(response.status).send(data);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Failed to proxy search funnel" });
    }
  });
};
