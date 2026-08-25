/**
 * Shopify discount sync helpers.
 *
 * Bridges the dashboard's native "Product Discounts" rules (stored in Mongo,
 * settings.product_discounts_rules) to real Shopify discounts, so a
 * "Discount code" rule actually exists in Shopify (cart.js/checkout.js
 * validate coupons purely via Shopify's codeDiscountNodeByCode) and an
 * "Automatic discount" rule is visible/reportable in Shopify admin too.
 */
const { shopifyAdminFetch } = require('./shopify');

const toGid = (id, type) => {
  if (!id) return id;
  const str = String(id);
  return str.includes('gid://') ? str : `gid://shopify/${type}/${str}`;
};

const CODE_DISCOUNT_FIELDS = `
  id
  codeDiscount {
    ... on DiscountCodeBasic {
      title
      status
      customerGets {
        items {
          __typename
          ... on DiscountCollections { collections(first: 50) { nodes { id title } } }
          ... on DiscountProducts { products(first: 50) { nodes { id title } } }
          ... on AllDiscountItems { allItems }
        }
      }
    }
  }
`;

const AUTOMATIC_DISCOUNT_FIELDS = `
  id
  automaticDiscount {
    ... on DiscountAutomaticBasic {
      title
      status
      customerGets {
        items {
          __typename
          ... on DiscountCollections { collections(first: 50) { nodes { id title } } }
          ... on DiscountProducts { products(first: 50) { nodes { id title } } }
          ... on AllDiscountItems { allItems }
        }
      }
    }
  }
`;

const CREATE_CODE_MUTATION = `
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { ${CODE_DISCOUNT_FIELDS} }
      userErrors { field code message }
    }
  }
`;

const UPDATE_CODE_MUTATION = `
  mutation discountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { ${CODE_DISCOUNT_FIELDS} }
      userErrors { field code message }
    }
  }
`;

const DEACTIVATE_CODE_MUTATION = `
  mutation discountCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { status } } }
      userErrors { field code message }
    }
  }
`;

const ACTIVATE_CODE_MUTATION = `
  mutation discountCodeActivate($id: ID!) {
    discountCodeActivate(id: $id) {
      codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { status } } }
      userErrors { field code message }
    }
  }
`;

const CREATE_AUTO_MUTATION = `
  mutation discountAutomaticBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { ${AUTOMATIC_DISCOUNT_FIELDS} }
      userErrors { field code message }
    }
  }
`;

const UPDATE_AUTO_MUTATION = `
  mutation discountAutomaticBasicUpdate($id: ID!, $automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { ${AUTOMATIC_DISCOUNT_FIELDS} }
      userErrors { field code message }
    }
  }
`;

const DEACTIVATE_AUTO_MUTATION = `
  mutation discountAutomaticDeactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticBasic { status } } }
      userErrors { field code message }
    }
  }
`;

const ACTIVATE_AUTO_MUTATION = `
  mutation discountAutomaticActivate($id: ID!) {
    discountAutomaticActivate(id: $id) {
      automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticBasic { status } } }
      userErrors { field code message }
    }
  }
`;

const LIST_CODE_QUERY = `
  query codeDiscountNodes($first: Int!, $after: String) {
    codeDiscountNodes(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            title
            status
            summary
            startsAt
            endsAt
            codes(first: 1) { nodes { code } }
            customerGets {
              value {
                __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount } }
              }
              items {
                __typename
                ... on DiscountCollections { collections(first: 50) { nodes { id title } } }
                ... on DiscountProducts { products(first: 50) { nodes { id title } } }
                ... on AllDiscountItems { allItems }
              }
            }
            minimumRequirement {
              __typename
              ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
              ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
            }
          }
          ... on DiscountCodeBxgy { title status summary }
          ... on DiscountCodeFreeShipping { title status summary startsAt endsAt }
        }
      }
    }
  }
`;

