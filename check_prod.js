const { MongoClient } = require('mongodb'); 
async function run() { 
  require('dotenv').config(); 
  const client = new MongoClient(process.env.MONGO_URI || process.env.MONGODB_URI); 
  await client.connect(); 
  const p = await client.db().collection('products').findOne(); 
  console.log(p ? Object.keys(p) : 'no products'); 
  console.log(p ? p.shopifyId : '');
  console.log(p ? p.id : '');
  await client.close(); 
} 
run();
