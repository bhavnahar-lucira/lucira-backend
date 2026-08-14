const { MongoClient } = require('mongodb');

async function main() {
  const uri = 'mongodb+srv://lucira_db_user:admin1985@cluster0.f1hn1yl.mongodb.net/shopify-app';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('Connected successfully to server');
    const db = client.db('shopify-app');
    const cartsCollection = db.collection('carts');

    const carts = await cartsCollection.find({}).toArray();
    console.log('All Carts in shopify-app:');
    carts.forEach(c => {
      console.log(`- UserID: ${c.userId}, SessionID: ${c.sessionId}, Items Count: ${c.items?.length || 0}`);
      if (c.items && c.items.length > 0) {
        console.log('  Items:', c.items.map(item => ({ title: item.title, id: item.id || item.shopifyId })));
      }
    });
  } catch (err) {
    console.error('Error connecting to database:', err);
  } finally {
    await client.close();
  }
}

main();
