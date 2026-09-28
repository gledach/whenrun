import test from 'node:test';
import assert from 'node:assert/strict';
import { planTask, blend, meanOver } from '../core/schedule.mjs';
import { makeSeries, HOUR, MIN } from '../core/series.mjs';
import { validateTask, nextLocalTime, taskBounds } from '../core/tasks.mjs';

const T0 = Date.UTC(2027, 0, 15, 0, 0, 0);

function priceSeries(values, from = T0) {
  return makeSeries({
    kind: 'price', unit: 'EUR / MWh', zone: 'DE-LU', source: 'test',
    slots: values.map((value, i) => ({
      start: from + i * HOUR, end: from + (i + 1) * HOUR, value,
    })),
  });
}

function renSeries(values, from = T0) {
  return makeSeries({
    kind: 'renewable-share', unit: '%', zone: 'DE', source: 'test',
    slots: values.map((value, i) => ({
      start: from + i * HOUR, end: from + (i + 1) * HOUR, value,
    })),
  });
}

function task(over = {}) {
  return validateTask({
    id: 'job',
    command: 'echo hi',
    durationMinutes: 60,
    kw: 2,
    enabled: true,
    ...over,
  }, 0, 'test');
}

test('a cheapest plan picks the cheapest hour and reports its baseline', () => {
  const prices = priceSeries([300, 50, 400, 200]);
  const plan = planTask(task(), { prices, now: T0 });

  assert.equal(plan.feasible, true);
  assert.equal(plan.window.start, T0 + HOUR);
  assert.equal(plan.spotEurPerMwh, 50);
  assert.equal(plan.baselineSpotEurPerMwh, 300, 'baseline is running right now, not the mean');
  assert.ok(plan.savings.savedEur > 0);
});

test('savings are measured against the delivered bill, not against spot alone', () => {
  const prices = priceSeries([400, 20]);
  const plan = planTask(task(), { prices, now: T0 });
  assert.ok(
    plan.savings.savedPctOfSpot > plan.savings.savedPctOfBill,
    'the spot-only figure is always the flattering one and must be labelled as such',
  );
});

test('a greenest plan can choose a more expensive hour on purpose', () => {
  const prices = priceSeries([10, 500]);
  const renewable = renSeries([5, 95]);
  const plan = planTask(task({ objective: 'greenest' }), { prices, renewable, now: T0 });

  assert.equal(plan.window.start, T0 + HOUR, 'greenest ignores price');
  assert.equal(plan.spotEurPerMwh, 500, 'and still reports what that costs you');
  assert.ok(plan.savings.savedEur < 0, 'choosing green at a premium is a loss, stated plainly');
  assert.equal(plan.renewableSharePct, 95);
});

test('a balanced plan avoids both the dirtiest and the dearest hour', () => {
  //        h0: cheap and dirty   h1: dear and clean   h2: middling both
  const prices = priceSeries([10, 500, 120]);
  const renewable = renSeries([5, 95, 60]);
  const plan = planTask(task({ objective: 'balanced' }), { prices, renewable, now: T0 });
  assert.equal(plan.window.start, T0 + 2 * HOUR, 'the compromise hour wins');
});

test('greenest degrades to cheapest when no renewable data exists', () => {
  const prices = priceSeries([300, 40, 500]);
  const plan = planTask(task({ objective: 'greenest' }), { prices, renewable: null, now: T0 });
  assert.equal(plan.feasible, true);
  assert.equal(plan.spotEurPerMwh, 40, 'no green data must not mean no plan');
  assert.equal(plan.renewableSharePct, null, 'and it must not invent a share it does not have');
});

test('an interruptible task gets the scattered optimum as advice, priced as a block', () => {
  const prices = priceSeries([10, 900, 900, 20]);
  const plan = planTask(
    task({ durationMinutes: 120, interruptible: true }),
    { prices, now: T0 },
  );

  assert.equal(plan.window.scattered.length, 2, 'the cheap hours are identified');
  assert.equal(plan.scatteredSpotEurPerMwh, 15, 'and what they would average is reported');

  // The tool starts a command and cannot pause one, so the money must describe
  // the straight-through run it will actually perform. Billing the scattered
  // figure would promise a saving that no script honoured WHENRUN_SLOTS to earn.
  assert.equal(plan.spotEurPerMwh, 455, 'priced as the contiguous block it will really run');
  assert.ok(
    plan.spotEurPerMwh > plan.scatteredSpotEurPerMwh,
    'the advisory figure must never be the one charged for',
  );
});

test('a non-interruptible task of the same length must stay contiguous', () => {
  const prices = priceSeries([10, 900, 900, 20]);
  const plan = planTask(task({ durationMinutes: 120 }), { prices, now: T0 });
  assert.equal(plan.window.scattered, null);
  assert.ok(plan.spotEurPerMwh > 15, 'a contiguous block cannot cherry-pick');
});

test('an impossible deadline is refused with a reason, not squeezed in', () => {
  const prices = priceSeries([100, 100]);
  const plan = planTask(task({ durationMinutes: 600 }), { prices, now: T0 });
  assert.equal(plan.feasible, false);
  assert.match(plan.problem, /only \d+ min of published prices/);
});

test('missing price data is refused rather than guessed', () => {
  const plan = planTask(task(), { prices: null, now: T0 });
  assert.equal(plan.feasible, false);
  assert.equal(plan.problem, 'no price data');
});

test('a disabled task still plans, so you can see what it would do', () => {
  const prices = priceSeries([300, 50]);
  const plan = planTask(task({ enabled: false }), { prices, now: T0 });
  assert.equal(plan.feasible, true);
  assert.equal(plan.enabled, false);
});

test('meanOver is time weighted across a partial slot', () => {
  const slots = priceSeries([100, 200]).slots;
  const m = meanOver(slots, T0, T0 + 90 * MIN);
  assert.ok(Math.abs(m - 400 / 3) < 1e-9);
});

test('blend gives a higher score to cheap and clean than to dear and dirty', () => {
  const p = priceSeries([10, 500]).slots;
  const r = renSeries([90, 10]).slots;
  const scored = blend(p, r, 0.5);
  assert.ok(scored[0].value > scored[1].value);
});

test('nextLocalTime always lands in the future', () => {
  const now = Date.now();
  for (const hhmm of ['00:00', '07:00', '12:30', '23:59']) {
    assert.ok(nextLocalTime(hhmm, now) > now, `${hhmm} resolved into the past`);
  }
});

test('nextLocalTime rejects a malformed time', () => {
  assert.throws(() => nextLocalTime('7:00'), /Not a HH:MM/);
  assert.throws(() => nextLocalTime('24:00'), /Not a HH:MM/);
});

test('an overnight window crossing midnight is not negative', () => {
  const t = task({ earliest: '22:00', deadline: '07:00' });
  const { notBefore, notAfter } = taskBounds(t, Date.now());
  assert.ok(notAfter > notBefore, '22:00 to 07:00 must span midnight, not invert');
});
