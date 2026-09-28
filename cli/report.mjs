/* What it actually did, and what that was worth.
 *
 * Reads the append-only ledger. Every figure here is the sum of what was
 * recorded at the time a job ran, never recomputed from today's prices, because
 * recomputing a past saving against a present price is how a tool ends up
 * reporting a number nobody can reproduce. */

import { readLedger } from '../core/store.mjs';
import { loadTariff } from '../core/tariff.mjs';
import { formatEur } from '../core/money.mjs';
import { c, table, dayLabel, hhmm } from '../core/format.mjs';
import { bool, num } from '../core/args.mjs';

export default async function report({ flags }) {
  const days = num(flags.days, 30);
  const since = Date.now() - days * 86400_000;
  const rows = readLedger({ sinceMs: since });
  const { tariff, file: tariffFile } = await loadTariff();

  const ran = rows.filter((r) => r.event === 'ran' && !r.dryRun);
  const refused = rows.filter((r) => r.event === 'refused');
  const planned = rows.filter((r) => r.event === 'planned');

  if (bool(flags.json)) {
    console.log(JSON.stringify({ days, ran, refused, planned, tariffFile }, null, 2));
    return 0;
  }

  console.log('');
  console.log(`${c.bold('report')}  ${c.dim(`last ${days} days`)}`);
  console.log('');

  if (ran.length === 0) {
    console.log(c.dim('  Nothing has been executed yet.'));
    if (planned.length) {
      console.log(c.dim(`  ${planned.length} dry run(s) recorded. Add --execute to run for real.`));
    }
    if (refused.length) {
      console.log(c.yellow(`  ${refused.length} refusal(s):`));
      for (const r of refused.slice(-5)) {
        console.log(c.dim(`    ${dayLabel(r.at)} ${hhmm(r.at)}  ${r.taskId}: ${r.note}`));
      }
    }
    console.log('');
    return 0;
  }

  const saved = ran.reduce((a, r) => a + (r.savedEur || 0), 0);
  const kwh = ran.reduce((a, r) => a + (r.kw || 0) * ((r.minutes || 0) / 60), 0);
  const failed = ran.filter((r) => r.exitCode !== 0);

  const byTask = new Map();
  for (const r of ran) {
    const cur = byTask.get(r.taskId) || { runs: 0, saved: 0, kwh: 0, failed: 0 };
    cur.runs += 1;
    cur.saved += r.savedEur || 0;
    cur.kwh += (r.kw || 0) * ((r.minutes || 0) / 60);
    if (r.exitCode !== 0) cur.failed += 1;
    byTask.set(r.taskId, cur);
  }

  const summary = [...byTask.entries()].map(([id, v]) => [
    id,
    String(v.runs),
    v.failed ? c.red(String(v.failed)) : c.dim('0'),
    `${v.kwh.toFixed(1)} kWh`,
    (v.saved >= 0 ? c.green : c.red)(formatEur(v.saved)),
  ]);

  console.log(
    table(summary, { headers: ['task', 'runs', 'failed', 'energy', 'saved'] })
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );

  console.log('');
  console.log(
    `  ${c.bold('Total')}  ${(saved >= 0 ? c.green : c.red)(formatEur(saved))} across ${ran.length} runs and ${kwh.toFixed(1)} kWh`,
  );
  if (failed.length) {
    console.log(c.yellow(`  ${failed.length} run(s) exited non-zero. The saving above counts them anyway: the power was still used.`));
  }

  // The honest denominator. Shifting load does nothing about the standing
  // charge or the fixed per-kWh components, so a monthly figure that ignores
  // them flatters the tool.
  const monthly = (tariff.basePriceEurPerMonth ?? 0) * (days / 30);
  console.log('');
  console.log(
    c.dim(
      `  For scale: the standing charge alone over this period is about ${formatEur(monthly)}, ` +
        'which no amount of load shifting changes.',
    ),
  );
  console.log(c.dim(`  Savings computed at run time against the tariff in ${tariffFile ?? 'the built-in default'}.`));
  console.log('');
  return 0;
}
