import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, retryDelayMs, SourceError } from '../core/http.mjs';

/* These are free public APIs. A daemon that gives up on the first 429 stops
 * scheduling for the rest of the day, so the retry policy is worth pinning
 * down without needing the network to misbehave on cue. */

test('transient statuses retry, permanent ones do not', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryable(s), true, `${s} should retry`);
  }
  for (const s of [400, 401, 403, 404, 410, 422]) {
    assert.equal(isRetryable(s), false, `${s} must not retry: the request itself is wrong`);
  }
});

test('backoff grows and is capped', () => {
  const a = retryDelayMs(null, 0);
  const b = retryDelayMs(null, 1);
  const c = retryDelayMs(null, 9);
  assert.ok(b > a, 'each attempt waits longer');
  assert.ok(c <= 8000, 'and it stops growing rather than sleeping forever');
});

test('Retry-After in seconds is honoured', () => {
  const res = { headers: { get: (k) => (k === 'retry-after' ? '5' : null) } };
  assert.equal(retryDelayMs(res, 0), 5000);
});

test('Retry-After as a date is honoured', () => {
  const when = new Date(Date.now() + 4000).toUTCString();
  const res = { headers: { get: () => when } };
  const d = retryDelayMs(res, 0);
  assert.ok(d > 1000 && d <= 5000, `expected about 4s, got ${d}`);
});

test('an absurd Retry-After is capped rather than obeyed', () => {
  const res = { headers: { get: () => '86400' } };
  assert.ok(retryDelayMs(res, 0) <= 30_000, 'a day is not a wait, it is an outage');
});

test('a malformed Retry-After falls back to backoff', () => {
  const res = { headers: { get: () => 'soon-ish' } };
  assert.equal(retryDelayMs(res, 1), retryDelayMs(null, 1));
});

test('SourceError carries enough to tell an outage from a bad request', () => {
  const e = new SourceError('x', { source: 's', status: 429, kind: 'http' });
  assert.equal(e.name, 'SourceError');
  assert.equal(e.status, 429);
  assert.equal(e.kind, 'http');
  assert.equal(e.source, 's');
});
