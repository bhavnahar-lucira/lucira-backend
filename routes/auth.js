/**
 * Authentication Routes (Fastify)
 * Handles OTP sending, verification, and customer registration
 */

const crypto = require('crypto');
const { shopifyAdminFetch, shopifyStorefrontFetch } = require('../lib/shopify');

function formatMobile(raw) {
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.length === 10) return "91" + cleaned;
  return cleaned;
}

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const otpCollection = db.collection('otps');
  const customerCollection = db.collection('customers');

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
      // Create Customer Access Token
      const mutation = `mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
        customerAccessTokenCreate(input: $input) {
          customerAccessToken { accessToken expiresAt }
          userErrors { field message }
        }
      }`;
      
      // In a real scenario, we'd need a password or a special multi-pass/multipass-like logic 
      // but for headless OTP we often use a proxy or a temporary password.
      // For this implementation, we'll return the customer and a simulated token 
      // OR use the Shopify Multipass if enabled.
      
      return { 
        status: 'LOGIN', 
        user: {
          id: customer.id,
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email,
          mobile: formatted
        },
        accessToken: "simulated_token_" + crypto.randomBytes(16).toString('hex') 
      };
    }

    return { status: 'REGISTER', mobile: formatted };
  });

  // POST /api/auth/register
  fastify.post('/register', async (request, reply) => {
    const { firstName, lastName, email, mobile } = request.body;
    
    const mutation = `mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id firstName lastName email phone }
        userErrors { field message }
      }
    }`;

    const variables = {
      input: {
        firstName,
        lastName,
        email,
        phone: formatMobile(mobile).startsWith('+') ? formatMobile(mobile) : `+${formatMobile(mobile)}`,
        password: crypto.randomBytes(12).toString('hex'), // Random password for headless
      }
    };

    try {
      const data = await shopifyAdminFetch(mutation, variables);
      if (data.customerCreate.userErrors?.length > 0) {
        return reply.code(400).send({ error: data.customerCreate.userErrors[0].message });
      }

      const customer = data.customerCreate.customer;
      return { 
        status: 'REGISTER_SUCCESS', 
        user: {
          id: customer.id,
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email,
          mobile: customer.phone
        },
        accessToken: "simulated_token_" + crypto.randomBytes(16).toString('hex')
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
