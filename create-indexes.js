const { MongoClient } = require('mongodb');

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lucira';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();
    
    console.log('Creating indexes...');
    await db.collection('abandoned_carts').createIndex({ updatedAt: -1 });
    await db.collection('user_tracking').createIndex({ timestamp: -1 });
    await db.collection('user_tracking').createIndex({ type: 1, timestamp: -1 });
    console.log('Indexes created successfully!');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

run();
