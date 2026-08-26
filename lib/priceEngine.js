/**
 * Price Engine (Backend Port)
 */

function calculatePriceBreakup(config, metalRates, stonePricingDB) {
  let metalRate = 0;

  if (config.metal_type?.toLowerCase() === "platinum") {
    metalRate = (metalRates.platinum_price || 0) * 100;
  } else {
    const purityKey = `gold_price_${config.purity?.toLowerCase()}`;
    metalRate = (metalRates[purityKey] || 0) * 100;
  }

  const metalWeight = Number(config.metal_weight || 0);
  const metalCost = metalRate * metalWeight;

  let diamondFinal = 0;
  let diamondOriginal = 0;
  let diamondPcs = 0;
  let diamondTitle = "Diamond";
  let diamondCarat = 0;
  let diamondClarity = "";
  let diamondColor = "";

  let gemstoneFinal = 0;
  let gemstoneOriginal = 0;
  let gemstonePcs = 0;
  let gemstoneTitle = "Gemstone";

  for (const stone of config.advanced_stone_config || []) {
    if (!stone?.stone_quantity) continue;

    const pricingRef = stonePricingDB.find(
      (p) => p.id === stone.pricing_id
    );
    if (!pricingRef) continue;

    const avgWeight =
      stone.stone_weight / stone.stone_quantity;

    let slabRate = 0;
    let slabDiscount = 0;

    for (const slab of pricingRef.slabs || []) {
      if (
        avgWeight >= slab.from_weight &&
        avgWeight <= slab.to_weight
      ) {
        slabRate = (slab.price || 0) * 100;
        slabDiscount = slab.discount || 0;
        break;
      }
    }

    const baseCost = slabRate * stone.stone_weight;

    const appliedDiscount =
      stone.stone_type === "diamond"
        ? config.diamond_discount ?? slabDiscount
        : slabDiscount;

    const discountAmount =
      (baseCost * appliedDiscount) / 100;

    const finalCost = baseCost - discountAmount;

    if (stone.stone_type === "diamond") {
      diamondFinal += finalCost;
      diamondOriginal += baseCost;
      diamondPcs += stone.stone_quantity;
      diamondTitle = pricingRef.title || "Diamond";
      diamondCarat += Number(stone.stone_weight || 0);
      
      if (pricingRef.title && pricingRef.title.includes(",")) {
        const parts = pricingRef.title.split(",");
        diamondColor = parts[0].trim();
        diamondClarity = parts[1].trim();
      }
    } else {
      gemstoneFinal += finalCost;
      gemstoneOriginal += baseCost;
      gemstonePcs += stone.stone_quantity;
      gemstoneTitle = pricingRef.title || "Gemstone";
    }
  }

  const mcRateOriginal = (config.making_charges || 0) * 100;
  const mcDiscountPercent =
    config.making_charges_discount || 0;

  const mcDiscountAmt =
    (mcRateOriginal * mcDiscountPercent) / 100;

  const mcRateFinal = mcRateOriginal - mcDiscountAmt;

  const mcCostOriginal = mcRateOriginal * metalWeight;
  const mcCostFinal = mcRateFinal * metalWeight;

  // "Other material" — a non-metal, non-stone component the variant carries as
  // a flat charge rather than a rate x weight (flexi-belt, beads, evil eye,
  // steel). Read straight off variant_config, so any component type staff add
  // is priced without a code change here.
  //
  // Its weight is informational only: making charges are rated on metal_weight,
  // which is why a 1.5g-metal / 22.266g-gross bracelet still bills making
  // charges on 1.5g. But the charge itself is part of what is sold, so it joins
  // the subtotal ahead of GST like every other component — omitting it is what
  // made this engine quote below the variant's own Shopify price (e.g.
  // LJ-MBR014-14YGLGD: engine said 21,525, Shopify holds 22,555, the gap being
  // a 1,000 flexi-belt plus its 3% GST).
  const additionalItemType = config.additional_item_type || null;
  const additionalItemWeight = Number(config.additional_item_weight || 0);
  const additionalItemCost = additionalItemType
    ? Number(config.additional_item_charges || 0) * 100
    : 0;

  const subtotal =
    metalCost + diamondFinal + gemstoneFinal + mcCostFinal + additionalItemCost;

  const taxPercent = metalRates.default_tax || 0;
  const taxAmount = (subtotal * taxPercent) / 100;

  const grandTotal = subtotal + taxAmount;

  return {
    metal: {
      purity: config.purity,
      metal_type: config.metal_type,
      weight: metalWeight,
      rate_per_gram: Math.round(metalRate / 100),
      cost: Math.round(metalCost / 100),
    },

    diamond: {
      title: diamondTitle,
      pcs: diamondPcs,
      carat: diamondCarat.toFixed(3),
      clarity: diamondClarity,
      color: diamondColor,
      original: Math.round(diamondOriginal / 100),
      final: Math.round(diamondFinal / 100),
      discount_percent:
        diamondOriginal > 0
          ? Math.round(
              ((diamondOriginal - diamondFinal) /
                diamondOriginal) *
                100
            )
          : 0,
    },

    gemstone: {
      title: gemstoneTitle,
      pcs: gemstonePcs,
      original: Math.round(gemstoneOriginal / 100),
      final: Math.round(gemstoneFinal / 100),
    },

    making_charges: {
      original: Math.round(mcCostOriginal / 100),
      final: Math.round(mcCostFinal / 100),
      discount_percent:
        mcCostOriginal > 0
          ? Math.round(
              ((mcCostOriginal - mcCostFinal) /
                mcCostOriginal) *
                100
            )
          : 0,
    },

    other_material: {
      type: additionalItemType,
      weight: additionalItemWeight,
      charges: Math.round(additionalItemCost / 100),
    },

    gst: {
      percent: taxPercent,
      amount: Math.round(taxAmount / 100),
    },

    total: Math.round(grandTotal / 100),
  };
}

module.exports = { calculatePriceBreakup };
