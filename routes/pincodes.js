/**
 * Pincode Routes (Fastify)
 */

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('pincodes');

  // GET /api/pincodes
  fastify.get('/', async (request, reply) => {
    const { page = 1, limit = 10, q = '' } = request.query;
    const filter = q ? { pincode: { $regex: q, $options: 'i' } } : {};
    
    const total = await collection.countDocuments(filter);
    const pincodes = await collection
      .find(filter)
      .sort({ pincode: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .toArray();

    return {
      success: true,
      pincodes,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit)
      }
    };
  });

  // POST /api/pincodes/import
  fastify.post('/import', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded' });

    const buffer = await data.toBuffer();
    const text = buffer.toString();
    const lines = text.split("\n").filter(line => line.trim());
    
    if (lines.length <= 1) return reply.code(400).send({ error: 'Empty file' });

    const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
    const csvData = lines.slice(1).map(line => {
      const values = line.split(",").map(v => v.trim());
      const obj = {};
      headers.forEach((header, index) => { obj[header] = values[index]; });
      return obj;
    });

    const operations = csvData.filter(item => item.pincode).map(item => ({
      updateOne: {
        filter: { pincode: item.pincode },
        update: { 
          $set: { 
            ...item,
            latitude: item.latitude ? parseFloat(item.latitude) : undefined,
            longitude: item.longitude ? parseFloat(item.longitude) : undefined,
            cod: item.cod === "true" || item.cod === "1",
            upi: item.upi === "true" || item.upi === "1",
            updatedAt: new Date()
          } 
        },
        upsert: true
      }
    }));

    if (operations.length > 0) {
      await collection.bulkWrite(operations);
    }

    return { success: true, totalProcessed: operations.length };
  });

  // PUT /api/pincodes
  fastify.put('/', async (request, reply) => {
    const { pincode, latitude, longitude, cod, upi } = request.body;
    await collection.updateOne(
      { pincode },
      { 
        $set: { 
          latitude: latitude ? parseFloat(latitude) : undefined,
          longitude: longitude ? parseFloat(longitude) : undefined,
          cod: !!cod,
          upi: !!upi,
          updatedAt: new Date()
        } 
      },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/pincodes/check
  fastify.get('/check', async (request, reply) => {
    const { pincode } = request.query;
    if (!pincode) return reply.code(400).send({ error: 'Pincode required' });
    const result = await collection.findOne({ pincode });
    return { 
      success: true, 
      deliverable: !!result, 
      data: result 
    };
  });
}

module.exports = routes;
