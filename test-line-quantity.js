// Locks the rule that made Razorpay bill twice what the cart showed:
// an in-stock line is sold as the single piece on hand, whatever quantity the
// stored cart carries. Run: node test-line-quantity.js
const assert = require("assert");
const { lineQuantity, INSURANCE_VARIANT_ID } = require("./lib/cartPricing");

const RING = "gid://shopify/ProductVariant/12345";

// The reported bug: cart displayed 1, draft order billed 2.
assert.strictEqual(lineQuantity({ variantId: RING, quantity: 2, inStock: true }), 1);
// cart.js persists the flag as a string on some paths.
assert.strictEqual(lineQuantity({ variantId: RING, quantity: 3, inStock: "true" }), 1);

// Made-to-order lines stay shopper-controlled (CartItem offers 1-10).
assert.strictEqual(lineQuantity({ variantId: RING, quantity: 3, inStock: false }), 3);
// Unknown stock is not a licence to clamp — the storefront wouldn't have.
assert.strictEqual(lineQuantity({ variantId: RING, quantity: 3 }), 3);

// Insurance is a flat add-on the storefront exempts from the clamp.
assert.strictEqual(lineQuantity({ variantId: INSURANCE_VARIANT_ID, quantity: 4, inStock: true }), 4);

// Junk quantities still floor at 1.
assert.strictEqual(lineQuantity({ variantId: RING, quantity: 0, inStock: false }), 1);
assert.strictEqual(lineQuantity({ variantId: RING }), 1);

// The incident's arithmetic: ₹15,560 subtotal at the clamped quantity, not ₹31,120.
const cart = [
  { variantId: RING, quantity: 2, inStock: true, finalPrice: 15560 },
  { variantId: INSURANCE_VARIANT_ID, quantity: 1, inStock: true, finalPrice: 1 },
];
const subtotal = cart.reduce((sum, i) => sum + i.finalPrice * lineQuantity(i), 0);
assert.strictEqual(subtotal, 15561);

console.log("lineQuantity: all checks passed");
