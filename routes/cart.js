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

  // Helper for tracking
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

  // GET /api/cart/get
  fastify.get('/get', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { userId, sessionId, context = 'storefront' } = request.query;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const query = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(query);

    return cart || { items: [], totalAmount: 0, totalQuantity: 0, context };
  });

  // POST /api/cart/add
  fastify.post('/add', async (request, reply) => {
    const { userId, sessionId, product, context = 'storefront' } = request.body;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const lookupQuery = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(lookupQuery) || { items: [], totalAmount: 0, totalQuantity: 0, context };

    const existingIndex = cart.items.findIndex(i => i.variantId === product.variantId);
    if (existingIndex > -1) {
      cart.items[existingIndex].quantity += (product.quantity || 1);
    } else {
      cart.items.unshift(product);
    }

    // Recalculate totals
    cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);
    cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.updatedAt = new Date();
    cart.context = context;

    const targetQuery = cart._id ? { _id: cart._id } : (userId ? { userId: String(userId), context } : { sessionId, context });
    await collection.updateOne(targetQuery, { $set: cart }, { upsert: true });

    // TRACK ADD TO CART
    await trackCartEvent('ADD_TO_CART', {
      userId,
      sessionId,
      context,
      product,
      email: request.body.email || cart.customer?.email,
      phone: request.body.phone || cart.customer?.phone
    }, request);

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
          cart.items[itemIndex].quantity = quantity;
        }
      }
      
      cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);
      cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      cart.updatedAt = new Date();
      await collection.updateOne({ _id: cart._id }, { $set: cart });
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
    }

    return userCart;
  });

  // POST /api/cart/checkout
  fastify.post('/checkout', async (request, reply) => {
    const { userId, sessionId, context = 'storefront' } = request.body;
    const lookupQuery = buildCartQuery(userId, sessionId, context);
    const cart = await collection.findOne(lookupQuery);
    
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
        quantity: Number(incomingItem.quantity || 1),
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
              collections(first: 20) {
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
                      collections(first: 20) {
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
            
            // 1. Check if product is explicitly entitled
            const isProductEntitled = entitledProductIds.includes(productGid);
            
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
        valueType
      };
    } catch (error) {
      console.error("COUPON VALIDATION ERROR:", error);
      return reply.code(500).send({ error: "Failed to validate coupon", message: error.message });
    }
  });
}

module.exports = routes;

