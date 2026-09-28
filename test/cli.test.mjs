/* Integration: actually spawn the CLI.
 *
 * The unit tests cover the engine. These cover the thing a person types, which
 * is where a broken import or a bad flag actually shows up. Everything runs
 * --offline against a seeded cache, so the gate never touches the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'whenrun.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whenrun-cli-'));
const tasksFile = path.join(tmp, 'tasks.mjs');

const env = {
  ...process.env,
  WHENRUN_DATA: tmp,
  WHENRUN_TASKS: tasksFile,
  NO_COLOR: '1',
};

/* A task list written for the test rather than the shipped demos, so a change
   to the demos cannot silently change what this asserts. */
fs.writeFileSync(
  tasksFile,
  `export default [
    { id: 'alpha', label: 'Alpha', command: 'node -e "0"', durationMinutes: 60, kw: 2, enabled: false },
    { id: 'beta', label: 'Beta', command: 'node -e "0"', durationMinutes: 60, kw: 1, deadline: '07:00', enabled: true },
  ];\n`,
  'utf8',
);

/* Seed the price cache from the captured fixture, shifted so its slots sit in
   the future. Prices are dated, and a fixture from the day it was captured is
   entirely in the past by the time anyone runs the suite. */
const { makeSeries } = await import('../core/series.mjs');
process.env.WHENRUN_DATA = tmp;
const store = await import('../core/store.mjs');

const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'energy-charts-de-lu.json'), 'utf8'));
const shift = Date.now() - raw.unix_seconds[0] * 1000 - 3600_000; // start an hour ago
store.saveSeries(
  makeSeries({
    kind: 'price',
    unit: 'EUR / MWh',
    zone: 'DE-LU',
    source: 'energy-charts',
    fetchedAt: Date.now(),
    slots: raw.unix_seconds
      .map((s, i) => ({
        start: s * 1000 + shift,
        end: (raw.unix_seconds[i + 1] ?? s + 900) * 1000 + shift,
        value: raw.price[i],
      }))
      .filter((s) => Number.isFinite(s.value)),
  }),
);

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

test('help exits cleanly and names the commands', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  for (const cmd of ['prices', 'plan', 'run', 'daemon', 'report', 'doctor']) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `help should mention ${cmd}`);
  }
});

test('an unknown command exits 2 rather than 0', () => {
  const r = run(['definitely-not-a-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test('tasks lists the configured tasks and their enabled state', () => {
  const r = run(['tasks']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /alpha/);
  assert.match(r.stdout, /beta/);
  assert.match(r.stdout, /1 of 2 enabled/);
});

test('prices renders from cache with no network', () => {
  const r = run(['prices', '--offline']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /EUR\/MWh/);
  assert.match(r.stdout, /Cheapest window/);
});

test('prices --json emits parseable JSON with a coverage block', () => {
  const r = run(['prices', '--offline', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.series.slots));
  assert.ok(parsed.coverage.status);
  assert.equal(typeof parsed.coverage.trustEmptyResult, 'boolean');
});

test('plan describes an ad-hoc job without running anything', () => {
  const r = run(['plan', '--offline', '--duration=90m', '--kw=3']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /window/);
  assert.match(r.stdout, /Nothing has been run/);
});

test('plan rejects a duration it cannot parse', () => {
  const r = run(['plan', '--offline', '--duration=soon']);
  assert.equal(r.status, 2);
  assert.match(r.stderr + r.stdout, /--duration/);
});

test('plan covers every configured task, enabled or not', () => {
  const r = run(['plan', '--offline']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha/);
  assert.match(r.stdout, /beta/);
});

test('run defaults to a dry run and executes nothing', () => {
  const r = run(['run', '--task=beta', '--offline']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run/);
});

test('run refuses a disabled task even when told to execute', () => {
  const r = run(['run', '--task=alpha', '--offline', '--execute', '--now']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refused/);
  assert.doesNotMatch(r.stdout, /^\s*running/m, 'it must refuse before claiming to run');
});

test('run needs a task id', () => {
  const r = run(['run', '--offline']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--task/);
});

test('run rejects an unknown task id', () => {
  const r = run(['run', '--task=ghost', '--offline']);
  assert.equal(r.status, 2);
});

test('daemon --once completes a single pass and releases its lock', () => {
  const r = run(['daemon', '--once', '--offline']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stopped/);
  assert.equal(fs.existsSync(path.join(tmp, 'daemon.lock')), false, 'the lock must not outlive the run');
});

test('report copes with an empty ledger', () => {
  const r = run(['report']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /report/);
});

test('doctor reports without the network and does not fail on warnings alone', () => {
  const r = run(['doctor', '--offline']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /node/);
  assert.match(r.stdout, /task file/);
});
