/**
 * Returns module — Admin API helpers for customer-initiated returns.
 *
 * Flow (Approach C from RETURNS_INTEGRATION_GUIDE.md):
 *   storefront button -> POST /api/customer/returns -> verify ownership + 15-day window
 *   -> returnRequest mutation -> Return object (status REQUESTED) in Shopify Orders
 *   -> sales approve/process in Shopify Admin -> webhooks sync status back here.
 *
 * The 15-day-after-delivery window is NOT auto-enforced by the Admin API, so we
 * enforce it here (see returnWindow()).
 */

const { shopifyAdminFetch } = require('./shopify');

const RETURN_WINDOW_DAYS = 15;

// Items that can never be returned (in addition to the 15-day rule).
const INSURANCE_VARIANT_GID = 'gid://shopify/ProductVariant/47709366026458';

// ---------------------------------------------------------------------------
// GraphQL (all validated against the Admin schema, API version 2024-10)
// ---------------------------------------------------------------------------

const ORDER_RETURN_CONTEXT_QUERY = `
  query OrderReturnContext($id: ID!) {
    order(id: $id) {
      id
      name
      displayFulfillmentStatus
      customer { id }
      fulfillments {
        id
        status
        createdAt
        events(first: 20) { edges { node { status happenedAt } } }
      }
      returns(first: 20) {
        nodes { id name status createdAt }
      }
    }
  }
`;

const RETURNABLE_FULFILLMENTS_QUERY = `
  query Returnable($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 20) {
      edges {
        node {
          id
          returnableFulfillmentLineItems(first: 50) {
            edges {
              node {
                quantity
                fulfillmentLineItem {
                  id
                  lineItem {
                    id
                    name
                    image { url }
                    customAttributes { key value }
                    variant { id }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const RETURN_REQUEST_MUTATION = `
  mutation ReturnRequest($input: ReturnRequestInput!) {
    returnRequest(input: $input) {
      return { id name status }
      userErrors { field message }
    }
  }
`;

const RETURN_DETAIL_QUERY = `
  query ReturnDetail($id: ID!) {
    return(id: $id) {
      id
      name
      status
      createdAt
      requestApprovedAt
      closedAt
      decline { reason note }
      order { id name }
      totalQuantity
      returnLineItems(first: 50) {
        nodes {
          ... on ReturnLineItem {
            id
            quantity
            returnReason
            customerNote
            fulfillmentLineItem { lineItem { name image { url } } }
          }
        }
      }
      reverseFulfillmentOrders(first: 10) {
        edges { node { id status } }
      }
      refunds(first: 10) {
        edges { node { id createdAt totalRefundedSet { shopMoney { amount currencyCode } } } }
      }
    }
  }
`;

const ORDER_TAGS_ADD_MUTATION = `
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

function toOrderGid(id) {
  if (!id) return null;
  const s = String(id);
  return s.startsWith('gid://') ? s : `gid://shopify/Order/${s.split('/').pop()}`;
}

