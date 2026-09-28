/* Where you are.
 *
 * This is the first thing to change if you are not here.
 *
 *   cp config/location.default.mjs config/location.local.mjs
 *
 * Then edit the copy. It is gitignored and wins over this file, so you can pull
 * upstream forever without a conflict. If you would rather your postcode were
 * not in a published repository, that copy is the place for it.
 *
 * Run `whenrun where` to see every zone this supports and which one is active.
 *
 * FIELDS
 *   postcode The postal code you are in. Not used to fetch anything today: it
 *   place    labels output, and it is the hook for network fees, which vary by
 *            grid operator rather than by bidding zone and are currently
 *            modelled as flat. See docs/roadmap.md item 2.
 *
 *   zone     The electricity bidding zone your prices come from. Not the same
 *            as a country: Germany and Luxembourg share one zone, Denmark has
 *            two, Italy and Norway have several. `whenrun where` lists them.
 *
 *   country  Used for the renewable-share forecast, which is published per
 *            country rather than per bidding zone. Leave it unset and it is
 *            derived from the zone, which is right for every zone listed.
 *
 *   source   Which price API to ask. "energy-charts" covers most of Europe at
 *            quarter-hourly resolution. "awattar" is Germany and Austria only,
 *            hourly, and exists mainly so the two can be cross-checked.
 */

export default {
  postcode: '82319',
  place: 'Starnberg',

  zone: 'DE-LU',
  country: undefined,
  source: 'energy-charts',
};
