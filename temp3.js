require('dotenv').config();
const { shopifyAdminFetch } = require('./lib/shopify.js');
shopifyAdminFetch('{ product(id: "gid://shopify/Product/9027684532442") { title, handle, tags, vendor, productType } }').then(console.log);
