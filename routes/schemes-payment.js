/**
 * Schemes Payment Routes (Fastify)
 * Handles Razorpay subscription payments for Vault of Dreams scheme
 * Uses fetch + Basic Auth (same pattern as checkout.js)
 */

const crypto = require('crypto');

function toSubunits(amount) {
  const numericAmount = Number(amount || 0);
  return Math.round(numericAmount * 100);
}

module.exports = async function (fastify) {
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
      const { amount, tenure = 9, customer_mobile, customer_name } = body;

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
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          period: 'monthly',
          interval: 1,
          total_count: tenure, // 9 months
          amount: amountInSubunits,
          currency: 'INR',
          description: `Vault of Dreams Scheme - ${customer_name || 'Customer'} (${tenure} months)`,
        }),
      });

      const planData = await planResponse.json();

      if (!planData.id) {
        console.error('Plan creation failed:', planData);
        return reply.code(500).send({
          error: 'Failed to create payment plan',
          details: planData,
        });
      }

      // STEP 2: Create a subscription using the plan
      const subscriptionResponse = await fetch('https://api.razorpay.com/v1/subscriptions', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan_id: planData.id,
          customer_notify: 1, // Send notification to customer
          total_count: tenure,
          description: `Vault of Dreams Enrollment - ${customer_mobile}`,
          notes: {
            customer_mobile,
            customer_name: customer_name || 'N/A',
            scheme_type: 'vault_of_dreams',
          },
        }),
      });

      const subscriptionData = await subscriptionResponse.json();

      if (!subscriptionData.id) {
        console.error('Subscription creation failed:', subscriptionData);
        return reply.code(500).send({
          error: 'Failed to create subscription',
          details: subscriptionData,
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
