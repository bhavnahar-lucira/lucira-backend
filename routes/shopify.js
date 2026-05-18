/**
 * Shopify Admin Bridge Routes (Fastify)
 * Handles uploads and proxy requests
 */

async function routes(fastify, options) {
  const { shopifyAdminFetch, waitForFileReady } = require('../lib/shopify');

  // POST /api/shopify/upload/staged
  fastify.post('/upload/staged', async (request, reply) => {
    try {
      const { filename, mimeType } = request.body;
      if (!filename || !mimeType) return reply.code(400).send({ error: 'Filename and mimeType required' });

      const query = 'mutation stagedUploadsCreate($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } } }';
      
      const data = await shopifyAdminFetch(query.replace('$', '$'), { 
        input: [{ 
          filename, 
          mimeType, 
          resource: 'FILE', 
          httpMethod: 'POST' 
        }] 
      });

      if (!data || !data.stagedUploadsCreate) {
        throw new Error('Invalid response from Shopify Admin API');
      }

      const { stagedTargets, userErrors } = data.stagedUploadsCreate;

      if (userErrors && userErrors.length > 0) {
        return reply.code(400).send({ error: userErrors[0].message });
      }

      return { stagedTarget: stagedTargets[0] };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/shopify/upload/register
  fastify.post('/upload/register', async (request, reply) => {
    try {
      const { resourceUrl, mimeType, filename } = request.body;
      if (!resourceUrl) return reply.code(400).send({ error: 'resourceUrl required' });

      const query = 'mutation fileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { message } } }';
      
      const data = await shopifyAdminFetch(query.replace('$', '$'), { 
        files: [{ 
          originalSource: resourceUrl, 
          contentType: mimeType.startsWith('image') ? 'IMAGE' : 'FILE', 
          alt: filename 
        }] 
      });

      if (!data || !data.fileCreate) {
        throw new Error('Invalid response from Shopify Admin API');
      }

      const { files, userErrors } = data.fileCreate;

      if (userErrors && userErrors.length > 0) {
        return reply.code(400).send({ error: userErrors[0].message });
      }

      const fileId = files[0].id;
      
      // Wait for Shopify to process the file and provide a public URL
      const finalUrl = await waitForFileReady(fileId);

      return { success: true, url: finalUrl };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
