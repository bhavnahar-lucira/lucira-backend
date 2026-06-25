/**
 * Customer Routes (Fastify)
 * Handles profile, avatar, dashboard stats, coins, etc.
 */

const { shopifyAdminFetch, shopifyStorefrontFetch, shopifyAdminRestFetch } = require('../lib/shopify');

const ADDRESS_FIELDS = `
  id
  address1
  address2
  city
  company
  country
  firstName
  lastName
  phone
  province
  zip
  formatted(withName: true, withCompany: true)
`;

function normalizeAddress(address) {
  if (!address) return null;
  return {
    id: address.id,
    firstName: address.firstName || "",
    lastName: address.lastName || "",
    company: address.company || "",
    address1: address.address1 || "",
    address2: address.address2 || "",
    city: address.city || "",
    province: address.province || "",
    zip: address.zip || "",
    country: address.country || "",
    phone: address.phone || "",
    formatted: Array.isArray(address.formatted) ? address.formatted.filter(Boolean) : [],
  };
}

async function fetchCustomerAddresses(customerAccessToken, db) {
  const data = await shopifyStorefrontFetch(`
    query CustomerAddresses($customerAccessToken: String!) {
      customer(customerAccessToken: $customerAccessToken) {
        id
        firstName
        lastName
        email
        phone
        defaultAddress {
          ${ADDRESS_FIELDS}
        }
        addresses(first: 50) {
          edges {
            node {
              ${ADDRESS_FIELDS}
            }
          }
        }
      }
    }
  `, { customerAccessToken });

  const customer = data?.customer;
  if (!customer) throw new Error("Customer not found");

  const addressIds = (customer.addresses?.edges || [])
    .map(({ node }) => node?.id)
    .filter(Boolean);

  let metaMap = new Map();
  try {
    const addressMetaCollection = db.collection("customer_address_meta");
    const metaRows = addressIds.length
      ? await addressMetaCollection.find({ addressId: { $in: addressIds } }).toArray()
      : [];
    metaMap = new Map(metaRows.map(row => [row.addressId, row.gstin || ""]));
  } catch (error) {
    console.error("GSTIN metadata read error:", error);
  }

  const defaultAddressId = customer.defaultAddress?.id || null;
  const addresses = (customer.addresses?.edges || []).map(({ node }) => {
    const normalized = normalizeAddress(node);
    return {
      ...normalized,
      gstin: metaMap.get(normalized?.id) || "",
      isDefault: normalized?.id === defaultAddressId,
    };
  });

  return {
    customer: {
      id: customer.id,
      firstName: customer.firstName || "",
      lastName: customer.lastName || "",
      email: customer.email || "",
      phone: customer.phone || "",
    },
    defaultAddressId,
    addresses,
  };
}

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const avatarCollection = db.collection('customer_avatars');
  const coinsCollection = db.collection('customer_coins');

  // Helper to extract access token from authorization header
  const getAccessToken = (request) => {
    const authHeader = request.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
  };

  // GET /api/customer/profile/avatar
  fastify.get('/profile/avatar', async (request, reply) => {
    const accessToken = getAccessToken(request);
    let customerId = null;

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });
        customerId = customerData?.customer?.id;
      } catch (err) {
        console.error("[Backend GET /profile/avatar] Shopify fetch error:", err);
      }
    }

    // Secondary fallback to query userId
    if (!customerId) {
      const { userId } = request.query;
      if (userId) {
        customerId = userId.startsWith("gid://") ? userId : `gid://shopify/Customer/${userId}`;
      }
    }

    if (!customerId) {
      return { avatar: null };
    }

    try {
      // 1. Try customer_profiles
      const profile = await db.collection("customer_profiles").findOne({ customerId });
      if (profile?.avatarUrl) {
        return { avatar: profile.avatarUrl };
      }

      // 2. Try customer_avatars as secondary fallback
      const avatarRecord = await avatarCollection.findOne({ userId: customerId });
      if (avatarRecord?.avatarUrl) {
        return { avatar: avatarRecord.avatarUrl };
      }
    } catch (e) {
      console.error("[Backend GET /profile/avatar] Database read error:", e);
    }

    return { avatar: null };
  });

  // POST /api/customer/profile/avatar
  fastify.post('/profile/avatar', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const customerData = await shopifyStorefrontFetch(`
        query($customerAccessToken: String!) {
          customer(customerAccessToken: $customerAccessToken) { id }
        }
      `, { customerAccessToken: accessToken });

      const customerId = customerData?.customer?.id;
      if (!customerId) {
        return reply.code(401).send({ error: "Unauthorized: Customer not found" });
      }

      const fileData = await request.file();
      if (!fileData) {
        return reply.code(400).send({ error: "No file uploaded" });
      }

      const buffer = await fileData.toBuffer();
      const base64Image = `data:${fileData.mimetype};base64,${buffer.toString('base64')}`;

      // Save to MongoDB collection 'customer_profiles'
      await db.collection("customer_profiles").updateOne(
        { customerId },
        { 
          $set: { 
            avatarUrl: base64Image,
            updatedAt: new Date()
          } 
        },
        { upsert: true }
      );

      return { success: true, url: base64Image };
    } catch (err) {
      console.error("[Backend POST /customer/profile/avatar] Error:", err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/customer/dashboard-stats
  fastify.get('/dashboard-stats', async (request, reply) => {
    const accessToken = getAccessToken(request);

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const simpleId = customerId.split("/").pop();
          
          const NECTOR_ENDPOINT = "https://refer-earn-385594025448.asia-south1.run.app";
          const fetchNectorCoins = async (simpleId) => {
            try {
              const res = await fetch(`${NECTOR_ENDPOINT}?customer_id=shopify-${simpleId}`, { cache: "no-store" });
              if (res.ok) {
                const data = await res.json();
                if (data?.status) {
                  return {
                    points: (data.coins_balance ?? 0).toString(),
                    tier: data.tier_name || "Member",
                    nextTierPoints: (data.next_tier_points ?? 0).toString(),
                    progress: data.tier_progress ?? 0,
                  };
                }
              }
            } catch (e) {
              console.warn("Nector live fetch failed:", e.message);
            }
            return null;
          };

          const metafieldQuery = `
            query getCustomerMetafields($id: ID!) {
              customer(id: $id) {
                metafield(namespace: "nector", key: "custom_properties") { value }
              }
            }
          `;

          const [nectorLive, metafieldData] = await Promise.all([
            fetchNectorCoins(simpleId),
            shopifyAdminFetch(metafieldQuery, { id: customerId }),
          ]);

          // Wishlist count from Mongo
          let wishlistCount = 0;
          try {
            const wishlist = await db.collection('wishlists').findOne({ userId: String(customerId) });
            wishlistCount = wishlist?.items?.length || 0;
          } catch (e) {
            console.error("Wishlist fetch error:", e);
          }

          let points = "0";
          let tier = "Member";
          let nextTierPoints = "0";
          let progress = 0;

          try {
            const rawJson = metafieldData?.customer?.metafield?.value;
            if (rawJson) {
              const parsed = JSON.parse(rawJson);
              points = parsed.nector_user_points?.toString() || "0";
              tier = parsed.nector_user_tier_name || "Member";
              nextTierPoints = parsed.nector_user_next_tier_remaining_points?.toString() || "0";
              progress = 75;
            }
          } catch (_) {}

          if (nectorLive) {
            points = nectorLive.points;
            tier = nectorLive.tier;
            nextTierPoints = nectorLive.nextTierPoints;
            progress = nectorLive.progress;
          }

          return { points, tier, nextTierPoints, progress, wishlistCount };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/dashboard-stats] Fetch failed:", err);
        return reply.code(500).send({ error: "Failed to fetch dashboard stats" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // GET /api/customer/nector-coins
  fastify.get('/nector-coins', async (request, reply) => {
    const accessToken = getAccessToken(request);

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const simpleId = customerId.split("/").pop();
          
          const NECTOR_ENDPOINT = "https://refer-earn-385594025448.asia-south1.run.app";
          const fetchNectorCoins = async (simpleId) => {
            try {
              const res = await fetch(`${NECTOR_ENDPOINT}?customer_id=shopify-${simpleId}`, { cache: "no-store" });
              if (res.ok) {
                const data = await res.json();
                if (data?.status) {
                  return data.coins_balance ?? 0;
                }
              }
            } catch (e) {
              console.warn("Nector live fetch failed:", e.message);
            }
            return null;
          };

          const metafieldQuery = `
            query getCustomerMetafields($id: ID!) {
              customer(id: $id) {
                metafield(namespace: "nector", key: "custom_properties") { value }
              }
            }
          `;

          const [nectorLive, metafieldData] = await Promise.all([
            fetchNectorCoins(simpleId),
            shopifyAdminFetch(metafieldQuery, { id: customerId }),
          ]);

          let coins_balance = 0;

          const cleanNumber = (val) => {
            if (val === null || val === undefined) return 0;
            if (typeof val === 'number') return val;
            const cleaned = String(val).replace(/,/g, '').trim();
            const num = Number(cleaned);
            return isNaN(num) ? 0 : num;
          };

          try {
            const rawJson = metafieldData?.customer?.metafield?.value;
            if (rawJson) {
              const parsed = JSON.parse(rawJson);
              coins_balance = cleanNumber(parsed.nector_user_points);
            }
          } catch (_) {}

          if (nectorLive !== null) {
            coins_balance = cleanNumber(nectorLive);
          }

          return { coins_balance, balance: coins_balance, history: [] };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/nector-coins] Fetch failed:", err);
        return reply.code(500).send({ error: "Failed to fetch customer coins" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // GET /api/customer/profile
  fastify.get('/profile', async (request, reply) => {
    const accessToken = getAccessToken(request);

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const data = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) {
              id
              firstName
              lastName
              email
              phone
              defaultAddress {
                phone
              }
            }
          }
        `, { customerAccessToken: accessToken });

        if (data?.customer) {
          const customerData = {
            ...data.customer,
            phone: data.customer.phone || data.customer.defaultAddress?.phone || null
          };
          return { success: true, customer: customerData };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/profile] Storefront query failed:", err);
        return reply.code(500).send({ error: "Failed to fetch customer profile" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // GET /api/customer/orders
  fastify.get('/orders', async (request, reply) => {
    const accessToken = getAccessToken(request);

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const numericCustomerId = customerId.split('/').pop();
          const { data } = await shopifyAdminRestFetch('orders.json', {
            customer_id: numericCustomerId,
            status: 'any',
            limit: 20
          });

          const ordersRaw = data.orders || [];

          // Find representative items
          const representativeItems = ordersRaw.map(order => {
            const sortedItems = [...(order.line_items || [])].sort((a, b) => {
              const aIsInsurance = a.name.toLowerCase().includes('insurance');
              const bIsInsurance = b.name.toLowerCase().includes('insurance');
              if (aIsInsurance && !bIsInsurance) return 1;
              if (!aIsInsurance && bIsInsurance) return -1;
              return parseFloat(b.price || 0) - parseFloat(a.price || 0);
            });
            return sortedItems[0];
          });

          // Fetch product images for representative items
          const productIds = [...new Set(representativeItems.map(item => item?.product_id).filter(id => id))];
          let productImages = {};
          if (productIds.length > 0) {
            try {
              const { data: productsData } = await shopifyAdminRestFetch('products.json', {
                ids: productIds.join(',')
              });
              (productsData.products || []).forEach(p => {
                productImages[p.id] = p.image?.src;
              });
            } catch (e) {
              console.error("Failed to fetch product images", e);
            }
          }

          const orders = ordersRaw.map((order, index) => {
            const repItem = representativeItems[index];
            return {
              id: order.admin_graphql_api_id,
              orderNumber: order.order_number.toString(),
              customerEmail: order.customer?.email || "",
              date: new Date(order.processed_at).toLocaleDateString('en-IN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              }),
              status: order.fulfillment_status === 'fulfilled' ? 'Delivered' : 
                      order.fulfillment_status === 'partial' ? 'In Transit' : 'Processing',
              amount: new Intl.NumberFormat('en-IN', {
                style: 'currency',
                currency: order.currency,
              }).format(order.total_price),
              product: repItem?.name || "Jewelry Item",
              image: (repItem?.product_id && productImages[repItem.product_id]) ? productImages[repItem.product_id] : "/images/product/1.jpg"
            };
          });

          return { success: true, orders };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/orders] Fetch failed:", err);
        return reply.code(500).send({ error: "Failed to fetch orders" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // GET /api/customer/orders/:id
  fastify.get('/orders/:id', async (request, reply) => {
    const accessToken = getAccessToken(request);
    const { id } = request.params;

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const numericCustomerId = customerId.split('/').pop();
          const { data } = await shopifyAdminRestFetch(`orders/${id}.json`, {});
          
          const orderRaw = data.order;
          if (!orderRaw || orderRaw.customer?.id?.toString() !== numericCustomerId) {
            return reply.code(404).send({ error: "Order not found" });
          }

          const productIds = [...new Set(orderRaw.line_items.map(item => item.product_id).filter(id => id))];
          let productImages = {};
          if (productIds.length > 0) {
            try {
              const { data: productsData } = await shopifyAdminRestFetch('products.json', { ids: productIds.join(',') });
              (productsData.products || []).forEach(p => { productImages[p.id] = p.image?.src; });
            } catch (e) {
              console.error("Failed to fetch product images for order details", e);
            }
          }

          const order = {
            id: orderRaw.admin_graphql_api_id,
            orderNumber: orderRaw.order_number.toString(),
            customerEmail: orderRaw.customer?.email || "",
            processedAt: orderRaw.processed_at,
            fulfillmentStatus: orderRaw.fulfillment_status || 'UNFULFILLED',
            financialStatus: orderRaw.financial_status || 'PENDING',
            totalPrice: { amount: orderRaw.total_price, currencyCode: orderRaw.currency },
            subtotalPrice: { amount: orderRaw.subtotal_price, currencyCode: orderRaw.currency },
            totalTax: { amount: orderRaw.total_tax, currencyCode: orderRaw.currency },
            shippingAddress: orderRaw.shipping_address ? {
              firstName: orderRaw.shipping_address.first_name,
              lastName: orderRaw.shipping_address.last_name,
              address1: orderRaw.shipping_address.address1,
              address2: orderRaw.shipping_address.address2,
              city: orderRaw.shipping_address.city,
              province: orderRaw.shipping_address.province,
              zip: orderRaw.shipping_address.zip,
              country: orderRaw.shipping_address.country,
              phone: orderRaw.shipping_address.phone
            } : null,
            lineItems: orderRaw.line_items.map(item => ({
              title: item.name,
              quantity: item.quantity,
              price: { amount: item.price, currencyCode: orderRaw.currency },
              image: (item.product_id && productImages[item.product_id]) ? productImages[item.product_id] : "/images/product/1.jpg",
              product_id: item.product_id
            }))
          };

          return { success: true, order };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/orders/:id] Fetch failed:", err);
        return reply.code(500).send({ error: "Failed to fetch order details" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // PATCH /api/customer/profile
  fastify.patch('/profile', async (request, reply) => {
    const accessToken = getAccessToken(request);
    const { firstName, lastName, phone } = request.body;

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const data = await shopifyAdminFetch(`
            mutation customerUpdate($input: CustomerInput!) {
              customerUpdate(input: $input) {
                customer { id firstName lastName phone }
                userErrors { field message }
              }
            }
          `, {
            input: { id: customerId, firstName, lastName, phone }
          });

          if (data?.customerUpdate?.userErrors?.length > 0) {
            return reply.code(400).send({ error: data.customerUpdate.userErrors[0].message });
          }
          return { success: true, customer: data.customerUpdate.customer };
        }
      } catch (err) {
        console.error("[Backend PATCH /customer/profile] Update failed:", err);
        return reply.code(500).send({ error: err.message });
      }
    }

    return { success: true };
  });

  // GET /api/customer/referral
  fastify.get('/referral', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return { referralCode: "LUCIRA123", stats: { totalReferrals: 0, earned: 0 } };
  });

  // POST /api/customer/referral
  fastify.post('/referral', async (request, reply) => {
    try {
      const { customerId } = request.body;
      if (!customerId) {
        return reply.code(400).send({ error: "Missing customerId" });
      }

      const shopifyCustomerId = customerId.toString().startsWith("gid://")
        ? customerId
        : `gid://shopify/Customer/${customerId}`;

      const query = `
        query getCustomerReferral($id: ID!) {
          customer(id: $id) {
            metafield(namespace: "nector", key: "custom_properties") {
              value
            }
          }
        }
      `;

      const data = await shopifyAdminFetch(query, { id: shopifyCustomerId });
      const rawJson = data?.customer?.metafield?.value;

      if (!rawJson) {
        return { referralLink: "" };
      }

      const parsed = JSON.parse(rawJson);
      const referralLink = parsed.nector_user_referral_link || "";

      return { referralLink };
    } catch (error) {
      console.error("Referral API Error:", error);
      return reply.code(500).send({ error: "Failed fetching referral link" });
    }
  });

  // GET /api/customer/referral/history
  fastify.get('/referral/history', async (request, reply) => {
    try {
      const { customer_id } = request.query;
      if (!customer_id) {
        return reply.code(400).send({ error: "Missing customer_id" });
      }

      const endpoint = `https://refer-earn-385594025448.asia-south1.run.app?customer_id=${encodeURIComponent(customer_id)}`;
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`Nector API responded with status: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Nector Proxy Error:", error);
      return reply.code(500).send({ error: "Failed to fetch referral history" });
    }
  });

  // GET /api/customer/returns
  fastify.get('/returns', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return { returns: [] };
  });

  // GET /api/customer/addresses
  fastify.get('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    try {
      return await fetchCustomerAddresses(accessToken, db);
    } catch (error) {
      console.error("Addresses fetch error:", error);
      if (error.message === "Customer not found") {
        return reply.code(401).send({ error: "Unauthorized: Session expired or customer not found" });
      }
      return reply.code(500).send({ error: "Failed to fetch addresses" });
    }
  });

  // POST /api/customer/addresses
  fastify.post('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { address, makeDefault } = request.body;

    try {
      const data = await shopifyStorefrontFetch(`
        mutation CustomerAddressCreate($customerAccessToken: String!, $address: MailingAddressInput!) {
          customerAddressCreate(customerAccessToken: $customerAccessToken, address: $address) {
            customerAddress {
              ${ADDRESS_FIELDS}
            }
            customerUserErrors {
              field
              message
            }
          }
        }
      `, {
        customerAccessToken: accessToken,
        address: {
          firstName: address.firstName,
          lastName: address.lastName,
          company: address.company,
          address1: address.address1,
          address2: address.address2,
          city: address.city,
          province: address.province,
          zip: address.zip,
          country: address.country,
          phone: address.phone,
        }
      });

      const payload = data.customerAddressCreate;
      const errors = payload?.customerUserErrors || [];
      if (errors.length) {
        return reply.code(400).send({ error: errors[0].message });
      }

      const addressId = payload?.customerAddress?.id;
      if (makeDefault && addressId) {
        await shopifyStorefrontFetch(`
          mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
            customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
              customer { id }
              customerUserErrors { field message }
            }
          }
        `, { customerAccessToken: accessToken, addressId });
      }

      if (addressId && address.gstin) {
        await db.collection("customer_address_meta").updateOne(
          { addressId },
          { $set: { addressId, gstin: address.gstin.trim().toUpperCase(), updatedAt: new Date() } },
          { upsert: true }
        );
      }

      return await fetchCustomerAddresses(accessToken, db);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // PATCH /api/customer/addresses
  fastify.patch('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { addressId, address, makeDefault, mode } = request.body;

    try {
      if (mode === "default") {
        await shopifyStorefrontFetch(`
          mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
            customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
              customer { id }
              customerUserErrors { field message }
            }
          }
        `, { customerAccessToken: accessToken, addressId });
        return await fetchCustomerAddresses(accessToken, db);
      }

      const data = await shopifyStorefrontFetch(`
        mutation CustomerAddressUpdate($customerAccessToken: String!, $id: ID!, $address: MailingAddressInput!) {
          customerAddressUpdate(customerAccessToken: $customerAccessToken, id: $id, address: $address) {
            customerAddress {
              ${ADDRESS_FIELDS}
            }
            customerUserErrors {
              field
              message
            }
          }
        }
      `, {
        customerAccessToken: accessToken,
        id: addressId,
        address: {
          firstName: address.firstName,
          lastName: address.lastName,
          company: address.company,
          address1: address.address1,
          address2: address.address2,
          city: address.city,
          province: address.province,
          zip: address.zip,
          country: address.country,
          phone: address.phone,
        }
      });

      const payload = data.customerAddressUpdate;
      const errors = payload?.customerUserErrors || [];
      if (errors.length) {
        return reply.code(400).send({ error: errors[0].message });
      }

      if (makeDefault && addressId) {
        await shopifyStorefrontFetch(`
          mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
            customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
              customer { id }
              customerUserErrors { field message }
            }
          }
        `, { customerAccessToken: accessToken, addressId });
      }

      if (addressId && address.gstin) {
        await db.collection("customer_address_meta").updateOne(
          { addressId },
          { $set: { addressId, gstin: address.gstin.trim().toUpperCase(), updatedAt: new Date() } },
          { upsert: true }
        );
      }

      return await fetchCustomerAddresses(accessToken, db);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // DELETE /api/customer/addresses
  fastify.delete('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { addressId } = request.query;

    try {
      const data = await shopifyStorefrontFetch(`
        mutation CustomerAddressDelete($customerAccessToken: String!, $id: ID!) {
          customerAddressDelete(customerAccessToken: $customerAccessToken, id: $id) {
            deletedCustomerAddressId
            customerUserErrors {
              field
              message
            }
          }
        }
      `, { customerAccessToken: accessToken, id: addressId });

      const payload = data.customerAddressDelete;
      const errors = payload?.customerUserErrors || [];
      if (errors.length) {
        return reply.code(400).send({ error: errors[0].message });
      }

      await db.collection("customer_address_meta").deleteOne({ addressId });

      return await fetchCustomerAddresses(accessToken, db);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
