// The money path: a paid Razorpay checkout must become exactly ONE Shopify
// order, no matter how many callers (browser, webhook, reconciler) race to
// finalize it — and closing the tab must not stop it happening.
// Run: node test-razorpay-finalize.js
const assert = require("assert");

// Stub Shopify before routes/checkout.js destructures it at require time.
const shopify = require("./lib/shopify");
let draftCompleteCalls = 0;
shopify.shopifyAdminFetch = async (query) => {
  if (query.includes("draftOrderUpdate")) return { draftOrderUpdate: { draftOrder: { id: "d1" }, userErrors: [] } };
  if (query.includes("draftOrderComplete")) {
    draftCompleteCalls += 1;
    return {
      draftOrderComplete: {
        draftOrder: { id: "d1", order: { id: "gid://shopify/Order/9", name: "#1009" } },
        userErrors: [],
      },
    };
  }
  if (query.includes("draftOrder(id")) return { draftOrder: { order: { id: "gid://shopify/Order/9", name: "#1009" } } };
  return {};
};

const { finalizeRazorpayCheckout, RAZORPAY_CHECKOUTS_COLLECTION, FINALIZE_MAX_ATTEMPTS } = require("./routes/checkout");

// Minimal in-memory Mongo supporting only the operators the finalizer uses.
const matches = (doc, filter) =>
  Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return cond.some((c) => matches(doc, c));
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$in" in cond) return cond.$in.includes(doc[k]);
      if ("$lt" in cond) return Number(doc[k] || 0) < cond.$lt;
    }
    return doc[k] === cond;
  });

const applyUpdate = (doc, update) => {
  Object.assign(doc, update.$set || {});
  for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = Number(doc[k] || 0) + v;
  for (const [k, v] of Object.entries(update.$setOnInsert || {})) if (!(k in doc)) doc[k] = v;
  return doc;
};

const makeDb = (seed) => {
  const store = { [RAZORPAY_CHECKOUTS_COLLECTION]: seed ? [seed] : [], carts: [{ userId: "u1", items: [{ price: 10 }] }] };
  return {
    collection: (name) => {
      const rows = (store[name] = store[name] || []);
      return {
        rows,
        findOne: async (f) => rows.find((r) => matches(r, f)) || null,
        findOneAndUpdate: async (f, u) => {
          const row = rows.find((r) => matches(r, f));
          return row ? applyUpdate(row, u) : null;
        },
        updateOne: async (f, u, opts = {}) => {
          const row = rows.find((r) => matches(r, f));
          if (row) applyUpdate(row, u);
          else if (opts.upsert) rows.push(applyUpdate({ _id: f._id }, u));
        },
      };
    },
  };
};

const pending = () => ({
  _id: "order_A",
  draftId: "gid://shopify/DraftOrder/1",
  status: "PENDING",
  attempts: 0,
  userId: "u1",
  sessionId: "s1",
  paymentMethod: { type: "razorpay", prepaidAmount: 100 },
  snapshot: { items: [{ price: 100, quantity: 1 }], customer: {}, cartTotalForNector: 100 },
  createdAt: new Date(),
});

(async () => {
  // 1. The webhook finalizes a checkout the browser never reported. One order.
  const db = makeDb(pending());
  const first = await finalizeRazorpayCheckout(db, {
    razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", source: "webhook", capturedAmount: 10000,
  });
  assert.strictEqual(first.shopifyOrderName, "#1009");
  assert.strictEqual(first.alreadyDone, false);
  assert.strictEqual(draftCompleteCalls, 1);

  // 2. The browser's late /complete must NOT create a second order.
  const second = await finalizeRazorpayCheckout(db, {
    razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", source: "browser",
  });
  assert.strictEqual(second.alreadyDone, true);
  assert.strictEqual(second.shopifyOrderName, "#1009");
  assert.strictEqual(draftCompleteCalls, 1, "duplicate Shopify order created");

  // 3. A caller arriving mid-finalize is told to wait, not to re-run it.
  const busy = makeDb({ ...pending(), status: "PROCESSING" });
  await assert.rejects(
    () => finalizeRazorpayCheckout(busy, { razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", source: "browser" }),
    (e) => e.name === "FinalizeStateError" && e.code === "IN_PROGRESS"
  );

  // 4. A checkout that has burned its retries is parked, not retried forever.
  const dead = makeDb({ ...pending(), status: "FAILED", attempts: FINALIZE_MAX_ATTEMPTS });
  await assert.rejects(
    () => finalizeRazorpayCheckout(dead, { razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", source: "webhook" }),
    (e) => e.name === "FinalizeStateError" && e.code === "DEAD"
  );

  // 5. Amount mismatches are tagged for review, never used to refuse a paid order.
  draftCompleteCalls = 0;
  const odd = makeDb(pending());
  const r = await finalizeRazorpayCheckout(odd, {
    razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", source: "webhook", capturedAmount: 1,
  });
  assert.strictEqual(r.shopifyOrderName, "#1009");
  assert.strictEqual(odd.collection(RAZORPAY_CHECKOUTS_COLLECTION).rows[0].amountMismatch, true);

  // 6. A driver returning the legacy {value: doc} shape must still finalize —
  //    misreading the claim would park a PAID checkout as FAILED.
  draftCompleteCalls = 0;
  const legacy = makeDb(pending());
  const inner = legacy.collection;
  legacy.collection = (name) => {
    const c = inner(name);
    return { ...c, findOneAndUpdate: async (f, u) => ({ value: await c.findOneAndUpdate(f, u), ok: 1 }) };
  };
  const legacyResult = await finalizeRazorpayCheckout(legacy, {
    razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", source: "webhook",
  });
  assert.strictEqual(legacyResult.shopifyOrderName, "#1009");
  assert.strictEqual(draftCompleteCalls, 1);

  console.log("razorpay finalize: all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
