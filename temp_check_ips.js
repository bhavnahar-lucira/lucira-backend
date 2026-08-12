const { MongoClient } = require('mongodb');
const uri = "mongodb://localhost:27017/lucira";
async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('lucira');
    const col = db.collection('abandoned_carts');
    const hasIp = await col.countDocuments({ ip: { $exists: true } });
    const noIp = await col.countDocuments({ ip: { $exists: false } });
    console.log(`Carts with IP: ${hasIp}`);
    console.log(`Carts without IP: ${noIp}`);
    const latestWithIp = await col.find({ ip: { $exists: true } }).sort({ updatedAt: -1 }).limit(1).toArray();
    console.log('Latest cart with IP:', JSON.stringify(latestWithIp, null, 2));
  } finally {
    await client.close();
  }
}
run();
