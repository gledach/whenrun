/* Window resolution across the clock.
 *
 * The runner pins TZ to Europe/Berlin so these are deterministic. The bug these
 * exist to prevent: an overnight task asked in the small hours scheduling for
 * the following night instead of the window it is already inside.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { taskBounds, validateTask, nextLocalTime, previousLocalTime } from '../core/tasks.mjs';

const at = (h, m = 0, day = 15) => new Date(2027, 5, day, h, m, 0, 0).getTime();
const hourOf = (ms) => new Date(ms).getHours();
const dayOf = (ms) => new Date(ms).getDate();
const task = (over) =>
  validateTask({ id: 'x', command: 'e', durationMinutes: 60, ...over }, 0, 'test');

test('an overnight task asked at 03:00 uses the window it is already inside', () => {
  const t = task({ earliest: '22:00', deadline: '07:00' });
  const now = at(3);
  const b = taskBounds(t, now);

  assert.equal(b.notBefore, now, 'it may start immediately, not tonight');
  assert.equal(hourOf(b.notAfter), 7);
  assert.equal(dayOf(b.notAfter), 15, 'the deadline is this morning');
  assert.equal((b.notAfter - b.notBefore) / 3600_000, 4);
});

test('the same task asked at midday waits for tonight', () => {
  const t = task({ earliest: '22:00', deadline: '07:00' });
  const b = taskBounds(t, at(12));
  assert.equal(hourOf(b.notBefore), 22);
  assert.equal(dayOf(b.notBefore), 15);
  assert.equal(dayOf(b.notAfter), 16, 'and finishes the next morning');
});

test('the same task asked at 23:00 may start immediately', () => {
  const t = task({ earliest: '22:00', deadline: '07:00' });
  const now = at(23);
  const b = taskBounds(t, now);
  assert.equal(b.notBefore, now, 'the window opened an hour ago');
});

test('a daytime task before its start waits for it', () => {
  const t = task({ earliest: '09:00', deadline: '17:00' });
  const b = taskBounds(t, at(7));
  assert.equal(hourOf(b.notBefore), 9);
  assert.equal(hourOf(b.notAfter), 17);
  assert.equal(dayOf(b.notBefore), dayOf(b.notAfter), 'a daytime window does not cross midnight');
});

test('a daytime task after its deadline rolls to tomorrow, whole', () => {
  const t = task({ earliest: '09:00', deadline: '17:00' });
  const b = taskBounds(t, at(18));
  assert.equal(dayOf(b.notBefore), 16);
  assert.equal(hourOf(b.notBefore), 9);
  assert.equal(dayOf(b.notAfter), 16);
  assert.equal((b.notAfter - b.notBefore) / 3600_000, 8, 'the full window, not a remnant');
});

test('a deadline with no earliest can start now', () => {
  const t = task({ deadline: '06:00' });
  const now = at(3);
  const b = taskBounds(t, now);
  assert.equal(b.notBefore, now);
  assert.equal((b.notAfter - b.notBefore) / 3600_000, 3);
});

test('no constraints gives a day of runway from now', () => {
  const now = at(13, 37);
  const b = taskBounds(task({}), now);
  assert.equal(b.notBefore, now);
  assert.equal((b.notAfter - b.notBefore) / 3600_000, 24);
});

test('the window is never inverted, at any hour, for any shape', () => {
  const shapes = [
    { earliest: '22:00', deadline: '07:00' },
    { earliest: '09:00', deadline: '17:00' },
    { earliest: '00:00', deadline: '23:59' },
    { earliest: '23:59', deadline: '00:00' },
    { deadline: '04:00' },
    {},
  ];
  for (const shape of shapes) {
    const t = task(shape);
    for (let h = 0; h < 24; h++) {
      const b = taskBounds(t, at(h, 30));
      assert.ok(
        b.notAfter > b.notBefore,
        `inverted window for ${JSON.stringify(shape)} at ${h}:30`,
      );
      assert.ok(b.notBefore >= at(h, 30), 'a window may not open in the past');
    }
  }
});

test('previousLocalTime is the mirror of nextLocalTime', () => {
  const ref = at(12);
  assert.ok(previousLocalTime('07:00', ref) <= ref);
  assert.ok(nextLocalTime('07:00', ref) > ref);
  assert.equal(hourOf(previousLocalTime('07:00', ref)), 7);
  assert.equal(dayOf(previousLocalTime('07:00', ref)), 15, 'today, since 07:00 has passed');
  assert.equal(dayOf(previousLocalTime('18:00', ref)), 14, 'yesterday, since 18:00 has not');
});

test('a spring-forward day still yields a sane window', () => {
  // Europe/Berlin loses 02:00 to 03:00 on 2027-03-28. A deadline of 07:00 that
  // morning is still 07:00 wall clock; the window is simply an hour shorter in
  // real time, which is correct rather than something to compensate for.
  const t = task({ earliest: '22:00', deadline: '07:00' });
  const eveningBefore = new Date(2027, 2, 27, 23, 0, 0).getTime();
  const b = taskBounds(t, eveningBefore);
  assert.ok(b.notAfter > b.notBefore);
  const hours = (b.notAfter - b.notBefore) / 3600_000;
  assert.ok(hours > 6 && hours < 9, `expected a shortened night, got ${hours}h`);
  assert.equal(hourOf(b.notAfter), 7, 'the deadline is a wall-clock time and stays one');
});

test('an autumn fall-back day gains an hour rather than breaking', () => {
  // 2027-10-31 in Europe/Berlin repeats 02:00 to 03:00.
  const t = task({ earliest: '22:00', deadline: '07:00' });
  const eveningBefore = new Date(2027, 9, 30, 23, 0, 0).getTime();
  const b = taskBounds(t, eveningBefore);
  const hours = (b.notAfter - b.notBefore) / 3600_000;
  assert.ok(hours > 7 && hours < 10, `expected a lengthened night, got ${hours}h`);
  assert.equal(hourOf(b.notAfter), 7);
});
