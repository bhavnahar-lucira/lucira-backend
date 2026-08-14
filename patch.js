const fs = require('fs');

const targetFile = 'd:\\versal-live\\lucira-backend\\routes\\products.js';
let content = fs.readFileSync(targetFile, 'utf8');

const newSearchEndpoint = `
  // GET /api/products/search
  fastify.get('/search', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://server.lucirajewelry.com';
      
      // We must pass on the query parameters verbatim to the expo search api
      const queryString = new URLSearchParams(request.query).toString();
      
      const response = await fetch(\`\${EXPO_API}/api/search?\${queryString}\`);
      if (!response.ok) {
        throw new Error(\`Search API error: \${response.status}\`);
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Search failed" });
    }
  });
`;

const newFiltersEndpoint = `
  // GET /api/products/filters
  fastify.get('/filters', async (request, reply) => {
    try {
      const EXPO_API = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://server.lucirajewelry.com';
      const queryString = new URLSearchParams(request.query).toString();
      
      const response = await fetch(\`\${EXPO_API}/api/search?\${queryString}&lite=true\`);
      if (!response.ok) {
        throw new Error(\`Search API error: \${response.status}\`);
      }
      
      const data = await response.json();
      // Only return the filters map
      return data.filters || {};
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Filters fetch failed" });
    }
  });
`;

content = content.replace(/\s*\/\/\s*GET \/api\/products\/search[\s\S]*?(?=\s*\/\/\s*GET \/api\/products\/bestsellers)/, newSearchEndpoint);

content = content.replace(/\s*\/\/\s*GET \/api\/products\/filters[\s\S]*?(?=\s*\/\/\s*GET \/api\/products\/|\};)/, newFiltersEndpoint);

fs.writeFileSync(targetFile, content);
console.log('Successfully patched products.js');
