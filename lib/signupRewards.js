/**
 * Signup reward (spin-the-wheel / scratch-card) helpers.
 *
 * The prize lives on the customer as a human-readable label in
 * custom.win_prize_spin_the_sheel — the label format is what the frontend's
 * /api/customer/spin-prize and /api/customer/reward-coupon routes read and
 * write, so it must stay "₹1,500 OFF"-style. Older rows written by /register
 * carry the raw value ("1500_off"); both forms are understood here.
 */

const { shopifyAdminFetch } = require('./shopify');

// Same odds as the wheel (OtpSpinAuth SPIN_PRIZES) so the A/B test compares
// the mechanic, not the payout. Zero-chance prizes are omitted.
const PRIZES = [
  { value: '1500_off', label: '₹1,500 OFF', amount: 1500, code: 'GRAND1500', chance: 33.33 },
  { value: '1000_off', label: '₹1,000 OFF', amount: 1000, code: 'GRAND1000', chance: 33.33 },
  { value: '750_off', label: '₹750 OFF', amount: 750, code: 'GRAND750', chance: 33.34 },
];

// Display-only window: the GRAND codes are shared and always valid in Shopify.
// Within this many days of signup the reward is "active" (reveal), after it
// is "expired" (the popup offers to "reactivate", which is purely cosmetic).
const REWARD_WINDOW_DAYS = 7;

const METAFIELD_NAMESPACE = 'custom';
// NOTE: "sheel" is the real key of the existing definition — do not fix.
const METAFIELD_KEY = 'win_prize_spin_the_sheel';

function drawPrize() {
  const total = PRIZES.reduce((sum, p) => sum + p.chance, 0);
  let r = Math.random() * total;
  for (const prize of PRIZES) {
    if (r < prize.chance) return prize;
    r -= prize.chance;
  }
  return PRIZES[0];
}

function findPrize(stored) {
  if (!stored) return null;
  const s = String(stored).trim();
  return PRIZES.find((p) => p.label === s || p.value === s) || null;
}

function rewardStatus(createdAt) {
  const created = createdAt ? new Date(createdAt) : null;
  const days = created ? (Date.now() - created.getTime()) / 86400000 : 0;
  return days > REWARD_WINDOW_DAYS ? 'expired' : 'active';
}

function expiresAtFrom(date) {
  return new Date(date.getTime() + REWARD_WINDOW_DAYS * 86400000).toISOString();
}

// Customer + stored prize by phone. `formattedMobile` is formatMobile() output.
async function findCustomerReward(formattedMobile) {
  const data = await shopifyAdminFetch(`
    query SignupRewardLookup($q: String!) {
      customers(first: 1, query: $q) {
        edges { node {
          id firstName createdAt
          metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") { value }
        } }
      }
    }
  `, { q: `phone:${formattedMobile}` });
  const node = data?.customers?.edges?.[0]?.node;
  if (!node) return null;
  return {
    id: node.id,
    firstName: node.firstName || '',
    createdAt: node.createdAt,
    prize: findPrize(node.metafield?.value),
  };
}

async function saveCustomerPrize(customerGid, prize) {
  const data = await shopifyAdminFetch(`
    mutation SetSignupPrize($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }
  `, {
    metafields: [{
      ownerId: customerGid,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      type: 'single_line_text_field',
      value: prize.label,
    }],
  });
  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join(', '));
}

// Public shape sent to the browser. `code` is only included after OTP.
function toRewardPayload(prize, { createdAt, withCode, fresh = false }) {
  if (!prize) return null;
  const status = fresh ? 'active' : rewardStatus(createdAt);
  return {
    value: prize.value,
    label: prize.label,
    amount: prize.amount,
    status,
    fresh,
    ...(withCode
      ? {
          code: prize.code,
          // An expired reward is "reactivated" for another window from now.
          expiresAt: expiresAtFrom(status === 'expired' || !createdAt ? new Date() : new Date(createdAt)),
        }
      : {}),
  };
}

module.exports = {
  PRIZES,
  REWARD_WINDOW_DAYS,
  drawPrize,
  findPrize,
  findCustomerReward,
  saveCustomerPrize,
  toRewardPayload,
};
