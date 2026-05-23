/**
 * Cart Routes (Fastify)
 */

const { shopifyAdminFetch } = require('../lib/shopify');

async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('carts');

  // Helper to build robust format-agnostic cart lookup query
  function buildCartQuery(userId, sessionId) {
    const conditions = [];
    if (userId) {
      const rawId = String(userId).trim();
      conditions.push({ userId: rawId });
      if (rawId.startsWith("gid://shopify/Customer/")) {
        const numericId = rawId.replace("gid://shopify/Customer/", "");
        conditions.push({ userId: numericId });
      } else {
        conditions.push({ userId: `gid://shopify/Customer/${rawId}` });
      }
    }
    if (sessionId) {
      conditions.push({ sessionId });
    }
    return conditions.length === 1 ? conditions[0] : { $or: conditions };
  }

  // GET /api/cart/get
  fastify.get('/get', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { userId, sessionId } = request.query;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const query = buildCartQuery(userId, sessionId);
    const cart = await collection.findOne(query);

    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });

  // POST /api/cart/add
  fastify.post('/add', async (request, reply) => {
    const { userId, sessionId, product } = request.body;
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });

    const lookupQuery = buildCartQuery(userId, sessionId);
    const cart = await collection.findOne(lookupQuery) || { items: [], totalAmount: 0, totalQuantity: 0 };

    const existingIndex = cart.items.findIndex(i => i.variantId === product.variantId);
    if (existingIndex > -1) {
      cart.items[existingIndex].quantity += (product.quantity || 1);
    } else {
      cart.items.unshift(product);
    }

    // Recalculate totals
    cart.totalAmount = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    cart.updatedAt = new Date();

    const targetQuery = cart._id ? { _id: cart._id } : (userId ? { userId: String(userId) } : { sessionId });
    await collection.updateOne(targetQuery, { $set: cart }, { upsert: true });
    return cart;
  });

  // POST /api/cart/remove
  fastify.post('/remove', async (request, reply) => {
    const { userId, sessionId, variantId } = request.body;
    const lookupQuery = buildCartQuery(userId, sessionId);
    const cart = await collection.findOne(lookupQuery);

    if (cart) {
      cart.items = cart.items.filter(i => i.variantId !== variantId);
      cart.totalAmount = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      cart.updatedAt = new Date();
      await collection.updateOne({ _id: cart._id }, { $set: cart });
    }

    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });

  // POST /api/cart/update
  fastify.post('/update', async (request, reply) => {
    const { userId, sessionId, currentVariantId, nextVariantId, quantity, size, price, variantTitle, inStock, sku } = request.body;
    const lookupQuery = buildCartQuery(userId, sessionId);
    const cart = await collection.findOne(lookupQuery);

    if (cart) {
      const itemIndex = cart.items.findIndex(i => i.variantId === currentVariantId);
      if (itemIndex > -1) {
        if (nextVariantId) {
          cart.items[itemIndex].variantId = nextVariantId;
          cart.items[itemIndex].size = size;
          cart.items[itemIndex].price = price;
          cart.items[itemIndex].variantTitle = variantTitle;
          cart.items[itemIndex].inStock = inStock;
          cart.items[itemIndex].sku = sku;
        }
        if (quantity !== undefined) {
          cart.items[itemIndex].quantity = quantity;
        }
      }
      
      cart.totalAmount = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      cart.totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
      cart.updatedAt = new Date();
      await collection.updateOne({ _id: cart._id }, { $set: cart });
    }

    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });

  // POST /api/cart/merge
  fastify.post('/merge', async (request, reply) => {
    const { userId, sessionId } = request.body;
    if (!userId || !sessionId) return reply.code(400).send({ error: 'Identity required' });

    // Normalize variantId to numeric string for comparison (strips GID prefix)
    const normalizeVid = (id) => String(id || '').replace(/.*ProductVariant\//i, '').trim();

    const guestCart = await collection.findOne({ sessionId });
    const lookupQuery = buildCartQuery(userId, null);
    const userCart = await collection.findOne(lookupQuery) || { items: [], totalAmount: 0, totalQuantity: 0 };

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

      const targetQuery = userCart._id ? { _id: userCart._id } : { userId: String(userId) };
      await collection.updateOne(targetQuery, { $set: userCart }, { upsert: true });
      await collection.deleteOne({ sessionId });
    }

    return userCart;
  });

  // POST /api/cart/checkout
  fastify.post('/checkout', async (request, reply) => {
    const { userId, sessionId } = request.body;
    const lookupQuery = buildCartQuery(userId, sessionId);
    const cart = await collection.findOne(lookupQuery);
    
    // For now, just return the cart. Real pricing validation would happen here.
    return cart || { items: [], totalAmount: 0, totalQuantity: 0 };
  });

  // POST /api/cart/sync
  fastify.post('/sync', async (request, reply) => {
    const { userId, sessionId, items } = request.body || {};
    if (!userId && !sessionId) return reply.code(400).send({ error: 'Identity required' });
    if (!Array.isArray(items)) return reply.code(400).send({ error: 'Items array is required' });

    const lookupQuery = buildCartQuery(userId, sessionId);
    let cart = await collection.findOne(lookupQuery);

    if (!cart) {
      cart = {
        userId: userId ? String(userId) : undefined,
        sessionId: sessionId || undefined,
        items: [],
        totalAmount: 0,
        totalQuantity: 0,
        createdAt: new Date()
      };
    }

    cart.items = items.map(incomingItem => {
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
      };
    });

    cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
    cart.totalQuantity = cart.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    cart.updatedAt = new Date();

    const targetQuery = cart._id ? { _id: cart._id } : (userId ? { userId: String(userId) } : { sessionId });
    await collection.updateOne(targetQuery, { $set: cart }, { upsert: true });

    return cart;
  });

  // POST /api/cart/coupon/validate
  fastify.post('/coupon/validate', async (request, reply) => {
    try {
      const { items, couponCode, customerEmail } = request.body || {};

      if (!couponCode) {
        return reply.code(400).send({ error: "Coupon code is required" });
      }

      const discountData = await shopifyAdminFetch(`
        query getDiscount($code: String!) {
          codeDiscountNodeByCode(code: $code) {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                status
                summary
                shortSummary
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
            }
          }
        }
      `, { code: couponCode });

      const discountNode = discountData?.codeDiscountNodeByCode;

      if (!discountNode || discountNode.codeDiscount.status !== "ACTIVE") {
        return reply.code(400).send({ error: "Invalid or expired coupon code" });
      }

      const discountInfo = discountNode.codeDiscount;
      let value = 0;
      let valueType = "FIXED_AMOUNT";

      if (discountInfo.customerGets?.value?.amount) {
        value = Number(discountInfo.customerGets.value.amount.amount);
        valueType = "FIXED_AMOUNT";
      } else if (discountInfo.customerGets?.value?.percentage) {
        value = Number(discountInfo.customerGets.value.percentage) * 100; // Shopify returns 0.1 for 10%
        valueType = "PERCENTAGE";
      }

      // --- Validation against Cart Items ---
      const entitledItems = discountInfo.customerGets?.items;
      
      // If it's not "all items", we need to validate
      if (entitledItems && !entitledItems.allItems) {
        const entitledProductIds = entitledItems.products?.nodes?.map(p => p.id) || [];
        const entitledCollectionIds = entitledItems.collections?.nodes?.map(c => c.id) || [];

        console.log("DEBUG: Entitled Products:", entitledProductIds);
        console.log("DEBUG: Entitled Collection IDs:", entitledCollectionIds);

        // Get product details for items in cart to check their IDs and collections
        const cartProductIds = (items || []).map(item => {
          const id = item.shopifyId || item.productId || item.id;
          return (id && id.toString().includes("gid://")) ? id : `gid://shopify/Product/${id}`;
        }).filter(Boolean);
        
        console.log("DEBUG: Cart Product GIDs:", cartProductIds);

        // 1. Fetch real-time collection memberships for the cart products from Shopify
        let shopifyProducts = [];
        if (cartProductIds.length > 0) {
          try {
            const productsData = await shopifyAdminFetch(`
              query getCartProducts($ids: [ID!]!) {
                nodes(ids: $ids) {
                  ... on Product {
                    id
                    collections(first: 20) {
                      nodes {
                        id
                        handle
                      }
                    }
                  }
                }
              }
            `, { ids: cartProductIds });
            shopifyProducts = productsData?.nodes?.filter(Boolean) || [];
          } catch (shopifyErr) {
            console.error("ERROR fetching cart products from Shopify:", shopifyErr);
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

          for (let i = 0; i < uniqueCollIds.length; i += CHUNK_SIZE) {
            const chunk = uniqueCollIds.slice(i, i + CHUNK_SIZE);
            try {
              const collectionsData = await shopifyAdminFetch(`
                query getCollections($ids: [ID!]!) {
                  nodes(ids: $ids) {
                    ... on Collection {
                      id
                      handle
                    }
                  }
                }
              `, { ids: chunk });
              if (collectionsData?.nodes) {
                collNodes.push(...collectionsData.nodes);
              }
            } catch (collErr) {
              console.error("ERROR fetching collection handles:", collErr);
            }
          }
          
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
          }

          console.log(`DEBUG: Item ${rawId} (${productGid}) - Product Entitled: ${isProductEntitled}, Collection Entitled: ${isCollectionEntitled}`);
          return isProductEntitled || isCollectionEntitled;
        });

        console.log("DEBUG: Applicable items count:", applicableItems.length);

        if (applicableItems.length === 0) {
          return reply.code(400).send({ 
            error: "This coupon is not applicable to the items in your cart." 
          });
        }
      }
      
      return { 
        success: true, 
        code: couponCode,
        summary: discountInfo.summary || discountInfo.shortSummary || "Coupon applied successfully",
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
