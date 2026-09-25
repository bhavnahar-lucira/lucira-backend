/**
 * Collection listing and search.
 *
 * Extracted from lib/smartCollections.js so BOTH collection-picking modules use
 * one implementation: Smart Collections (which rule owns which collection page)
 * and From-same-collection (which collection a recommendation rule covers).
 * They had two separate pickers with the same three defects — a hard 20-result
 * cap, title-only matching, and no way to paste a URL — and fixing one while
 * the other rotted is how they drifted apart in the first place.
 *
 * Nothing here is specific to either module: it lists what the shop has, says
 * which of it this app can actually read, and ranks matches.
 */

const { shopifyAdminFetch, shopifyStorefrontFetch } = require('./shopify');
const { getServerCache } = require('./cache');

// ---------------------------------------------------------------------------
// Every collection in the store — the global rule's work list. Cached 1h;
// membership changes don't need to be fresher than the daily pass.
// ---------------------------------------------------------------------------
const ALL_COLLECTIONS_QUERY = `
  query smartSortAllCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title sortOrder productsCount { count } }
    }
  }
`;

async function listAllCollections() {
  return getServerCache('smart-sort:all-collections', async () => {
    const out = [];
    let after = null;
    let pages = 0;
    do {
      const data = await shopifyAdminFetch(ALL_COLLECTIONS_QUERY, { first: 250, after }, { priority: 'background' });
      const page = data?.collections;
      if (!page) break;
      for (const node of page.nodes || []) {
        out.push({
          id: node.id,
          handle: node.handle,
          title: node.title,
          sortOrder: node.sortOrder,
          productsCount: node.productsCount?.count ?? 0
        });
      }
      pages += 1;
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      if (after && pages >= 20) after = null; // 5k collections, far above reality
    } while (after);
    console.log(`[SmartSort] Collection list: ${out.length} collections (${pages} pages)`);
    return out;
  }, { ttlMs: 60 * 60 * 1000 });
}

// ---------------------------------------------------------------------------
// Collections the STOREFRONT has but the Admin API cannot see.
//
// Measured on this shop, 22 Sep 2026: 12 of them, including "Jewelry" (2,689
// products), "Men's Jewelry", "Rings For Men" and three store pages. Every
// Admin read returns a bare `null` with NO error — collection(id:), node(),
// collectionByHandle, the paged list under three sort keys, a product's own
// collections connection, REST, and API versions 2024-10 through 2025-10 —
// which is exactly why they look deleted rather than unreadable.
//
// CAUSE: they are smart collections whose condition uses the `Status` column
// ("Status is equal to Active"). The Shopify admin offers that rule; the Admin
// GraphQL API does not expose it — `CollectionRuleColumn` holds the same 15
// values in 2024-10, 2025-07 and 2025-10 and STATUS is not among them. A
// collection whose ruleSet the API cannot represent is dropped from every
// collection READ resolver. Of the 1,155 readable collections, 533 carry a
// ruleSet and not one uses a status column; every rule is TAG, VARIANT_PRICE,
// a metafield, TITLE, VARIANT_INVENTORY, TYPE or CATEGORY.
//
// The records exist: product.inCollection(id: <jewelry>) returns TRUE on the
// same token that gets null from collection(id:). Membership evaluation never
// serializes the ruleSet; the read resolvers do.
//
// NOT app permissions — the "Shopify Admin API" sales channel is enabled on
// the collection, and a second, unrelated Admin credential is equally blind
// and reports the same 1,155. Do not re-investigate that.
//
// The consequence is bigger than search: a sync could not scan or reorder one
// either. So they are listed here, greyed and unselectable, with the real
// remedy — rebuild the condition on a column the API supports, such as a tag.
// ---------------------------------------------------------------------------
const STOREFRONT_COLLECTIONS_QUERY = `
  query smartSortStorefrontCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title }
    }
  }
`;

