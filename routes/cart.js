/**
 * Cart Routes (Fastify)
 */

const { shopifyAdminFetch, shopifyStorefrontFetch } = require('../lib/shopify');

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('carts');

  // Helper to build robust format-agnostic cart lookup query
  function buildCartQuery(userId, sessionId, context = 'storefront') {
    const conditions = [];
    if (userId) {
      const rawId = String(userId).trim();
      conditions.push({ userId: rawId, context });
      if (rawId.startsWith("gid://shopify/Customer/")) {
        const numericId = rawId.replace("gid://shopify/Customer/", "");
        conditions.push({ userId: numericId, context });
      } else {
        conditions.push({ userId: `gid://shopify/Customer/${rawId}`, context });
      }
    }
    if (sessionId) {
      conditions.push({ sessionId, context });
    }
    return conditions.length === 1 ? conditions[0] : { $or: conditions };
  }

  // Helper for tracking events to user_tracking collection
  const trackCartEvent = async (type, payload, request) => {
    try {
      const trackingCollection = fastify.mongo.db.collection('user_tracking');
      const sourcePage = request.headers['referer'] || 'unknown';
      
      await trackingCollection.insertOne({
        type, // 'ADD_TO_CART', 'REMOVE_FROM_CART'
        userId: payload.userId || 'guest',
        sessionId: payload.sessionId || 'unknown',
        context: payload.context || 'storefront',
        email: payload.email || 'unknown',
        phone: payload.phone || 'unknown',
        product: payload.product?.title || 'unknown',
        variantId: payload.product?.variantId || 'unknown',
        sourcePage,
        timestamp: new Date(),
        ip: request.ip
      });
      console.log(`[Tracking] ${type} tracked for ${payload.userId || payload.sessionId} in context ${payload.context || 'storefront'}`);
    } catch (err) {
      console.error(`[Tracking Error] Failed to track ${type}:`, err.message);
    }
  };

  // Helper for tracking abandoned carts specifically for the dashboard
  const updateAbandonedCart = async (payload) => {
    // Use setImmediate to avoid blocking the main request cycle (Vercel Edge / Function safe)
    setImmediate(async () => {
      try {
        const abandonedCollection = fastify.mongo.db.collection('abandoned_carts');
        const sessionIdentities = fastify.mongo.db.collection('session_identities');
        let { sessionId, userId, items, totalAmount, totalQuantity, context = 'storefront' } = payload;
        
        if (!sessionId && !userId) return;

        // 1. Identify the Customer
        let identifiedCustomer = payload.customer || null;

        // If we have a userId, we MUST get the details
        if (userId && !identifiedCustomer) {
           // A. Check persistent mapping first (fastest)
           const linkedIdentity = await sessionIdentities.findOne({ userId: String(userId) });
           if (linkedIdentity) {
             identifiedCustomer = linkedIdentity.customer;
           } else {
             // B. Check MongoDB orders (cached data)
             const ordersCol = fastify.mongo.db.collection('orders');
             const prevOrder = await ordersCol.findOne(
               { $or: [{ "shopifyPayload.customer.id": Number(userId) }, { "shopifyPayload.customer.id": String(userId) }] },
               { projection: { "shopifyPayload.customer": 1 }, sort: { createdAt: -1 } }
             );
             if (prevOrder?.shopifyPayload?.customer) {
               identifiedCustomer = {
                 firstName: prevOrder.shopifyPayload.customer.first_name,
                 lastName: prevOrder.shopifyPayload.customer.last_name,
                 email: prevOrder.shopifyPayload.customer.email,
                 phone: prevOrder.shopifyPayload.customer.phone
               };
             } else {
               // C. Fetch directly from Shopify (source of truth for new users)
               const gid = String(userId).startsWith("gid://") ? userId : `gid://shopify/Customer/${userId}`;
               const shopifyData = await shopifyAdminFetch(`
                 query getCustomer($id: ID!) {
                   customer(id: $id) {
                     firstName lastName email phone
                   }
                 }
               `, { id: gid });
               
               if (shopifyData?.customer) {
                 identifiedCustomer = {
                   firstName: shopifyData.customer.firstName || "",
                   lastName: shopifyData.customer.lastName || "",
                   email: shopifyData.customer.email || "",
                   phone: shopifyData.customer.phone || ""
                 };
               }
             }
           }
        }

        // If we have an identity and a sessionId, store/refresh the link
        if (identifiedCustomer && sessionId) {
           await sessionIdentities.updateOne(
             { sessionId },
             { $set: { userId: String(userId), customer: identifiedCustomer, updatedAt: new Date() } },
             { upsert: true }
           );
        }

        // If we DON'T have a userId but HAVE a sessionId, check for recognized session (Logout recognition)
        if (!userId && sessionId && !identifiedCustomer) {
          const linkedIdentity = await sessionIdentities.findOne({ sessionId });
          if (linkedIdentity) {
            identifiedCustomer = linkedIdentity.customer;
            userId = linkedIdentity.userId;
          }
        }

        // 2. Build Persistence Query
        const query = sessionId ? { sessionId, context } : { userId: String(userId), context };

        // 3. Find existing record to preserve context
        const existing = await abandonedCollection.findOne(query);

        // 4. Prepare Update Document
        const updateDoc = {
          items: items || [],
          totalAmount: totalAmount || 0,
          totalQuantity: totalQuantity || 0,
          updatedAt: new Date(),
          context
        };

        if (sessionId) updateDoc.sessionId = sessionId;
        if (userId) updateDoc.userId = String(userId);
        
        if (identifiedCustomer) {
           updateDoc.customer = identifiedCustomer;
        } else if (existing?.customer) {
           updateDoc.customer = existing.customer;
        }

        // 5. Upsert the abandoned cart record
        await abandonedCollection.updateOne(query, { $set: updateDoc }, { upsert: true });
        
        // 6. Retroactive Linking: If this session just became identified, update all previous guest records
        if (sessionId && identifiedCustomer && userId) {
           await abandonedCollection.updateMany(
             { sessionId, context, customer: { $exists: false } },
             { $set: { userId: String(userId), customer: identifiedCustomer } }
           );
        }
      } catch (err) {
        console.error("[AbandonedCart Error] Failed to update:", err.message);
      }
    });
  };

  // Helper to trigger ATC Webhook for real users
  const triggerAtcWebhook = async (userId, items, request) => {
    try {
      if (!userId) return; // Only if logged in (real user)

      // 1. Get Customer Details
      const sessionIdentities = fastify.mongo.db.collection('session_identities');
      let customer = null;
      const linkedIdentity = await sessionIdentities.findOne({ userId: String(userId) });
      if (linkedIdentity) {
        customer = linkedIdentity.customer;
      } else {
        // Fallback to Shopify directly
        const gid = String(userId).startsWith("gid://") ? userId : `gid://shopify/Customer/${userId}`;
        const shopifyData = await shopifyAdminFetch(`
          query getCustomer($id: ID!) {
            customer(id: $id) {
              firstName lastName email phone
            }
          }
        `, { id: gid }).catch(() => null);
        
        if (shopifyData?.customer) {
          customer = {
            firstName: shopifyData.customer.firstName || "",
            lastName: shopifyData.customer.lastName || "",
            email: shopifyData.customer.email || "",
            phone: shopifyData.customer.phone || ""
          };
        }
      }

      // Extract UTMs from cookie
      let utms = {};
      if (request && request.headers && request.headers.cookie) {
        const cookieStr = request.headers.cookie;
        const match = cookieStr.match(/lucira_utms=([^;]+)/);
        if (match && match[1]) {
          try {
            utms = JSON.parse(decodeURIComponent(match[1]));
          } catch(e) {}
        }
      }

      const leaddetails = {
        First_Name: customer?.firstName || (customer?.name ? customer.name.split(' ')[0] : "") || "Unknown",
        Last_Name: customer?.lastName || (customer?.name ? customer.name.split(' ').slice(1).join(' ') : "") || "Unknown",
        Mobile: customer?.mobile || customer?.phone || "",
        Email: customer?.email || "",
        Lead_Source: "Website",
        Allocation_Type: "Auto",
        UTM_Source: utms.utm_source || "",
        UTM_Medium: utms.utm_medium || "",
        UTM_Campaign: utms.utm_campaign || "",
        Deal_Trigger_Event: "ATC",
        Record_Type: "Sales"
      };

      const webhookUrl = "https://atc-headless-webhook-385594025448.asia-south1.run.app/webhookbe2p6x9n4r8";

      // Loop over items and send a webhook per item
      for (const product of items) {
        const customerevent = {
          Event_Type: "ATC",
          Channel: "website",
          Order_Value: String(product.offerPrice || product.finalPrice || product.price || 0),
          Currency: "INR"
        };

        const products = [
          {
            product_name: product.productName || product.title || "",
            price: String(product.price || 0),
            product_sku: product.sku || "",
            product_url: product.productUrl || (product.handle ? `https://www.lucirajewelry.com/products/${product.handle}` : ""),
            quantity: String(product.quantity || 1),
            product_type: product.productType || product.type || "",
            category: product.category || product.type || "",
            product_id: String(product.productId || product.id || product.shopifyId || "")
          }
        ];

        const payload = { leaddetails, customerevent, products, order: {} };

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(() => null);
        
        if (!response || !response.ok) {
          console.error(`[ATC Webhook] Failed to send for product: ${product.title}`);
        } else {
          console.log(`[ATC Webhook] Successfully sent for user ${customer?.email || 'Unknown'} - product: ${product.title}`);
        }
      }
    } catch (err) {
      console.error(`[ATC Webhook Error]:`, err.message);
    }
  };

  // GET /api/cart/get
  fastify.get('/get', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { userId, sessionId, context = 'storefront' } = request.query;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const query = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(query);

    const result = cart || { items: [], totalAmount: 0, totalQuantity: 0, context };
    
    // SECURITY: Minimize disclosure in the cart items if needed, but usually frontend needs variantId
    // For now, ensure no sensitive MongoDB internal fields are leaked.
    if (result._id) delete result._id;
    
    // Sync to abandoned carts on read as well to ensure dashboard is fresh
    if (result.items?.length > 0) {
      updateAbandonedCart({ 
        sessionId, 
        userId, 
        items: result.items, 
        totalAmount: result.totalAmount, 
        totalQuantity: result.totalQuantity, 
        context 
      });
    }

    return result;
  });

  // POST /api/cart/add
  fastify.post('/add', async (request, reply) => {
    const { userId, sessionId, product, context = 'storefront' } = request.body;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const lookupQuery = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(lookupQuery) || { items: [], totalAmount: 0, totalQuantity: 0, context };

    const normalizeVid = (id) => String(id || '').replace(/.*ProductVariant\//i, '').trim();
    const targetVid = normalizeVid(product.variantId);
    
    // SECURITY: Prevent unauthorized ₹0 Gold Coin from entering the DB
    const GOLD_COIN_ID = "47661824082138";
    if (targetVid === GOLD_COIN_ID && (Number(product.price) === 0 || product.isFreeGift)) {
      const db = fastify.mongo.db;
      const settings = await db.collection('settings').findOne({ key: 'gold_coin_offer' });
      const isEnabled = settings?.enabled ?? false;
      const threshold = Number(settings?.threshold) || 20000;
      
      const currentSubtotal = cart.items.reduce((acc, item) => {
        if (normalizeVid(item.variantId) === GOLD_COIN_ID) return acc;
        return acc + (Number(item.price || item.finalPrice || 0) * Number(item.quantity || 1));
      }, 0);

      if (!isEnabled || currentSubtotal < threshold) {
        console.warn(`[Security] Blocked attempt to add free Gold Coin. Enabled: ${isEnabled}, Subtotal: ${currentSubtotal}`);
        // If they try to force it, we don't add it as free. 
        // We either reject it or set a high fallback price.
        return reply.code(400).send({ error: "Promotion not available or threshold not met" });
      }
    }

    const existingIndex = cart.items.findIndex(i => normalizeVid(i.variantId) === targetVid);
    const incomingQty = Math.max(1, Number(product.quantity || 1));
    
    if (existingIndex > -1) {
      cart.items[existingIndex].quantity += incomingQty;
    } else {
      cart.items.unshift({ ...product, quantity: incomingQty });
    }

    // Recalculate totals
    cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);
    cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.updatedAt = new Date();
    cart.context = context;

    const targetQuery = cart._id ? { _id: cart._id } : (userId ? { userId: String(userId), context } : { sessionId, context });
    await collection.updateOne(targetQuery, { $set: cart }, { upsert: true });

    // TRACK ABANDONED CART
    updateAbandonedCart({ 
      sessionId, 
      userId, 
      items: cart.items, 
      totalAmount: cart.totalAmount, 
      totalQuantity: cart.totalQuantity, 
      context 
    });

    // TRACK ADD TO CART EVENT
    await trackCartEvent('ADD_TO_CART', {
      userId,
      sessionId,
      context,
      product,
      email: request.body.email || cart.customer?.email,
      phone: request.body.phone || cart.customer?.phone
    }, request);

    // TRIGGER ATC WEBHOOK (for logged in users)
    if (userId) {
      // Run asynchronously to not block the response
      triggerAtcWebhook(userId, [{ ...product, quantity: incomingQty }], request);
    }

    return cart;
  });

  // POST /api/cart/remove
  fastify.post('/remove', async (request, reply) => {
    const { userId, sessionId, variantId, context = 'storefront' } = request.body;
    const lookupQuery = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(lookupQuery);

    if (cart) {
      const normalizeVid = (id) => String(id || '').replace(/.*ProductVariant\//i, '').trim();
      const targetVid = normalizeVid(variantId);
      cart.items = cart.items.filter(i => normalizeVid(i.variantId) !== targetVid);
      cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);
      cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      cart.updatedAt = new Date();
      await collection.updateOne({ _id: cart._id }, { $set: cart });

      // TRACK ABANDONED CART UPDATE
      updateAbandonedCart({ 
        sessionId, 
        userId, 
        items: cart.items, 
        totalAmount: cart.totalAmount, 
        totalQuantity: cart.totalQuantity, 
        context 
      });
    }

    return cart || { items: [], totalAmount: 0, totalQuantity: 0, context };
  });

  // POST /api/cart/update
  fastify.post('/update', async (request, reply) => {
    const { userId, sessionId, currentVariantId, nextVariantId, quantity, size, price, finalPrice, variantTitle, inStock, sku, goldWeight, diamondTotalPcs, diamondCarat, leadTime, estDelivery, context = 'storefront' } = request.body;
    const lookupQuery = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(lookupQuery);

    if (cart) {
      const normalizeVid = (id) => String(id || '').replace(/.*ProductVariant\//i, '').trim();
      const targetVid = normalizeVid(currentVariantId);
      const itemIndex = cart.items.findIndex(i => normalizeVid(i.variantId) === targetVid);
      if (itemIndex > -1) {
        let fNextVid = nextVariantId;
        let fSize = size;
        let fPrice = price;
        let fVTitle = variantTitle;
        let fInStock = inStock;
        let fSku = sku;
        let fGWeight = goldWeight;
        let fDPcs = diamondTotalPcs;
        let fDCarat = diamondCarat;

        // Auto-find nextVariantId if missing but size is provided
        if (!fNextVid && size && cart.items[itemIndex].variantOptions) {
          const opt = cart.items[itemIndex].variantOptions.find(v => String(v.size) === String(size));
          if (opt) {
            fNextVid = opt.variantId;
            fSize = opt.size;
            fPrice = opt.price;
            fVTitle = opt.variantTitle;
            fInStock = opt.inStock;
            fSku = opt.sku;
            if (opt.goldWeight) fGWeight = opt.goldWeight;
            if (opt.diamondTotalPcs) fDPcs = opt.diamondTotalPcs;
            if (opt.diamondCarat) fDCarat = opt.diamondCarat;
          }
        }

        if (fNextVid) {
          cart.items[itemIndex].variantId = fNextVid;
          cart.items[itemIndex].size = fSize;
          cart.items[itemIndex].price = fPrice;
          if (finalPrice !== undefined) cart.items[itemIndex].finalPrice = finalPrice;
          else if (fPrice !== undefined) cart.items[itemIndex].finalPrice = fPrice;
          cart.items[itemIndex].variantTitle = fVTitle;
          cart.items[itemIndex].inStock = fInStock;
          cart.items[itemIndex].sku = fSku;
          
          if (fGWeight !== undefined) cart.items[itemIndex].goldWeight = fGWeight;
          if (fDPcs !== undefined) cart.items[itemIndex].diamondTotalPcs = fDPcs;
          if (fDCarat !== undefined) cart.items[itemIndex].diamondCarat = fDCarat;
          if (leadTime !== undefined) cart.items[itemIndex].leadTime = leadTime;
          if (estDelivery !== undefined) cart.items[itemIndex].estDelivery = estDelivery;
        }
        if (quantity !== undefined) {
          cart.items[itemIndex].quantity = Math.max(1, Number(quantity || 1));
        }
      }
      
      cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);
      cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      cart.updatedAt = new Date();
      await collection.updateOne({ _id: cart._id }, { $set: cart });

      // TRACK ABANDONED CART UPDATE
      updateAbandonedCart({ 
        sessionId, 
        userId, 
        items: cart.items, 
        totalAmount: cart.totalAmount, 
        totalQuantity: cart.totalQuantity, 
        context 
      });
    }

    return cart || { items: [], totalAmount: 0, totalQuantity: 0, context };
  });

  // POST /api/cart/merge
  fastify.post('/merge', async (request, reply) => {
    const { userId, sessionId, context = 'storefront' } = request.body;
    if (!userId || !sessionId) return reply.code(400).send({ error: 'Identity required' });

    // Normalize variantId to numeric string for comparison (strips GID prefix)
    const normalizeVid = (id) => String(id || '').replace(/.*ProductVariant\//i, '').trim();

    const guestCart = await collection.findOne({ sessionId, context });
    const lookupQuery = buildCartQuery(userId, null, context);
    const userCart = await collection.findOne(lookupQuery) || { items: [], totalAmount: 0, totalQuantity: 0, context };

    if (guestCart && guestCart.items.length > 0) {
      guestCart.items.forEach(gItem => {
        const gVid = normalizeVid(gItem.variantId);
        const existing = userCart.items.find(uItem => normalizeVid(uItem.variantId) === gVid);
        if (existing) {
          existing.quantity += gItem.quantity;
          // If existing item has no price but guest item does, update it
          if (!Number(existing.price) && Number(gItem.price)) {
            existing.price = gItem.price;
            existing.finalPrice = gItem.finalPrice || gItem.price;
          }
        } else {
          userCart.items.unshift(gItem);
        }
      });

      userCart.totalAmount = userCart.items.reduce((sum, item) => sum + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);
      userCart.totalQuantity = userCart.items.reduce((sum, item) => sum + Number(item.quantity || 1), 0);
      userCart.updatedAt = new Date();
      userCart.context = context;

      const targetQuery = userCart._id ? { _id: userCart._id } : { userId: String(userId), context };
      await collection.updateOne(targetQuery, { $set: userCart }, { upsert: true });
      await collection.deleteOne({ sessionId, context });

      // TRACK ABANDONED CART MERGE (CONVERT GUEST TO REAL USER)
      updateAbandonedCart({ 
        sessionId, 
        userId, 
        items: userCart.items, 
        totalAmount: userCart.totalAmount, 
        totalQuantity: userCart.totalQuantity, 
        context 
      });

      // TRIGGER ATC WEBHOOK FOR ALL ITEMS MERGED FROM GUEST CART
      if (userId && guestCart.items.length > 0) {
        // Run asynchronously
        triggerAtcWebhook(userId, guestCart.items, request);
      }
    }

    return userCart;
  });

  // POST /api/cart/checkout
  fastify.post('/checkout', async (request, reply) => {
    const { userId, sessionId, context = 'storefront' } = request.body;
    const lookupQuery = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(lookupQuery);
    
    if (cart) {
       // On checkout start, ensure abandoned cart is fully synced with latest info
       updateAbandonedCart({ 
         sessionId, 
         userId, 
         items: cart.items, 
         totalAmount: cart.totalAmount, 
         totalQuantity: cart.totalQuantity, 
         context 
       });
    }

    // For now, just return the cart. Real pricing validation would happen here.
    return cart || { items: [], totalAmount: 0, totalQuantity: 0, context };
  });

  // POST /api/cart/sync
  fastify.post('/sync', async (request, reply) => {
    const { userId, sessionId, items, context = 'storefront' } = request.body || {};
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });
    if (!Array.isArray(items)) return reply.code(400).send({ error: 'Items array is required' });

    const lookupQuery = buildCartQuery(userId, sessionId, context);
    let cart = await collection.findOne(lookupQuery);

    if (!cart) {
      cart = {
        userId: userId ? String(userId) : undefined,
        sessionId: sessionId || undefined,
        context,
        items: [],
        totalAmount: 0,
        totalQuantity: 0,
        createdAt: new Date()
      };
    }

    const incomingItemsMapped = items.map(incomingItem => {
      const existing = cart.items?.find(i => {
        if (!i.variantId || !incomingItem.variantId) return false;
        return String(i.variantId).toLowerCase() === String(incomingItem.variantId).toLowerCase();
      });
      return {
        // preserve existing custom fields if they exist
        ...(existing || {}),
        variantId: incomingItem.variantId,
        productId: incomingItem.productId || incomingItem.id,
        quantity: Math.max(1, Number(incomingItem.quantity || 1)),
        price: Number(incomingItem.price || incomingItem.finalPrice || 0),
        variantTitle: incomingItem.variantTitle || "",
        title: incomingItem.title || "",
        sku: incomingItem.sku || "",
        image: incomingItem.image || "",
        handle: incomingItem.handle || "",
        
        // sync incoming dynamic technical fields if provided
        goldWeight: incomingItem.goldWeight || existing?.goldWeight || 0,
        goldPrice: incomingItem.goldPrice || existing?.goldPrice || 0,
        goldPricePerGram: incomingItem.goldPricePerGram || existing?.goldPricePerGram || 0,
        makingCharges: incomingItem.makingCharges || existing?.makingCharges || 0,
        diamondCharges: incomingItem.diamondCharges || existing?.diamondCharges || 0,
        gst: incomingItem.gst || existing?.gst || 0,
        finalPrice: incomingItem.finalPrice || existing?.finalPrice || 0,
        diamondTotalPcs: incomingItem.diamondTotalPcs || existing?.diamondTotalPcs || 0,
        engraving: incomingItem.engraving || existing?.engraving || "",
        engravingText: incomingItem.engravingText || existing?.engravingText || "",
        engravingFont: incomingItem.engravingFont || existing?.engravingFont || "",
        giftText: incomingItem.giftText || existing?.giftText || "",
        variantOptions: incomingItem.variantOptions || existing?.variantOptions || [],
        availableSizes: incomingItem.availableSizes || existing?.availableSizes || [],
        inStock: incomingItem.inStock !== undefined ? incomingItem.inStock : existing?.inStock,
        leadTime: incomingItem.leadTime || existing?.leadTime || 12,
        estDelivery: incomingItem.estDelivery || existing?.estDelivery || "",
      };
    });

    const existingItemsToKeep = (cart.items || []).filter(existing => {
      return !items.some(inc => {
        if (!inc.variantId || !existing.variantId) return false;
        return String(inc.variantId).toLowerCase() === String(existing.variantId).toLowerCase();
      });
    });

    cart.items = [...incomingItemsMapped, ...existingItemsToKeep];

    cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
    cart.totalQuantity = cart.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    cart.updatedAt = new Date();
    cart.context = context;

    const targetQuery = cart._id ? { _id: cart._id } : (userId ? { userId: String(userId), context } : { sessionId, context });
    await collection.updateOne(targetQuery, { $set: cart }, { upsert: true });

    // TRACK ABANDONED CART SYNC
    updateAbandonedCart({ 
      sessionId, 
      userId, 
      items: cart.items, 
      totalAmount: cart.totalAmount, 
      totalQuantity: cart.totalQuantity, 
      context 
    });

    return cart;
  });

  // GET /api/cart/test-coupon
  fastify.get('/test-coupon', async (request, reply) => {
    const { code, id } = request.query;
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
      `, { code });

      const productsData = await shopifyStorefrontFetch(`
        query getCartProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              collections(first: 100) {
                nodes { id handle }
              }
            }
          }
        }
      `, { ids: [id] });

      return { discount: discountData, product: productsData };
    } catch (e) {
      return { error: e.message };
    }
  });

  // POST /api/cart/coupon/validate
  fastify.post('/coupon/validate', async (request, reply) => {
    try {
      const { items, couponCode, customerEmail } = request.body || {};

      if (!couponCode) {
        return reply.code(400).send({ error: "Coupon code is required" });
      }

      // Query ALL 3 discount types: Basic, BuyXGetY, FreeShipping
      // Previously only DiscountCodeBasic was queried → BuyXGetY / FreeShipping silently failed
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
                shortSummary
                minimumRequirement {
                  ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
                  ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
                }
                customerGets {
                  value {
                    ... on DiscountAmount {
                      amount { amount }
                    }
                    ... on DiscountPercentage {
                      percentage
                    }
                  }
                  items {
                    ... on AllDiscountItems { allItems }
                    ... on DiscountProducts {
                      products(first: 100) { nodes { id } }
                    }
                    ... on DiscountCollections {
                      collections(first: 100) { nodes { id } }
                    }
                  }
                }
              }
              ... on DiscountCodeBxgy {
                __typename
                title
                status
                summary
              }
              ... on DiscountCodeFreeShipping {
                __typename
                title
                status
                summary
                minimumRequirement {
                  ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
                  ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
                }
              }
            }
          }
        }
      `, { code: couponCode });

      const discountNode = discountData?.codeDiscountNodeByCode;
      const discountInfo = discountNode?.codeDiscount;

      // Check discount exists and is active
      if (!discountNode || !discountInfo || discountInfo.status !== "ACTIVE") {
        return reply.code(400).send({ error: "Invalid or expired coupon code" });
      }

      const discountType = discountInfo.__typename;

      let value = 0;
      let valueType = "FIXED_AMOUNT";
      let summary = discountInfo.summary || discountInfo.shortSummary || "Coupon applied successfully";

      if (discountType === "DiscountCodeBasic") {
        if (discountInfo.customerGets?.value?.amount) {
          value = Number(discountInfo.customerGets.value.amount.amount);
          valueType = "FIXED_AMOUNT";
        } else if (discountInfo.customerGets?.value?.percentage !== undefined) {
          // Shopify returns 0.1 for 10% — convert to actual percentage number
          value = Number(discountInfo.customerGets.value.percentage) * 100;
          valueType = "PERCENTAGE";
        }

        // Check minimum purchase requirement
        const minRequirement = discountInfo.minimumRequirement;
        if (minRequirement?.greaterThanOrEqualToSubtotal) {
          const minAmount = Number(minRequirement.greaterThanOrEqualToSubtotal.amount);
          const cartSubtotal = (items || []).reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
          if (cartSubtotal < minAmount) {
            return reply.code(400).send({
              error: `Minimum purchase of ₹${minAmount.toLocaleString('en-IN')} required to use this coupon. Your cart total is ₹${cartSubtotal.toLocaleString('en-IN')}.`
            });
          }
        }

        // --- Product/Collection eligibility check ---
        const entitledItems = discountInfo.customerGets?.items;

        if (entitledItems && !entitledItems.allItems) {
          const entitledProductIds = entitledItems.products?.nodes?.map(p => p.id) || [];
          const entitledCollectionIds = entitledItems.collections?.nodes?.map(c => c.id) || [];

          console.log("DEBUG: Entitled Products:", entitledProductIds);
          console.log("DEBUG: Entitled Collection IDs:", entitledCollectionIds);

          const cartProductIds = (items || []).map(item => {
            const id = item.shopifyId || item.productId || item.id;
            return (id && id.toString().includes("gid://")) ? id : `gid://shopify/Product/${id}`;
          }).filter(Boolean);

          console.log("DEBUG: Cart Product GIDs:", cartProductIds);

          // 1. Fetch real-time collection memberships for the cart products from Shopify
          let shopifyProducts = [];
          if (cartProductIds.length > 0) {
            try {
              // Using Storefront API instead of Admin API because Admin API sometimes returns null for nodes
              const productsData = await shopifyStorefrontFetch(`
                query getCartProducts($ids: [ID!]!) {
                  nodes(ids: $ids) {
                    ... on Product {
                      id
                      collections(first: 100) {
                        nodes { id handle }
                      }
                    }
                  }
                }
              `, { ids: cartProductIds });
              shopifyProducts = productsData?.nodes?.filter(Boolean) || [];
            } catch (shopifyErr) {
              console.error("ERROR fetching cart products from Shopify Storefront API:", shopifyErr);
            }
          }

          console.log("DEBUG: Shopify Products found:", JSON.stringify(shopifyProducts));

          // 2. Fetch from MongoDB next_local_db.products for fallback/tag-matching
          let dbProducts = [];
          try {
            const db = fastify.mongo.client.db("next_local_db");
            const productsCollection = db.collection("products");
            dbProducts = await productsCollection.find({ 
              shopifyId: { $in: cartProductIds } 
            }).project({ shopifyId: 1, collectionHandles: 1, tags: 1 }).toArray();
          } catch (dbErr) {
            console.error("ERROR querying products from DB:", dbErr);
          }

          console.log("DEBUG: DB Products found:", dbProducts.map(p => ({ id: p.shopifyId, collections: p.collectionHandles, tags: p.tags })));

          let entitledCollectionHandles = [];
          if (entitledCollectionIds.length > 0) {
            // Fetch handles for the entitled collection IDs with chunking
            const uniqueCollIds = [...new Set(entitledCollectionIds)];
            const CHUNK_SIZE = 100;
            const collNodes = [];

            const chunkPromises = [];

            for (let i = 0; i < uniqueCollIds.length; i += CHUNK_SIZE) {
              const chunk = uniqueCollIds.slice(i, i + CHUNK_SIZE);
              chunkPromises.push(
                shopifyAdminFetch(`
                  query getCollections($ids: [ID!]!) {
                    nodes(ids: $ids) {
                      ... on Collection {
                        id
                        handle
                      }
                    }
                  }
                `, { ids: chunk }).catch(collErr => {
                  console.error("ERROR fetching collection handles:", collErr);
                  return null;
                })
              );
            }

            const chunkResults = await Promise.all(chunkPromises);
            chunkResults.forEach((collectionsData) => {
              if (collectionsData?.nodes) {
                collNodes.push(...collectionsData.nodes);
              }
            });
            
            entitledCollectionHandles = collNodes.map(n => n.handle).filter(Boolean) || [];
            console.log("DEBUG: Entitled Collection Handles:", entitledCollectionHandles);
          }

          const applicableItems = (items || []).filter(item => {
            // Normalize Product GID for comparison
            const rawId = item.shopifyId || item.productId || item.id;
            let productGid = (rawId && rawId.toString().includes("gid://")) ? rawId : `gid://shopify/Product/${rawId}`;

            // EMBRACE3% (Eterna) applies ONLY to products explicitly tagged "embrace".
            // Use an exact tag match — never a substring match on title/handle, or
            // names like "Eternal Heart Plain Gold Ring" falsely match "eterna".
            if (couponCode.toUpperCase() === 'EMBRACE3%') {
              const dbProductEmbrace = dbProducts.find(p => p.shopifyId === productGid);
              const hasEmbraceTag = tags =>
                Array.isArray(tags) &&
                tags.some(t => typeof t === 'string' && t.trim().toLowerCase() === 'embrace');
              return hasEmbraceTag(item.tags) || (dbProductEmbrace && hasEmbraceTag(dbProductEmbrace.tags));
            }

            // 1. Check if product is explicitly entitled
            let isProductEntitled = entitledProductIds.includes(productGid);
            
            // 2. Check if any of product's collections are entitled (via Shopify Real-time API)
            const shopifyProduct = shopifyProducts.find(p => p.id === productGid);
            const productCollectionIds = shopifyProduct?.collections?.nodes?.map(c => c.id) || [];
            const productCollectionHandles = shopifyProduct?.collections?.nodes?.map(c => c.handle) || [];
            
            let isCollectionEntitled = entitledCollectionIds.some(cid => productCollectionIds.includes(cid)) ||
                                       entitledCollectionHandles.some(ch => productCollectionHandles.includes(ch));

            // 3. Fallback: Check MongoDB collections/tags matching
            if (!isCollectionEntitled) {
              const dbProduct = dbProducts.find(p => p.shopifyId === productGid);
              if (dbProduct) {
                // 3a. Check collectionHandles in DB (if any exist)
                if (dbProduct.collectionHandles && entitledCollectionHandles.length > 0) {
                  isCollectionEntitled = dbProduct.collectionHandles.some(h => entitledCollectionHandles.includes(h));
                }
                // 3b. Check tags converted to handles/slugs matching entitled collection handles
                if (!isCollectionEntitled && dbProduct.tags && entitledCollectionHandles.length > 0) {
                  const tagSlugs = dbProduct.tags.map(tag => tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));
                  isCollectionEntitled = tagSlugs.some(slug => entitledCollectionHandles.includes(slug));
                }
              }
              
              // 3c. FINAL FALLBACK: Check if the product handle or title contains the collection handle words
              if (!isCollectionEntitled && entitledCollectionHandles.length > 0) {
                const lowerHandle = (item.handle || "").toLowerCase();
                const lowerTitle = (item.title || "").toLowerCase();
                const lowerType = (item.type || item.category || "").toLowerCase();
                
                // Helper to normalize strings (remove punctuation, apostrophes, and 's' at the end of words)
                const normalize = (str) => {
                  return str.replace(/['’]s/g, '') // remove 's and ’s
                            .replace(/[^a-z0-9\s-]/g, ' ') // remove other punctuation
                            .replace(/-/g, ' ') // dashes to spaces
                            .split(/\s+/)
                            .map(w => w.endsWith('s') && w.length > 3 ? w.slice(0, -1) : w) // simple depluralize
                            .filter(Boolean)
                            .join(' ');
                };

                const normTitle = normalize(lowerTitle);
                const normHandle = normalize(lowerHandle);
                const normType = normalize(lowerType);

                isCollectionEntitled = entitledCollectionHandles.some(ch => {
                   const normColl = normalize(ch);
                   // If the normalized collection string is entirely contained in the normalized title/handle/type
                   if (normHandle.includes(normColl) || normTitle.includes(normColl) || normType.includes(normColl)) {
                     return true;
                   }
                   
                   // Or if all significant words of the collection handle exist in the title/handle
                   const collWords = normColl.split(' ').filter(w => w.length > 2 && w !== 'all' && w !== 'collection');
                   if (collWords.length > 0) {
                     return collWords.every(w => normHandle.includes(w) || normTitle.includes(w) || normType.includes(w));
                   }
                   return false;
                });
                
                // Extra Smart Fallback: If the coupon is for 'diamond-jewelry', and the cart item actually has diamonds,
                // allow it even if the product was accidentally missed from the Shopify collection.
                if (!isCollectionEntitled && entitledCollectionHandles.includes('diamond-jewelry')) {
                  if (item.diamondTotalPcs > 0 || (item.diamondCharges && item.diamondCharges > 0)) {
                    isCollectionEntitled = true;
                  }
                }
              }
            }

            console.log(`DEBUG: Item ${rawId} - Product Entitled: ${isProductEntitled}, Collection Entitled: ${isCollectionEntitled}`);
            return isProductEntitled || isCollectionEntitled;
          });

          console.log("DEBUG: Applicable items count:", applicableItems.length);

          if (applicableItems.length === 0) {
            return reply.code(400).send({
              error: "This coupon is not applicable to the items in your cart."
            });
          }

          var applicableItemIds = applicableItems.map(item => {
            const rawId = item.shopifyId || item.productId || item.id;
            return (rawId && rawId.toString().includes("gid://")) ? rawId : `gid://shopify/Product/${rawId}`;
          });
        }

      } else if (discountType === "DiscountCodeFreeShipping") {
        // Free shipping coupon — value is 0 but mark shipping as free
        value = 0;
        valueType = "FREE_SHIPPING";

        const minRequirement = discountInfo.minimumRequirement;
        if (minRequirement?.greaterThanOrEqualToSubtotal) {
          const minAmount = Number(minRequirement.greaterThanOrEqualToSubtotal.amount);
          const cartSubtotal = (items || []).reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
          if (cartSubtotal < minAmount) {
            return reply.code(400).send({
              error: `Minimum purchase of ₹${minAmount.toLocaleString('en-IN')} required for free shipping. Your cart total is ₹${cartSubtotal.toLocaleString('en-IN')}.`
            });
          }
        }

      } else if (discountType === "DiscountCodeBxgy") {
        // Buy X Get Y coupon — applied automatically at Shopify checkout
        // We accept it here but note it applies at checkout, not in our cart UI
        value = 0;
        valueType = "BXGY";
        summary = discountInfo.summary || "Buy X Get Y offer — discount will apply at checkout";
      }

      return {
        success: true,
        code: couponCode.trim().toUpperCase(),
        summary,
        value,
        valueType,
        applicableItemIds: typeof applicableItemIds !== 'undefined' ? applicableItemIds : []
      };
    } catch (error) {
      console.error("COUPON VALIDATION ERROR:", error);
      return reply.code(500).send({ error: "Failed to validate coupon", message: error.message });
    }
  });
}

module.exports = routes;

