/* Regressions for defects found in an adversarial review after the first
 * working version. Each test names the behaviour that was wrong, so a future
 * change that reintroduces it fails with a sentence rather than a diff. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { jobCost, deliveredCentPerKwh, saving } from '../core/money.mjs';
import { isContiguous, bestWindow, resolutionMinutes } from '../core/series.mjs';
import * as energyCharts from '../sources/energy-charts.mjs';
import * as awattar from '../sources/awattar.mjs';
import { planTask } from '../core/schedule.mjs';
import { makeSeries, HOUR } from '../core/series.mjs';
import { validateTask } from '../core/tasks.mjs';

const T0 = Date.UTC(2027, 0, 15, 0, 0, 0);
const prices = (values) =>
  makeSeries({
    kind: 'price', unit: 'EUR / MWh', zone: 'DE-LU', source: 'test',
    slots: values.map((value, i) => ({ start: T0 + i * HOUR, end: T0 + (i + 1) * HOUR, value })),
  });
const task = (over) =>
  validateTask({ id: 'j', command: 'e', durationMinutes: 60, kw: 2, enabled: true, ...over }, 0, 't');

/* ── a missing spot price must not cost exactly zero ──────────────────────
   null / 10 is 0 in JavaScript, so an absent price used to produce a
   confident "you saved 100% of the energy component". */

test('a null spot price is refused rather than priced at zero', () => {
  assert.throws(() => jobCost({ spotEurPerMwh: null, kw: 11, minutes: 60 }), TypeError);
  assert.throws(() => deliveredCentPerKwh(null), TypeError);
  assert.throws(() => deliveredCentPerKwh(undefined), TypeError);
  assert.throws(() => jobCost({ spotEurPerMwh: NaN, kw: 1, minutes: 60 }), TypeError);
});

test('a real spot price of zero is still allowed', () => {
  // Zero is a legitimate clearing price and must not be confused with absent.
  assert.doesNotThrow(() => jobCost({ spotEurPerMwh: 0, kw: 1, minutes: 60 }));
});

/* ── negative prices must not invert the reported share ─────────────────── */

test('a negative baseline reports no energy-component share rather than a negative one', () => {
  // Moving from -5 to -50 EUR/MWh is a real saving, but the share of a
  // negative baseline is meaningless and used to print as "-900%".
  const s = saving({ fromSpot: -5, toSpot: -50, kw: 11, minutes: 60 });
  assert.ok(s.savedEur > 0, 'the money saved is still real');
  assert.equal(s.savedPctOfSpot, null, 'and the share is withheld rather than inverted');
  assert.ok(s.savedPctOfBill > 0);
});

test('a positive baseline still reports a share', () => {
  const s = saving({ fromSpot: 200, toSpot: 100, kw: 1, minutes: 60 });
  assert.ok(typeof s.savedPctOfSpot === 'number' && s.savedPctOfSpot > 0);
});

/* ── a hole in the upstream series must stay a hole ─────────────────────── */

test('a gap upstream does not become one long slot at an invented price', async () => {
  // Hourly series with 02:00, 03:00 and 04:00 missing entirely.
  const series = await energyCharts.fetchPrices({
    zone: 'DE-LU',
    fixture: {
      unit: 'EUR / MWh',
      unix_seconds: [0, 3600, 7200, 18000, 21600],
      price: [10, 20, 30, 999, 40],
    },
  });

  assert.equal(resolutionMinutes(series.slots), 60);
  assert.equal(
    isContiguous(series.slots),
    false,
    'the missing hours must remain missing, not be papered over',
  );

  // 00:00 to 03:00 is a genuine unbroken run and may be scheduled.
  const legit = bestWindow(series.slots, { durationMinutes: 180 });
  assert.ok(legit, 'real contiguous runs are still usable');
  assert.equal(legit.start, 0);

  // Starting at 02:00 would have to cross 03:00 to 05:00, which the market
  // never priced. Before the fix that gap was hidden inside one stretched slot
  // and this returned a window at an invented price.
  const acrossGap = bestWindow(series.slots, { durationMinutes: 180, notBefore: 7200_000 });
  assert.equal(acrossGap, null, 'no job may be scheduled across hours the market never priced');
});

test('a series with no gaps is still contiguous', async () => {
  const series = await energyCharts.fetchPrices({
    zone: 'DE-LU',
    fixture: { unit: 'EUR / MWh', unix_seconds: [0, 3600, 7200], price: [10, 20, 30] },
  });
  assert.equal(isContiguous(series.slots), true);
  assert.equal(series.slots.at(-1).end - series.slots.at(-1).start, HOUR, 'the last slot gets one interval');
});

/* ── aWATTar speaks countries, the rest of the tool speaks zones ────────── */

test('the default bidding zone reaches awattar instead of reporting an empty cache', () => {
  assert.equal(awattar.normaliseZone('DE-LU'), 'DE');
  assert.equal(awattar.normaliseZone('de-lu'), 'DE');
  assert.equal(awattar.normaliseZone('AT'), 'AT');
  assert.equal(awattar.normaliseZone('FR'), null);
  assert.match(awattar.priceUrl({ zone: 'DE-LU', now: 1 }), /awattar\.de/);
});

/* ── the plan must describe the run that will actually happen ───────────── */

test('an interruptible task is never priced at its advisory optimum', () => {
  const plan = planTask(task({ durationMinutes: 120, interruptible: true }), {
    prices: prices([10, 900, 900, 20]),
    now: T0,
  });
  assert.ok(plan.scatteredSpotEurPerMwh < plan.spotEurPerMwh);
  assert.ok(
    plan.savings.savedEur < 100,
    'the ledger figure must come from the block that runs, not the slots that were suggested',
  );
});

test('a plan is refused when prices cannot cover the window it picked', () => {
  // A horizon that satisfies the minute count but leaves the chosen block
  // unpriceable should refuse, not emit NaN.
  const plan = planTask(task({ durationMinutes: 60 }), { prices: prices([]), now: T0 });
  assert.equal(plan.feasible, false);
});