const LIST_AUTO_QUERY = `
  query automaticDiscountNodes($first: Int!, $after: String) {
    automaticDiscountNodes(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        automaticDiscount {
          __typename
          ... on DiscountAutomaticBasic {
            title
            status
            startsAt
            endsAt
            summary
            customerGets {
              value {
                __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount } }
              }
              items {
                __typename
                ... on DiscountCollections { collections(first: 50) { nodes { id title } } }
                ... on DiscountProducts { products(first: 50) { nodes { id title } } }
                ... on AllDiscountItems { allItems }
              }
            }
            minimumRequirement {
              __typename
              ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
              ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
            }
          }
          ... on DiscountAutomaticBxgy { title status summary }
          ... on DiscountAutomaticFreeShipping { title status summary startsAt endsAt }
        }
      }
    }
  }
`;

function buildMinimumRequirement(rule) {
  if (rule.minRequirement === 'amount' && rule.minRequirementValue > 0) {
    return { subtotal: { greaterThanOrEqualToSubtotal: String(rule.minRequirementValue) } };
  }
  if (rule.minRequirement === 'quantity' && rule.minRequirementValue > 0) {
    return { quantity: { greaterThanOrEqualToQuantity: String(rule.minRequirementValue) } };
  }
  return null;
}

function buildCustomerGetsValue(rule) {
  if (rule.discountType === 'percentage') {
    return { percentage: Math.min(1, Math.max(0, Number(rule.discountValue) / 100)) };
  }
  return { discountAmount: { amount: String(rule.discountValue), appliesOnEachItem: true } };
}

// Shopify's items input is delta-based (add/remove), not a full replace, so we
// diff against the selection we last successfully synced rather than resend
// the whole list every time. On create, previousRule is empty, so everything
// simply lands in "add" and "remove" stays empty.
function buildItemsInput(rule, previousRule) {
  if (rule.appliesTo === 'specific_products') {
    const newIds = (rule.selectedProducts || []).map((p) => toGid(p.id, 'Product'));
    const oldIds = (previousRule?.selectedProducts || []).map((p) => toGid(p.id, 'Product'));
    const productsToAdd = newIds.filter((id) => !oldIds.includes(id));
    const productsToRemove = oldIds.filter((id) => !newIds.includes(id));
    const products = {};
    if (productsToAdd.length) products.productsToAdd = productsToAdd;
    if (productsToRemove.length) products.productsToRemove = productsToRemove;
    return { products };
  }

  const newIds = (rule.selectedCollections || []).map((c) => toGid(c.id, 'Collection'));
  const oldIds = (previousRule?.selectedCollections || []).map((c) => toGid(c.id, 'Collection'));
  const collectionsToAdd = newIds.filter((id) => !oldIds.includes(id));
  const collectionsToRemove = oldIds.filter((id) => !newIds.includes(id));
  const collections = {};
  if (collectionsToAdd.length) collections.add = collectionsToAdd;
  if (collectionsToRemove.length) collections.remove = collectionsToRemove;
  return { collections };
}

function buildCustomerGetsInput(rule, previousRule) {
  return {
    value: buildCustomerGetsValue(rule),
    items: buildItemsInput(rule, previousRule),
  };
}

