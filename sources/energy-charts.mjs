/* Energy-Charts, Fraunhofer ISE.
 *
 * The default source. No key, no account, no rate limit worth worrying about,
 * and it publishes both halves of the problem: day-ahead price and a renewable
 * share forecast. Data is CC BY 4.0 from Bundesnetzagentur | SMARD.de, which
 * the report command attributes.
 *
 * Resolution is 15 minutes, matching the German market since the switch away
 * from hourly intervals. Nothing here hardcodes that: the slot length is taken
 * from the gaps between timestamps, so an hourly zone parses correctly too. */

import { getJson, SourceError } from '../core/http.mjs';
import { makeSeries, MIN } from '../core/series.mjs';

const BASE = 'https://api.energy-charts.info';

/** Bidding zones this source accepts. Not exhaustive upstream, just the ones worth listing. */
export const ZONES = [
  'DE-LU', 'AT', 'BE', 'CH', 'CZ', 'DK1', 'DK2', 'ES', 'FR', 'IT-North',
  'NL', 'NO2', 'PL', 'PT', 'SE4', 'SK',
];

/** Turn parallel arrays into slots. The last slot borrows the modal gap. */
function pairsToSlots(unixSeconds, values) {
  if (!Array.isArray(unixSeconds) || !Array.isArray(values)) return [];

  // Only go as far as both arrays reach. Upstream sometimes publishes a longer
  // timestamp axis than value axis, and zipping past the end invents data.
  const n = Math.min(unixSeconds.length, values.length);
  if (n === 0) return [];

  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push((unixSeconds[i] - unixSeconds[i - 1]) * 1000);
  const modalGap = gaps.length ? mode(gaps) : 15 * MIN;

  const slots = [];
  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const start = unixSeconds[i] * 1000;
    const end = i + 1 < n ? unixSeconds[i + 1] * 1000 : start + modalGap;
    slots.push({ start, end, value });
  }
  return slots;
}

function mode(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = arr[0];
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

export const id = 'energy-charts';
export const label = 'Energy-Charts (Fraunhofer ISE)';
export const needsKey = false;
export const attribution =
  'Price data CC BY 4.0 from Bundesnetzagentur | SMARD.de via Energy-Charts (Fraunhofer ISE)';

/** Local YYYY-MM-DD. The endpoint takes calendar dates, not timestamps. */
function isoDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Without an explicit range this endpoint returns today only, which at 23:00 is
 * about fifteen minutes of future prices and useless for scheduling anything
 * overnight. Tomorrow's auction clears in the early afternoon, so the range is
 * always requested through tomorrow and the caller gets whatever exists.
 */
export function priceUrl({ zone = 'DE-LU', now = Date.now(), daysAhead = 1 } = {}) {
  const start = isoDate(now);
  const end = isoDate(now + daysAhead * 86400_000);
  return `${BASE}/price?bzn=${encodeURIComponent(zone)}&start=${start}&end=${end}`;
}

export async function fetchPrices({ zone = 'DE-LU', fixture = null, now = Date.now() } = {}) {
  const json = fixture ?? (await getJson(priceUrl({ zone, now }), { source: id }));

  const slots = pairsToSlots(json.unix_seconds, json.price);
  if (slots.length === 0) {
    throw new SourceError(`${id}: no price points for zone ${zone}`, { source: id, kind: 'empty' });
  }

  return makeSeries({
    kind: 'price',
    unit: json.unit || 'EUR / MWh',
    zone,
    source: id,
    slots,
  });
}

/**
 * Renewable share forecast, percent of load. Country code, not bidding zone,
 * which is an upstream inconsistency rather than a choice made here.
 *
 * The figure can exceed 100. It is a share of domestic load, not of
 * generation, so when renewables outproduce German load the surplus is
 * exported and the number goes above 100. That is correct data. Do not clamp
 * it: those are exactly the hours a greenest-window search should prefer.
 */
export async function fetchRenewableShare({ country = 'de', fixture = null } = {}) {
  const json =
    fixture ?? (await getJson(`${BASE}/ren_share_forecast?country=${encodeURIComponent(country)}`, { source: id }));

  const slots = pairsToSlots(json.unix_seconds, json.ren_share);
  if (slots.length === 0) {
    throw new SourceError(`${id}: no renewable share for ${country}`, { source: id, kind: 'empty' });
  }

  return makeSeries({
    kind: 'renewable-share',
    unit: '%',
    zone: country.toUpperCase(),
    source: id,
    slots,
  });
}
