/* Turning a market price into what you actually pay.
 *
 * The number everyone quotes is the day-ahead spot price in EUR/MWh. It is not
 * your bill. A German household bill is roughly spot + supplier markup + grid
 * fees + levies + taxes + VAT, and only the first of those moves by the hour.
 *
 * This matters for honesty more than for arithmetic. If spot halves between
 * 18:00 and 03:00, your bill does not halve: the fixed components dilute it.
 * A tool that reports "saved 62%" when the real figure is 19% is lying in a way
 * that is very easy to do by accident, so the split is modelled explicitly and
 * every saving is reported against the delivered price, not the spot price. */

/** 1 MWh = 1000 kWh, and 1 EUR = 100 ct, so EUR/MWh / 10 = ct/kWh. */
export function eurPerMwhToCentPerKwh(eurPerMwh) {
  return eurPerMwh / 10;
}

/* `null / 10` is 0 in JavaScript, not NaN. Without this guard a missing spot
   price prices energy at exactly zero and then reports, with total confidence,
   that you saved 100% of the energy component. tariff.mjs guards every one of
   its fields for the same reason; the spot price had no such guard. */
function requireSpot(value, where) {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `${where}: spot price must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export const DEFAULT_TARIFF = {
  /* Supplier markup on top of spot, ct/kWh net. Dynamic tariffs in Germany
     typically sit somewhere near this. Yours is on your contract. */
  markupCentPerKwh: 1.5,

  /* Everything that does not move by the hour: grid fees, concession levy,
     electricity tax, metering. ct/kWh net. This is the number that decides how
     much a cheap hour is actually worth to you, so the default is deliberately
     realistic rather than flattering. */
  fixedCentPerKwh: 18.0,

  /* German VAT. Applied to the whole delivered price. */
  vatRate: 0.19,

  /* Monthly standing charge, EUR. Does not affect window choice; carried so a
     report can show it rather than pretend the bill is only energy. */
  basePriceEurPerMonth: 12.0,
};

/**
 * Delivered price for one kWh consumed at a given spot price.
 * @returns {number} cents per kWh, VAT included
 */
export function deliveredCentPerKwh(spotEurPerMwh, tariff = DEFAULT_TARIFF) {
  requireSpot(spotEurPerMwh, 'deliveredCentPerKwh');
  const net =
    eurPerMwhToCentPerKwh(spotEurPerMwh) +
    (tariff.markupCentPerKwh ?? 0) +
    (tariff.fixedCentPerKwh ?? 0);
  return net * (1 + (tariff.vatRate ?? 0));
}

/**
 * What a job costs.
 * @param {{ spotEurPerMwh: number, kw: number, minutes: number }} job
 * @returns {{ kwh: number, centPerKwh: number, eur: number, spotShareEur: number }}
 */
export function jobCost({ spotEurPerMwh, kw, minutes }, tariff = DEFAULT_TARIFF) {
  requireSpot(spotEurPerMwh, 'jobCost');
  const kwh = kw * (minutes / 60);
  const centPerKwh = deliveredCentPerKwh(spotEurPerMwh, tariff);
  const spotShare =
    eurPerMwhToCentPerKwh(spotEurPerMwh) * (1 + (tariff.vatRate ?? 0)) * kwh / 100;
  return {
    kwh,
    centPerKwh,
    eur: (centPerKwh * kwh) / 100,
    spotShareEur: spotShare,
  };
}

/**
 * The saving from moving a job from one spot price to another.
 *
 * Only the spot component differs between two windows, so this is the whole of
 * the difference. Reported both in absolute money and as a share of the
 * delivered baseline, because the second number is the honest one and it is
 * always much smaller than the spot-only comparison a naive tool would print.
 */
export function saving({ fromSpot, toSpot, kw, minutes }, tariff = DEFAULT_TARIFF) {
  const before = jobCost({ spotEurPerMwh: fromSpot, kw, minutes }, tariff);
  const after = jobCost({ spotEurPerMwh: toSpot, kw, minutes }, tariff);
  const eur = before.eur - after.eur;
  return {
    beforeEur: before.eur,
    afterEur: after.eur,
    savedEur: eur,
    savedPctOfBill: before.eur === 0 ? 0 : (eur / before.eur) * 100,
    /* Negative day-ahead prices are routine in DE-LU and were hit during
       testing in AT. A negative denominator here turns a real saving into
       "-900% of its energy component", so the share is only meaningful when
       the baseline energy component was actually positive. */
    savedPctOfSpot:
      before.spotShareEur > 0 ? (eur / before.spotShareEur) * 100 : null,
    kwh: before.kwh,
  };
}

export function formatEur(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(2)} EUR`;
}

export function formatCent(n) {
  return `${n.toFixed(2)} ct/kWh`;
}
