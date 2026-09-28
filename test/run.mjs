#!/usr/bin/env node
/* The gate. Fully offline.
 *
 * `node --test test/` resolves the directory as a module on some Node and
 * platform combinations rather than globbing it, so the file list is built here
 * and passed explicitly. Deterministic beats clever for the one command that
 * decides whether a change ships.
 *
 * Network tests live in test/live.mjs and are deliberately not run here: a gate
 * that fails when a free public API has a bad afternoon teaches you to ignore
 * the gate. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const files = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(HERE, f));

if (files.length === 0) {
  console.error('No *.test.mjs files found. That is a broken checkout, not a passing suite.');
  process.exit(1);
}

console.log(`whenrun test gate: ${files.length} files, offline\n`);

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, TZ: process.env.TZ || 'Europe/Berlin' },
});

child.on('close', (code) => process.exit(code ?? 1));
