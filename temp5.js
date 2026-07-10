require('dotenv').config();
const { MongoClient } = require('mongodb');

async function check() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('next_local_db');
  
  // Find products that might be "Eterna"
  const products = await db.collection('products').find({
    $or: [
      { handle: /eterna/i },
      { title: /eterna/i },
      { tags: /eterna/i },
      { collectionHandles: /eterna/i },
      { handle: /embrace/i },
      { title: /embrace/i },
      { tags: /embrace/i },
      { collectionHandles: /embrace/i }
    ]
  }).project({ title: 1, handle: 1, tags: 1, collectionHandles: 1, category: 1, type: 1 }).limit(10).toArray();
  
  console.log(JSON.stringify(products, null, 2));
  await client.close();
}
check().catch(console.error);
