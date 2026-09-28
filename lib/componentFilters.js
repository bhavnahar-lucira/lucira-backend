/**
 * Component filters — the shared engine behind the Diamond and Gemstone
 * filter pages. Each page mirrors values derived from the VARIANT metafield
 * `ornaverse.components` into PRODUCT metafields in `custom`, so Search &
 * Discovery can filter on them.
 *
 * `ornaverse.components` exists only on variants (0 of 3,075 products carry a
 * product-level copy) and every variant of a product holds the same stones (a
 * full walk of all 101,722 variants on 26 Sep 2026 found no product whose
 * stones differed between variants), so only the FIRST variant is read. A full
 * scan is ~13 pages of 250 products.
 *
 * A filter is a spec:
 *   {
 *     tag:            log prefix ('DiamondShape')
 *     fields:         [{ field, key, name, type, description }]  — type is one of
 *                     single_line_text_field | number_integer | number_decimal |
 *                     list.single_line_text_field
 *     breakdownField: field counted for the page's distribution chips
 *     decide(components) -> { status, target?, source?, unknown? }
 *        status 'ok'        target = { [field]: value | null }; null fields are not written
 *        status 'unmapped'  same, but a code had no full name (its field is null)
 *        any other status   nothing to write (e.g. 'no_diamond')
 *        source             short text for the page ("RD · of 3 rows")
 *   }
 *
 * createFilterEngine(spec) returns:
 *   FIELDS, evaluateProduct(node), getDefinitions(), ensureDefinitions(),
 *   scanCatalog({ force, priority }), summarize(rows), syncProduct(ref),
 *   applyRows(rows, { onProgress, priority }), invalidateScan()
 *
 * NOTHING IS EVER DELETED (by decision, 26 Sep 2026): a 'stale' product — one
 * with values stored but nothing to derive them from any more — is only
 * reported, never cleared. Differing values ARE overwritten.
 *
 * Row states, shared with the admin:
 *   in_sync   every field holds its computed value
 *   missing   something to write, and none of the differing fields has a value yet
 *   mismatch  at least one field holds a different value      -> overwrite
 *   stale     nothing to derive, but a value is still stored   -> reported only
 *   unmapped  a code has no full name; the other fields are still written
 *   no_components / bad_json / the spec's own "none" status    -> nothing to do
 */

const { shopifyAdminFetch } = require('./shopify');

const NAMESPACE = 'custom';
const WRITE_BATCH = 25; // metafieldsSet hard limit (metafields, not products) per call
const SCAN_TTL_MS = 10 * 60 * 1000;

// How each metafield type is read back, compared and written.
const TYPES = {
  single_line_text_field: {
    parse: (raw) => raw,
    same: (a, b) => a === b,
    serialize: (v) => v,
  },
  number_integer: {
    parse: Number,
    same: (a, b) => Math.abs(a - b) < 1e-9,
    serialize: String,
  },
  number_decimal: {
    parse: Number,
    same: (a, b) => Math.abs(a - b) < 1e-9,
    serialize: String,
  },
  'list.single_line_text_field': {
    parse: (raw) => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [String(v)];
      } catch {
        return [raw];
      }
    },
    same: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
    serialize: (v) => JSON.stringify(v),
  },
};

// Parses the raw metafield; the spec only ever sees an array of components.
function readComponents(value) {
  if (!value) return { status: 'no_components' };
  try {
    const parsed = JSON.parse(value);
    return { components: Array.isArray(parsed) ? parsed : parsed?.components || [] };
  } catch {
    return { status: 'bad_json' };
  }
}

