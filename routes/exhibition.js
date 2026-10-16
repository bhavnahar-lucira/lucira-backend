/**
 * Event Exhibition Routes (Fastify)
 * Handles customer registration, OTP, 1000 Lucira Points rewards,
 * and admin dashboard leads management & export.
 */

const crypto = require('crypto');
const { shopifyAdminFetch, shopifyStorefrontFetch } = require('../lib/shopify');

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

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const leadsCollection = db.collection('exhibition_leads');
  const otpCollection = db.collection('otps');
  const customerCollection = db.collection('customers');

  // Background index creation
  leadsCollection.createIndex({ mobile: 1 }, { background: true }).catch(console.error);
  leadsCollection.createIndex({ createdAt: -1 }, { background: true }).catch(console.error);
  leadsCollection.createIndex({ email: 1 }, { background: true }).catch(console.error);
  leadsCollection.createIndex({ status: 1 }, { background: true }).catch(console.error);

  /**
   * POST /check
   * Checks if user already registered/claimed reward
   */
  fastify.post('/check', async (request, reply) => {
    const { mobile } = request.body || {};
    if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

    const formatted = formatMobile(mobile);
    const existing = await leadsCollection.findOne({ mobile: formatted });

    if (existing && existing.status === 'CLAIMED') {
      return {
        alreadyClaimed: true,
        points: existing.points || 1000,
        claimedAt: existing.claimedAt || existing.createdAt,
        lead: existing
      };
    }

    return { alreadyClaimed: false };
  });

  /**
   * POST /send-otp
   * Saves or updates lead with initial form details and sends OTP
   */
  fastify.post('/send-otp', async (request, reply) => {
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
      }
    };

    // If already claimed in the past, don't overwrite status
    if (existingLead && existingLead.status === 'CLAIMED') {
      delete leadUpdate.$setOnInsert.status;
    }

    await leadsCollection.updateOne({ mobile: formatted }, leadUpdate, { upsert: true });

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

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

        if (result.type !== "success") {
          console.error("[Exhibition MSG91 Error]", result);
        } else {
          console.log(`[Exhibition OTP] MSG91 Sent ${otp} to ${formatted}`);
        }
      } else {
        console.warn("[Exhibition OTP] MSG91 credentials missing, logging to console only.");
        console.log(`[Exhibition OTP] Sent ${otp} to ${formatted}`);
      }
    } catch (err) {
      console.error("[Exhibition OTP SMS Error]", err);
    }

    return { success: true, message: 'OTP sent successfully' };
  });

  /**
   * POST /verify-otp
   */
  fastify.post('/verify-otp', async (request, reply) => {
    const { mobile, otp } = request.body || {};
    if (!mobile || !otp) return reply.code(400).send({ error: 'Mobile and OTP required' });

    const formatted = formatMobile(mobile);
    const record = await otpCollection.findOne({ mobile: formatted });

    if (!record || record.otp !== String(otp).trim() || record.expiresAt < new Date()) {
      return reply.code(400).send({ error: 'Invalid or expired OTP' });
    }

    // OTP verified, clear it
    await otpCollection.deleteOne({ _id: record._id });

    return { success: true, verified: true };
  });

  /**
   * POST /claim
   * Marks lead as CLAIMED with 1000 Lucira Points
   */
  fastify.post('/claim', async (request, reply) => {
    const { firstName, lastName, fullName, email, mobile, dob } = request.body || {};
    if (!mobile) return reply.code(400).send({ error: 'Mobile required' });

    const formatted = formatMobile(mobile);
    const displayPhone = getDisplayMobile(mobile);
    const now = new Date();

    const cleanEmail = email ? String(email).toLowerCase().trim() : '';
    const cleanFullName = (fullName || `${firstName || ''} ${lastName || ''}`).trim();
    const cleanFirst = firstName || cleanFullName.split(/\s+/)[0] || '';
    const cleanLast = lastName || cleanFullName.split(/\s+/).slice(1).join(' ') || '';

    const existingLead = await leadsCollection.findOne({ mobile: formatted });
    const isAlreadyClaimed = existingLead && existingLead.status === 'CLAIMED';

    const leadRecord = {
      mobile: formatted,
      displayPhone,
      fullName: cleanFullName || existingLead?.fullName || '',
      firstName: cleanFirst || existingLead?.firstName || '',
      lastName: cleanLast || existingLead?.lastName || '',
      email: cleanEmail || existingLead?.email || '',
      dob: dob || existingLead?.dob || '',
      points: 1000,
      status: 'CLAIMED',
      source: 'exhibition',
      claimedAt: existingLead?.claimedAt || now,
      updatedAt: now,
      createdAt: existingLead?.createdAt || now,
    };

    await leadsCollection.updateOne(
      { mobile: formatted },
      { $set: leadRecord },
      { upsert: true }
    );

    // Look for customer in local db or Shopify to provide login session if available
    let user = null;
    let accessToken = null;

    try {
      let savedCustomer = await customerCollection.findOne({ mobile: formatted });
      if (savedCustomer) {
        user = {
          id: savedCustomer._id.toString(),
          email: savedCustomer.email,
          mobile: savedCustomer.mobile,
          first_name: savedCustomer.first_name || cleanFirst,
          last_name: savedCustomer.last_name || cleanLast,
        };
      }
    } catch (e) {
      console.error('[Exhibition Claim] Session lookup error:', e);
    }

    return {
      success: true,
      alreadyClaimed: isAlreadyClaimed,
      points: 1000,
      message: isAlreadyClaimed
        ? 'Welcome back! You have already claimed your 1000 Lucira Points.'
        : 'Congratulations! 1000 Lucira Points have been added to your account.',
      lead: leadRecord,
      user,
      accessToken,
    };
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

      // Summary Stats (Overall)
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
