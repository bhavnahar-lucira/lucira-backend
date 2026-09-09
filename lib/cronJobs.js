const cron = require('node-cron');
const { shopifyAdminFetch } = require('./shopify');

async function sendWebEngageEvent(customerId, eventName, data) {
  const apiKey = process.env.WEBENGAGE_API_KEY;
  const licenseCode = process.env.WEBENGAGE_LICENSE_CODE;
  
  if (!apiKey || !licenseCode) {
    console.warn(`[Cron] WebEngage credentials missing. Cannot fire ${eventName} event.`);
    return;
  }
  
  const url = `https://api.webengage.com/v1/accounts/${licenseCode}/events`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        userId: customerId,
        eventName: eventName,
        eventTime: new Date().toISOString(),
        eventData: data
      })
    });
    if (!res.ok) {
      console.error(`[Cron] WebEngage API error: ${res.statusText}`);
    } else {
      console.log(`[Cron] Successfully fired ${eventName} for ${customerId}`);
    }
  } catch (error) {
    console.error(`[Cron] Failed to send WebEngage event: ${error.message}`);
  }
}

async function createShopifyDiscountCode(shopifyCustomerId, occasionType) {
  // occasionType: 'BIRTHDAY' or 'ANNIVERSARY'
  const idPrefix = occasionType === 'BIRTHDAY' ? 'BDAY' : 'ANNI';
  const rawId = shopifyCustomerId.split('/').pop();
  const year = new Date().getFullYear();
  const codeString = `${idPrefix}-${rawId}-${year}`; // e.g. BDAY-123456789-2026
  
  const startsAt = new Date().toISOString();
  const endsAtDate = new Date();
  endsAtDate.setDate(endsAtDate.getDate() + 14);
  const endsAt = endsAtDate.toISOString();

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
          }
        }
        userErrors {
          field
          code
          message
        }
      }
    }
  `;

  const variables = {
    basicCodeDiscount: {
      title: `${occasionType} Coupon for ${rawId}`,
      code: codeString,
      startsAt: startsAt,
      endsAt: endsAt,
      customerSelection: {
        customers: {
          add: [shopifyCustomerId]
        }
      },
      customerGets: {
        value: {
          discountAmount: {
            amount: 500,
            appliesOnEachItem: false
          }
        },
        items: {
          all: true
        }
      },
      appliesOncePerCustomer: true,
      usageLimit: 1
    }
  };

  try {
    const data = await shopifyAdminFetch(mutation, variables);
    const errors = data?.discountCodeBasicCreate?.userErrors;
    if (errors && errors.length > 0) {
      console.error(`[Cron] Error creating discount code:`, errors);
      return null;
    }
    
    // Also save this code to the customer's metafield so the frontend can display it
    const metafieldMutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { message }
        }
      }
    `;
    await shopifyAdminFetch(metafieldMutation, {
      metafields: [{
        ownerId: shopifyCustomerId,
        namespace: "lucira_profile",
        key: "active_coupon",
        value: codeString,
        type: "single_line_text_field"
      }]
    });

    return codeString;
  } catch (err) {
    console.error(`[Cron] Exception creating discount code: ${err.message}`);
    return null;
  }
}

function initCronJobs(fastify) {
  // Run every day at 12:00 AM
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Running daily birthday and anniversary check...');
    
    try {
      const db = fastify.mongo.db;
      if (!db) {
        console.error('[Cron] MongoDB instance not available');
        return;
      }
      
      const customersCollection = db.collection('customers');
      
      // Target date: exactly 7 days from now
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 7);
      
      // Format as DD-MM to match frontend format (e.g., 03-01-1999)
      const day = String(targetDate.getDate()).padStart(2, '0');
      const month = String(targetDate.getMonth() + 1).padStart(2, '0');
      const targetDateStringRegex = new RegExp(`^${day}-${month}`); // Matches DD-MM-*
      
      console.log(`[Cron] Looking for occasions matching: ${day}-${month}`);
      
      // Query MongoDB
      const eligibleCustomers = await customersCollection.find({
        $or: [
          { date_of_birth: { $regex: targetDateStringRegex } },
          { anniversary_date: { $regex: targetDateStringRegex } }
        ]
      }).toArray();
      
      console.log(`[Cron] Found ${eligibleCustomers.length} eligible customers.`);
      
      for (const customer of eligibleCustomers) {
        const shopifyId = customer.shopify_customer_id;
        if (!shopifyId) continue;
        
        const fullShopifyId = shopifyId.includes('gid://') ? shopifyId : `gid://shopify/Customer/${shopifyId}`;
        
        let occasion = null;
        if (customer.date_of_birth && targetDateStringRegex.test(customer.date_of_birth)) occasion = 'BIRTHDAY';
        if (customer.anniversary_date && targetDateStringRegex.test(customer.anniversary_date)) occasion = 'ANNIVERSARY';
        
        if (!occasion) continue;
        
        // Ensure we haven't already processed this exact occasion this year
        // To prevent multiple triggers, we could check a 'last_processed_year' field, but since this runs once a day, it's fine.
        const currentYear = new Date().getFullYear();
        if (customer[`last_coupon_year_${occasion}`] === currentYear) {
          continue; 
        }

        console.log(`[Cron] Generating ${occasion} coupon for ${shopifyId}`);
        const code = await createShopifyDiscountCode(fullShopifyId, occasion);
        
        if (code) {
          // Fire WebEngage promoClick
          await sendWebEngageEvent(shopifyId, 'promoClick', {
            coupon_code: code,
            discount_value: 500,
            occasion: occasion
          });

          // Mark as processed in Mongo
          const updateField = `last_coupon_year_${occasion}`;
          await customersCollection.updateOne(
            { _id: customer._id },
            { $set: { [updateField]: currentYear } }
          );
        }
      }
      
    } catch (err) {
      console.error('[Cron] Error running daily check:', err);
    }
  });
}

module.exports = { initCronJobs };
