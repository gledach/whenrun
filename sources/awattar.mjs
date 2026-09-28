/* aWATTar market data.
 *
 * Second source, also keyless, Germany and Austria only. Hourly rather than
 * quarter-hourly, which makes it a coarser answer to the same question. It is
 * kept because two independent sources is the difference between "the price is
 * X" and "one server said X": doctor cross-checks them and warns when they
 * disagree by more than a rounding error.
 *
 * Note the domain carries the country: .de and .at are separate deployments. */

import { getJson, SourceError } from '../core/http.mjs';
import { makeSeries } from '../core/series.mjs';

const HOSTS = { DE: 'https://api.awattar.de', AT: 'https://api.awattar.at' };

/* The rest of the tool speaks bidding zones, where Germany is DE-LU. aWATTar
   speaks countries. Without this the default zone produced "no data has ever
   been collected", which blames the cache for a naming mismatch. */
const ZONE_ALIASES = { 'DE-LU': 'DE', DE: 'DE', AT: 'AT' };

export function normaliseZone(zone) {
  return ZONE_ALIASES[String(zone ?? '').trim().toUpperCase()] ?? null;
}

export const id = 'awattar';
export const label = 'aWATTar market data';
export const needsKey = false;
export const ZONES = ['DE', 'AT'];
export const attribution = 'Market data from aWATTar';

/**
 * `start` is epoch milliseconds. Asking from now rather than taking the default
 * is what gets tomorrow's hours once the day-ahead auction has cleared; the
 * bare endpoint stops at the end of today.
 */
export function priceUrl({ zone = 'DE', now = Date.now() } = {}) {
  const host = HOSTS[normaliseZone(zone)];
  if (!host) return null;
  return `${host}/v1/marketdata?start=${Math.floor(now)}`;
}

export async function fetchPrices({ zone = 'DE', fixture = null, now = Date.now() } = {}) {
  const url = priceUrl({ zone, now });
  if (!url) {
    throw new SourceError(`${id}: zone ${zone} not served. Use DE or AT`, {
      source: id,
      kind: 'empty',
    });
  }

  const json = fixture ?? (await getJson(url, { source: id }));
  const rows = Array.isArray(json?.data) ? json.data : [];

  const slots = rows
    .filter((r) => Number.isFinite(r.marketprice))
    .map((r) => ({
      start: r.start_timestamp,
      end: r.end_timestamp,
      value: r.marketprice,
    }));

  if (slots.length === 0) {
    throw new SourceError(`${id}: no price points returned`, { source: id, kind: 'empty' });
  }

  // Upstream states its unit per row. Trusting the first row rather than
  // assuming EUR/MWh, so a unit change upstream surfaces instead of silently
  // scaling every bill by 1000.
  const unit = rows[0].unit || 'Eur/MWh';
  if (!/eur\s*\/\s*mwh/i.test(unit)) {
    throw new SourceError(`${id}: unexpected unit "${unit}", refusing to guess`, {
      source: id,
      kind: 'parse',
    });
  }

  return makeSeries({ kind: 'price', unit, zone: normaliseZone(zone), source: id, slots });
}
