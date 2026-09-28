import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, minutes, num, bool } from '../core/args.mjs';

test('parseArgs handles --key=value, --key value and bare flags', () => {
  const a = parseArgs(['run', '--task=backup', '--zone', 'DE-LU', '--execute']);
  assert.deepEqual(a._, ['run']);
  assert.equal(a.flags.task, 'backup');
  assert.equal(a.flags.zone, 'DE-LU');
  assert.equal(a.flags.execute, true);
});

test('parseArgs keeps a value containing an equals sign intact', () => {
  const a = parseArgs(['--command=node -e "a=1"']);
  assert.equal(a.flags.command, 'node -e "a=1"');
});

test('parseArgs does not swallow the next flag as a value', () => {
  const a = parseArgs(['--execute', '--task=x']);
  assert.equal(a.flags.execute, true);
  assert.equal(a.flags.task, 'x');
});

test('minutes accepts the shapes people actually type', () => {
  assert.equal(minutes('90'), 90);
  assert.equal(minutes('45m'), 45);
  assert.equal(minutes('45min'), 45);
  assert.equal(minutes('2h'), 120);
  assert.equal(minutes('1h30'), 90);
  assert.equal(minutes('1h30m'), 90);
});

test('minutes refuses nonsense rather than guessing', () => {
  assert.equal(minutes('soon', null), null);
  assert.equal(minutes(undefined, null), null);
  assert.equal(minutes(true, null), null, 'a bare --duration flag has no value');
});

test('num and bool have sane fallbacks', () => {
  assert.equal(num('2.5', 0), 2.5);
  assert.equal(num('abc', 7), 7);
  assert.equal(num(undefined, 7), 7);
  assert.equal(bool(undefined, false), false);
  assert.equal(bool(true), true);
  assert.equal(bool('false'), false);
  assert.equal(bool('0'), false);
  assert.equal(bool('no'), false);
  assert.equal(bool('yes'), true);
});
