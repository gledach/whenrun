/* Parsed against real responses captured from the live APIs, not handwritten
 * shapes. A handwritten fixture tests that the parser matches my belief about
 * the API; a captured one tests that it matches the API. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as energyCharts from '../sources/energy-charts.mjs';
import * as awattar from '../sources/awattar.mjs';
import { resolutionMinutes, isContiguous } from '../core/series.mjs';
import { SourceError } from '../core/http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));

test('energy-charts prices parse to a contiguous quarter-hourly series', async () => {
  const series = await energyCharts.fetchPrices({ zone: 'DE-LU', fixture: fixture('energy-charts-de-lu.json') });

  assert.equal(series.kind, 'price');
  assert.equal(series.zone, 'DE-LU');
  assert.equal(series.source, 'energy-charts');
  assert.ok(series.slots.length >= 90, `expected a full day, got ${series.slots.length} slots`);
  assert.equal(resolutionMinutes(series.slots), 15, 'German day-ahead is quarter-hourly');
  assert.equal(isContiguous(series.slots), true, 'no holes in a published day');
  assert.match(series.unit, /EUR\s*\/\s*MWh/i);
  assert.ok(series.slots.every((s) => Number.isFinite(s.value)));
});

test('energy-charts renewable share parses, and may legitimately exceed 100%', async () => {
  const series = await energyCharts.fetchRenewableShare({ country: 'de', fixture: fixture('energy-charts-ren-share.json') });

  assert.equal(series.kind, 'renewable-share');
  assert.equal(series.unit, '%');
  assert.ok(series.slots.length > 100, 'forecast runs beyond one day');

  // Share is of domestic load, not of generation. When renewables outproduce
  // German load the surplus is exported and the figure goes above 100. That is
  // real data, so the upper bound here is a sanity check against a parsing
  // error, not a claim that 100 is the ceiling.
  for (const s of series.slots) {
    assert.ok(s.value >= 0 && s.value <= 200, `share implausible, likely a parse error: ${s.value}`);
  }
  assert.ok(
    series.slots.some((s) => s.value > 50),
    'a real German forecast should cross 50% somewhere in 48 hours',
  );
});

test('energy-charts does not zip past the shorter array', async () => {
  // Upstream publishes a longer timestamp axis than value axis on some
  // endpoints. Zipping to the longer one invents prices out of undefined.
  const series = await energyCharts.fetchPrices({
    zone: 'DE-LU',
    fixture: { unix_seconds: [1000, 1900, 2800, 3700], price: [10, 20], unit: 'EUR / MWh' },
  });
  assert.equal(series.slots.length, 2);
});

test('energy-charts skips null values rather than treating them as zero', async () => {
  const series = await energyCharts.fetchPrices({
    zone: 'DE-LU',
    fixture: { unix_seconds: [1000, 1900, 2800], price: [10, null, 30], unit: 'EUR / MWh' },
  });
  assert.equal(series.slots.length, 2);
  assert.deepEqual(series.slots.map((s) => s.value), [10, 30]);
});

test('energy-charts refuses an empty response instead of returning an empty plan', async () => {
  await assert.rejects(
    () => energyCharts.fetchPrices({ zone: 'DE-LU', fixture: { unix_seconds: [], price: [] } }),
    SourceError,
  );
});

test('awattar prices parse to an hourly series', async () => {
  const series = await awattar.fetchPrices({ zone: 'DE', fixture: fixture('awattar-de.json') });

  assert.equal(series.kind, 'price');
  assert.equal(series.zone, 'DE');
  assert.ok(series.slots.length >= 20, `expected roughly a day, got ${series.slots.length}`);
  assert.equal(resolutionMinutes(series.slots), 60, 'aWATTar publishes hourly');
  assert.equal(isContiguous(series.slots), true);
});

test('awattar refuses an unexpected unit rather than scaling the bill by 1000', async () => {
  await assert.rejects(
    () =>
      awattar.fetchPrices({
        zone: 'DE',
        fixture: { data: [{ start_timestamp: 1, end_timestamp: 2, marketprice: 5, unit: 'Ct/kWh' }] },
      }),
    /unexpected unit/,
  );
});

test('awattar refuses a zone it does not serve', async () => {
  await assert.rejects(() => awattar.fetchPrices({ zone: 'FR', fixture: {} }), /not served/);
});

test('the two sources agree on the day they overlap', async () => {
  const ec = await energyCharts.fetchPrices({ zone: 'DE-LU', fixture: fixture('energy-charts-de-lu.json') });
  const aw = await awattar.fetchPrices({ zone: 'DE', fixture: fixture('awattar-de.json') });

  // Compare hour by hour where both published, averaging the quarter-hours.
  let compared = 0;
  let worst = 0;
  for (const hour of aw.slots) {
    const inside = ec.slots.filter((s) => s.start >= hour.start && s.end <= hour.end);
    if (inside.length === 0) continue;
    const mean = inside.reduce((a, s) => a + s.value, 0) / inside.length;
    worst = Math.max(worst, Math.abs(mean - hour.value));
    compared += 1;
  }

  assert.ok(compared > 0, 'fixtures should overlap by at least an hour');
  // Two independent publishers of the same auction. A few EUR/MWh of drift is
  // rounding and quarter-hour averaging; a large gap means one of them is wrong.
  assert.ok(worst < 25, `sources disagree by ${worst.toFixed(2)} EUR/MWh across ${compared} hours`);
});

/* The range parameters are the difference between a scheduler that works at
 * 23:00 and one that has fifteen minutes of data. Worth testing without the
 * network, because a silent regression here only shows up overnight. */

test('energy-charts asks for today through tomorrow, not just today', () => {
  const now = Date.UTC(2027, 2, 14, 22, 30);
  const url = energyCharts.priceUrl({ zone: 'DE-LU', now });
  assert.match(url, /bzn=DE-LU/);
  assert.match(url, /start=\d{4}-\d{2}-\d{2}/);
  assert.match(url, /end=\d{4}-\d{2}-\d{2}/);

  const start = /start=(\d{4}-\d{2}-\d{2})/.exec(url)[1];
  const end = /end=(\d{4}-\d{2}-\d{2})/.exec(url)[1];
  assert.notEqual(start, end, 'requesting a single day leaves nothing to schedule at 23:00');
  assert.ok(new Date(end) > new Date(start));
});

test('awattar asks from now, so tomorrow arrives once the auction clears', () => {
  const now = 1_800_000_000_000;
  assert.equal(awattar.priceUrl({ zone: 'DE', now }), `https://api.awattar.de/v1/marketdata?start=${now}`);
  assert.equal(awattar.priceUrl({ zone: 'AT', now }), `https://api.awattar.at/v1/marketdata?start=${now}`);
  assert.equal(awattar.priceUrl({ zone: 'FR', now }), null);
});