function createFilterEngine(spec) {
  const FIELDS = spec.fields;
  const FIELD_NAMES = FIELDS.map((f) => f.field);
  const typeOf = (field) => TYPES[FIELDS.find((f) => f.field === field).type];
  const has = (v) => v != null && !(Array.isArray(v) && !v.length);

  function rowState(decision, target, stored) {
    if (target) {
      const diffs = FIELD_NAMES.filter(
        (f) => has(target[f]) && !(has(stored[f]) && typeOf(f).same(stored[f], target[f]))
      );
      let state;
      if (!diffs.length) state = decision === 'unmapped' ? 'unmapped' : 'in_sync';
      else state = diffs.some((f) => has(stored[f])) ? 'mismatch' : 'missing';
      return { state, diffs };
    }
    return { state: FIELD_NAMES.some((f) => has(stored[f])) ? 'stale' : decision, diffs: [] };
  }

  function evaluateProduct(node) {
    const variant = node.variants?.nodes?.[0];
    const read = readComponents(variant?.components?.value || null);
    const decision = read.status ? { status: read.status } : spec.decide(read.components);
    const target = decision.status === 'ok' || decision.status === 'unmapped' ? decision.target : null;

    const stored = {};
    for (const f of FIELDS) {
      const raw = node[f.field + 'Mf']?.value ?? null;
      stored[f.field] = raw == null ? null : TYPES[f.type].parse(raw);
    }

    return {
      id: node.id,
      legacyId: node.legacyResourceId,
      title: node.title,
      handle: node.handle,
      status: node.status,
      image: node.featuredImage?.url || null,
      sku: variant?.sku || null,
      decision: decision.status,
      source: decision.source || null,
      unknown: decision.unknown || [],
      target,
      stored,
      ...rowState(decision.status, target, stored),
    };
  }

  const PRODUCT_FIELDS = `
    id legacyResourceId title handle status
    featuredImage { url }
    ${FIELDS.map((f) => `${f.field}Mf: metafield(namespace: "${NAMESPACE}", key: "${f.key}") { value }`).join('\n    ')}
    variants(first: 1) {
      nodes {
        sku
        components: metafield(namespace: "ornaverse", key: "components") { value }
      }
    }
  `;

  // -------------------------------------------------------------------------
  // Definitions

  // [{ field, key, name, id | null, metafieldsCount }]
  async function getDefinitions() {
    const data = await shopifyAdminFetch(
      `query ${spec.tag}Definitions {
        ${FIELDS.map((f) => `${f.field}: metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "${NAMESPACE}", key: "${f.key}") {
          nodes { id name metafieldsCount }
        }`).join('\n')}
      }`
    );
    return FIELDS.map((f) => {
      const def = data[f.field].nodes[0];
      return { field: f.field, key: `${NAMESPACE}.${f.key}`, name: f.name, id: def?.id || null, metafieldsCount: def?.metafieldsCount ?? 0 };
    });
  }

  async function createDefinition(f) {
    const create = async (definition) => {
      const data = await shopifyAdminFetch(
        `mutation ${spec.tag}DefinitionCreate($definition: MetafieldDefinitionInput!) {
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
    // collection condition. If the shop refuses an extra (capability, pin
    // limit), create the plain definition rather than none.
    const base = {
      namespace: NAMESPACE, key: f.key, name: f.name, description: f.description, type: f.type,
      ownerType: 'PRODUCT', access: { storefront: 'PUBLIC_READ' },
    };
    let result = await create({ ...base, pin: true, capabilities: { smartCollectionCondition: { enabled: true } } });
    if (result.userErrors?.length && !result.createdDefinition) {
      console.warn(`[${spec.tag}] ${f.key}: definition with extras refused, retrying plain:`, result.userErrors);
      result = await create(base);
    }
    if (!result.createdDefinition) {
      throw new Error(`Could not create the ${f.name} definition: ` +
        (result.userErrors || []).map((e) => e.message).join('; '));
    }
    return result.createdDefinition;
  }

  // Creates whichever definitions are missing.
  async function ensureDefinitions() {
    const defs = await getDefinitions();
    const created = [];
    for (const def of defs) {
      if (def.id) continue;
      const made = await createDefinition(FIELDS.find((f) => f.field === def.field));
      def.id = made.id;
      created.push(def.key);
    }
    return { definitions: defs, created };
  }

  // -------------------------------------------------------------------------
  // Scan

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
        const data = await shopifyAdminFetch(
          `query ${spec.tag}Scan($cursor: String) {
            products(first: 250, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { ${PRODUCT_FIELDS} }
            }
          }`,
          { cursor },
          { priority }
        );
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
    const breakdown = {};
    for (const r of rows) {
      states[r.state] = (states[r.state] || 0) + 1;
      const v = r.target?.[spec.breakdownField];
      for (const value of Array.isArray(v) ? v : v ? [v] : []) breakdown[value] = (breakdown[value] || 0) + 1;
    }
    return {
      total: rows.length,
      withSource: rows.filter((r) => r.target).length,
      present: states.in_sync || 0,
      needsSync: (states.missing || 0) + (states.mismatch || 0),
      states,
      breakdown: Object.entries(breakdown)
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  // -------------------------------------------------------------------------
  // Single product

  // Accepts a numeric id, a GID, a Shopify admin URL, a storefront URL
  // (/products/<handle>), a bare handle or a SKU (product- or variant-level).
  async function resolveProduct(ref) {
    const raw = String(ref || '').trim();
    if (!raw) throw Object.assign(new Error('Enter a product id, handle, URL or SKU'), { statusCode: 400 });

    const byId = async (gid) => {
      const data = await shopifyAdminFetch(
        `query ${spec.tag}Product($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
        { id: gid }
      );
      return data.product;
    };
    const bySearch = async (query) => {
      const data = await shopifyAdminFetch(
        `query ${spec.tag}Find($q: String!) { products(first: 2, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`,
        { q: query }
      );
      return data.products.nodes;
    };

    const gid = raw.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
    const numeric = raw.match(/^(\d+)$/) || raw.match(/\/products\/(\d+)(?:[/?#]|$)/);
    if (gid || numeric) return byId(`gid://shopify/Product/${(gid || numeric)[1]}`);

    const handle = (raw.match(/\/products\/([^/?#]+)/) || [])[1] || raw;
    const byHandle = await shopifyAdminFetch(
      `query ${spec.tag}ByHandle($h: String!) { productByHandle(handle: $h) { ${PRODUCT_FIELDS} } }`,
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
    await ensureDefinitions();

    const before = evaluateProduct(node);
    const result = await applyRows([before], { priority: 'interactive' });
    const after = result.written ? afterWrite(before) : before;

    patchCache(after);
    return { before, after, action: result.written ? 'written' : 'unchanged', errors: result.errors };
  }

  // The row as it is once its differing fields have been written.
  function afterWrite(row) {
    const stored = { ...row.stored };
    for (const f of row.diffs) stored[f] = row.target[f];
    return { ...row, stored, ...rowState(row.decision, row.target, stored) };
  }

  function patchCache(row) {
    if (!scanCache) return;
    const i = scanCache.rows.findIndex((r) => r.id === row.id);
    if (i >= 0) scanCache.rows[i] = row;
  }

  // -------------------------------------------------------------------------
  // Writes

  const toInput = (row, field) => {
    const f = FIELDS.find((x) => x.field === field);
    return { ownerId: row.id, namespace: NAMESPACE, key: f.key, type: f.type, value: TYPES[f.type].serialize(row.target[field]) };
  };

  /**
   * Writes the differing fields of every row that is 'missing' or 'mismatch'.
   * Everything else is skipped, so passing every row is safe. Progress counts
   * products; a call carries up to 25 metafields and never splits a product.
   */
  async function applyRows(rows, { onProgress, priority = 'background' } = {}) {
    const writes = rows.filter((r) => r.state === 'missing' || r.state === 'mismatch');
    const errors = [];
    let done = 0;
    let written = 0;
    const total = writes.length;

    const batches = [];
    let batch = [];
    let size = 0;
    for (const r of writes) {
      if (size + r.diffs.length > WRITE_BATCH) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(r);
      size += r.diffs.length;
    }
    if (batch.length) batches.push(batch);

    for (const b of batches) {
      const data = await shopifyAdminFetch(
        `mutation ${spec.tag}Set($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }`,
        { metafields: b.flatMap((r) => r.diffs.map((f) => toInput(r, f))) },
        { priority }
      );
      const { userErrors } = data.metafieldsSet;
      // metafieldsSet is all-or-nothing per call: any userError means none of
      // the batch was written.
      if (userErrors.length) {
        errors.push(...userErrors.map((e) => ({ message: e.message, field: e.field })));
      } else {
        written += b.length;
        b.forEach((r) => patchCache(afterWrite(r)));
      }
      done += b.length;
      onProgress?.({ done, total, written, errors: errors.length });
    }

    return { total, written, errors };
  }

  return {
    tag: spec.tag,
    FIELDS,
    evaluateProduct,
    getDefinitions,
    ensureDefinitions,
    scanCatalog,
    summarize,
    syncProduct,
    applyRows,
    invalidateScan,
  };
}

module.exports = { createFilterEngine, readComponents };