function isoOrNow(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildCodeDiscountInput(rule, previousRule) {
  const input = {
    title: rule.title,
    code: rule.title,
    startsAt: isoOrNow(rule.startsAt),
    endsAt: isoOrNull(rule.endsAt),
    context: { all: 'ALL' },
    customerGets: buildCustomerGetsInput(rule, previousRule),
  };
  const minimumRequirement = buildMinimumRequirement(rule);
  if (minimumRequirement) input.minimumRequirement = minimumRequirement;
  return input;
}

function buildAutomaticDiscountInput(rule, previousRule) {
  const input = {
    title: rule.title,
    startsAt: isoOrNow(rule.startsAt),
    endsAt: isoOrNull(rule.endsAt),
    customerGets: buildCustomerGetsInput(rule, previousRule),
  };
  const minimumRequirement = buildMinimumRequirement(rule);
  if (minimumRequirement) input.minimumRequirement = minimumRequirement;
  return input;
}

function throwOnUserErrors(payload, mutationName) {
  if (!payload) throw new Error(`Invalid response from Shopify Admin API (${mutationName})`);
  if (payload.userErrors && payload.userErrors.length > 0) {
    const err = new Error(payload.userErrors[0].message);
    err.userErrors = payload.userErrors;
    throw err;
  }
}

function resolvedItemsFromNode(discount) {
  const items = discount?.customerGets?.items;
  if (items?.__typename === 'DiscountCollections') {
    return { resolvedCollections: items.collections?.nodes || [], resolvedProducts: [] };
  }
  if (items?.__typename === 'DiscountProducts') {
    return { resolvedCollections: [], resolvedProducts: items.products?.nodes || [] };
  }
  return { resolvedCollections: [], resolvedProducts: [] };
}

async function createOrUpdateCodeDiscount(rule, previousRule) {
  const input = buildCodeDiscountInput(rule, previousRule);
  const isUpdate = !!rule.shopifyDiscountId;
  const query = isUpdate ? UPDATE_CODE_MUTATION : CREATE_CODE_MUTATION;
  const variables = isUpdate
    ? { id: rule.shopifyDiscountId, basicCodeDiscount: input }
    : { basicCodeDiscount: input };

  const data = await shopifyAdminFetch(query, variables);
  const payload = isUpdate ? data.discountCodeBasicUpdate : data.discountCodeBasicCreate;
  throwOnUserErrors(payload, isUpdate ? 'discountCodeBasicUpdate' : 'discountCodeBasicCreate');

  const node = payload.codeDiscountNode;
  const { resolvedCollections, resolvedProducts } = resolvedItemsFromNode(node.codeDiscount);
  return {
    shopifyDiscountId: node.id,
    status: node.codeDiscount.status,
    resolvedCollections,
    resolvedProducts,
  };
}

async function createOrUpdateAutomaticDiscount(rule, previousRule) {
  const input = buildAutomaticDiscountInput(rule, previousRule);
  const isUpdate = !!rule.shopifyDiscountId;
  const query = isUpdate ? UPDATE_AUTO_MUTATION : CREATE_AUTO_MUTATION;
  const variables = isUpdate
    ? { id: rule.shopifyDiscountId, automaticBasicDiscount: input }
    : { automaticBasicDiscount: input };

  const data = await shopifyAdminFetch(query, variables);
  const payload = isUpdate ? data.discountAutomaticBasicUpdate : data.discountAutomaticBasicCreate;
  throwOnUserErrors(payload, isUpdate ? 'discountAutomaticBasicUpdate' : 'discountAutomaticBasicCreate');

  const node = payload.automaticDiscountNode;
  const { resolvedCollections, resolvedProducts } = resolvedItemsFromNode(node.automaticDiscount);
  return {
    shopifyDiscountId: node.id,
    status: node.automaticDiscount.status,
    resolvedCollections,
    resolvedProducts,
  };
}

async function deactivateShopifyDiscount(shopifyDiscountId, method) {
  const isCode = method === 'code';
  const query = isCode ? DEACTIVATE_CODE_MUTATION : DEACTIVATE_AUTO_MUTATION;
  const data = await shopifyAdminFetch(query, { id: shopifyDiscountId });
  const payload = isCode ? data.discountCodeDeactivate : data.discountAutomaticDeactivate;
  throwOnUserErrors(payload, isCode ? 'discountCodeDeactivate' : 'discountAutomaticDeactivate');

  const node = isCode ? payload.codeDiscountNode : payload.automaticDiscountNode;
  const status = isCode ? node?.codeDiscount?.status : node?.automaticDiscount?.status;
  return { status };
}

async function activateShopifyDiscount(shopifyDiscountId, method) {
  const isCode = method === 'code';
  const query = isCode ? ACTIVATE_CODE_MUTATION : ACTIVATE_AUTO_MUTATION;
  const data = await shopifyAdminFetch(query, { id: shopifyDiscountId });
  const payload = isCode ? data.discountCodeActivate : data.discountAutomaticActivate;
  throwOnUserErrors(payload, isCode ? 'discountCodeActivate' : 'discountAutomaticActivate');

  const node = isCode ? payload.codeDiscountNode : payload.automaticDiscountNode;
  const status = isCode ? node?.codeDiscount?.status : node?.automaticDiscount?.status;
  return { status };
}

function normalizeListedCodeNode(node) {
  const cd = node.codeDiscount;
  const typename = cd.__typename;
  const base = {
    shopifyDiscountId: node.id,
    method: 'code',
    shopifyType: typename,
    editable: typename === 'DiscountCodeBasic',
    title: cd.codes?.nodes?.[0]?.code || cd.title,
    shopifyStatus: cd.status,
    startsAt: cd.startsAt || null,
    endsAt: cd.endsAt || null,
    summary: cd.summary || '',
  };
  if (typename !== 'DiscountCodeBasic') return base;

  const value = cd.customerGets?.value;
  const items = cd.customerGets?.items;
  const minReq = cd.minimumRequirement;

  return {
    ...base,
    discountType: value?.__typename === 'DiscountPercentage' ? 'percentage' : 'fixed_amount',
    discountValue:
      value?.__typename === 'DiscountPercentage'
        ? Number(value.percentage) * 100
        : Number(value?.amount?.amount || 0),
    appliesTo: items?.__typename === 'DiscountProducts' ? 'specific_products' : 'specific_collections',
    selectedCollections:
      items?.__typename === 'DiscountCollections'
        ? (items.collections?.nodes || []).map((c) => ({ id: c.id, title: c.title }))
        : [],
    selectedProducts:
      items?.__typename === 'DiscountProducts'
        ? (items.products?.nodes || []).map((p) => ({ id: p.id, title: p.title }))
        : [],
    minRequirement:
      minReq?.__typename === 'DiscountMinimumSubtotal'
        ? 'amount'
        : minReq?.__typename === 'DiscountMinimumQuantity'
        ? 'quantity'
        : 'none',
    minRequirementValue:
      minReq?.__typename === 'DiscountMinimumSubtotal'
        ? Number(minReq.greaterThanOrEqualToSubtotal.amount)
        : minReq?.__typename === 'DiscountMinimumQuantity'
        ? Number(minReq.greaterThanOrEqualToQuantity)
        : 0,
  };
}

function normalizeListedAutoNode(node) {
  const ad = node.automaticDiscount;
  const typename = ad.__typename;
  const base = {
    shopifyDiscountId: node.id,
    method: 'automatic',
    shopifyType: typename,
    editable: typename === 'DiscountAutomaticBasic',
    title: ad.title,
    shopifyStatus: ad.status,
    startsAt: ad.startsAt || null,
    endsAt: ad.endsAt || null,
    summary: ad.summary || '',
  };
  if (typename !== 'DiscountAutomaticBasic') return base;

  const value = ad.customerGets?.value;
  const items = ad.customerGets?.items;
  const minReq = ad.minimumRequirement;

  return {
    ...base,
    discountType: value?.__typename === 'DiscountPercentage' ? 'percentage' : 'fixed_amount',
    discountValue:
      value?.__typename === 'DiscountPercentage'
        ? Number(value.percentage) * 100
        : Number(value?.amount?.amount || 0),
    appliesTo: items?.__typename === 'DiscountProducts' ? 'specific_products' : 'specific_collections',
    selectedCollections:
      items?.__typename === 'DiscountCollections'
        ? (items.collections?.nodes || []).map((c) => ({ id: c.id, title: c.title }))
        : [],
    selectedProducts:
      items?.__typename === 'DiscountProducts'
        ? (items.products?.nodes || []).map((p) => ({ id: p.id, title: p.title }))
        : [],
    minRequirement:
      minReq?.__typename === 'DiscountMinimumSubtotal'
        ? 'amount'
        : minReq?.__typename === 'DiscountMinimumQuantity'
        ? 'quantity'
        : 'none',
    minRequirementValue:
      minReq?.__typename === 'DiscountMinimumSubtotal'
        ? Number(minReq.greaterThanOrEqualToSubtotal.amount)
        : minReq?.__typename === 'DiscountMinimumQuantity'
        ? Number(minReq.greaterThanOrEqualToQuantity)
        : 0,
  };
}

async function fetchAllShopifyDiscounts() {
  const results = [];

  let after = null;
  do {
    const data = await shopifyAdminFetch(LIST_CODE_QUERY, { first: 50, after });
    const conn = data.codeDiscountNodes;
    for (const node of conn.nodes) results.push(normalizeListedCodeNode(node));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  after = null;
  do {
    const data = await shopifyAdminFetch(LIST_AUTO_QUERY, { first: 50, after });
    const conn = data.automaticDiscountNodes;
    for (const node of conn.nodes) results.push(normalizeListedAutoNode(node));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  return results;
}

module.exports = {
  createOrUpdateCodeDiscount,
  createOrUpdateAutomaticDiscount,
  deactivateShopifyDiscount,
  activateShopifyDiscount,
  fetchAllShopifyDiscounts,
};
