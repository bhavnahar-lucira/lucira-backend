/**
 * Diamond Shape Filter — derives ONE shape per product for Search & Discovery.
 *
 * Source: the VARIANT metafield `ornaverse.components` (JSON written by the
 * Ornaverse ERP sync). There is no product-level copy of it — 0 of 3,075
 * products carry one. Every variant of a product holds the same stones (a full
 * walk of all 101,722 variants on 26 Sep 2026 found 0 products whose winning
 * shape differed between variants), so only the FIRST variant is read. That
 * keeps a full scan at ~13 pages of 250 products (~79 points each) instead of
 * a 400-page variant walk.
 *
 * Rule: among the components whose item_group_name is "Diamond", the biggest
 * stone is the one with the largest weight / pieces (average carat per stone).
 * Colour stones are ignored even when they are bigger. Ties (11 products in
 * the 26 Sep walk, e.g. "Pear & Round Diamond Cuff Bracelet") go to the row
 * with the larger TOTAL weight, then to whichever comes first in the JSON, so
 * the answer is deterministic.
 *
 * Target: product metafield `custom.diamond_shape_filter` ("Diamond Shape
 * Filter", single_line_text_field), holding the FULL name ("Marquise", not
 * "MQ"). Bare names match the storefront's own shape vocabulary
 * (ShopByShape.jsx links to ?shape=round). `ornaverse.diamond_shape` already
 * exists but is the ERP's namespace (3 values in use) — it is deliberately not
 * reused, so an ERP sync can never overwrite what this module writes.
 *
 * Exports:
 *   SHAPE_NAMES, DEFINITION
 *   pickBiggestDiamond(componentsValue)     - pure; the decision for one product
 *   evaluateProduct(node)                   - pure; node from the scan query -> row
 *   getDefinition() / ensureDefinition()
 *   scanCatalog({ force, priority })        - every product with its state (cached)
 *   syncProduct(ref)                        - one product, resolved from id/GID/URL/handle/SKU
 *   applyRows(rows, { onProgress })         - write metafields for rows (never deletes)
 *   invalidateScan()
 */

const { shopifyAdminFetch } = require('./shopify');

const NAMESPACE = 'custom';
const KEY = 'diamond_shape_filter';

const DEFINITION = {
  namespace: NAMESPACE,
  key: KEY,
  name: 'Diamond Shape Filter',
  description:
    'Shape of the biggest diamond (largest weight per piece in ornaverse.components). ' +
    'Written by the Lucira dashboard — do not edit by hand, the next sync overwrites it.',
  ownerType: 'PRODUCT',
  type: 'single_line_text_field',
};

// Every code seen in ornaverse.components on 26 Sep 2026 (Diamond and Color
// Stone rows). The ones Ornaverse does not document were read off the product
// titles that carry them:
//   PN  -> "Pin-Cut Solitaire ..."          AK  -> "Ashoka-Cut Solitaire ..."
//   LL  -> "Classic Lily-Cut Diamond ..."   COF -> "Coffin-Cut Solitaire ..."
//   CO and POR -> both "Portuguese ..."     SPT -> "Delta Trillion-Cut ..." (1 product)
// A code missing from this table is NOT guessed: the product is reported as
// "unmapped" on the dashboard and nothing is written for it.
const SHAPE_NAMES = {
  RD: 'Round',
  PR: 'Princess',
  OV: 'Oval',
  PE: 'Pear',
  MQ: 'Marquise',
  EM: 'Emerald',
  CU: 'Cushion',
  HR: 'Heart',
  RA: 'Radiant',
  AS: 'Asscher',
  BG: 'Baguette',
  TBG: 'Tapered Baguette',
  TR: 'Trillion',
  SPT: 'Trillion',
  HX: 'Hexagon',
  PN: 'Pin',
  CO: 'Portuguese',
  POR: 'Portuguese',
  AK: 'Ashoka',
  LL: 'Lily',
  COF: 'Coffin',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The decision, isolated so it can be tested without Shopify.
 * @param {string|null} value  raw ornaverse.components metafield value
 * @returns {{ status: 'ok'|'no_components'|'bad_json'|'no_diamond'|'unmapped',
 *             code?: string, shape?: string, perPiece?: number, candidates?: object[] }}
 */
function pickBiggestDiamond(value) {
  if (!value) return { status: 'no_components' };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: 'bad_json' };
  }
  const components = Array.isArray(parsed) ? parsed : parsed?.components || [];

  const candidates = components
    .map((c, index) => ({
      index,
      code: String(c?.shape_code || '').trim().toUpperCase(),
      pieces: num(c?.pieces),
      weight: num(c?.weight),
      isDiamond: String(c?.item_group_name || '').trim().toLowerCase() === 'diamond',
    }))
    .filter((c) => c.isDiamond && c.pieces > 0 && c.code && c.code !== 'NA')
    .map(({ isDiamond, ...c }) => ({ ...c, perPiece: c.weight / c.pieces }));

  if (!candidates.length) return { status: 'no_diamond' };

  const EPS = 1e-9;
  const [best] = [...candidates].sort(
    (a, b) =>
      (Math.abs(b.perPiece - a.perPiece) > EPS ? b.perPiece - a.perPiece : 0) ||
      (Math.abs(b.weight - a.weight) > EPS ? b.weight - a.weight : 0) ||
      a.index - b.index
  );

  const shape = SHAPE_NAMES[best.code];
  const out = { code: best.code, perPiece: Number(best.perPiece.toFixed(4)), candidates };
  return shape ? { status: 'ok', shape, ...out } : { status: 'unmapped', ...out };
}

