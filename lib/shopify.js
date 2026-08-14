const { fetchWithRetry } = require('./helpers');
const { getServerCache } = require('./cache');

const SHOP = 'luciraonline';
const rawStore = process.env.SHOPIFY_STORE || process.env.SHOPIFYSTORE || SHOP;
const SHOP_DOMAIN = rawStore.includes('.') ? rawStore : rawStore + '.myshopify.com';

async function shopifyStorefrontFetch(query, variables = {}, options = {}) {
  let token = process.env.STOREFRONT_TOKEN;
  
  // Use the RW token specifically for customer and blog queries
  const isCustomerOrBlog = /customer|blog|article|address/i.test(query);
  if (isCustomerOrBlog && process.env.SHOPIFY_RW_STOREFRONT_TOKEN) {
    token = process.env.SHOPIFY_RW_STOREFRONT_TOKEN;
  }
  
  if (!token) {
    throw new Error('STOREFRONT_TOKEN not configured');
  }

  try {
    const res = await fetchWithRetry(
      'https://' + SHOP_DOMAIN + '/api/2024-10/graphql.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
        ...options
      }
    );

    const data = await res.json();
    if (data.errors) {
      console.error('GraphQL Errors:', JSON.stringify(data.errors, null, 2));
      throw new Error(data.errors[0]?.message || 'GraphQL error');
    }
    return data.data;
  } catch (err) {
    console.error('Storefront Fetch Error (' + SHOP_DOMAIN + '):', err.message);
    throw err;
  }
}

async function shopifyAdminFetch(query, variables = {}, options = {}) {
  const adminToken = process.env.ADMIN_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error('ADMIN_TOKEN or SHOPIFY_ADMIN_TOKEN not configured');
  }

  const res = await fetchWithRetry(
    'https://' + SHOP_DOMAIN + '/admin/api/' + (options.apiVersion || '2024-10') + '/graphql.json',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': adminToken,
      },
      body: JSON.stringify({ query, variables }),
      ...options
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    console.error('Admin Fetch Error (' + res.status + '):', errorText);
    throw new Error('Shopify Admin API error ' + res.status + ': ' + errorText.substring(0, 100));
  }

  const data = await res.json();
  if (data.errors) {
    console.error('GraphQL Errors:', data.errors);
    throw new Error(data.errors[0]?.message || 'GraphQL error');
  }
  return data.data;
}

async function waitForFileReady(fileId, maxAttempts = 15, delay = 2000) {
  const query = 'query getFile($id: ID!) { node(id: $id) { ... on GenericFile { url fileStatus } ... on MediaImage { image { url } fileStatus } ... on Video { sources { url } fileStatus } } }';
  const q = query.replace('$', '$').replace('$', '$');

  let attempts = 0;
  while (attempts < maxAttempts) {
    console.log('⏳ Polling Shopify for file status (' + fileId + ')... attempt ' + (attempts + 1));
    const data = await shopifyAdminFetch(q, { id: fileId });
    const file = data?.node;
    
    if (file) {
      console.log('✅ Shopify File Status: ' + file.fileStatus);
      if (file.fileStatus === 'READY') {
        const finalUrl = file.url || file.image?.url || (file.sources && file.sources[0]?.url);
        if (finalUrl) {
          console.log('✨ File ready! URL: ' + finalUrl);
          return finalUrl;
        }
      }
      if (file.fileStatus === 'FAILED') {
        throw new Error('File processing failed in Shopify');
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
    attempts++;
  }
  throw new Error('Timeout waiting for file to be ready in Shopify');
}

async function shopifyAdminRestFetch(endpoint, params = {}, options = {}) {
  const adminToken = process.env.ADMIN_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error('ADMIN_TOKEN not configured');
  }

  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => q.set(k, v));
  const queryString = q.toString() ? `?${q.toString()}` : "";
  const url = `https://${SHOP_DOMAIN}/admin/api/${options.apiVersion || "2024-10"}/${endpoint}${queryString}`;

  const res = await fetchWithRetry(url, {
    method: options.method || "GET",
    headers: {
      "X-Shopify-Access-Token": adminToken,
      "Content-Type": "application/json",
    },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`REST Error (${res.status}):`, errorText);
    throw new Error(`REST API ${res.status}: ${errorText.substring(0, 100)}`);
  }

  const data = await res.json();
  return { data, status: res.status };
}

async function getShopPricingData() {
  return getServerCache(
    "shop-pricing-data",
    async () => {
      const shopPricingQuery = `
        query {
          shop {
            metalPrices: metafield(namespace: "DI-GoldPrice", key: "metal_prices") { value }
            stonePricing: metafield(namespace: "DI-GoldPrice", key: "stone_pricing") { value }
          }
        }
      `;
      const shopData = await shopifyAdminFetch(shopPricingQuery);
      return {
        metalRates: shopData?.shop?.metalPrices?.value ? JSON.parse(shopData.shop.metalPrices.value) : {},
        stonePricingDB: shopData?.shop?.stonePricing?.value ? JSON.parse(shopData.shop.stonePricing.value) : [],
      };
    },
    { ttlMs: 60 * 60 * 1000, maxEntries: 20 }
  );
}

module.exports = {
  shopifyStorefrontFetch,
  shopifyAdminFetch,
  shopifyAdminRestFetch,
  waitForFileReady,
  getShopPricingData
};
