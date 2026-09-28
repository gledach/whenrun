/* Reports, does not repair.
 *
 * The checks are ordered by what breaks first in practice: config before
 * network, network before data quality, data quality before anything that
 * executes. */

import fs from 'node:fs';
import { loadTasks } from '../core/tasks.mjs';
import { loadTariff } from '../core/tariff.mjs';
import { getPrices, getRenewableShare, SOURCES, DEFAULT_ZONE } from '../core/collect.mjs';
import { stats, resolutionMinutes, slice } from '../core/series.mjs';
import { paths, pretty } from '../core/paths.mjs';
import { readLedger } from '../core/store.mjs';
import { describe } from '../core/exec.mjs';
import { c } from '../core/format.mjs';
import { bool } from '../core/args.mjs';

export default async function doctor({ flags }) {
  const zone = flags.zone || DEFAULT_ZONE;
  const offline = bool(flags.offline);
  const now = Date.now();
  let problems = 0;
  let warnings = 0;

  const ok = (label, detail = '') => console.log(`  ${c.green('ok')}    ${label}${detail ? `  ${c.dim(detail)}` : ''}`);
  const warn = (label, detail = '') => {
    warnings += 1;
    console.log(`  ${c.yellow('warn')}  ${label}${detail ? `  ${c.dim(detail)}` : ''}`);
  };
  const bad = (label, detail = '') => {
    problems += 1;
    console.log(`  ${c.red('FAIL')}  ${label}${detail ? `  ${c.dim(detail)}` : ''}`);
  };

  console.log('');
  console.log(c.bold('whenrun doctor'));
  console.log('');

  // ── runtime ──
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok('node', `v${process.versions.node}`);
  else bad('node', `v${process.versions.node}, needs >= 22`);

  // ── config ──
  try {
    const { file, tasks } = await loadTasks();
    const enabled = tasks.filter((t) => t.enabled);
    ok('task file', `${pretty(file)}, ${tasks.length} task(s), ${enabled.length} enabled`);
    if (file.endsWith('tasks.default.mjs')) {
      warn('task file is the shipped default', 'cp config/tasks.default.mjs config/tasks.local.mjs');
    }
    for (const t of enabled) {
      if (!fs.existsSync(t.cwd)) bad(`task ${t.id}: cwd does not exist`, t.cwd);
    }
    for (const t of enabled) {
      console.log(`        ${c.dim(`${t.id} will run: ${describe(t)}`)}`);
    }
  } catch (err) {
    bad('task file', err.message);
  }

  try {
    const { file, tariff, isDefault } = await loadTariff();
    ok('tariff', `${file ? pretty(file) : 'built-in'}, fixed ${tariff.fixedCentPerKwh} ct/kWh, VAT ${(tariff.vatRate * 100).toFixed(0)}%`);
    if (isDefault) {
      warn('tariff is the shipped default', 'every saving figure is only as real as these numbers');
    }
  } catch (err) {
    bad('tariff', err.message);
  }

  // ── data ──
  if (offline) {
    warn('network checks skipped', '--offline');
  } else {
    for (const name of Object.keys(SOURCES)) {
      const zoneForSource = name === 'awattar' ? 'DE' : zone;
      try {
        const { series, coverage, from } = await getPrices({
          source: name,
          zone: zoneForSource,
          now,
        });
        if (!series) {
          bad(`source ${name}`, coverage.warnings.join('; '));
          continue;
        }
        const future = slice(series.slots, now, Infinity);
        const st = stats(future.length ? future : series.slots);
        const hoursAhead = (st.to - now) / 3600_000;
        const detail =
          `${zoneForSource}, ${series.slots.length} slots @ ${resolutionMinutes(series.slots)}min, ` +
          `${hoursAhead.toFixed(1)}h ahead, ${st.min.toFixed(0)} to ${st.max.toFixed(0)} EUR/MWh, via ${from}`;

        if (hoursAhead < 2) {
          bad(`source ${name}`, `${detail}. Too little future data to schedule anything`);
        } else if (hoursAhead < 8) {
          warn(`source ${name}`, `${detail}. Tomorrow clears in the early afternoon`);
        } else {
          ok(`source ${name}`, detail);
        }
      } catch (err) {
        bad(`source ${name}`, err.message);
      }
    }

    try {
      const { series } = await getRenewableShare({ now });
      if (series) {
        const st = stats(series.slots);
        ok('renewable forecast', `${series.slots.length} slots, ${st.min.toFixed(0)}% to ${st.max.toFixed(0)}%`);
      } else {
        warn('renewable forecast', 'unavailable. greenest and balanced fall back to cheapest');
      }
    } catch (err) {
      warn('renewable forecast', err.message);
    }
  }

  // ── storage ──
  try {
    fs.mkdirSync(paths.data, { recursive: true });
    fs.accessSync(paths.data, fs.constants.W_OK);
    const ledger = readLedger();
    ok('data directory', `${pretty(paths.data)}, ${ledger.length} ledger row(s)`);
  } catch (err) {
    bad('data directory', `${pretty(paths.data)}: ${err.message}`);
  }

  // ── safety posture ──
  console.log('');
  console.log(c.dim('  Execution is opt-in twice over: a task needs enabled: true, and the'));
  console.log(c.dim('  command needs --execute. Commands come only from your task file.'));

  console.log('');
  if (problems) console.log(`  ${c.red(`${problems} problem(s)`)}${warnings ? `, ${warnings} warning(s)` : ''}`);
  else if (warnings) console.log(`  ${c.yellow(`${warnings} warning(s)`)}, nothing broken`);
  else console.log(`  ${c.green('all good')}`);
  console.log('');

  return problems > 0 ? 1 : 0;
}
