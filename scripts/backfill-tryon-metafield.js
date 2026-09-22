// One-time backfill: flag every product Camweara can render a virtual try-on for.
//
// Source of truth is Camweara's own manifest, the same file their button script
// reads to decide whether to reveal itself, so the flag can never drift from
// what the try-on will actually do. regionId "2" in TryOnButton.jsx picks the
// virginia bucket.
//
// The manifest lists PRODUCT-level SKUs ("LJ-R00080"); Shopify stores VARIANT
// SKUs ("LJ-R00080-14RGLGD"), which is the same trim getProductSku() does.
//
//   node scripts/backfill-tryon-metafield.js          # dry run, writes nothing
//   node scripts/backfill-tryon-metafield.js --write  # sets custom.has_virtual_tryon


require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const MANIFEST = "https://virginia-bucket-camweara.s3.amazonaws.com/luciraonline/luciraonline_tryonbutton.json";
const STORE = (process.env.SHOPIFY_STORE || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
const WRITE = process.argv.includes("--write");

async function admin(query, variables) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://${STORE}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (!throttled) {
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      return json.data;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error("throttled out");
}

// Walk the whole catalogue once rather than firing ~300 sku: searches. One pass
// of 250-product pages costs far less against the cost bucket, and it also
// tells us which manifest SKUs match NOTHING, which a per-SKU search would
// quietly return empty for.
const PAGE = `
  query Products($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title status
        hasTryOn: metafield(namespace: "custom", key: "has_virtual_tryon") { value }
        variants(first: 100) { nodes { sku } }
      }
    }
  }`;

const productSku = (sku) => {
  if (!sku) return null;
  const parts = String(sku).replace("/", "").split("-");
  return parts.length >= 3 ? `${parts[0]}-${parts[1]}` : parts.join("-");
};

(async () => {
  if (!STORE || !TOKEN) throw new Error("SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN missing");

  const manifest = await (await fetch(MANIFEST)).json();
  // A handful of manifest entries are variant-level ("LJ-PE0056-14YGLGD"). Trim
  // them the same way, so they match the product the way Camweara itself keys
  // off psku — which it documents as "shows all variants".
  const tryOnSkus = new Set((manifest.jewelry_skus || []).map(productSku));
  console.log(`Camweara manifest: ${tryOnSkus.size} product SKUs`);

  const matched = [];      // products to flag
  const alreadySet = [];
  const seenSkus = new Set();
  let cursor = null, scanned = 0;

  do {
    const data = await admin(PAGE, { cursor });
    for (const p of data.products.nodes) {
      scanned++;
      const pskus = [...new Set(p.variants.nodes.map((v) => productSku(v.sku)).filter(Boolean))];
      const hit = pskus.find((s) => tryOnSkus.has(s));
      if (!hit) continue;
      seenSkus.add(hit);
      if (p.hasTryOn?.value === "true") alreadySet.push(p.id);
      else matched.push({ id: p.id, title: p.title, sku: hit, status: p.status });
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  const unmatched = [...tryOnSkus].filter((s) => !seenSkus.has(s));

  console.log(`\nScanned ${scanned} products`);
  console.log(`  matched a try-on SKU : ${matched.length + alreadySet.length}`);
  console.log(`  already flagged      : ${alreadySet.length}`);
  console.log(`  to write             : ${matched.length}`);
  console.log(`  manifest SKUs with NO product: ${unmatched.length}`);
  if (unmatched.length) console.log(`    ${unmatched.slice(0, 15).join(", ")}${unmatched.length > 15 ? " …" : ""}`);
  const drafts = matched.filter((m) => m.status !== "ACTIVE");
  if (drafts.length) console.log(`  (of which not ACTIVE : ${drafts.length})`);
  console.log(`\nSample:`);
  matched.slice(0, 8).forEach((m) => console.log(`  ${m.sku.padEnd(12)} ${m.title}`));

  if (!WRITE) return console.log(`\nDRY RUN — nothing written. Re-run with --write to apply.`);

  const SET = `
    mutation Set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`;

  let written = 0;
  for (let i = 0; i < matched.length; i += 25) {
    const chunk = matched.slice(i, i + 25);
    const data = await admin(SET, {
      metafields: chunk.map((m) => ({
        ownerId: m.id,
        namespace: "custom",
        key: "has_virtual_tryon",
        type: "boolean",
        value: "true",
      })),
    });
    const errs = data.metafieldsSet.userErrors;
    if (errs.length) console.error(`  errors:`, errs);
    written += chunk.length - errs.length;
    console.log(`  ${written}/${matched.length}`);
  }
  console.log(`\nDone — flagged ${written} products.`);
})().catch((e) => { console.error(e); process.exit(1); });
