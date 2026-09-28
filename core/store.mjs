/* Persistence, such as it is.
 *
 * Three files, no database, no dependency. A price cache so the daemon is not
 * hammering a free public API once a minute and still works when it is down, an
 * append-only run ledger, and a small state file for "has this already run
 * today".
 *
 * Append-only for the ledger is deliberate: a run that happened is a fact, and
 * nothing in this tool should be able to revise history to make its own savings
 * report look better. Corrections get appended, never overwritten.
 *
 * This module is the only thing that touches those files. Everything else asks
 * it, which is the same chokepoint rule the rest of the house follows. */

import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDataDir } from './paths.mjs';

/* ─── price cache ─────────────────────────────────────────────────────────
   One file per source+zone+kind. Overwritten wholesale on each successful
   fetch, because a day-ahead series is republished in full rather than
   appended to, and a corrected price supersedes the one it corrects. */

function cacheFile(kind, source, zone) {
  const safe = `${kind}__${source}__${zone}`.replace(/[^a-z0-9_.-]/gi, '-');
  return path.join(paths.priceCache, `${safe}.json`);
}

export function saveSeries(series) {
  ensureDataDir();
  const file = cacheFile(series.kind, series.source, series.zone);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(series), 'utf8');
  fs.renameSync(tmp, file); // atomic, so a crash mid-write cannot truncate the cache
  return file;
}

export function loadSeries(kind, source, zone) {
  const file = cacheFile(kind, source, zone);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && Array.isArray(parsed.slots) ? parsed : null;
  } catch {
    return null; // a corrupt cache is a cache miss, never a crash
  }
}

export function cacheAgeMs(kind, source, zone) {
  const series = loadSeries(kind, source, zone);
  if (!series?.fetchedAt) return Infinity;
  return Date.now() - series.fetchedAt;
}

/* ─── run ledger ──────────────────────────────────────────────────────── */

/**
 * @param {{ taskId: string, event: string, at?: number, plannedStart?: number,
 *           plannedEnd?: number, spotEurPerMwh?: number, baselineSpot?: number,
 *           kw?: number, minutes?: number, savedEur?: number, exitCode?: number,
 *           dryRun?: boolean, note?: string }} entry
 */
export function appendRun(entry) {
  ensureDataDir();
  const row = { at: Date.now(), ...entry };
  fs.appendFileSync(paths.ledger, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export function readLedger({ sinceMs = 0 } = {}) {
  if (!fs.existsSync(paths.ledger)) return [];
  const out = [];
  for (const line of fs.readFileSync(paths.ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if ((row.at ?? 0) >= sinceMs) out.push(row);
    } catch {
      // One bad line must not cost the whole history.
    }
  }
  return out;
}

/* ─── state ───────────────────────────────────────────────────────────── */

export function readState() {
  if (!fs.existsSync(paths.state)) return {};
  try {
    return JSON.parse(fs.readFileSync(paths.state, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeState(next) {
  ensureDataDir();
  const tmp = `${paths.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, paths.state);
}

export function markRan(taskId, when = Date.now()) {
  const state = readState();
  state[taskId] = { ...(state[taskId] || {}), lastRunAt: when };
  writeState(state);
  return state[taskId];
}

export function lastRunAt(taskId) {
  return readState()[taskId]?.lastRunAt ?? null;
}

export function totals() {
  const rows = readLedger();
  const done = rows.filter((r) => r.event === 'ran' && !r.dryRun);
  return {
    ledgerRows: rows.length,
    completedRuns: done.length,
    savedEur: done.reduce((a, r) => a + (r.savedEur || 0), 0),
    kwh: done.reduce((a, r) => a + ((r.kw || 0) * ((r.minutes || 0) / 60)), 0),
  };
}
