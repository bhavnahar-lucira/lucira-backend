/**
 * Schemes Payment Routes (Fastify)
 * Handles Razorpay subscription payments for Vault of Dreams scheme
 * Uses fetch + Basic Auth (same pattern as checkout.js)
 */

const crypto = require('crypto');
const { ornaverseFetch } = require('../lib/ornaverse');

function toSubunits(amount) {
  const numericAmount = Number(amount || 0);
  return Math.round(numericAmount * 100);
}

function buildFormBody(fields) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }

  return params;
}

async function parseRazorpayResponse(response) {
  const raw = await response.text();

  if (!raw) {
    return { raw: "", data: {} };
  }

  try {
    return { raw, data: JSON.parse(raw) };
  } catch (error) {
    return { raw, data: { raw } };
  }
}

module.exports = async function (fastify) {
  /**
   * ORNAVERSE ROUTES
   */

  // POST /api/schemes/customer/get
  fastify.post('/customer/get', async (request, reply) => {
    try {
      const { mobile } = request.body || {};
      if (!mobile) return reply.code(400).send({ error: "Mobile number is required" });

      const data = await ornaverseFetch('/Services/POS/Customer/GetCustomer', 'POST', { mobile });
      return data;
    } catch (error) {
      return reply.code(error.status || 500).send({ error: error.message, details: error.details });
    }
  });

  // POST /api/schemes/customer/update
  fastify.post('/customer/update', async (request, reply) => {
    try {
      const payload = request.body || {};
      const data = await ornaverseFetch('/Services/MarketPlace/Customer/UpdateCustomer', 'POST', payload);
      return data;
    } catch (error) {
      return reply.code(error.status || 500).send({ error: error.message, details: error.details });
    }
  });

  // POST /api/schemes/customer/create
  fastify.post('/customer/create', async (request, reply) => {
    try {
      const payload = request.body || {};
      const data = await ornaverseFetch('/Services/MarketPlace/Customer/Generate', 'POST', payload);
      return data;
    } catch (error) {
      return reply.code(error.status || 500).send({ error: error.message, details: error.details });
    }
  });

  // POST /api/schemes/enrollments/create
  fastify.post('/enrollments/create', async (request, reply) => {
    try {
      const body = request.body || {};
      const data = await ornaverseFetch('/Services/POS/SchemeEnrollment/Create', 'POST', { Entity: body });
      return data;
    } catch (error) {
      return reply.code(error.status || 500).send({ error: error.message, details: error.details });
    }
  });

  // GET /api/schemes/enrollments
  fastify.get('/enrollments', async (request, reply) => {
    try {
      const { party_id } = request.query;
      if (!party_id) return reply.code(400).send({ error: "party_id is required" });

      const data = await ornaverseFetch('/Services/POS/SchemeEnrollment/List', 'POST', {
        Take: 0,
        party_id: Number(party_id)
      });
      return data;
    } catch (error) {
      return reply.code(error.status || 500).send({ error: error.message, details: error.details });
    }
  });

  // POST /api/schemes/receipt/create
  fastify.post('/receipt/create', async (request, reply) => {
    try {
      const body = request.body || {};
      const data = await ornaverseFetch('/Services/POS/SchemeReceipt/Create', 'POST', body);
      return data;
    } catch (error) {
      return reply.code(error.status || 500).send({ error: error.message, details: error.details });
    }
  });

  // POST /api/schemes/razorpay/plan
  fastify.post('/razorpay/plan', async (request, reply) => {
    try {
      const { amount, tenure } = request.body || {};
      if (!amount) return reply.code(400).send({ error: "Amount is required" });

      const keyId = process.env.RAZORPAY_KEY_ID || '';
      const keySecret = process.env.RAZORPAY_KEY_SECRET || '';

      const amountInSubunits = toSubunits(amount);

      const planResponse = await fetch('https://api.razorpay.com/v1/plans', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildFormBody({
          period: 'monthly',
          interval: 1,
          'item[name]': `Vault Of Dreams ₹${amount}`,
          'item[amount]': amountInSubunits,
          'item[currency]': 'INR',
          'notes[tenure]': tenure,
        }),
      });

      const { data: planData } = await parseRazorpayResponse(planResponse);

      if (!planResponse.ok) {
        return reply.code(planResponse.status).send({ error: "Failed to create plan", details: planData });
      }

      return planData;
    } catch (error) {
      return reply.code(500).send({ error: error.message });
    }
  });

  /**
   * POST /api/schemes/payment-records
   * Save/Update detailed payment records in MongoDB
   */
  fastify.post('/payment-records', async (request, reply) => {
    try {
      const body = request.body || {};
      const db = fastify.mongo.db;
      const collection = db.collection('scheme_payment_records');

      const filter = {};
      if (body.receipt_entity_id) filter.receipt_entity_id = String(body.receipt_entity_id);
      else if (body.razorpay_payment?.razorpay_payment_id) filter.razorpay_payment_id = String(body.razorpay_payment.razorpay_payment_id);
      else if (body.subscription?.id) filter.subscription_id = String(body.subscription.id);
      else if (body.enrollment_result?.EntityId) filter.enrollment_entity_id = String(body.enrollment_result.EntityId);
      else if (body.customer?.mobile) filter.mobile = String(body.customer.mobile);
      else return reply.code(400).send({ error: "Unable to identify payment record" });

      const update = {
        $set: {
          mobile: body.customer?.mobile ? String(body.customer.mobile) : null,
          party_id: body.customer?.party_id ? String(body.customer.party_id) : null,
          subscription_id: body.subscription?.id ? String(body.subscription.id) : null,
          razorpay_payment_id: body.razorpay_payment?.razorpay_payment_id ? String(body.razorpay_payment.razorpay_payment_id) : null,
          enrollment_entity_id: body.enrollment_result?.EntityId ? String(body.enrollment_result.EntityId) : null,
          receipt_entity_id: body.receipt_entity_id || body.receipt_create_result?.EntityId || null,
          customer: body.customer || null,
          enrollment_draft: body.enrollment_draft || null,
          payment_context: body.payment_context || null,
          payment_status: body.payment_status || "initiated",
          payment_verified: Boolean(body.payment_verified),
          payment_failure_reason: body.payment_failure_reason || null,
          subscription: body.subscription || null,
          razorpay_payment: body.razorpay_payment || null,
          razorpay_failure: body.razorpay_failure || null,
          enrollment_payload: body.enrollment_payload || null,
          enrollment_result: body.enrollment_result || null,
          enrolled_scheme: body.enrolled_scheme || null,
          receipt_create_payload: body.receipt_create_payload || null,
          receipt_create_result: body.receipt_create_result || null,
          receipt_create_error: body.receipt_create_error || null,
          updated_at: new Date(),
        },
        $setOnInsert: {
          created_at: new Date(),
        },
      };

      const result = await collection.findOneAndUpdate(filter, update, {
        upsert: true,
        returnDocument: 'after',
      });

      return { success: true, record: result };
    } catch (error) {
      console.error('Payment record save error:', error);
      return reply.code(500).send({ error: 'Failed to save payment record', message: error.message });
    }
  });

  /**
   * RAZORPAY & MONGODB ROUTES
   */

  /**
   * POST /api/schemes/enrollment
   * Save customer enrollment details to MongoDB
   */
  fastify.post('/enrollment', async (request, reply) => {
    try {
      const body = request.body || {};
      const {
        customer_id,
        mobile,
        amount,
        nominee_name,
        nominee_age,
        nominee_relation,
        address,
        pincode,
        city,
        state,
        razorpay_subscription_id,
        razorpay_payment_id,
      } = body;

      // Validate required fields
      if (!mobile || !amount || !nominee_name || !nominee_age) {
        return reply.code(400).send({ error: "Missing required fields" });
      }

      const db = fastify.mongo.db;
      const enrollmentsCollection = db.collection('scheme_enrollments');

      // Create enrollment record
      const enrollment = {
        customer_id: customer_id || null,
        mobile: String(mobile),
        scheme_type: 'vault_of_dreams',
        amount: Number(amount),
        status: 'active',
        enrollment_date: new Date(),
        nominee: {
          name: nominee_name,
          age: Number(nominee_age),
          relation: nominee_relation,
        },
        address: {
          full: address,
          pincode: pincode,
          city: city,
          state: state,
        },
        payment: {
          razorpay_subscription_id: razorpay_subscription_id,
          razorpay_payment_id: razorpay_payment_id,
          monthly_amount: Number(amount),
          tenure_months: 9,
          total_installments: 9,
        },
        installments_paid: 1, // First payment done
        next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      };

      const result = await enrollmentsCollection.insertOne(enrollment);

      return reply.code(201).send({
        success: true,
        enrollment_id: result.insertedId,
        message: 'Enrollment saved successfully',
      });
    } catch (error) {
      console.error('Enrollment save error:', error);
      return reply.code(500).send({
        error: 'Failed to save enrollment',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/schemes/enrollment/:mobile
   * Fetch enrollments by mobile number
   */
  fastify.get('/enrollment/:mobile', async (request, reply) => {
    try {
      const { mobile } = request.params;

      if (!mobile) {
        return reply.code(400).send({ error: 'Mobile number is required' });
      }

      const db = fastify.mongo.db;
      const enrollmentsCollection = db.collection('scheme_enrollments');

      const enrollments = await enrollmentsCollection
        .find({ mobile: String(mobile) })
        .sort({ enrollment_date: -1 })
        .toArray();

      return reply.send({
        success: true,
        count: enrollments.length,
        enrollments,
      });
    } catch (error) {
      console.error('Enrollment fetch error:', error);
      return reply.code(500).send({
        error: 'Failed to fetch enrollments',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/schemes/razorpay/subscription
   * Create a Razorpay subscription for the scheme
   * Uses fetch + Basic Auth (same pattern as checkout.js)
   */
  fastify.post('/razorpay/subscription', async (request, reply) => {
    try {
      const body = request.body || {};
      const customer = body.customer || {};
      const amount = body.amount;
      const tenure = Number(body.tenure || 9);
      const customer_mobile = body.customer_mobile || customer.mobile || customer.phone || "";
      const customer_name = body.customer_name || customer.name || "";
      const customer_email = body.customer_email || customer.email || body.email || "";

      if (!amount || !customer_mobile) {
        return reply.code(400).send({
          error: 'Amount and customer mobile are required',
        });
      }

      const keyId = process.env.RAZORPAY_KEY_ID || '';
      const keySecret = process.env.RAZORPAY_KEY_SECRET || '';

      if (!keyId || !keySecret) {
        return reply.code(500).send({
          error: 'Razorpay credentials not configured',
        });
      }

      const amountInSubunits = toSubunits(amount);

      // STEP 1: Create a subscription plan
      // Plans are templates for recurring payments
      const planResponse = await fetch('https://api.razorpay.com/v1/plans', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildFormBody({
          period: 'monthly',
          interval: 1,
          'item[name]': `Vault of Dreams Scheme - ${customer_name || 'Customer'} (${tenure} months)`,
          'item[amount]': amountInSubunits,
          'item[currency]': 'INR',
          'item[description]': `Vault of Dreams Scheme - ${customer_name || 'Customer'} (${tenure} months)`,
          'notes[tenure]': tenure,
        }),
      });

      const { data: planData, raw: planRaw } = await parseRazorpayResponse(planResponse);

      if (!planResponse.ok || !planData.id) {
        console.error('Plan creation failed:', {
          status: planResponse.status,
          planData,
          planRaw,
        });
        return reply.code(500).send({
          error: 'Failed to create payment plan',
          details: planData,
          status: planResponse.status,
        });
      }

      // STEP 2: Create a subscription using the plan
      const subscriptionResponse = await fetch('https://api.razorpay.com/v1/subscriptions', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildFormBody({
          plan_id: planData.id,
          customer_notify: 1,
          total_count: tenure,
          customer_email,
          customer_contact: customer_mobile,
          'notes[customer_mobile]': customer_mobile,
          'notes[customer_name]': customer_name || 'N/A',
          'notes[scheme_type]': 'vault_of_dreams',
        }),
      });

      const { data: subscriptionData, raw: subscriptionRaw } = await parseRazorpayResponse(subscriptionResponse);

      if (!subscriptionResponse.ok || !subscriptionData.id) {
        console.error('Subscription creation failed:', {
          status: subscriptionResponse.status,
          subscriptionData,
          subscriptionRaw,
        });
        return reply.code(500).send({
          error: 'Failed to create subscription',
          details: subscriptionData,
          status: subscriptionResponse.status,
        });
      }

      return reply.send({
        success: true,
        subscription_id: subscriptionData.id,
        plan_id: planData.id,
        short_url: subscriptionData.short_url,
        amount: amount,
        tenure: tenure,
        key_id: keyId, // Frontend needs this for checkout
      });
    } catch (error) {
      console.error('Subscription creation error:', error);
      return reply.code(500).send({
        error: 'Failed to initiate subscription',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/schemes/razorpay/verify
   * Verify Razorpay payment signature
   */
  fastify.post('/razorpay/verify', async (request, reply) => {
    try {
      const body = request.body || {};
      const {
        razorpay_payment_id,
        razorpay_subscription_id,
        razorpay_signature,
      } = body;

      if (!razorpay_payment_id || !razorpay_signature) {
        return reply.code(400).send({
          error: 'Payment details are incomplete',
        });
      }

      const secret = process.env.RAZORPAY_KEY_SECRET || '';

      if (!secret) {
        return reply.code(500).send({
          error: 'Razorpay secret not configured',
        });
      }

      // Verify signature: expected = HMAC(payment_id|subscription_id, secret)
      const body_str = razorpay_subscription_id
        ? `${razorpay_payment_id}|${razorpay_subscription_id}`
        : razorpay_payment_id;

      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(body_str)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        console.error('Signature verification failed');
        return reply.code(400).send({
          error: 'Invalid payment signature',
          success: false,
        });
      }

      return reply.send({
        success: true,
        message: 'Payment verified successfully',
        payment_id: razorpay_payment_id,
        subscription_id: razorpay_subscription_id,
      });
    } catch (error) {
      console.error('Signature verification error:', error);
      return reply.code(500).send({
        error: 'Verification failed',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/schemes/razorpay/webhook
   * Handle Razorpay webhook events
   */
  fastify.post('/razorpay/webhook', async (request, reply) => {
    try {
      const signature = request.headers['x-razorpay-signature'];
      const body = JSON.stringify(request.body);

      const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

      if (!secret) {
        console.warn('Webhook secret not configured, skipping verification');
        return reply.send({ success: true });
      }

      // Verify webhook signature
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

      if (expectedSignature !== signature) {
        console.error('Webhook signature verification failed');
        return reply.code(400).send({ error: 'Invalid webhook signature' });
      }

      const event = request.body;

      // Handle different webhook events
      switch (event.event) {
        case 'subscription.activated':
          console.log('Subscription activated:', event.payload.subscription.id);
          // TODO: Update enrollment status to 'active'
          break;

        case 'subscription.charged':
          console.log('Subscription charged:', event.payload.subscription.id);
          // TODO: Update installments_paid counter
          break;

        case 'subscription.failed':
          console.log('Subscription failed:', event.payload.subscription.id);
          // TODO: Update enrollment status to 'payment_failed'
          break;

        case 'subscription.completed':
          console.log('Subscription completed:', event.payload.subscription.id);
          // TODO: Update enrollment status to 'completed'
          break;

        default:
          console.log('Unknown event:', event.event);
      }

      return reply.send({ success: true });
    } catch (error) {
      console.error('Webhook processing error:', error);
      return reply.code(500).send({
        error: 'Webhook processing failed',
        message: error.message,
      });
    }
  });
};
