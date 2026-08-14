/**
 * Search synonyms — mirrors the Shopify "Search & Discovery" synonym groups.
 *
 * Shopify's Storefront `search` does NOT reliably apply Search & Discovery
 * synonyms, and Shopify exposes no API to read the groups. So the groups are
 * mirrored in data/search-synonyms.json and applied here: when a shopper
 * searches any term in a group, the search is expanded to the whole group so
 * Shopify returns the canonical products (e.g. "kada" / "kangan" → Bracelets).
 *
 * To update: copy each group from the Search & Discovery app (Synonyms tab)
 * into data/search-synonyms.json — the index below rebuilds on server start.
 */

const GROUPS = require("../data/search-synonyms.json");

// normalized term -> Set of every term in the group(s) it belongs to.
// The group title is included as a searchable term alongside its synonyms.
const index = new Map();
for (const [title, terms] of Object.entries(GROUPS || {})) {
  const norm = [...(terms || []), title]
    .map((t) => String(t).toLowerCase().trim())
    .filter(Boolean);
  for (const t of norm) {
    if (!index.has(t)) index.set(t, new Set());
    for (const other of norm) index.get(t).add(other);
  }
}

/**
 * Expand a raw search term to its full synonym group.
 * @returns {string[]|null} all group terms, or null if the term isn't a synonym.
 */
function expandSynonyms(query) {
  const key = String(query || "").toLowerCase().trim();
  if (!key) return null;
  const set = index.get(key);
  return set ? [...set] : null;
}

/** Build a Shopify search query string from a synonym group (phrase-OR'd). */
function synonymQuery(terms) {
  return (terms || [])
    .map((t) => String(t).replace(/["\\]/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" OR ");
}

module.exports = { expandSynonyms, synonymQuery };
