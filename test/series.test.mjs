import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSeries, resolutionMinutes, slice, stats, isContiguous,
  bestWindow, bestSlots, MIN, HOUR,
} from '../core/series.mjs';

const T0 = Date.UTC(2027, 0, 15, 0, 0, 0);

/** Build hourly slots from an array of values starting at T0. */
function hourly(values, from = T0) {
  return values.map((value, i) => ({
    start: from + i * HOUR,
    end: from + (i + 1) * HOUR,
    value,
  }));
}

function quarterly(values, from = T0) {
  return values.map((value, i) => ({
    start: from + i * 15 * MIN,
    end: from + (i + 1) * 15 * MIN,
    value,
  }));
}

test('makeSeries sorts, drops junk and dedupes by start', () => {
  const s = makeSeries({
    kind: 'price', unit: 'EUR / MWh', zone: 'DE-LU', source: 'test',
    slots: [
      { start: T0 + HOUR, end: T0 + 2 * HOUR, value: 20 },
      { start: T0, end: T0 + HOUR, value: 10 },
      { start: T0, end: T0 + HOUR, value: 11 },      // correction, wins
      { start: T0 + 5 * HOUR, end: T0 + 5 * HOUR, value: 5 }, // zero length, dropped
      { start: T0 + 6 * HOUR, end: T0 + 7 * HOUR, value: NaN }, // dropped
    ],
  });
  assert.equal(s.slots.length, 2);
  assert.equal(s.slots[0].value, 11, 'later duplicate supersedes earlier');
  assert.ok(s.slots[0].start < s.slots[1].start, 'sorted ascending');
});

test('resolutionMinutes reports the modal slot length', () => {
  assert.equal(resolutionMinutes(hourly([1, 2, 3])), 60);
  assert.equal(resolutionMinutes(quarterly([1, 2, 3, 4])), 15);
  assert.equal(resolutionMinutes([]), 0);
});

test('resolutionMinutes survives one odd slot', () => {
  const slots = hourly([1, 2, 3]);
  slots.push({ start: T0 + 3 * HOUR, end: T0 + 3 * HOUR + 30 * MIN, value: 4 });
  assert.equal(resolutionMinutes(slots), 60, 'one 30-minute slot does not change the mode');
});

test('slice keeps partial overlaps', () => {
  const slots = hourly([1, 2, 3, 4]);
  const got = slice(slots, T0 + 30 * MIN, T0 + 2 * HOUR + 30 * MIN);
  assert.equal(got.length, 3, 'a job may start and end mid-slot');
});

test('stats computes min, max, mean, median', () => {
  const s = stats(hourly([10, 20, 30, 40]));
  assert.equal(s.min, 10);
  assert.equal(s.max, 40);
  assert.equal(s.mean, 25);
  assert.equal(s.median, 25);
  assert.equal(s.count, 4);
});

test('isContiguous detects a gap', () => {
  const slots = hourly([1, 2, 3]);
  assert.equal(isContiguous(slots), true);
  slots.splice(1, 1);
  assert.equal(isContiguous(slots), false);
});

test('bestWindow finds the cheapest hour', () => {
  const slots = hourly([100, 50, 200, 80]);
  const w = bestWindow(slots, { durationMinutes: 60 });
  assert.equal(w.mean, 50);
  assert.equal(w.start, T0 + HOUR);
});

test('bestWindow finds the cheapest contiguous pair, not the two cheapest hours', () => {
  // The two cheapest hours are index 0 and 3, but they do not touch.
  // The cheapest adjacent pair is 2+3 at mean 55.
  const slots = hourly([10, 200, 90, 20]);
  const w = bestWindow(slots, { durationMinutes: 120 });
  assert.equal(w.start, T0 + 2 * HOUR);
  assert.equal(w.mean, 55);
});

test('bestWindow weights by time, not by slot count', () => {
  // 90 minutes starting at T0 covers all of hour 0 and half of hour 1.
  // Time weighted: (100*60 + 200*30) / 90 = 133.33, not the flat mean 150.
  const slots = hourly([100, 200, 300]);
  const w = bestWindow(slots, { durationMinutes: 90, notBefore: T0, notAfter: T0 + 90 * MIN });
  assert.ok(Math.abs(w.mean - 400 / 3) < 1e-9, `expected 133.33, got ${w.mean}`);
});

test('bestWindow respects notBefore and notAfter', () => {
  const slots = hourly([10, 20, 30, 40]);
  const w = bestWindow(slots, {
    durationMinutes: 60,
    notBefore: T0 + 2 * HOUR,
    notAfter: T0 + 4 * HOUR,
  });
  assert.equal(w.start, T0 + 2 * HOUR, 'cheapest hour overall is excluded by notBefore');
  assert.equal(w.mean, 30);
});

test('bestWindow returns null when the horizon cannot hold the job', () => {
  const slots = hourly([10, 20]);
  assert.equal(bestWindow(slots, { durationMinutes: 300 }), null);
});

test('bestWindow returns null rather than spanning a gap', () => {
  const slots = hourly([10, 20, 30, 40]);
  slots.splice(1, 1); // remove hour 1, leaving a hole
  const w = bestWindow(slots, { durationMinutes: 120, notBefore: T0, notAfter: T0 + 3 * HOUR });
  assert.equal(w, null, 'a job cannot run across a slot that was never published');
});

test('bestWindow maximises when told to', () => {
  const slots = hourly([10, 90, 20]);
  const w = bestWindow(slots, { durationMinutes: 60, direction: 'max' });
  assert.equal(w.mean, 90);
});

test('bestWindow rejects a nonsense duration', () => {
  assert.throws(() => bestWindow(hourly([1]), { durationMinutes: 0 }), TypeError);
  assert.throws(() => bestWindow(hourly([1]), { durationMinutes: -5 }), TypeError);
});

test('bestSlots picks the cheapest hours even when they do not touch', () => {
  const slots = hourly([10, 200, 90, 20]);
  const got = bestSlots(slots, { durationMinutes: 120 });
  const starts = got.slots.map((s) => (s.start - T0) / HOUR);
  assert.deepEqual(starts, [0, 3], 'interruptible loads may scatter');
  assert.equal(got.mean, 15);
});

test('bestSlots returns null when the horizon is too short', () => {
  assert.equal(bestSlots(hourly([1, 2]), { durationMinutes: 600 }), null);
});

test('quarter-hourly series work without any hourly assumption', () => {
  // 96 quarter-hours, cheapest run of four consecutive at index 40.
  const values = new Array(96).fill(100);
  for (let i = 40; i < 44; i++) values[i] = 5;
  const slots = quarterly(values);
  const w = bestWindow(slots, { durationMinutes: 60 });
  assert.equal(w.mean, 5);
  assert.equal(w.start, T0 + 40 * 15 * MIN);
});
