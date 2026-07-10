require('dotenv').config();
const mongoose = require('mongoose');
const { Product } = require('./lib/db.js');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const products = await Product.find({
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
  }).select('title handle collectionHandles tags').limit(10);
  
  console.log(JSON.stringify(products, null, 2));
  mongoose.connection.close();
}
check();
