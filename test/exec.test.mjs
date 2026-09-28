/* The module that can actually cost you something. These tests are the reason
 * to trust the two locks on the door. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runTask, describe, planEnv, ExecRefused } from '../core/exec.mjs';
import { validateTask } from '../core/tasks.mjs';

const task = (over = {}) =>
  validateTask(
    { id: 't', command: 'node -e "process.exit(0)"', durationMinutes: 5, enabled: true, ...over },
    0,
    'test',
  );

test('a disabled task is refused even when asked to execute for real', async () => {
  await assert.rejects(
    () => runTask(task({ enabled: false }), { dryRun: false }),
    ExecRefused,
    'enabled:false is the lock that does not depend on the caller remembering a flag',
  );
});

test('a dry run never spawns anything', async () => {
  const r = await runTask(
    task({ command: { cmd: process.execPath, args: ['-e', 'process.exit(9)'] } }),
    { dryRun: true },
  );
  assert.equal(r.dryRun, true);
  assert.equal(r.exitCode, 0, 'a dry run reports success without having run the failing command');
});

test('exit codes are reported, not swallowed', async () => {
  const r = await runTask(task({ command: { cmd: process.execPath, args: ['-e', 'process.exit(3)'] } }), {
    dryRun: false,
  });
  assert.equal(r.exitCode, 3);
});

test('stdout is streamed line by line', async () => {
  const lines = [];
  await runTask(
    task({ command: { cmd: process.execPath, args: ['-e', "console.log('one');console.log('two')"] } }),
    { dryRun: false, onLine: (l) => lines.push(l) },
  );
  assert.deepEqual(lines, ['one', 'two']);
});

test('a command that does not exist fails instead of throwing', async () => {
  const r = await runTask(
    task({ command: { cmd: 'definitely-not-a-real-binary-xyz', args: [] } }),
    { dryRun: false },
  );
  assert.equal(r.exitCode, -1);
  assert.ok(r.error, 'the spawn error is reported on the result, not raised');
});

test('a hung command is killed rather than holding the window forever', async () => {
  const r = await runTask(
    task({ command: { cmd: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } }),
    { dryRun: false, timeoutMinutes: 0.03 },
  );
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
});

test('describe renders both command forms', () => {
  assert.equal(describe(task({ command: 'npm run backup' })), 'npm run backup');
  assert.equal(describe(task({ command: { cmd: 'node', args: ['a.js', '--x'] } })), 'node a.js --x');
});

test('planEnv exposes the window without letting a price reach a command line', () => {
  const plan = {
    window: { start: Date.UTC(2027, 0, 1, 2), end: Date.UTC(2027, 0, 1, 3), scattered: null },
    spotEurPerMwh: 63.941,
    renewableSharePct: 88.6,
  };
  const env = planEnv(task(), plan);
  assert.equal(env.WHENRUN_TASK, 't');
  assert.equal(env.WHENRUN_SPOT_EUR_MWH, '63.94');
  assert.equal(env.WHENRUN_RENEWABLE_PCT, '89');
  assert.equal(env.WHENRUN_WINDOW_START, '2027-01-01T02:00:00.000Z');
  assert.equal(env.WHENRUN_SLOTS, '', 'a block task has no slot list');

  // The command is whatever the user wrote. Nothing above is interpolated into
  // it; it is passed as environment, which is why a price cannot become syntax.
  assert.equal(describe(task()), 'node -e "process.exit(0)"');
});

test('planEnv copes with a plan that has no renewable data', () => {
  const env = planEnv(task(), {
    window: { start: 0, end: 1, scattered: null },
    spotEurPerMwh: 10,
    renewableSharePct: null,
  });
  assert.equal(env.WHENRUN_RENEWABLE_PCT, '');
});
