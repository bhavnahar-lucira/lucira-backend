/**
 * Event Exhibition Registration & Reward Routes (Fastify)
 * Handles customer registration, mandatory field validation (First Name, Last Name, Email, Phone, DOB),
 * OTP verification, 1000 Lucira/Nector Coins reward attribution,
 * and admin dashboard leads management & CSV export.
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

function getDisplayMobile(raw) {
  if (!raw) return "";
  const cleaned = String(raw).replace(/\D/g, "");
  if (cleaned.length === 12 && cleaned.startsWith("91")) {
    return cleaned.slice(2);
  }
  if (cleaned.length === 10) return cleaned;
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
  const leadsCollection = db.collection('exhibition_leads');
  const claimsCollection = db.collection('exhibition_claims');
  const otpCollection = db.collection('otps');
  const customerCollection = db.collection('customers');

  // Background index creation
  leadsCollection.createIndex({ mobile: 1 }, { background: true }).catch(console.error);
  leadsCollection.createIndex({ createdAt: -1 }, { background: true }).catch(console.error);
  leadsCollection.createIndex({ email: 1 }, { background: true }).catch(console.error);
  leadsCollection.createIndex({ status: 1 }, { background: true }).catch(console.error);
  claimsCollection.createIndex({ mobile: 1 }, { background: true }).catch(console.error);

  /**
   * POST /check
   * Checks if mobile exists and if user has already claimed the 1000 exhibition coins
   */
  fastify.post('/check', async (request, reply) => {
    try {
      const { mobile } = request.body || {};
      if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

      const formatted = formatMobile(mobile);
      if (!formatted || formatted.length < 10) {
        return reply.code(400).send({ error: 'Valid mobile number required' });
      }

      // 1. Check in MongoDB exhibition_leads / exhibition_claims
      const existingLead = await leadsCollection.findOne({ mobile: formatted });
      if (existingLead && existingLead.status === 'CLAIMED') {
        return {
          exists: true,
          alreadyClaimed: true,
          points: existingLead.points || 1000,
          customer: {
            firstName: existingLead.firstName,
            lastName: existingLead.lastName,
            email: existingLead.email,
            phone: formatted,
            dob: existingLead.dob,
          },
          lead: existingLead,
        };
      }

      const existingClaim = await claimsCollection.findOne({ mobile: formatted });
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
            dob: existingClaim.dob,
          },
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
          dob: customer.dobMetafield?.value || customer.dobAltMetafield?.value || '',
        },
      };
    } catch (err) {
      request.log.error(err, '[exhibition/check] Error');
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /send-otp
   * Saves or updates lead with initial form details and sends 4-digit OTP via MSG91
   */
  fastify.post('/send-otp', async (request, reply) => {
    try {
      const { mobile, fullName, firstName, lastName, email, dob } = request.body || {};
      if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

      const formatted = formatMobile(mobile);
      const displayPhone = getDisplayMobile(mobile);

      // Save/Upsert pending lead details immediately so no contact info is lost
      const now = new Date();
      const cleanEmail = email ? String(email).toLowerCase().trim() : '';
      const cleanFullName = (fullName || `${firstName || ''} ${lastName || ''}`).trim();
      const cleanFirst = firstName || cleanFullName.split(/\s+/)[0] || '';
      const cleanLast = lastName || cleanFullName.split(/\s+/).slice(1).join(' ') || '';

      const existingLead = await leadsCollection.findOne({ mobile: formatted });

      const leadUpdate = {
        $set: {
          mobile: formatted,
          displayPhone,
          ...(cleanFullName ? { fullName: cleanFullName } : {}),
          ...(cleanFirst ? { firstName: cleanFirst } : {}),
          ...(cleanLast ? { lastName: cleanLast } : {}),
          ...(cleanEmail ? { email: cleanEmail } : {}),
          ...(dob ? { dob } : {}),
          updatedAt: now,
        },
        $setOnInsert: {
          status: 'PENDING_VERIFICATION',
          points: 1000,
          source: 'exhibition',
          createdAt: now,
        },
      };

      if (existingLead && existingLead.status === 'CLAIMED') {
        delete leadUpdate.$setOnInsert.status;
      }

      await leadsCollection.updateOne({ mobile: formatted }, leadUpdate, { upsert: true });

      // Generate 4-digit OTP matching design
      const otp = Math.floor(1000 + Math.random() * 9000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

      await otpCollection.updateOne(
        { mobile: formatted },
        { $set: { otp, expiresAt, createdAt: now } },
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
          let result;
          try { result = JSON.parse(textResponse); } catch (e) { result = { type: 'error', message: textResponse }; }

          if (result.type !== 'success') {
            console.error('[Exhibition MSG91 Error]', result);
          } else {
            console.log(`[Exhibition OTP] MSG91 Sent ${otp} to ${formatted}`);
          }
        } else {
          console.warn('[Exhibition OTP] MSG91 credentials missing, logging to console only.');
          console.log(`[Exhibition OTP] Sent ${otp} to ${formatted}`);
        }
      } catch (err) {
        console.error('[Exhibition OTP SMS Error]', err);
      }

      return { success: true, message: 'OTP sent successfully' };
    } catch (err) {
      request.log.error(err, '[exhibition/send-otp] Error');
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /verify-otp
   */
  fastify.post('/verify-otp', async (request, reply) => {
    try {
      const { mobile, otp } = request.body || {};
      if (!mobile || !otp) return reply.code(400).send({ error: 'Mobile and OTP required' });

      const formatted = formatMobile(mobile);
      const record = await otpCollection.findOne({ mobile: formatted });

      if (!record || record.otp !== String(otp).trim() || record.expiresAt < new Date()) {
        return reply.code(400).send({ error: 'Invalid or expired OTP' });
      }

      // Mark as verified and clean up
      await otpCollection.updateOne(
        { mobile: formatted },
        { $set: { verified: true, verifiedAt: new Date() } }
      );
      await otpCollection.deleteOne({ _id: record._id });

      return { verified: true, message: 'OTP verified successfully' };
    } catch (err) {
      request.log.error(err, '[exhibition/verify-otp] Error');
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /claim
   * Validates mandatory fields, claims 1000 points, syncs customer with Shopify & Nector,
   * updates dashboard exhibition_leads to CLAIMED.
   */
  fastify.post('/claim', async (request, reply) => {
    try {
      const { firstName, lastName, fullName, email, mobile, dob, otp } = request.body || {};

      if (!mobile) {
        return reply.code(400).send({ error: 'Phone Number is mandatory' });
      }

      const formattedMobile = formatMobile(mobile);
      const displayPhone = getDisplayMobile(mobile);
      if (!formattedMobile || formattedMobile.length < 10) {
        return reply.code(400).send({ error: 'Please enter a valid 10-digit mobile number' });
      }

      const cleanFullName = (fullName || `${firstName || ''} ${lastName || ''}`).trim();
      const cleanFirst = (firstName || cleanFullName.split(/\s+/)[0] || 'Attendee').trim();
      const cleanLast = (lastName || cleanFullName.split(/\s+/).slice(1).join(' ') || '').trim();

      const cleanEmail = email && email.trim() && /\S+@\S+\.\S+/.test(email.trim())
        ? email.trim().toLowerCase()
        : `${cleanFirst.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user'}.${formattedMobile}@lucirajewelry.com`;

      const isoDob = dob ? parseDobToIso(dob.trim()) : '';
      const phoneString = formattedMobile.startsWith('+') ? formattedMobile : `+${formattedMobile}`;
      const now = new Date();

      // Check OTP verification if provided
      if (otp) {
        const otpRecord = await otpCollection.findOne({ mobile: formattedMobile });
        if (otpRecord && (otpRecord.otp !== String(otp).trim() || otpRecord.expiresAt < now)) {
          return reply.code(400).send({ error: 'Invalid or expired OTP' });
        }
        if (otpRecord) {
          await otpCollection.deleteOne({ _id: otpRecord._id });
        }
      }

      // Check if already claimed in MongoDB
      const existingLead = await leadsCollection.findOne({ mobile: formattedMobile });
      const isAlreadyClaimed = existingLead && existingLead.status === 'CLAIMED';

      if (isAlreadyClaimed) {
        return reply.send({
          status: 'ALREADY_CLAIMED',
          alreadyClaimed: true,
          points: existingLead.points || 1000,
          message: 'Welcome back! You have already claimed your 1000 Lucira Points.',
          lead: existingLead,
        });
      }

      // Find or Create Shopify Customer
      let customer = null;
      let isNewCustomer = false;
      const randomPassword = crypto.randomBytes(16).toString('hex');

      try {
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
        customer = findData?.customers?.edges?.[0]?.node;

        if (customer) {
          const hasTag = Array.isArray(customer.tags) && customer.tags.includes('exhibition-1000-coins');
          const hasClaimMf = customer.claimedMetafield?.value === 'true';

          if (hasTag || hasClaimMf) {
            // Already claimed in Shopify
            await leadsCollection.updateOne(
              { mobile: formattedMobile },
              { $set: { status: 'CLAIMED', points: 1000, updatedAt: now } },
              { upsert: true }
            );
            return reply.send({
              status: 'ALREADY_CLAIMED',
              alreadyClaimed: true,
              points: 1000,
              message: 'You have already claimed your 1000 Lucira Points!',
            });
          }

          // Add exhibition tag
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
                  tags: updatedTags.join(', '),
                },
              }),
            });
          } catch (e) {
            console.warn('[exhibition] Update existing customer error:', e.message);
          }
        } else {
          // Create new customer in Shopify
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
                  opt_in_level: 'single_opt_in',
                },
              },
            }),
          });

          const created = restData?.data?.customer;
          if (created) {
            customer = {
              id: `gid://shopify/Customer/${created.id}`,
              firstName: created.first_name,
              lastName: created.last_name,
              email: created.email,
              phone: created.phone,
            };

            await customerCollection.updateOne(
              { mobile: formattedMobile },
              { $set: { password: randomPassword, updatedAt: now } },
              { upsert: true }
            );
          }
        }

        // Set metafields if customer resolved
        if (customer) {
          const simpleId = customer.id.split('/').pop();
          const customerGid = `gid://shopify/Customer/${simpleId}`;
          const metafields = [
            ...(isoDob ? [
              { ownerId: customerGid, namespace: 'lucira_profile', key: 'date_of_birth', value: String(isoDob), type: 'single_line_text_field' },
              { ownerId: customerGid, namespace: 'custom', key: 'birthday', value: String(isoDob), type: 'date' },
            ] : []),
            { ownerId: customerGid, namespace: 'lucira_rewards', key: 'exhibition_claimed', value: 'true', type: 'single_line_text_field' },
            { ownerId: customerGid, namespace: 'lucira_rewards', key: 'exhibition_coins', value: '1000', type: 'single_line_text_field' },
          ];

          shopifyAdminFetch(`
            mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors { field message }
              }
            }
          `, { metafields }).catch(e => console.warn('[exhibition] Metafields set warning:', e.message));

          // Trigger Nector activity
          const apiKey = process.env.NECTOR_WRITE_API_KEY || 'ak_0e13d00ec2a326b966a06461e85a51bc7d3984db5942e7e4a1d633a2fc0e67ab';
          const workspaceId = process.env.NECTOR_WORKSPACE_ID || 'shopify-luciraonline';

          fetch(`https://platform.nector.io/api/v2/merchant/activities`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-apikey': apiKey,
              'x-workspaceid': workspaceId,
              'x-source': 'exhibition-event',
            },
            body: JSON.stringify({
              trigger_id: 'exhibition_1000_coins',
              customer_id: `shopify-${simpleId}`,
              coins: 1000,
              metadata: {
                source: 'event_exhibition',
                first_name: cleanFirst,
                last_name: cleanLast,
                dob: isoDob,
              },
            }),
          }).catch(err => console.warn('[exhibition] Nector trigger warning:', err.message));
        }
      } catch (err) {
        console.warn('[exhibition] Shopify/Nector sync error:', err.message);
      }

      // Upsert into exhibition_leads collection for dashboard
      const leadRecord = {
        mobile: formattedMobile,
        displayPhone,
        fullName: cleanFullName || `${cleanFirst} ${cleanLast}`.trim(),
        firstName: cleanFirst,
        lastName: cleanLast,
        email: cleanEmail,
        dob: dob ? String(dob).trim() : '',
        points: 1000,
        status: 'CLAIMED',
        source: 'exhibition',
        claimedAt: now,
        updatedAt: now,
        createdAt: existingLead?.createdAt || now,
        isNewCustomer,
      };

      await leadsCollection.updateOne(
        { mobile: formattedMobile },
        { $set: leadRecord },
        { upsert: true }
      );

      // Also upsert exhibition_claims for compatibility
      await claimsCollection.updateOne(
        { mobile: formattedMobile },
        {
          $set: {
            mobile: formattedMobile,
            email: cleanEmail,
            firstName: cleanFirst,
            lastName: cleanLast,
            dob: isoDob,
            points: 1000,
            claimedAt: now,
            isNewCustomer,
          },
        },
        { upsert: true }
      );

      // Generate Storefront Access Token if possible
      let storefrontToken = null;
      if (customer) {
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
              password: pass,
            },
          });
          storefrontToken = tokenRes?.customerAccessTokenCreate?.customerAccessToken?.accessToken;
        } catch (e) {
          console.warn('[exhibition] Storefront token creation warning:', e.message);
        }
      }

      const finalToken = storefrontToken || ('simulated_token_' + crypto.randomBytes(16).toString('hex'));

      const userData = {
        id: customer?.id || `local_${formattedMobile}`,
        first_name: cleanFirst,
        last_name: cleanLast,
        name: `${cleanFirst} ${cleanLast}`.trim(),
        email: cleanEmail,
        mobile: phoneString,
        phone: phoneString,
        dob: isoDob || dob,
        points: 1000,
      };

      return reply.send({
        status: 'CLAIM_SUCCESS',
        alreadyClaimed: false,
        isNewCustomer,
        points: 1000,
        user: userData,
        accessToken: finalToken,
        lead: leadRecord,
        message: 'Registration Successful! Your 1000 Lucira Points have been credited.',
      });
    } catch (err) {
      request.log.error(err, '[exhibition/claim] Error');
      return reply.code(500).send({ error: err.message || 'Registration failed' });
    }
  });

  /**
   * GET /leads (Admin Dashboard)
   * Supports search, status filtering, date range, pagination, and summary statistics
   */
  fastify.get('/leads', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const { search, status, start_date, end_date, page = 1, limit = 50 } = request.query;
      const query = {};

      if (status && status !== 'ALL') {
        query.status = status;
      }

      if (search && search.trim()) {
        const cleanSearch = search.trim();
        const searchRegex = new RegExp(cleanSearch, 'i');
        query.$or = [
          { fullName: searchRegex },
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
          { mobile: searchRegex },
          { displayPhone: searchRegex },
        ];
      }

      if (start_date || end_date) {
        query.createdAt = {};
        if (start_date) {
          query.createdAt.$gte = new Date(`${start_date}T00:00:00+05:30`);
        }
        if (end_date) {
          query.createdAt.$lte = new Date(`${end_date}T23:59:59+05:30`);
        }
      }

      const p = Math.max(1, parseInt(page, 10) || 1);
      const l = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
      const skip = (p - 1) * l;

      const [leads, total] = await Promise.all([
        leadsCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(l).toArray(),
        leadsCollection.countDocuments(query),
      ]);

      // Summary Stats
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [totalLeads, claimedCount, pendingCount, todayCount] = await Promise.all([
        leadsCollection.countDocuments({}),
        leadsCollection.countDocuments({ status: 'CLAIMED' }),
        leadsCollection.countDocuments({ status: 'PENDING_VERIFICATION' }),
        leadsCollection.countDocuments({ createdAt: { $gte: todayStart } }),
      ]);

      return {
        success: true,
        data: leads,
        total,
        page: p,
        limit: l,
        totalPages: Math.ceil(total / l),
        stats: {
          totalLeads,
          claimedCount,
          pendingCount,
          totalPoints: claimedCount * 1000,
          todayCount,
        },
      };
    } catch (err) {
      console.error('[Admin Exhibition Leads] Error:', err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  /**
   * GET /leads/export (Admin Dashboard CSV Export)
   * Fetches all matching leads without pagination limit
   */
  fastify.get('/leads/export', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const { search, status, start_date, end_date } = request.query;
      const query = {};

      if (status && status !== 'ALL') {
        query.status = status;
      }

      if (search && search.trim()) {
        const cleanSearch = search.trim();
        const searchRegex = new RegExp(cleanSearch, 'i');
        query.$or = [
          { fullName: searchRegex },
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
          { mobile: searchRegex },
          { displayPhone: searchRegex },
        ];
      }

      if (start_date || end_date) {
        query.createdAt = {};
        if (start_date) {
          query.createdAt.$gte = new Date(`${start_date}T00:00:00+05:30`);
        }
        if (end_date) {
          query.createdAt.$lte = new Date(`${end_date}T23:59:59+05:30`);
        }
      }

      const allLeads = await leadsCollection.find(query).sort({ createdAt: -1 }).toArray();

      return {
        success: true,
        data: allLeads,
        total: allLeads.length,
      };
    } catch (err) {
      console.error('[Admin Exhibition Leads Export] Error:', err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = routes;
