/* The one place that decides where anything lives on disk.
 *
 * Every other module asks this. That is the rule that stops a daemon started
 * from a different working directory writing its ledger somewhere the report
 * command will never look for it. */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.WHENRUN_DATA
  ? path.resolve(process.env.WHENRUN_DATA)
  : path.join(ROOT, 'data');

export const CONFIG_DIR = path.join(ROOT, 'config');

export const paths = {
  root: ROOT,
  data: DATA_DIR,
  priceCache: path.join(DATA_DIR, 'prices'),
  ledger: path.join(DATA_DIR, 'runs.jsonl'),
  state: path.join(DATA_DIR, 'state.json'),
  lock: path.join(DATA_DIR, 'daemon.lock'),
};

export function ensureDataDir() {
  fs.mkdirSync(paths.priceCache, { recursive: true });
  return DATA_DIR;
}

/** Shortest path that still identifies the file, for log lines. */
export function pretty(p) {
  const rel = path.relative(ROOT, p);
  return rel.startsWith('..') ? p : rel.split(path.sep).join('/');
}
