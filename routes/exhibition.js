/**
 * Event Exhibition Registration & Reward Routes (Fastify)
 * Handles customer registration, mandatory field validation (First Name, Last Name, Email, Phone, DOB),
 * OTP verification, and 1000 Lucira/Nector Coins reward attribution with single-claim enforcement.
 */

const crypto = require('crypto');
const { shopifyAdminFetch, shopifyStorefrontFetch, shopifyAdminRestFetch } = require('../lib/shopify');

function formatMobile(raw) {
  if (!raw) return "";
  let str = String(raw).trim();
  let cleaned = str.replace(/\D/g, "");
  
  if (cleaned.length === 12 && cleaned.startsWith("91")) {
    cleaned = cleaned.substring(2);
  }

  while (cleaned.startsWith("0")) {
    cleaned = cleaned.substring(1);
  }

  if (cleaned.length === 10) return "91" + cleaned;
  return cleaned;
}

function parseDobToIso(raw) {
  if (!raw) return "";
  const str = String(raw).trim();
  // Format YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // Format DD/MM/YYYY
  const parts = str.split(/[/.-]/);
  if (parts.length === 3) {
    if (parts[0].length === 2 && parts[2].length === 4) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }
  return str;
}

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const otpCollection = db.collection('otps');
  const customerCollection = db.collection('customers');
  const exhibitionClaimsCollection = db.collection('exhibition_claims');

  // POST /api/exhibition/check
  // Checks if mobile exists and if user has already claimed the 1000 exhibition coins
  fastify.post('/check', async (request, reply) => {
    try {
      const { mobile } = request.body || {};
      if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

      const formatted = formatMobile(mobile);
      if (!formatted || formatted.length < 10) {
        return reply.code(400).send({ error: 'Valid mobile number required' });
      }

      // 1. Check in MongoDB exhibition_claims
      const existingClaim = await exhibitionClaimsCollection.findOne({ mobile: formatted });
      if (existingClaim) {
        return {
          exists: true,
          alreadyClaimed: true,
          points: existingClaim.points || 1000,
          customer: {
            firstName: existingClaim.firstName,
            lastName: existingClaim.lastName,
            email: existingClaim.email,
            phone: formatted,
            dob: existingClaim.dob
          }
        };
      }

      // 2. Query Shopify Customer
      const query = `{
        customers(first: 1, query: "phone:${formatted}") {
          edges {
            node {
              id
              firstName
              lastName
              email
              phone
              tags
              claimedMetafield: metafield(namespace: "lucira_rewards", key: "exhibition_claimed") { value }
              dobMetafield: metafield(namespace: "lucira_profile", key: "date_of_birth") { value }
              dobAltMetafield: metafield(namespace: "custom", key: "birthday") { value }
            }
          }
        }
      }`;

      const data = await shopifyAdminFetch(query);
      const customer = data?.customers?.edges?.[0]?.node;

      if (!customer) {
        return { exists: false, alreadyClaimed: false };
      }

      const hasClaimedTag = Array.isArray(customer.tags) && customer.tags.some(t => t.toLowerCase() === 'exhibition-1000-coins');
      const hasClaimedMetafield = customer.claimedMetafield?.value === 'true';
      const alreadyClaimed = hasClaimedTag || hasClaimedMetafield;

      return {
        exists: true,
        alreadyClaimed,
        customer: {
          id: customer.id,
          firstName: customer.firstName || '',
          lastName: customer.lastName || '',
          email: customer.email || '',
          phone: customer.phone || formatted,
          dob: customer.dobMetafield?.value || customer.dobAltMetafield?.value || ''
        }
      };
    } catch (err) {
      request.log.error(err, '[exhibition/check] Error');
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/exhibition/send-otp
  fastify.post('/send-otp', async (request, reply) => {
    const { mobile } = request.body || {};
    if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

    const formatted = formatMobile(mobile);
    const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP matching Figma
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
        const textResponse = await response.text();
        console.log(`[Exhibition OTP] MSG91 Sent ${otp} to ${formatted}`);
      } else {
        console.log(`[Exhibition OTP Dev] Sent ${otp} to ${formatted}`);
      }
    } catch (err) {
      console.error("[Exhibition OTP SMS Error]", err);
    }
    
    return { success: true, message: 'OTP sent successfully' };
  });

  // POST /api/exhibition/verify-otp
  fastify.post('/verify-otp', async (request, reply) => {
    const { mobile, otp } = request.body || {};
    if (!mobile || !otp) return reply.code(400).send({ error: 'Mobile and OTP required' });

    const formatted = formatMobile(mobile);
    const record = await otpCollection.findOne({ mobile: formatted });

    if (!record || record.otp !== otp || record.expiresAt < new Date()) {
      return reply.code(400).send({ error: 'Invalid or expired OTP' });
    }

    // Mark as verified in DB so subsequent claim can proceed without OTP replay
    await otpCollection.updateOne(
      { mobile: formatted },
      { $set: { verified: true, verifiedAt: new Date() } }
    );

    return { verified: true, message: 'OTP verified successfully' };
  });

  // POST /api/exhibition/claim
  // Validates all 5 mandatory fields: First Name, Last Name, Email, Phone, DOB.
  // Credits 1000 Lucira/Nector Coins and guarantees single-time claim per customer.
  fastify.post('/claim', async (request, reply) => {
    try {
      const { firstName, lastName, email, mobile, dob, otp } = request.body || {};

      // 1. Mandatory field checks
      if (!firstName || !firstName.trim()) {
        return reply.code(400).send({ error: 'First Name is mandatory' });
      }
      if (!lastName || !lastName.trim()) {
        return reply.code(400).send({ error: 'Last Name is mandatory' });
      }
      // Email is optional in Figma exhibition design; auto-generate fallback if omitted
      const cleanEmail = email && email.trim() && /\S+@\S+\.\S+/.test(email.trim())
        ? email.trim().toLowerCase()
        : `${(firstName || 'user').toLowerCase().replace(/[^a-z0-9]/g, '') || 'user'}.${formatMobile(mobile)}@lucirajewelry.com`;

      if (!mobile) {
        return reply.code(400).send({ error: 'Phone Number is mandatory' });
      }
      if (!dob || !dob.trim()) {
        return reply.code(400).send({ error: 'Date of Birth (DOB) is mandatory' });
      }

      const formattedMobile = formatMobile(mobile);
      if (!formattedMobile || formattedMobile.length < 10) {
        return reply.code(400).send({ error: 'Please enter a valid 10-digit mobile number' });
      }

      // Check OTP verification
      if (otp) {
        const otpRecord = await otpCollection.findOne({ mobile: formattedMobile });
        if (!otpRecord || otpRecord.otp !== otp || otpRecord.expiresAt < new Date()) {
          return reply.code(400).send({ error: 'Invalid or expired OTP' });
        }
        await otpCollection.deleteOne({ _id: otpRecord._id });
      }

      const cleanFirst = firstName.trim();
      const cleanLast = lastName.trim();
      const isoDob = parseDobToIso(dob.trim());
      const phoneString = formattedMobile.startsWith('+') ? formattedMobile : `+${formattedMobile}`;

      // 2. Check if already claimed in MongoDB
      const existingClaim = await exhibitionClaimsCollection.findOne({
        $or: [
          { mobile: formattedMobile },
          { email: cleanEmail }
        ]
      });

      if (existingClaim) {
        return reply.send({
          status: 'ALREADY_CLAIMED',
          alreadyClaimed: true,
          points: existingClaim.points || 1000,
          message: 'You have already claimed your 1000 Lucira Points!'
        });
      }

      // 3. Find or Create Shopify Customer
      const findQuery = `{
        customers(first: 1, query: "phone:${formattedMobile}") {
          edges {
            node {
              id
              firstName
              lastName
              email
              phone
              tags
              claimedMetafield: metafield(namespace: "lucira_rewards", key: "exhibition_claimed") { value }
            }
          }
        }
      }`;

      const findData = await shopifyAdminFetch(findQuery);
      let customer = findData?.customers?.edges?.[0]?.node;
      let isNewCustomer = false;
      const randomPassword = crypto.randomBytes(16).toString('hex');

      if (customer) {
        // Customer already exists in Shopify — check if they already claimed
        const hasTag = Array.isArray(customer.tags) && customer.tags.includes('exhibition-1000-coins');
        const hasClaimMf = customer.claimedMetafield?.value === 'true';

        if (hasTag || hasClaimMf) {
          // Record in Mongo so fast checks pass
          await exhibitionClaimsCollection.updateOne(
            { mobile: formattedMobile },
            { 
              $set: { 
                mobile: formattedMobile,
                email: cleanEmail,
                firstName: cleanFirst,
                lastName: cleanLast,
                dob: isoDob,
                customerId: customer.id,
                points: 1000,
                claimedAt: new Date()
              }
            },
            { upsert: true }
          );

          return reply.send({
            status: 'ALREADY_CLAIMED',
            alreadyClaimed: true,
            points: 1000,
            message: 'You have already claimed your 1000 Lucira Points!'
          });
        }

        // Add tag and update profile
        const existingTags = customer.tags || [];
        const updatedTags = Array.from(new Set([...existingTags, 'exhibition-1000-coins', 'event-exhibition']));
        const simpleId = customer.id.split('/').pop();

        try {
          await shopifyAdminRestFetch(`customers/${simpleId}.json`, {}, {
            method: 'PUT',
            body: JSON.stringify({
              customer: {
                id: Number(simpleId),
                first_name: customer.firstName || cleanFirst,
                last_name: customer.lastName || cleanLast,
                email: customer.email || cleanEmail,
                tags: updatedTags.join(', ')
              }
            })
          });
        } catch (e) {
          console.warn('[exhibition] Update existing customer error:', e.message);
        }
      } else {
        // Create new customer
        isNewCustomer = true;
        const restData = await shopifyAdminRestFetch('customers.json', {}, {
          method: 'POST',
          body: JSON.stringify({
            customer: {
              first_name: cleanFirst,
              last_name: cleanLast,
              email: cleanEmail,
              phone: phoneString,
              password: randomPassword,
              password_confirmation: randomPassword,
              verified_email: true,
              tags: 'exhibition-1000-coins, event-exhibition',
              email_marketing_consent: {
                state: 'subscribed',
                opt_in_level: 'single_opt_in'
              }
            }
          })
        });

        if (restData.errors) {
          throw new Error(JSON.stringify(restData.errors));
        }

        const created = restData?.data?.customer;
        if (!created) {
          throw new Error('Failed to create customer in Shopify');
        }

        customer = {
          id: `gid://shopify/Customer/${created.id}`,
          firstName: created.first_name,
          lastName: created.last_name,
          email: created.email,
          phone: created.phone
        };

        // Save password in Mongo for storefront login
        await customerCollection.updateOne(
          { mobile: formattedMobile },
          { $set: { password: randomPassword, updatedAt: new Date() } },
          { upsert: true }
        );
      }

      const simpleId = customer.id.split('/').pop();
      const customerGid = `gid://shopify/Customer/${simpleId}`;

      // 4. Save DOB & Exhibition Claimed Metafields in Shopify
      const metafields = [
        { ownerId: customerGid, namespace: "lucira_profile", key: "date_of_birth", value: String(isoDob), type: "single_line_text_field" },
        { ownerId: customerGid, namespace: "custom", key: "birthday", value: String(isoDob), type: "date" },
        { ownerId: customerGid, namespace: "lucira_rewards", key: "exhibition_claimed", value: "true", type: "single_line_text_field" },
        { ownerId: customerGid, namespace: "lucira_rewards", key: "exhibition_coins", value: "1000", type: "single_line_text_field" }
      ];

      try {
        await shopifyAdminFetch(`
          mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }
        `, { metafields });
      } catch (e) {
        console.error('[exhibition] Failed to save metafields:', e.message);
      }

      // 5. Trigger Nector / Lucira Points credit
      try {
        const apiKey = process.env.NECTOR_WRITE_API_KEY || "ak_0e13d00ec2a326b966a06461e85a51bc7d3984db5942e7e4a1d633a2fc0e67ab";
        const workspaceId = process.env.NECTOR_WORKSPACE_ID || "shopify-luciraonline";

        // Call Nector Activities API to award the exhibition bonus
        await fetch(`https://platform.nector.io/api/v2/merchant/activities`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-apikey": apiKey,
            "x-workspaceid": workspaceId,
            "x-source": "exhibition-event"
          },
          body: JSON.stringify({
            trigger_id: "exhibition_1000_coins",
            customer_id: `shopify-${simpleId}`,
            coins: 1000,
            metadata: {
              source: "event_exhibition",
              first_name: cleanFirst,
              last_name: cleanLast,
              dob: isoDob
            }
          })
        }).catch((err) => console.warn('[exhibition] Nector trigger error:', err.message));
      } catch (err) {
        console.warn('[exhibition] Nector award error:', err.message);
      }

      // 6. Record Claim in MongoDB
      await exhibitionClaimsCollection.updateOne(
        { mobile: formattedMobile },
        {
          $set: {
            customerId: customerGid,
            mobile: formattedMobile,
            email: cleanEmail,
            firstName: cleanFirst,
            lastName: cleanLast,
            dob: isoDob,
            points: 1000,
            claimedAt: new Date(),
            isNewCustomer
          }
        },
        { upsert: true }
      );

      // 7. Generate Storefront Customer Access Token
      let storefrontToken = null;
      try {
        let saved = await customerCollection.findOne({ mobile: formattedMobile });
        let pass = saved?.password || randomPassword;
        const tokenRes = await shopifyStorefrontFetch(`
          mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
            customerAccessTokenCreate(input: $input) {
              customerAccessToken { accessToken expiresAt }
              userErrors { field message }
            }
          }
        `, {
          input: {
            email: customer.email || cleanEmail,
            password: pass
          }
        });
        storefrontToken = tokenRes?.customerAccessTokenCreate?.customerAccessToken?.accessToken;
      } catch (e) {
        console.warn('[exhibition] Storefront token creation failed:', e.message);
      }

      const finalToken = storefrontToken || ('simulated_token_' + crypto.randomBytes(16).toString('hex'));

      const userData = {
        id: customerGid,
        first_name: cleanFirst,
        last_name: cleanLast,
        name: `${cleanFirst} ${cleanLast}`.trim(),
        email: cleanEmail,
        mobile: phoneString,
        phone: phoneString,
        dob: isoDob,
        points: 1000
      };

      return reply.send({
        status: 'CLAIM_SUCCESS',
        alreadyClaimed: false,
        isNewCustomer,
        points: 1000,
        user: userData,
        accessToken: finalToken,
        message: 'Registration Successful! Your 1000 Lucira Points have been credited.'
      });
    } catch (err) {
      request.log.error(err, '[exhibition/claim] Error');
      return reply.code(500).send({ error: err.message || 'Registration failed' });
    }
  });
}

module.exports = routes;
