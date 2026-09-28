/* Getting data, and being honest about how old it is.
 *
 * Every read returns a coverage block alongside the series. Without one, a
 * stale cache is indistinguishable from a calm market, and this tool would
 * happily schedule tomorrow's washing against last Tuesday's prices while
 * reporting a confident saving.
 *
 * `trustEmptyResult` is the flag that matters: false means "I could not see",
 * not "there was nothing to see". Callers must refuse to act on the second
 * when they are actually looking at the first. */

import * as energyCharts from '../sources/energy-charts.mjs';
import * as awattar from '../sources/awattar.mjs';
import { saveSeries, loadSeries } from './store.mjs';
import { stats } from './series.mjs';

export const SOURCES = { 'energy-charts': energyCharts, awattar };
export const DEFAULT_SOURCE = 'energy-charts';
export const DEFAULT_ZONE = 'DE-LU';

/* Day-ahead results publish once a day, early afternoon CET. Anything under
   six hours old is current; past eighteen there should have been a new
   publication and there was not. */
const FRESH_MS = 6 * 3600_000;
const STALE_MS = 18 * 3600_000;

export function coverageFor(series, { now = Date.now() } = {}) {
  if (!series) {
    return {
      status: 'never',
      trustEmptyResult: false,
      ageMinutes: null,
      warnings: ['no data has ever been collected for this zone'],
    };
  }

  const age = now - (series.fetchedAt ?? 0);
  const s = stats(series.slots);
  const warnings = [];

  let status = 'fresh';
  if (age > STALE_MS) status = 'stale';
  else if (age > FRESH_MS) status = 'slowing';

  if (status !== 'fresh') {
    warnings.push(
      `price data is ${Math.round(age / 3600_000)}h old; day-ahead publishes daily in the early afternoon`,
    );
  }
  if (s && s.to < now) {
    warnings.push('every published slot is already in the past');
    status = 'stale';
  }
  const hoursAhead = s ? (s.to - now) / 3600_000 : 0;
  if (s && hoursAhead < 6 && hoursAhead > 0) {
    warnings.push(`only ${hoursAhead.toFixed(1)}h of future prices are published`);
  }

  return {
    status,
    trustEmptyResult: status === 'fresh',
    ageMinutes: Math.round(age / 60_000),
    horizonHours: Number(hoursAhead.toFixed(1)),
    slots: series.slots.length,
    warnings,
  };
}

/**
 * Fetch prices, falling back to cache. Never throws on a network failure when a
 * cache exists: a daemon that dies because a free API blipped is worse than a
 * daemon that says so and carries on with yesterday's numbers.
 */
export async function getPrices({
  source = DEFAULT_SOURCE,
  zone = DEFAULT_ZONE,
  offline = false,
  now = Date.now(),
} = {}) {
  const mod = SOURCES[source];
  if (!mod) throw new Error(`Unknown source "${source}". Known: ${Object.keys(SOURCES).join(', ')}`);

  if (!offline) {
    try {
      const fresh = await mod.fetchPrices({ zone });
      saveSeries(fresh);
      return { series: fresh, coverage: coverageFor(fresh, { now }), from: 'network' };
    } catch (err) {
      const cached = loadSeries('price', source, zone);
      if (!cached) {
        return {
          series: null,
          coverage: {
            status: 'never',
            trustEmptyResult: false,
            ageMinutes: null,
            warnings: [`fetch failed and no cache exists: ${err.message}`],
          },
          from: 'none',
          error: err,
        };
      }
      const coverage = coverageFor(cached, { now });
      coverage.warnings.unshift(`live fetch failed, using cache: ${err.message}`);
      return { series: cached, coverage, from: 'cache', error: err };
    }
  }

  const cached = loadSeries('price', source, zone);
  return {
    series: cached,
    coverage: coverageFor(cached, { now }),
    from: cached ? 'cache' : 'none',
  };
}

/** Renewable share. Optional by design: absence downgrades objectives, it does not fail. */
export async function getRenewableShare({ country = 'de', offline = false, now = Date.now() } = {}) {
  if (!offline) {
    try {
      const fresh = await energyCharts.fetchRenewableShare({ country });
      saveSeries(fresh);
      return { series: fresh, coverage: coverageFor(fresh, { now }), from: 'network' };
    } catch {
      // fall through to cache
    }
  }
  const cached = loadSeries('renewable-share', 'energy-charts', country.toUpperCase());
  return {
    series: cached,
    coverage: coverageFor(cached, { now }),
    from: cached ? 'cache' : 'none',
  };
}