async function listUnavailableCollections() {
  return getServerCache('smart-sort:unavailable-collections', async () => {
    const adminIds = new Set((await listAllCollections()).map((c) => c.id));
    const out = [];
    let after = null;
    let pages = 0;
    try {
      do {
        const data = await shopifyStorefrontFetch(STOREFRONT_COLLECTIONS_QUERY, { first: 250, after });
        const page = data?.collections;
        if (!page) break;
        for (const node of page.nodes || []) {
          if (node?.id && !adminIds.has(node.id)) {
            out.push({
              id: node.id,
              handle: node.handle,
              title: node.title,
              sortOrder: null,
              productsCount: 0,
              // The flag every consumer keys off: present in the store, but
              // this app cannot read or reorder it.
              available: false
            });
          }
        }
        pages += 1;
        after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after && pages < 20);
    } catch (err) {
      // The storefront token is optional to this feature — without it the
      // picker simply behaves as it did before.
      console.warn('[SmartSort] Storefront collection scan failed:', err.message);
      return [];
    }
    if (out.length) {
      console.log(`[SmartSort] ${out.length} collection(s) exist on the storefront but are NOT available to this app ` +
        `(the Admin API cannot read them; check for a \"Status\" collection rule): ${out.map((c) => c.handle).join(', ')}`);
    }
    return out;
  }, { ttlMs: 60 * 60 * 1000 });
}

// Everything the picker may show: what the app can act on, plus what the store
// has but the app cannot reach.
async function collectionIndex() {
  const [admin, unavailable] = await Promise.all([
    listAllCollections(),
    listUnavailableCollections().catch(() => [])
  ]);
  return unavailable.length ? admin.concat(unavailable) : admin;
}

// ---------------------------------------------------------------------------
// Collection picker search.
//
// This used to ask Shopify `collections(first: 20, query: "title:*q*")` on
// every keystroke. Measured against this store on 22 Sep 2026 that reached
// under 5% of the real matches: of 1,155 collections, "gold" matches 416 and
// "diamond" 394, and the picker showed 20 of each — so most of the catalogue
// simply could not be selected, and every keystroke cost a Shopify request.
//
// listAllCollections() already holds the WHOLE store (5 background requests,
// cached an hour) because the global pass needs it, so the search runs over
// that list in memory: complete, instant, and free per keystroke. A handle or
// id that is not in the cached list — a collection created in the last hour —
// falls back to a direct Shopify lookup, so a brand-new collection is still
// reachable by pasting its URL.
// ---------------------------------------------------------------------------
const lc = (s) => String(s || '').toLowerCase();

// Spelling variants this catalogue actually mixes. Measured 22 Sep 2026: of
// the 90 collections whose name contains the word, 81 are spelled the British
// way ("Real Gold Jewellery", 232 products; "Wedding Jewellery") and only 9 the
// American way — so a merchant typing the obvious term "jewelry" was shown 9
// and missed the other 81. Normalising BOTH the query and the collection text
// through the same table is what closes that, and it is why the picker can
// disagree with Shopify's own search and still be right.
const SPELLING_VARIANTS = [
  [/jewell?e?ry/g, 'jewelry'],  // jewellery / jewelery / jewellry / jewelry
  [/colour/g, 'color'],
  [/customis/g, 'customiz'],
  [/grey/g, 'gray'],
];

// Crude, deliberate singulariser: "rings" -> "ring", "necklaces" -> "necklace".
// Needed in both directions — "ring" appears in 16 collection names here and
// "rings" in 360, so whichever one is typed has to reach the other.
const singular = (w) => {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};

const normalizeWord = (w) => {
  let out = w;
  for (const [re, to] of SPELLING_VARIANTS) out = out.replace(re, to);
  return singular(out);
};

