import { getPrices, getRenewableShare } from '../core/collect.mjs';
import { planTask } from '../core/schedule.mjs';
import { loadTasks, validateTask } from '../core/tasks.mjs';
import { loadTariff } from '../core/tariff.mjs';
import { formatEur } from '../core/money.mjs';
import { c, range, untilPhrase, coverageLine, table } from '../core/format.mjs';
import { loadLocation } from '../core/location.mjs';
import { bool, minutes, num } from '../core/args.mjs';

export default async function plan({ flags }) {
  const { zone, source, country } = await loadLocation(flags);
  const offline = bool(flags.offline);
  const now = Date.now();

  const [{ series: prices, coverage }, ren, { tariff, file: tariffFile, isDefault }] =
    await Promise.all([
      getPrices({ zone, source, offline, now }),
      getRenewableShare({ country, offline, now }).catch(() => ({ series: null })),
      loadTariff(),
    ]);

  if (!prices) {
    console.error(`No price data for ${zone}.`);
    for (const w of coverage.warnings) console.error(`  ${w}`);
    return 1;
  }

  // Ad-hoc mode: describe a job on the command line instead of in a file.
  const adHoc = flags.duration !== undefined;
  let tasks;
  let sourceLabel;

  if (adHoc) {
    const dur = minutes(flags.duration);
    if (!dur) {
      console.error('--duration must be a length like 45m, 2h or 90');
      return 2;
    }
    tasks = [
      validateTask(
        {
          id: 'adhoc',
          label: flags.label || 'ad-hoc job',
          command: 'true',
          durationMinutes: dur,
          kw: num(flags.kw, 0),
          earliest: typeof flags.after === 'string' ? flags.after : undefined,
          deadline: typeof flags.by === 'string' ? flags.by : undefined,
          interruptible: bool(flags.interruptible),
          objective: typeof flags.objective === 'string' ? flags.objective : 'cheapest',
          enabled: false,
        },
        0,
        'command line',
      ),
    ];
    sourceLabel = 'command line';
  } else {
    const loaded = await loadTasks();
    tasks = loaded.tasks;
    sourceLabel = loaded.file;
    if (flags.task) tasks = tasks.filter((t) => t.id === flags.task);
    if (tasks.length === 0) {
      console.error(`No task matching --task=${flags.task}`);
      return 2;
    }
  }

  const plans = tasks.map((t) =>
    planTask(t, { prices, renewable: ren.series, now, tariff, weight: num(flags.weight, 0.5) }),
  );

  if (bool(flags.json)) {
    console.log(JSON.stringify({ zone, coverage, plans }, null, 2));
    return 0;
  }

  console.log('');
  console.log(
    `${c.bold('plan')} ${c.dim(`· ${zone} · ${sourceLabel}`)}  ${coverageLine(coverage)}`,
  );
  if (isDefault) {
    console.log(
      c.yellow(
        '  ! using the default tariff. Copy config/tariff.default.mjs to tariff.local.mjs for real numbers.',
      ),
    );
  }
  for (const w of coverage.warnings) console.log(c.yellow(`  ! ${w}`));
  console.log('');

  for (const p of plans) {
    renderPlan(p, now);
    console.log('');
  }

  const totalSaving = plans
    .filter((p) => p.feasible && p.savings)
    .reduce((a, p) => a + p.savings.savedEur, 0);
  if (plans.length > 1 && Math.abs(totalSaving) > 0.001) {
    console.log(
      `  ${c.bold('Total')}  ${tone(totalSaving)(formatEur(totalSaving))} ${c.dim('against starting everything now')}`,
    );
    console.log('');
  }

  console.log(c.dim(`  Tariff: ${tariffFile ?? 'built-in default'}`));
  console.log(c.dim('  Nothing has been run. Use `whenrun run --task=<id> --execute`.'));
  console.log('');
  return 0;
}

const tone = (n) => (n > 0 ? c.green : n < 0 ? c.red : c.dim);

function renderPlan(p, now) {
  const head = `  ${c.bold(p.label)} ${c.dim(`(${p.taskId})`)}`;

  if (!p.feasible) {
    console.log(head);
    console.log(`    ${c.red('cannot schedule')}  ${p.problem}`);
    return;
  }

  const badge = p.enabled ? c.green('enabled') : c.dim('disabled');
  console.log(`${head}  ${badge}  ${c.dim(p.objective)}`);

  const rows = [];
  rows.push([
    'window',
    p.window.scattered
      ? `${p.window.scattered.length} slots, ${range(p.window.start, p.window.end, now)}`
      : range(p.window.start, p.window.end, now),
    c.dim(untilPhrase(p.window.start, now)),
  ]);
  rows.push([
    'spot',
    `${p.spotEurPerMwh.toFixed(1)} EUR/MWh`,
    p.baselineSpotEurPerMwh !== null
      ? c.dim(`vs ${p.baselineSpotEurPerMwh.toFixed(1)} starting now`)
      : '',
  ]);
  if (p.renewableSharePct !== null && p.renewableSharePct !== undefined) {
    rows.push(['renewable', `${p.renewableSharePct.toFixed(0)}%`, '']);
  }
  rows.push([
    'energy',
    `${p.cost.kwh.toFixed(2)} kWh at ${p.cost.centPerKwh.toFixed(1)} ct/kWh`,
    c.dim(formatEur(p.cost.eur)),
  ]);

  if (p.savings) {
    const s = p.savings;
    rows.push([
      'saving',
      `${tone(s.savedEur)(formatEur(s.savedEur))} ${c.dim(`(${s.savedPctOfBill.toFixed(1)}% of this job's bill)`)}`,
      c.dim(`${s.savedPctOfSpot.toFixed(0)}% of its energy component`),
    ]);
  }

  console.log(
    table(rows)
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
}