function toNumericId(gid) {
  return gid ? String(gid).split('/').pop() : null;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Returns the Date used to anchor the return window, or null if not delivered.
 * Tiered so the feature works even when carriers don't emit delivery events:
 *   1. A DELIVERED fulfillment event (accurate delivery date).
 *   2. Fallback: the fulfillment's createdAt (dispatch date) for any successful
 *      fulfillment. This matches how the storefront already labels a FULFILLED
 *      order as "Delivered". Set RETURN_WINDOW_FROM=delivered_only to disable
 *      the fallback and require a real DELIVERED event.
 */
function deliveredAt(order) {
  const requireDeliveredEvent = process.env.RETURN_WINDOW_FROM === 'delivered_only';

  // 1) Prefer an explicit DELIVERED event.
  for (const f of order?.fulfillments || []) {
    const events = f?.events?.edges || [];
    const delivered = events.find((e) => e?.node?.status === 'DELIVERED');
    if (delivered?.node?.happenedAt) return new Date(delivered.node.happenedAt);
  }

  if (requireDeliveredEvent) return null;

  // 2) Fallback: dispatch date of a successful fulfillment.
  for (const f of order?.fulfillments || []) {
    if (f?.status === 'SUCCESS' && f?.createdAt) return new Date(f.createdAt);
  }
  return null;
}

/**
 * Enforce the 15-day-after-delivery window in code.
 * @returns {{ ok:boolean, reason?:string, deliveredAt?:Date, deadline?:Date }}
 */
function returnWindow(order) {
  const d = deliveredAt(order);
  if (!d) {
    // Not delivered (or no DELIVERED event). Treat FULFILLED-without-event as
    // "in transit / awaiting delivery confirmation" — not yet returnable.
    return { ok: false, reason: 'NOT_DELIVERED' };
  }
  const deadline = new Date(d);
  deadline.setDate(deadline.getDate() + RETURN_WINDOW_DAYS);
  const ok = new Date() <= deadline;
  return { ok, reason: ok ? undefined : 'WINDOW_EXPIRED', deliveredAt: d, deadline };
}

/**
 * Final-sale check for a single line item (Lucira policy):
 *  - Insurance add-on (never returnable)
 *  - Custom / Build-Your-Jewelry (made to order)
 *  - Engraved / personalized
 * @returns {{ finalSale:boolean, reason?:string }}
 */
function finalSaleForLineItem(lineItem) {
  if (!lineItem) return { finalSale: false };

  const name = (lineItem.name || '').toLowerCase();
  const variantId = lineItem.variant?.id || '';
  const attrs = lineItem.customAttributes || [];

  if (variantId === INSURANCE_VARIANT_GID || name.includes('insurance')) {
    return { finalSale: true, reason: 'INSURANCE' };
  }

  const attrKeys = attrs.map((a) => (a?.key || '').toLowerCase());
  const attrBlob = attrs
    .map((a) => `${a?.key || ''} ${a?.value || ''}`)
    .join(' ')
    .toLowerCase();

  // Build-Your-Jewelry items carry a `_byj*` custom attribute (e.g. _byj_preview).
  if (attrKeys.some((k) => k.startsWith('_byj')) || attrBlob.includes('build your jewel') || attrBlob.includes('build-your-jewel')) {
    return { finalSale: true, reason: 'CUSTOM_BYJ' };
  }

  // Engraving / personalization.
  if (/engrav|personaliz|personalis/.test(attrBlob) || /engrav|personaliz|personalis/.test(name)) {
    return { finalSale: true, reason: 'ENGRAVED' };
  }

  return { finalSale: false };
}

const FINAL_SALE_LABEL = {
  INSURANCE: 'Insurance add-on (non-returnable)',
  CUSTOM_BYJ: 'Custom / Build-Your-Jewelry item (made to order — final sale)',
  ENGRAVED: 'Engraved / personalized item (final sale)',
};

// ---------------------------------------------------------------------------
// Reason mapping (UI value -> Shopify ReturnReason enum)
// ---------------------------------------------------------------------------

const RETURN_REASONS = [
  { value: 'SIZE_TOO_SMALL', label: 'Size too small' },
  { value: 'SIZE_TOO_LARGE', label: 'Size too large' },
  { value: 'DEFECTIVE', label: 'Damaged or defective' },
  { value: 'WRONG_ITEM', label: 'Received the wrong item' },
  { value: 'NOT_AS_DESCRIBED', label: 'Not as described' },
  { value: 'STYLE', label: "Didn't like the style" },
  { value: 'COLOR', label: "Didn't like the colour" },
  { value: 'UNWANTED', label: 'Changed my mind' },
  { value: 'OTHER', label: 'Other reason' },
];

const VALID_REASONS = new Set(RETURN_REASONS.map((r) => r.value));

function mapReason(reason) {
  const r = String(reason || '').toUpperCase();
  return VALID_REASONS.has(r) ? r : 'OTHER';
}

// ---------------------------------------------------------------------------
// Customer-facing timeline
// ---------------------------------------------------------------------------

const TIMELINE_STAGES = [
  { key: 'requested', label: 'Return Requested', desc: 'We received your request' },
  { key: 'approved', label: 'Approved', desc: 'Our team approved the return' },
  { key: 'picked_up', label: 'Pickup & Transit', desc: 'On its way back to us' },
  { key: 'quality_check', label: 'Quality Check', desc: 'Inspecting the returned item' },
  { key: 'refunded', label: 'Refund Processed', desc: 'Refund transfer arranged' },
  { key: 'completed', label: 'Completed', desc: 'Return closed' },
];

/**
 * Derive a customer-friendly view (state + timeline) from a Shopify Return.
 */
function buildReturnView(ret) {
  const status = ret?.status || 'REQUESTED';
  const refunds = (ret?.refunds?.edges || []).map((e) => e.node);
  const rfos = (ret?.reverseFulfillmentOrders?.edges || []).map((e) => e.node);

  const hasRefund = refunds.length > 0;
  const closed = status === 'CLOSED' || !!ret?.closedAt;
  const approved = !!ret?.requestApprovedAt || ['OPEN', 'CLOSED'].includes(status);

  const reached = {
    requested: true,
    approved: approved,
    picked_up: approved && rfos.length > 0,
    quality_check: hasRefund || closed,
    refunded: hasRefund || closed,
    completed: closed,
  };

  let state = 'active';
  if (status === 'DECLINED') state = 'declined';
  else if (status === 'CANCELED') state = 'canceled';
  else if (closed) state = 'completed';

  const timeline = TIMELINE_STAGES.map((stage) => ({
    ...stage,
    reached: !!reached[stage.key],
  }));
  // currentStage = last reached stage index
  let currentStage = 0;
  timeline.forEach((s, i) => { if (s.reached) currentStage = i; });

  const items = (ret?.returnLineItems?.nodes || [])
    .filter((n) => n && (n.quantity != null))
    .map((n) => ({
      id: n.id,
      quantity: n.quantity,
      reason: n.returnReason || null,
      note: n.customerNote || '',
      title: n.fulfillmentLineItem?.lineItem?.name || 'Item',
      image: n.fulfillmentLineItem?.lineItem?.image?.url || null,
    }));

  const refund = hasRefund
    ? {
        amount: refunds[0]?.totalRefundedSet?.shopMoney?.amount || null,
        currency: refunds[0]?.totalRefundedSet?.shopMoney?.currencyCode || 'INR',
        createdAt: refunds[0]?.createdAt || null,
      }
    : null;

  return {
    id: ret?.id,
    name: ret?.name,
    status,
    state,
    createdAt: ret?.createdAt || null,
    approvedAt: ret?.requestApprovedAt || null,
    closedAt: ret?.closedAt || null,
    declineReason: ret?.decline?.reason || null,
    declineNote: ret?.decline?.note || null,
    order: ret?.order ? { id: ret.order.id, name: ret.order.name } : null,
    items,
    refund,
    timeline,
    currentStage,
  };
}

// ---------------------------------------------------------------------------
// Shopify-backed operations
// ---------------------------------------------------------------------------

async function getOrderReturnContext(orderGid) {
  const data = await shopifyAdminFetch(ORDER_RETURN_CONTEXT_QUERY, { id: orderGid });
  return data?.order || null;
}

/**
 * Returnable line items for an order, with final-sale exclusions applied.
 * @returns {{ items: Array, hasReturnable: boolean }}
 */
async function getReturnableItems(orderGid) {
  const data = await shopifyAdminFetch(RETURNABLE_FULFILLMENTS_QUERY, { orderId: orderGid });
  const fulfillments = data?.returnableFulfillments?.edges || [];

  const items = [];
  for (const f of fulfillments) {
    const lines = f?.node?.returnableFulfillmentLineItems?.edges || [];
    for (const l of lines) {
      const node = l?.node;
      const fli = node?.fulfillmentLineItem;
      const li = fli?.lineItem;
      if (!fli?.id || !li) continue;
      const maxQty = node?.quantity || 0;
      if (maxQty <= 0) continue;

      const fs = finalSaleForLineItem(li);
      items.push({
        fulfillmentLineItemId: fli.id,
        title: li.name || 'Jewelry Item',
        image: li.image?.url || null,
        maxQuantity: maxQty,
        eligible: !fs.finalSale,
        ineligibleReason: fs.finalSale ? (FINAL_SALE_LABEL[fs.reason] || 'Final sale') : null,
      });
    }
  }
  return { items, hasReturnable: items.some((i) => i.eligible) };
}

/**
 * Create a REQUESTED return via the Admin API.
 * @param {string} orderGid
 * @param {Array<{fulfillmentLineItemId:string, quantity:number, reason:string, customerNote?:string}>} lineItems
 * @returns {{ return?:object, userErrors?:Array }}
 */
async function createReturnRequest(orderGid, lineItems) {
  const input = {
    orderId: orderGid,
    // No returnShippingFee -> Lucira does not charge a return shipping fee.
    returnLineItems: lineItems.map((li) => ({
      fulfillmentLineItemId: li.fulfillmentLineItemId,
      quantity: li.quantity,
      returnReason: mapReason(li.reason),
      customerNote: String(li.customerNote || '').slice(0, 300),
    })),
  };
  const data = await shopifyAdminFetch(RETURN_REQUEST_MUTATION, { input });
  return data?.returnRequest || {};
}

async function getReturnDetail(returnGid) {
  const data = await shopifyAdminFetch(RETURN_DETAIL_QUERY, { id: returnGid });
  return data?.return ? buildReturnView(data.return) : null;
}

/** Best-effort order tag so Shopify Flow / segments can pick up the request. */
async function tagOrderReturnRequested(orderGid) {
  try {
    await shopifyAdminFetch(ORDER_TAGS_ADD_MUTATION, {
      id: orderGid,
      tags: ['return-requested'],
    });
  } catch (err) {
    console.error('[returns] tagOrderReturnRequested failed:', err.message);
  }
}

/**
 * Best-effort sales-team notification. Fires the Zoho-style CRM webhook if a
 * return webhook URL is configured; otherwise no-ops (Shopify Flow is the
 * primary staff alert — see RETURNS_INTEGRATION_GUIDE.md).
 */
async function notifySalesTeamOfReturn({ order, customer, lineItems, returnName }) {
  const url = process.env.CRM_RETURN_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leaddetails: {
          Email: customer?.email || '',
          Mobile: customer?.phone || '',
          First_Name: customer?.firstName || '',
          Last_Name: customer?.lastName || '',
          Lead_Source: 'Website',
          Record_Type: 'Sales',
          Allocation_Type: 'Auto',
        },
        returnevent: {
          type: 'ReturnRequested',
          returnName: returnName || '',
          orderName: order?.name || '',
          orderId: order?.id || '',
          currency: 'INR',
          items: (lineItems || []).map((li) => ({
            title: li.title,
            quantity: li.quantity,
            reason: li.reason,
            note: li.customerNote || '',
          })),
        },
      }),
    });
  } catch (err) {
    console.error('[returns] notifySalesTeamOfReturn failed:', err.message);
  }
}

module.exports = {
  RETURN_WINDOW_DAYS,
  RETURN_REASONS,
  toOrderGid,
  toNumericId,
  deliveredAt,
  returnWindow,
  finalSaleForLineItem,
  mapReason,
  buildReturnView,
  getOrderReturnContext,
  getReturnableItems,
  createReturnRequest,
  getReturnDetail,
  tagOrderReturnRequested,
  notifySalesTeamOfReturn,
};