// 'mens-wedding-rings' -> 'men wedding ring'; "Men's Jewellery" -> 'men jewelry'.
// Splitting on non-alphanumerics is what lets a search for "mens" reach a title
// spelled "Men's" by way of its handle; the word normaliser is what lets
// "jewelry" reach "Jewellery" and "rings" reach "Ring".
const searchWords = (s) => lc(s)
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .split(' ')
  .filter(Boolean)
  .map(normalizeWord)
  .join(' ');

const anyWordStartsWith = (text, q) => text.split(' ').some((w) => w.startsWith(q));

/**
 * What did the merchant paste? A storefront URL, an admin URL, a bare handle,
 * a numeric id, a GID — or just words. Anything with /collections/<x> in it is
 * treated as a direct reference, which is the whole point: the thing already
 * open in another tab IS the collection they are trying to name.
 */
function parseCollectionRef(raw) {
  const s = String(raw || '').trim();
  const gid = s.match(/^gid:\/\/shopify\/Collection\/(\d+)$/);
  if (gid) return { kind: 'id', value: 'gid://shopify/Collection/' + gid[1] };
  if (/^\d{6,}$/.test(s)) return { kind: 'id', value: 'gid://shopify/Collection/' + s };
  // Storefront /collections/<handle>, admin /collections/<numeric id>. Host is
  // irrelevant on purpose — localhost:3000, the live domain and
  // admin.shopify.com all work.
  const m = s.match(/\/collections\/([^/?#\s]+)/i);
  if (m) {
    let seg = m[1];
    try { seg = decodeURIComponent(seg); } catch (_) { /* leave it as typed */ }
    seg = seg.trim();
    if (/^\d+$/.test(seg)) return { kind: 'id', value: 'gid://shopify/Collection/' + seg, from: 'url' };
    if (seg) return { kind: 'handle', value: lc(seg), from: 'url' };
  }
  return { kind: 'text', value: s };
}

// Lower is a better match; -1 means no match at all.
//
// `rawQ` is the query EXACTLY as typed (lowercased); `q` is the normalised
// form. Tier 0 exists because normalising costs precision at the top: this
// store has both "Bestsellers" and "Bestseller", which singularise to the same
// thing, so without an exact check the one the merchant actually typed could
// lose the tie-break to the other on product count.
function scoreCollection(c, q, tokens, rawQ) {
  const h = lc(c.handle);
  const hw = searchWords(c.handle);
  const tw = searchWords(c.title);
  if (rawQ && (h === rawQ || lc(c.title) === rawQ)) return 0;  // typed verbatim
  if (h === q || hw === q) return 1;                  // the handle, allowing for spelling
  if (tw === q) return 2;                             // the title, allowing for spelling
  if (h.startsWith(q) || hw.startsWith(q)) return 3;
  if (tw.startsWith(q)) return 4;
  if (anyWordStartsWith(tw, q) || anyWordStartsWith(hw, q)) return 5;
  if (tw.includes(q) || hw.includes(q) || h.includes(q)) return 6;
  // Several words in any order: "gold solitaire" finds "Solitaire Rings Yellow
  // Gold". One-letter tokens (the "s" an apostrophe leaves behind) are dropped
  // by the caller — they sit in almost every title and would match everything.
  if (tokens.length > 1) {
    const hay = tw + ' ' + hw;
    if (tokens.every((tok) => hay.includes(tok))) return 7;
  }
  return -1;
}

const COLLECTION_LOOKUP_BY_HANDLE = `
  query smartSortCollectionByHandle($query: String!) {
    collections(first: 1, query: $query) {
      nodes { id handle title sortOrder productsCount { count } }
    }
  }
`;

const COLLECTION_LOOKUP_BY_ID = `
  query smartSortCollectionById($id: ID!) {
    collection(id: $id) { id handle title sortOrder productsCount { count } }
  }
`;

const shapeCollection = (n) => (n ? {
  id: n.id,
  handle: n.handle,
  title: n.title,
  sortOrder: n.sortOrder,
  productsCount: n.productsCount?.count ?? 0
} : null);

// Straight to Shopify for ONE exact handle/id. Only reached when the cached
// store list does not have it — i.e. a collection made within the hour.
async function lookupCollectionDirect(ref) {
  try {
    if (ref.kind === 'id') {
      const data = await shopifyAdminFetch(COLLECTION_LOOKUP_BY_ID, { id: ref.value }, { priority: 'interactive' });
      return shapeCollection(data?.collection);
    }
    const clean = ref.value.replace(/["\\]/g, '');
    const data = await shopifyAdminFetch(COLLECTION_LOOKUP_BY_HANDLE, { query: 'handle:' + clean }, { priority: 'interactive' });
    const node = (data?.collections?.nodes || [])[0];
    // `handle:` matches loosely, so confirm it really is the one asked for.
    return node && lc(node.handle) === ref.value ? shapeCollection(node) : null;
  } catch (err) {
    console.warn('[SmartSort] Direct collection lookup failed:', err.message);
    return null;
  }
}

/**
 * Search every collection in the store. Returns the best `limit` matches AND
 * the total that matched — that count is what tells someone staring at 25 rows
 * that another 391 sit behind them and the query has to be narrower, which is
 * exactly what the old 20-row cap hid.
 */
async function searchCollections(rawQuery, { limit = 25 } = {}) {
  const ref = parseCollectionRef(rawQuery);
  const all = await collectionIndex();
  let query = rawQuery;
  let missed = null;

  // A pasted URL / id / handle resolves to exactly one collection. The
  // comparison here is EXACT and un-normalised on purpose: a handle in a URL
  // is an identifier, not a search term.
  if (ref.kind === 'id' || ref.kind === 'handle') {
    const hit = all.find((c) => (ref.kind === 'id' ? c.id === ref.value : lc(c.handle) === ref.value));
    const found = hit || await lookupCollectionDirect(ref);
    if (found) {
      return {
        collections: [found],
        total: 1,
        matchedBy: ref.from === 'url' ? 'url' : ref.kind,
        // Counted here too, not only on the text path: pasting the URL of a
        // collection this app cannot read is EXACTLY when the explanation is
        // needed, and the picker only shows it when this is non-zero.
        unavailable: found.available === false ? 1 : 0,
        source: hit ? 'index' : 'shopify'
      };
    }
    // The handle does not exist. Rather than an empty box, search the handle's
    // own words and SAY the handle missed — a storefront URL can 200 on a
    // handle no collection actually has, which otherwise reads as a broken
    // picker instead of a wrong URL.
    missed = ref;
    query = ref.value.replace(/-/g, ' ');
  }

  const q = searchWords(query);
  const rawQ = lc(String(query).trim());
  const empty = { collections: [], total: 0, matchedBy: 'text', source: 'index' };
  if (!q) return empty;
  const tokens = q.split(' ').filter((t) => t.length > 1);

  const scored = [];
  for (const c of all) {
    const s = scoreCollection(c, q, tokens, rawQ);
    if (s >= 0) scored.push({ c, s });
  }
  scored.sort((a, b) =>
    a.s - b.s ||
    (b.c.productsCount || 0) - (a.c.productsCount || 0) ||
    String(a.c.title).localeCompare(String(b.c.title)));

  return {
    collections: scored.slice(0, limit).map((x) => x.c),
    total: scored.length,
    matchedBy: missed ? (missed.from === 'url' ? 'url-miss' : 'handle-miss') : 'text',
    missedHandle: missed ? missed.value : null,
    // How many of the matches this app cannot actually act on, so the picker
    // can explain rather than just grey a row out.
    unavailable: scored.reduce((n, x) => n + (x.c.available === false ? 1 : 0), 0),
    source: 'index'
  };
}
module.exports = {
  listAllCollections,
  listUnavailableCollections,
  collectionIndex,
  searchCollections,
  parseCollectionRef
};
