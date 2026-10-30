/**
 * Diamond filters — four PRODUCT metafields derived from the Diamond rows of
 * ornaverse.components (the shared scan / write / state engine, and why only
 * the first variant is read, are in lib/componentFilters.js):
 *
 *   custom.diamond_shape_filter  "Diamond Shape Filter"  text     shape of the biggest diamond, full name ("Marquise")
 *   custom.diamond_carat_filter  "Diamond Carat Filter"  decimal  weight / pieces of that same row (ct per stone, 4 dp)
 *   custom.diamond_pieces        "Diamond Pieces"        integer  total pieces over ALL diamond rows
 *   custom.diamond_weight        "Diamond Weight"        decimal  total carat weight over ALL diamond rows (3 dp)
 *
 * Only item_group_name "Diamond" counts; colour stones are ignored even when
 * they are bigger (they have their own page, lib/gemstone.js). The biggest
 * diamond is the row with the largest weight / pieces. Ties (11 products in
 * the 26 Sep walk, e.g. "Pear & Round Diamond Cuff Bracelet") go to the row
 * with the larger TOTAL weight, then to whichever comes first in the JSON.
 *
 * Shape names are bare ("Round"), matching the storefront's own vocabulary
 * (ShopByShape.jsx links to ?shape=round). `ornaverse.diamond_shape` already
 * exists but is the ERP's namespace — it is deliberately not reused, so an ERP
 * sync can never overwrite what this module writes.
 *
 * Exports: SHAPE_NAMES, pickBiggestDiamond(componentsValue), and the engine
 * (FIELDS, evaluateProduct, scanCatalog, syncProduct, applyRows, …).
 */

const { createFilterEngine, readComponents } = require('./componentFilters');

const NOTE = 'Written by the Lucira dashboard from ornaverse.components — do not edit by hand, the next sync overwrites it.';

// Every code seen in ornaverse.components on 26 Sep 2026 (Diamond and Color
// Stone rows). The ones Ornaverse does not document were read off the product
// titles that carry them:
//   PN  -> "Pin-Cut Solitaire ..."          AK  -> "Ashoka-Cut Solitaire ..."
//   LL  -> "Classic Lily-Cut Diamond ..."   COF -> "Coffin-Cut Solitaire ..."
//   CO and POR -> both "Portuguese ..."     SPT -> "Delta Trillion-Cut ..." (1 product)
// A code missing from this table is NOT guessed: the product is reported as
// "unmapped" on the dashboard and no shape is written for it (the numbers
// still are — they do not depend on the name). Shared with lib/gemstone.js.
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
// Rounding also removes float noise from sums (0.1 + 0.2).
const round = (n, dp) => Number(n.toFixed(dp));

/**
 * The decision for one product, from the parsed components array.
 * @returns {{ status: 'ok'|'no_diamond'|'unmapped', code?, shape?, perPiece?,
 *             totalPieces?, totalWeight?, candidates? }}
 */
function decideDiamond(components) {
  const diamonds = components
    .map((c, index) => ({
      index,
      code: String(c?.shape_code || '').trim().toUpperCase(),
      pieces: num(c?.pieces),
      weight: num(c?.weight),
      isDiamond: String(c?.item_group_name || '').trim().toLowerCase() === 'diamond',
    }))
    .filter((c) => c.isDiamond && c.pieces > 0)
    .map(({ isDiamond, ...c }) => ({ ...c, perPiece: c.weight / c.pieces }));

  // Totals count every diamond row; the shape needs a real code.
  const candidates = diamonds.filter((c) => c.code && c.code !== 'NA');
  if (!candidates.length) return { status: 'no_diamond' };

  const EPS = 1e-9;
  const [best] = [...candidates].sort(
    (a, b) =>
      (Math.abs(b.perPiece - a.perPiece) > EPS ? b.perPiece - a.perPiece : 0) ||
      (Math.abs(b.weight - a.weight) > EPS ? b.weight - a.weight : 0) ||
      a.index - b.index
  );

  const shape = SHAPE_NAMES[best.code];
  const out = {
    code: best.code,
    perPiece: round(best.perPiece, 4),
    totalPieces: diamonds.reduce((s, c) => s + c.pieces, 0),
    totalWeight: round(diamonds.reduce((s, c) => s + c.weight, 0), 3),
    candidates,
  };
  return shape ? { status: 'ok', shape, ...out } : { status: 'unmapped', ...out };
}

// Same decision from the raw metafield value (kept for tests and scripts).
function pickBiggestDiamond(value) {
  const read = readComponents(value);
  return read.status ? { status: read.status } : decideDiamond(read.components);
}

const engine = createFilterEngine({
  tag: 'DiamondShape',
  breakdownField: 'shape',
  fields: [
    {
      field: 'shape', key: 'diamond_shape_filter', name: 'Diamond Shape Filter', type: 'single_line_text_field',
      description: 'Shape of the biggest diamond (largest weight per piece in ornaverse.components). ' + NOTE,
    },
    {
      field: 'carat', key: 'diamond_carat_filter', name: 'Diamond Carat Filter', type: 'number_decimal',
      description: 'Carats per stone of the biggest diamond (weight ÷ pieces of the row that decides the shape). ' + NOTE,
    },
    {
      field: 'pieces', key: 'diamond_pieces', name: 'Diamond Pieces', type: 'number_integer',
      description: 'Total number of diamonds (sum of pieces over every Diamond component). ' + NOTE,
    },
    {
      field: 'weight', key: 'diamond_weight', name: 'Diamond Weight', type: 'number_decimal',
      description: 'Total diamond weight in carats (sum over every Diamond component). ' + NOTE,
    },
  ],
  decide(components) {
    const d = decideDiamond(components);
    if (d.status !== 'ok' && d.status !== 'unmapped') return d;
    return {
      status: d.status,
      target: { shape: d.shape || null, carat: d.perPiece, pieces: d.totalPieces, weight: d.totalWeight },
      source: d.code + (d.candidates.length > 1 ? ` · of ${d.candidates.length} rows` : ''),
      unknown: d.shape ? [] : [d.code],
    };
  },
});

module.exports = { SHAPE_NAMES, pickBiggestDiamond, ...engine };
