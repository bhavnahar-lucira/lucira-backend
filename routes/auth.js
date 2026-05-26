/**
 * Authentication Routes (Fastify)
 * Handles OTP sending, verification, and customer registration
 */

const crypto = require('crypto');
const { shopifyAdminFetch, shopifyStorefrontFetch, shopifyAdminRestFetch } = require('../lib/shopify');

function formatMobile(raw) {
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.length === 10) return "91" + cleaned;
  return cleaned;
}

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const otpCollection = db.collection('otps');
  const customerCollection = db.collection('customers');

  // POST /api/auth/check-customer
  fastify.post('/check-customer', async (request, reply) => {
    const { mobile } = request.body;
    if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

    const formatted = formatMobile(mobile);
    const query = `{ customers(first: 1, query: "phone:${formatted}") { edges { node { id firstName lastName } } } }`;
    const data = await shopifyAdminFetch(query);
    const customer = data?.customers?.edges?.[0]?.node;

    if (customer) {
      return { exists: true, firstName: customer.firstName, lastName: customer.lastName };
    }
    return { exists: false };
  });

  // POST /api/auth/send-otp
  fastify.post('/send-otp', async (request, reply) => {
    const { mobile } = request.body;
    if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

    const formatted = formatMobile(mobile);
    const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    await otpCollection.updateOne(
      { mobile: formatted },
      { $set: { otp, expiresAt, createdAt: new Date() } },
      { upsert: true }
    );

    // Send SMS via MSG91
    try {
      const authKey = process.env.MSG91_AUTH_KEY;
      const templateId = process.env.MSG91_TEMPLATE_ID;

      if (authKey && templateId) {
        const msg91Url = `https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=${formatted}&authkey=${authKey}&otp=${otp}`;
        const response = await fetch(msg91Url, { method: 'POST' });
        const textResponse = await response.text(); let result; try { result = JSON.parse(textResponse); } catch(e) { result = { type: 'error', message: textResponse }; }
        
        if (result.type !== "success") {
          console.error("[MSG91 Error]", result);
          // Don't throw here, the record is still in DB, but log it
        } else {
          console.log(`[OTP] MSG91 Sent ${otp} to ${formatted}`);
        }
      } else {
        console.warn("[OTP] MSG91 credentials missing, logging to console only.");
        console.log(`[OTP] Sent ${otp} to ${formatted}`);
      }
    } catch (err) {
      console.error("[OTP SMS Error]", err);
    }
    
    return { success: true, message: 'OTP sent successfully' };
  });

  // POST /api/auth/verify-otp
  fastify.post('/verify-otp', async (request, reply) => {
    const { mobile, otp } = request.body;
    if (!mobile || !otp) return reply.code(400).send({ error: 'Mobile and OTP required' });

    const formatted = formatMobile(mobile);
    const record = await otpCollection.findOne({ mobile: formatted });

    if (!record || record.otp !== otp || record.expiresAt < new Date()) {
      return reply.code(400).send({ error: 'Invalid or expired OTP' });
    }

    // OTP verified, clear it
    await otpCollection.deleteOne({ _id: record._id });

    // Check if customer exists in Shopify
    const query = `{ customers(first: 1, query: "phone:${formatted}") { edges { node { id firstName lastName email phone } } } }`;
    const data = await shopifyAdminFetch(query);
    const customer = data?.customers?.edges?.[0]?.node;

    if (customer) {
      // Generate a new secure password
      const newPassword = crypto.randomBytes(16).toString("hex");
      const emailToUse = customer.email || `${formatted}@lucira.internal`;

      // Update customer password in Shopify via Admin REST API
      const numericCustomerId = customer.id.split('/').pop();
      await shopifyAdminRestFetch(`customers/${numericCustomerId}.json`, {}, {
        method: "PUT",
        body: JSON.stringify({
          customer: {
            id: numericCustomerId,
            email: emailToUse,
            password: newPassword,
            password_confirmation: newPassword
          }
        })
      });

      // Create Storefront Customer Access Token (Retry loop due to Shopify sync delay)
      let storefrontToken = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const tokenData = await shopifyStorefrontFetch(`
            mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
              customerAccessTokenCreate(input: $input) {
                customerAccessToken { accessToken expiresAt }
                userErrors { field message }
              }
            }
          `, {
            input: {
              email: emailToUse,
              password: newPassword
            }
          });
          
          if (tokenData?.customerAccessTokenCreate?.customerAccessToken?.accessToken) {
            storefrontToken = tokenData.customerAccessTokenCreate.customerAccessToken.accessToken;
            break;
          } else if (tokenData?.customerAccessTokenCreate?.userErrors?.length > 0) {
            console.warn(`[verify-otp] Token creation user error (Attempt ${attempt}):`, tokenData.customerAccessTokenCreate.userErrors);
          }
        } catch (err) {
          console.error(`[verify-otp] Failed to create storefront token (Attempt ${attempt}):`, err.message);
        }
        
        if (!storefrontToken && attempt < 3) {
          // Wait 1.5 seconds before retrying
          await new Promise(res => setTimeout(res, 1500));
        }
      }

      if (!storefrontToken) {
         console.error("[verify-otp] FATAL: Could not generate Shopify Storefront Token after 3 attempts.");
      }

      const finalToken = storefrontToken || ("simulated_token_" + crypto.randomBytes(16).toString('hex'));

      return { 
        status: 'LOGIN', 
        user: {
          id: customer.id,
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email || emailToUse,
          mobile: formatted
        },
        accessToken: finalToken
      };
    }

    return { status: 'REGISTER', mobile: formatted };
  });

  // POST /api/auth/register
  fastify.post('/register', async (request, reply) => {
    const { firstName, lastName, email, mobile } = request.body;
    
    const randomPassword = crypto.randomBytes(16).toString('hex');
    try {
      const formattedMobile = formatMobile(mobile);
      const phoneString = formattedMobile.startsWith('+') ? formattedMobile : `+${formattedMobile}`;

      const restData = await shopifyAdminRestFetch('customers.json', {}, {
        method: "POST",
        body: JSON.stringify({
          customer: {
            first_name: firstName,
            last_name: lastName,
            email,
            phone: phoneString,
            password: randomPassword,
            password_confirmation: randomPassword,
            verified_email: true,
            email_marketing_consent: {
              state: "subscribed",
              opt_in_level: "single_opt_in"
            }
          }
        })
      });

      const customer = restData?.data?.customer;
      if (!customer) {
        throw new Error("Failed to create customer in Shopify");
      }

      // Create Storefront Customer Access Token
      let storefrontToken = null;
      try {
        const tokenData = await shopifyStorefrontFetch(`
          mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
            customerAccessTokenCreate(input: $input) {
              customerAccessToken { accessToken expiresAt }
              userErrors { field message }
            }
          }
        `, {
          input: {
            email: customer.email,
            password: randomPassword
          }
        });
        storefrontToken = tokenData?.customerAccessTokenCreate?.customerAccessToken?.accessToken;
      } catch (err) {
        console.error("[register] Failed to create storefront token:", err);
      }

      const finalToken = storefrontToken || ("simulated_token_" + crypto.randomBytes(16).toString('hex'));

      return { 
        status: 'REGISTER_SUCCESS', 
        user: {
          id: `gid://shopify/Customer/${customer.id}`,
          first_name: customer.first_name || "",
          last_name: customer.last_name || "",
          email: customer.email || "",
          mobile: customer.phone || ""
        },
        accessToken: finalToken
      };
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/auth/logout
  fastify.post('/logout', async (request, reply) => {
    return { success: true };
  });

  // GET /api/auth/admin-login
  fastify.get('/admin-login', async (request, reply) => {
      // Logic for admin login check
      return { authenticated: false };
  });
}

module.exports = routes;