// state vocabulary shared with the admin:
//   in_sync   — metafield holds exactly the computed shape
//   missing   — a shape was computed, the metafield is empty      -> write
//   mismatch  — the metafield holds a different value             -> overwrite
//   stale     — no diamond any more, but a value is still stored  -> reported only, never deleted
//   unmapped  — biggest diamond has a shape code we have no name for
//   no_diamond / no_components / bad_json — nothing to write, nothing stored
function evaluateProduct(node) {
  const variant = node.variants?.nodes?.[0];
  const decision = pickBiggestDiamond(variant?.components?.value || null);
  const current = node.shapeFilter?.value ?? null;
  const computed = decision.status === 'ok' ? decision.shape : null;

  let state;
  if (decision.status === 'ok') {
    state = current === computed ? 'in_sync' : current ? 'mismatch' : 'missing';
  } else if (current && decision.status !== 'unmapped') {
    state = 'stale';
  } else {
    state = decision.status;
  }

  return {
    id: node.id,
    legacyId: node.legacyResourceId,
    title: node.title,
    handle: node.handle,
    status: node.status,
    image: node.featuredImage?.url || null,
    sku: variant?.sku || null,
    code: decision.code || null,
    perPiece: decision.perPiece ?? null,
    diamondRows: decision.candidates?.length || 0,
    computed,
    current,
    state,
  };
}

const PRODUCT_FIELDS = `
  id legacyResourceId title handle status
  featuredImage { url }
  shapeFilter: metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
  variants(first: 1) {
    nodes {
      sku
      components: metafield(namespace: "ornaverse", key: "components") { value }
    }
  }
`;

