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

/* ── bestSlots on a mixed-resolution series ──────────────────────────────── */

test('bestSlots time-weights and reports the duration it really reserves', async () => {
  const { bestSlots, MIN } = await import('../core/series.mjs');
  // One 60-minute slot and three 15-minute ones. Counting modal-resolution
  // slots claimed 60 minutes while reserving 105, and mispriced by over 40%.
  const slots = [
    { start: 0, end: 60 * MIN, value: 0.5 },
    { start: 60 * MIN, end: 75 * MIN, value: 1 },
    { start: 75 * MIN, end: 90 * MIN, value: 2 },
    { start: 90 * MIN, end: 105 * MIN, value: 3 },
  ];
  const got = bestSlots(slots, { durationMinutes: 60 });

  assert.equal(got.minutes, 60, 'the cheapest 60 minutes is the single long slot');
  assert.equal(got.slots.length, 1);
  assert.equal(got.mean, 0.5, 'and it is not averaged against slots it did not take');
});

test('bestSlots accepts a slot that straddles the boundary, as bestWindow does', async () => {
  const { bestSlots, MIN } = await import('../core/series.mjs');
  const slots = [
    { start: 0, end: 60 * MIN, value: 1 },
    { start: 60 * MIN, end: 120 * MIN, value: 2 },
  ];
  // notBefore falls inside the first slot. Strict containment used to drop it,
  // so a task could pass the feasibility check and then be told no window
  // existed, which is the wrong diagnosis for a splittable job.
  const got = bestSlots(slots, { durationMinutes: 60, notBefore: 30 * MIN });
  assert.ok(got, 'a partially available slot is still usable');
  assert.equal(got.slots[0].start, 30 * MIN, 'and it is clipped to the boundary, not dropped');

  // Slots are taken whole, so covering 60 minutes out of a 30-minute remainder
  // plus a full hour genuinely reserves 90. Reporting that rather than the
  // requested 60 is the point: the old code claimed the duration it was asked
  // for regardless of what it actually held.
  assert.equal(got.minutes, 90);
  assert.ok(got.minutes >= 60, 'never less than the job needs');
});

/* ── an objective that lost its data must say so ─────────────────────────── */

test('greenest without a forecast reports the downgrade instead of hiding it', () => {
  const plan = planTask(task({ objective: 'greenest' }), {
    prices: prices([300, 40, 500]),
    renewable: null,
    now: T0,
  });
  assert.equal(plan.feasible, true);
  assert.equal(plan.degraded, true, 'it silently became a cheapest plan and must admit it');
  assert.match(plan.degradedReason, /fell back to cheapest/);
  assert.equal(plan.objective, 'greenest', 'while still reporting what was asked for');
});

test('greenest with a forecast is not flagged as degraded', () => {
  const renewable = makeSeries({
    kind: 'renewable-share', unit: '%', zone: 'DE', source: 't',
    slots: [0, 1, 2].map((i) => ({ start: T0 + i * HOUR, end: T0 + (i + 1) * HOUR, value: 50 + i })),
  });
  const plan = planTask(task({ objective: 'greenest' }), {
    prices: prices([300, 40, 500]), renewable, now: T0,
  });
  assert.equal(plan.degraded, false);
});

test('a cheapest plan is never flagged as degraded, forecast or not', () => {
  const plan = planTask(task({ objective: 'cheapest' }), {
    prices: prices([300, 40]), renewable: null, now: T0,
  });
  assert.equal(plan.degraded, false, 'cheapest never needed the forecast');
});

/* ── every time this tool prints uses a 24-hour clock ────────────────────── */

test('times render as 24-hour whatever the system locale would prefer', async () => {
  const { hhmm } = await import('../core/format.mjs');
  // 19:30 local. A 12-hour locale would render this "7:30 PM".
  const evening = new Date(2027, 0, 15, 19, 30).getTime();
  assert.equal(hhmm(evening), '19:30');

  const morning = new Date(2027, 0, 15, 7, 5).getTime();
  assert.equal(hhmm(morning), '07:05', 'and the leading zero is kept');

  const midnight = new Date(2027, 0, 15, 0, 0).getTime();
  assert.equal(hhmm(midnight), '00:00', 'midnight is 00:00, never 12:00 AM');
});

test('the refusal message is 24-hour too, not toLocaleString', () => {
  // This one message used to use toLocaleString, which renders "7:00:00 AM" on
  // a US locale while every other time in the tool printed 07:00.
  const plan = planTask(task({ durationMinutes: 600, deadline: '07:00' }), {
    prices: prices([100, 100]),
    now: T0,
  });
  assert.equal(plan.feasible, false);
  assert.doesNotMatch(plan.problem, /\bAM\b|\bPM\b/, 'no am or pm anywhere in the output');
  assert.match(plan.problem, /\d{2}:\d{2}/, 'and a zero-padded 24-hour time instead');
});

test('a time without its leading zero is refused rather than guessed at', () => {
  assert.throws(
    () => task({ deadline: '7:00' }),
    /HH:MM/,
    '"7:00" is ambiguous between 07:00 and 19:00, so it is not accepted',
  );
});
