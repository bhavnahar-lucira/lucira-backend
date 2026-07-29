require('dotenv').config();
const { shopifyAdminFetch } = require('./lib/shopify.js');
shopifyAdminFetch('{ collection(id: "gid://shopify/Collection/455769587930") { title, handle } }').then(console.log);
