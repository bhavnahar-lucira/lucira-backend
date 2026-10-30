/**
 * Gemstone filters — four PRODUCT metafields taken straight from the
 * "Color Stone" rows of ornaverse.components. No calculation beyond totals:
 * the values are the rows' own stone_color_code, shape_code, pieces and
 * weight. (The shared scan / write / state engine is lib/componentFilters.js.)
 *
 *   custom.gemstone_color   "Gemstone Color"   list of text  every stone colour, full name, JSON order, no repeats
 *   custom.gemstone_shape   "Gemstone Shape"   list of text  every stone shape, full name, JSON order, no repeats
 *   custom.gemstone_pieces  "Gemstone Pieces"  integer       total pieces over ALL colour-stone rows
 *   custom.gemstone_weight  "Gemstone Weight"  decimal       total carat weight over ALL colour-stone rows (3 dp)
 *
 * On 28 Sep 2026 180 products had colour stones (6 of them no diamond). 174
 * have one row; 6 have 2–4 rows, usually different colours ("Blue And Pink
 * Gemstone & Diamond Toi et Moi Ring": BLUE PR + PINK EM). By decision, those
 * keep ALL their stones: colour and shape are lists, so the product shows
 * under both Blue and Pink, and pieces / weight are totals.
 *
 * A code of "NA" is skipped (a few custom-order rows carry no colour or shape).
 * A code missing from the tables is NOT guessed: that field is left unwritten
 * for the product, which is reported as "unmapped" until the code is added.
 */

const { createFilterEngine } = require('./componentFilters');
const { SHAPE_NAMES } = require('./diamondShape');

const NOTE = 'Written by the Lucira dashboard from ornaverse.components — do not edit by hand, the next sync overwrites it.';

// Every colour code on a Color Stone row on 28 Sep 2026. The short ones were
// read off product titles: WH -> pearls ("Chevron Pearl Diamond Ring"),
// TQ -> evil-eye pieces, BLK -> "Obsidian Glow …", RB -> "Ombre Rainbow …";
// CPH = Champagne per Sumit.
const COLOR_NAMES = {
  BLUE: 'Blue',
  GREEN: 'Green',
  PINK: 'Pink',
  PURPLE: 'Purple',
  RED: 'Red',
  YELLOW: 'Yellow',
  WH: 'White',
  BLK: 'Black',
  TQ: 'Turquoise',
  RB: 'Rainbow',
  CPH: 'Champagne',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const code = (v) => String(v || '').trim().toUpperCase();

// Full names for the codes, in first-seen order without repeats. NA/blank
// codes are skipped; unknown ones are collected, and then the list is null
// (not written) rather than written with a stone missing.
function names(rows, pick, table, unknown) {
  const out = [];
  let missing = false;
  for (const r of rows) {
    const c = code(pick(r));
    if (!c || c === 'NA') continue;
    const name = table[c];
    if (!name) {
      unknown.push(c);
      missing = true;
    } else if (!out.includes(name)) {
      out.push(name);
    }
  }
  return missing ? null : out;
}

function decideGemstone(components) {
  const stones = components.filter((c) => String(c?.item_group_name || '').trim().toLowerCase() === 'color stone');
  if (!stones.length) return { status: 'no_gemstone' };

  const unknown = [];
  const target = {
    color: names(stones, (s) => s.stone_color_code, COLOR_NAMES, unknown),
    shape: names(stones, (s) => s.shape_code, SHAPE_NAMES, unknown),
    pieces: stones.reduce((s, c) => s + num(c.pieces), 0),
    weight: Number(stones.reduce((s, c) => s + num(c.weight), 0).toFixed(3)),
  };
  return {
    status: unknown.length ? 'unmapped' : 'ok',
    target,
    source: stones.map((s) => `${num(s.pieces)} × ${code(s.stone_color_code)} ${code(s.shape_code)}`).join(' + '),
    unknown: [...new Set(unknown)],
  };
}

const engine = createFilterEngine({
  tag: 'Gemstone',
  breakdownField: 'color',
  fields: [
    {
      field: 'color', key: 'gemstone_color', name: 'Gemstone Color', type: 'list.single_line_text_field',
      description: 'Colour of every gemstone (stone_color_code of each Color Stone component, full name). ' + NOTE,
    },
    {
      field: 'shape', key: 'gemstone_shape', name: 'Gemstone Shape', type: 'list.single_line_text_field',
      description: 'Shape of every gemstone (shape_code of each Color Stone component, full name). ' + NOTE,
    },
    {
      field: 'pieces', key: 'gemstone_pieces', name: 'Gemstone Pieces', type: 'number_integer',
      description: 'Total number of gemstones (sum of pieces over every Color Stone component). ' + NOTE,
    },
    {
      field: 'weight', key: 'gemstone_weight', name: 'Gemstone Weight', type: 'number_decimal',
      description: 'Total gemstone weight in carats (sum over every Color Stone component). ' + NOTE,
    },
  ],
  decide: decideGemstone,
});

module.exports = { COLOR_NAMES, decideGemstone, ...engine };
