/* The store writes to disk, so every test here runs against its own temp
 * directory. paths.mjs reads WHENRUN_DATA at import time, which is why the
 * module is imported dynamically after the environment is set. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whenrun-test-'));
process.env.WHENRUN_DATA = tmp;

const store = await import('../core/store.mjs');
const { makeSeries } = await import('../core/series.mjs');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const series = (value, fetchedAt = Date.now()) =>
  makeSeries({
    kind: 'price', unit: 'EUR / MWh', zone: 'TEST', source: 'unit', fetchedAt,
    slots: [{ start: 0, end: 3600_000, value }],
  });

test('a series round-trips through the cache', () => {
  store.saveSeries(series(42));
  const back = store.loadSeries('price', 'unit', 'TEST');
  assert.equal(back.slots[0].value, 42);
  assert.equal(back.zone, 'TEST');
});

test('a missing cache is a miss, not a crash', () => {
  assert.equal(store.loadSeries('price', 'unit', 'NOPE'), null);
  assert.equal(store.cacheAgeMs('price', 'unit', 'NOPE'), Infinity);
});

test('a corrupt cache file is a miss, not a crash', () => {
  store.saveSeries(series(1));
  const file = fs
    .readdirSync(path.join(tmp, 'prices'))
    .map((f) => path.join(tmp, 'prices', f))
    .find((f) => f.includes('TEST'));
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  assert.equal(store.loadSeries('price', 'unit', 'TEST'), null, 'a bad cache must never take the process down');
});

test('cache age reflects fetchedAt', () => {
  store.saveSeries(series(7, Date.now() - 7200_000));
  const age = store.cacheAgeMs('price', 'unit', 'TEST');
  assert.ok(age > 7000_000 && age < 7400_000, `age was ${age}`);
});

test('the ledger appends and never rewrites', () => {
  store.appendRun({ taskId: 'a', event: 'ran', savedEur: 1, kw: 2, minutes: 60, exitCode: 0 });
  store.appendRun({ taskId: 'a', event: 'ran', savedEur: 2, kw: 2, minutes: 60, exitCode: 0 });
  const rows = store.readLedger();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].savedEur, 1, 'the first row is still the first row');
  assert.equal(rows[1].savedEur, 2);
});

test('one corrupt ledger line does not cost the whole history', () => {
  const file = path.join(tmp, 'runs.jsonl');
  fs.appendFileSync(file, 'not json at all\n', 'utf8');
  store.appendRun({ taskId: 'b', event: 'ran', savedEur: 5, exitCode: 0 });
  const rows = store.readLedger();
  assert.ok(rows.length >= 3, 'readable rows survive an unreadable one');
  assert.ok(rows.some((r) => r.taskId === 'b'));
});

test('readLedger filters by time', () => {
  const future = Date.now() + 60_000;
  assert.equal(store.readLedger({ sinceMs: future }).length, 0);
});

test('totals count completed runs and ignore dry runs', () => {
  store.appendRun({ taskId: 'c', event: 'ran', dryRun: true, savedEur: 99, kw: 1, minutes: 60 });
  const t = store.totals();
  assert.ok(t.savedEur < 90, 'a dry run must not appear in the savings total');
});

test('state records the last run per task', () => {
  assert.equal(store.lastRunAt('zzz'), null);
  const when = Date.now();
  store.markRan('zzz', when);
  assert.equal(store.lastRunAt('zzz'), when);
});
