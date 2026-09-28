/* What you actually pay, on top of the market price.
 *
 * These defaults are a realistic German household shape, not your contract.
 * Copy to config/tariff.local.mjs and put your own numbers in, because every
 * euro this tool claims to save is computed from them.
 *
 *   cp config/tariff.default.mjs config/tariff.local.mjs
 *
 * Where to find each number: your supplier's price sheet (Preisblatt) for the
 * markup and base price, and your last annual bill (Jahresabrechnung) for the
 * rest. If you are not on a dynamic tariff at all, this tool can still tell you
 * when power is cheap, but you will not be charged differently for using it.
 */

export default {
  /* Supplier markup on top of the spot price, ct/kWh net. */
  markupCentPerKwh: 1.5,

  /* Everything that does not move by the hour: grid fees (Netzentgelte),
     concession levy, electricity tax, metering. ct/kWh net.

     This is the number that decides how much a cheap hour is worth. A large
     fixed component means even a free hour of power is not a free hour of
     bill, which is why the tool reports savings against the delivered price
     rather than against spot. */
  fixedCentPerKwh: 18.0,

  /* German VAT on the whole delivered price. */
  vatRate: 0.19,

  /* Monthly standing charge, EUR. Does not affect which window wins; carried
     so a report can show the whole bill rather than only the part that moves. */
  basePriceEurPerMonth: 12.0,
};
