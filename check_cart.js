const { MongoClient } = require('mongodb'); 
async function run() { 
  let client;
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://lucira:j0Wd96Y7D6eTz8Qz@lucira-db.kwwvngs.mongodb.net/lucira?retryWrites=true&w=majority';
    // Let me check if lucira-backend/.env exists first.
    require('dotenv').config();
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/lucira';
    client = new MongoClient(uri); 
    await client.connect(); 
    const db = client.db(); 
    const cart = await db.collection('carts').find().sort({updatedAt: -1}).limit(1).toArray(); 
    console.log("CART ITEMS:");
    console.log(JSON.stringify(cart[0].items, null, 2)); 
    
    // Also fetch the product
    const productIds = cart[0].items.map(item => {
      const rawId = item.shopifyId || item.productId || item.id;
      return (rawId && rawId.toString().includes("gid://")) ? rawId : `gid://shopify/Product/${rawId}`;
    });
    const dbProducts = await db.collection('products').find({ shopifyId: { $in: productIds } }).toArray();
    console.log("DB PRODUCTS:");
    dbProducts.forEach(p => console.log(p.shopifyId, p.tags));

  } catch(e) {
    console.error(e);
  } finally {
    if (client) await client.close(); 
  }
} 
run();
