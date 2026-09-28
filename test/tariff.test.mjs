import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTariff } from '../core/tariff.mjs';
import { validateTask } from '../core/tasks.mjs';

/* A tariff with a string where a number belongs produces NaN savings that
 * propagate all the way to the report without ever throwing, so validation
 * refuses rather than repairs. */

test('a valid tariff passes through with defaults filled in', () => {
  const t = validateTariff({ fixedCentPerKwh: 20 });
  assert.equal(t.fixedCentPerKwh, 20);
  assert.equal(typeof t.vatRate, 'number');
});

test('a non-numeric component is refused', () => {
  assert.throws(() => validateTariff({ fixedCentPerKwh: '20' }), /must be a number/);
  assert.throws(() => validateTariff({ vatRate: null }), /must be a number/);
});

test('VAT given as a percentage is caught', () => {
  assert.throws(() => validateTariff({ vatRate: 19 }), /fraction/);
});

test('a wildly negative component is treated as a typo', () => {
  assert.throws(() => validateTariff({ fixedCentPerKwh: -5 }), /typo/);
});

/* Task validation is the last thing between a mistake and a command running
 * unattended overnight, so it refuses rather than defaulting. */

test('a task must declare a duration', () => {
  assert.throws(() => validateTask({ id: 'x', command: 'echo' }, 0, 'f'), /durationMinutes/);
});

test('a task must have a command in one of the two shapes', () => {
  assert.throws(() => validateTask({ id: 'x', durationMinutes: 10 }, 0, 'f'), /needs command/);
  assert.doesNotThrow(() => validateTask({ id: 'x', durationMinutes: 10, command: 'echo' }, 0, 'f'));
  assert.doesNotThrow(() =>
    validateTask({ id: 'x', durationMinutes: 10, command: { cmd: 'node', args: [] } }, 0, 'f'),
  );
});

test('enabled is opt-in and never inferred', () => {
  assert.equal(validateTask({ id: 'x', command: 'e', durationMinutes: 5 }, 0, 'f').enabled, false);
  assert.equal(
    validateTask({ id: 'x', command: 'e', durationMinutes: 5, enabled: 'yes' }, 0, 'f').enabled,
    false,
    'only the boolean true enables a task, so a truthy typo cannot',
  );
  assert.equal(
    validateTask({ id: 'x', command: 'e', durationMinutes: 5, enabled: true }, 0, 'f').enabled,
    true,
  );
});

test('a malformed clock time is refused', () => {
  const base = { id: 'x', command: 'e', durationMinutes: 5 };
  assert.throws(() => validateTask({ ...base, deadline: '7:00' }, 0, 'f'), /HH:MM/);
  assert.throws(() => validateTask({ ...base, earliest: '25:00' }, 0, 'f'), /HH:MM/);
  assert.doesNotThrow(() => validateTask({ ...base, deadline: '07:00', earliest: '22:30' }, 0, 'f'));
});

test('an unknown objective is refused', () => {
  assert.throws(
    () => validateTask({ id: 'x', command: 'e', durationMinutes: 5, objective: 'fastest' }, 0, 'f'),
    /objective must be/,
  );
});

test('a duration longer than the day-ahead horizon is refused', () => {
  assert.throws(
    () => validateTask({ id: 'x', command: 'e', durationMinutes: 2000 }, 0, 'f'),
    /longer than a day/,
  );
});

test('an id with shell-unfriendly characters is refused', () => {
  assert.throws(() => validateTask({ id: 'a b', command: 'e', durationMinutes: 5 }, 0, 'f'), /id matching/);
  assert.throws(() => validateTask({ id: '../x', command: 'e', durationMinutes: 5 }, 0, 'f'), /id matching/);
});