const SCAN_QUERY = `
  query diamondShapeScan($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

// ---------------------------------------------------------------------------
// Definition

async function getDefinition() {
  const data = await shopifyAdminFetch(
    `query diamondShapeDefinition {
      metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "${NAMESPACE}", key: "${KEY}") {
        nodes { id name metafieldsCount }
      }
    }`
  );
  return data.metafieldDefinitions.nodes[0] || null;
}

async function ensureDefinition() {
  const existing = await getDefinition();
  if (existing) return { ...existing, created: false };

  const create = async (definition) => {
    const data = await shopifyAdminFetch(
      `mutation diamondShapeDefinitionCreate($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id name }
          userErrors { field message code }
        }
      }`,
      { definition }
    );
    return data.metafieldDefinitionCreate;
  };

  // Storefront read so the headless site can show it; usable as a smart
  // collection condition so "Marquise" collections can be rule-based. If the
  // shop refuses the capability, create the plain definition rather than none.
  const base = { ...DEFINITION, pin: true, access: { storefront: 'PUBLIC_READ' } };
  let result = await create({ ...base, capabilities: { smartCollectionCondition: { enabled: true } } });
  if (result.userErrors?.length && !result.createdDefinition) {
    console.warn('[DiamondShape] definition with capabilities refused, retrying plain:', result.userErrors);
    result = await create(base);
  }
  if (!result.createdDefinition) {
    throw new Error('Could not create the Diamond Shape Filter definition: ' +
      (result.userErrors || []).map((e) => e.message).join('; '));
  }
  return { ...result.createdDefinition, metafieldsCount: 0, created: true };
}

// ---------------------------------------------------------------------------
// Scan

const SCAN_TTL_MS = 10 * 60 * 1000;
let scanCache = null; // { at, rows }
let scanInFlight = null;

function invalidateScan() {
  scanCache = null;
}

async function scanCatalog({ force = false, priority = 'background' } = {}) {
  if (!force && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache;
  if (scanInFlight) return scanInFlight;

  scanInFlight = (async () => {
    const rows = [];
    let cursor = null;
    do {
      const data = await shopifyAdminFetch(SCAN_QUERY, { cursor }, { priority });
      for (const node of data.products.nodes) rows.push(evaluateProduct(node));
      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);
    scanCache = { at: Date.now(), rows };
    return scanCache;
  })();

  try {
    return await scanInFlight;
  } finally {
    scanInFlight = null;
  }
}

function summarize(rows) {
  const states = {};
  const shapes = {};
  for (const r of rows) {
    states[r.state] = (states[r.state] || 0) + 1;
    if (r.computed) shapes[r.computed] = (shapes[r.computed] || 0) + 1;
  }
  const withDiamond = rows.filter((r) => r.computed || r.state === 'unmapped').length;
  return {
    total: rows.length,
    withDiamond,
    present: states.in_sync || 0,
    needsSync: (states.missing || 0) + (states.mismatch || 0),
    states,
    shapes: Object.entries(shapes)
      .map(([shape, count]) => ({ shape, count }))
      .sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------
// Single product

// Accepts a numeric id, a GID, a Shopify admin URL, a storefront URL
// (/products/<handle>), a bare handle or a SKU (product- or variant-level).
async function resolveProduct(ref) {
  const raw = String(ref || '').trim();
  if (!raw) throw Object.assign(new Error('Enter a product id, handle, URL or SKU'), { statusCode: 400 });

  const byId = async (gid) => {
    const data = await shopifyAdminFetch(
      `query diamondShapeProduct($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
      { id: gid }
    );
    return data.product;
  };
  const bySearch = async (query) => {
    const data = await shopifyAdminFetch(
      `query diamondShapeFind($q: String!) { products(first: 2, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`,
      { q: query }
    );
    return data.products.nodes;
  };

  const gid = raw.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
  const numeric = raw.match(/^(\d+)$/) ||raw.match(/\/products\/(\d+)(?:[/?#]|$)/);
  if (gid || numeric) return byId(`gid://shopify/Product/${(gid || numeric)[1]}`);

  const handle = (raw.match(/\/products\/([^/?#]+)/) || [])[1] || raw;
  const byHandle = await shopifyAdminFetch(
    `query diamondShapeByHandle($h: String!) { productByHandle(handle: $h) { ${PRODUCT_FIELDS} } }`,
    { h: handle.toLowerCase() }
  );
  if (byHandle.productByHandle) return byHandle.productByHandle;

  // SKU: exact variant SKU first, then the product-level prefix (LJ-R00080).
  const skuHits = await bySearch(`sku:${JSON.stringify(raw)}`);
  if (skuHits.length) return skuHits[0];
  const prefixHits = await bySearch(`sku:${raw}*`);
  return prefixHits[0] || null;
}

async function syncProduct(ref) {
  const node = await resolveProduct(ref);
  if (!node) throw Object.assign(new Error(`No product found for "${ref}"`), { statusCode: 404 });
  await ensureDefinition();

  const before = evaluateProduct(node);
  const result = await applyRows([before], { priority: 'interactive' });
  const after = result.written ? { ...before, current: before.computed, state: 'in_sync' } : before;

  patchCache(after);
  return { before, after, action: result.written ? 'written' : 'unchanged', errors: result.errors };
}

function patchCache(row) {
  if (!scanCache) return;
  const i = scanCache.rows.findIndex((r) => r.id === row.id);
  if (i >= 0) scanCache.rows[i] = row;
}

// ---------------------------------------------------------------------------
// Writes

const WRITE_BATCH = 25; // metafieldsSet hard limit per call

/**
 * Writes the computed shape for every row that is 'missing' or 'mismatch'.
 * Everything else is skipped, so passing every row is safe.
 *
 * NOTHING IS EVER DELETED (by decision, 26 Sep 2026): a 'stale' row — a value
 * stored on a product that no longer has a diamond — is only reported on the
 * dashboard and left exactly as it is.
 */
async function applyRows(rows, { onProgress, priority = 'background' } = {}) {
  const writes = rows.filter((r) => r.state === 'missing' || r.state === 'mismatch');
  const errors = [];
  let written = 0;
  const total = writes.length;

  for (let i = 0; i < writes.length; i += WRITE_BATCH) {
    const chunk = writes.slice(i, i + WRITE_BATCH);
    const data = await shopifyAdminFetch(
      `mutation diamondShapeSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }`,
      {
        metafields: chunk.map((r) => ({
          ownerId: r.id, namespace: NAMESPACE, key: KEY, type: DEFINITION.type, value: r.computed,
        })),
      },
      { priority }
    );
    const { metafields, userErrors } = data.metafieldsSet;
    // metafieldsSet is all-or-nothing per call: any userError means none of
    // the chunk was written.
    if (userErrors.length) {
      errors.push(...userErrors.map((e) => ({ message: e.message, field: e.field })));
    } else {
      written += metafields.length;
      chunk.forEach((r) => patchCache({ ...r, current: r.computed, state: 'in_sync' }));
    }
    onProgress?.({ done: i + chunk.length, total, written, errors: errors.length });
  }

  return { total, written, errors };
}

module.exports = {
  SHAPE_NAMES,
  DEFINITION,
  pickBiggestDiamond,
  evaluateProduct,
  getDefinition,
  ensureDefinition,
  scanCatalog,
  summarize,
  syncProduct,
  applyRows,
  invalidateScan,
};
