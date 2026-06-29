require('dotenv').config();
const { shopifyAdminFetch } = require('./lib/shopify');

async function test() {
  try {
    console.log("Testing Shopify Admin API metaobject fetch...");
    const query = `query {
      metaobjects(type: "daily_gold_rate", first: 10) {
        edges {
          node {
            type
            fields {
              key
              value
            }
          }
        }
      }
    }`;
    const data = await shopifyAdminFetch(query);
    console.log("Result:", JSON.stringify(data, null, 2));
    
    // Also let's try querying ALL metaobjects if daily_gold_rate is wrong
    const queryAll = `query {
      metaobjects(first: 5) {
        edges {
          node {
            type
          }
        }
      }
    }`;
    const dataAll = await shopifyAdminFetch(queryAll);
    console.log("Available Types:", JSON.stringify(dataAll, null, 2));
    
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
