const { shopifyAdminFetch, shopifyStorefrontFetch } = require('./lib/shopify');

async function test() {
  try {
    const discountData = await shopifyAdminFetch(`
      query getDiscount($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              __typename
              title
              status
              summary
              customerGets {
                items {
                  ... on AllDiscountItems { allItems }
                  ... on DiscountProducts { products(first: 100) { nodes { id } } }
                  ... on DiscountCollections { collections(first: 100) { nodes { id } } }
                }
              }
            }
          }
        }
      }
    `, { code: 'sargun1000' });
    console.log("=== COUPON ===");
    console.log(JSON.stringify(discountData, null, 2));

    const productsData = await shopifyStorefrontFetch(`
      query getCartProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            collections(first: 20) {
              nodes { id handle }
            }
          }
        }
      }
    `, { ids: ['gid://shopify/Product/9027684532442'] });
    console.log("\n=== PRODUCT ===");
    console.log(JSON.stringify(productsData, null, 2));
  } catch(e) { console.error(e) }
}
test();
