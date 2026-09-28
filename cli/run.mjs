/* Run one task: wait for its window, then execute it.
 *
 * Dry run is the default. `--execute` is required to actually run anything, and
 * even then a task with enabled:false is refused by core/exec.mjs. Two
 * independent locks on the same door, because this is the command that can cost
 * you something. */

import { getPrices, getRenewableShare, DEFAULT_SOURCE, DEFAULT_ZONE } from '../core/collect.mjs';
import { planTask } from '../core/schedule.mjs';
import { loadTasks } from '../core/tasks.mjs';
import { loadTariff } from '../core/tariff.mjs';
import { runTask, describe, planEnv, ExecRefused } from '../core/exec.mjs';
import { appendRun, markRan } from '../core/store.mjs';
import { formatEur } from '../core/money.mjs';
import { c, range, untilPhrase, hhmm } from '../core/format.mjs';
import { bool, num } from '../core/args.mjs';

export default async function run({ flags }) {
  const id = typeof flags.task === 'string' ? flags.task : null;
  if (!id) {
    console.error('Which task? Use --task=<id>. See `whenrun tasks`.');
    return 2;
  }

  const execute = bool(flags.execute);
  const waitForWindow = !bool(flags.now);
  const zone = flags.zone || DEFAULT_ZONE;
  const source = flags.source || DEFAULT_SOURCE;
  const now = Date.now();

  const { tasks } = await loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    console.error(`No task "${id}". See \`whenrun tasks\`.`);
    return 2;
  }

  const [{ series: prices, coverage }, ren, { tariff }] = await Promise.all([
    getPrices({ zone, source, offline: bool(flags.offline), now }),
    getRenewableShare({ offline: bool(flags.offline), now }).catch(() => ({ series: null })),
    loadTariff(),
  ]);

  const plan = planTask(task, { prices, renewable: ren.series, now, tariff, weight: num(flags.weight, 0.5) });

  console.log('');
  console.log(`${c.bold(task.label)} ${c.dim(`(${task.id})`)}`);

  if (!plan.feasible) {
    console.log(`  ${c.red('cannot schedule')}  ${plan.problem}`);
    appendRun({ taskId: task.id, event: 'refused', note: plan.problem });
    return 1;
  }

  if (!coverage.trustEmptyResult) {
    console.log(c.yellow(`  ! ${coverage.warnings.join('; ')}`));
    if (execute && coverage.status === 'stale' && !bool(flags.force)) {
      console.log(
        c.red('  refusing to execute against stale prices. Pass --force if you mean it.'),
      );
      appendRun({ taskId: task.id, event: 'refused', note: 'stale price data' });
      return 1;
    }
  }

  console.log(`  window   ${range(plan.window.start, plan.window.end, now)}  ${c.dim(untilPhrase(plan.window.start, now))}`);
  console.log(`  spot     ${plan.spotEurPerMwh.toFixed(1)} EUR/MWh`);
  console.log(`  cost     ${formatEur(plan.cost.eur)}  ${c.dim(`${plan.cost.kwh.toFixed(2)} kWh`)}`);
  if (plan.savings) {
    const s = plan.savings;
    const tint = s.savedEur >= 0 ? c.green : c.red;
    console.log(`  saving   ${tint(formatEur(s.savedEur))}  ${c.dim(`${s.savedPctOfBill.toFixed(1)}% of this job's bill`)}`);
  }
  console.log(`  command  ${c.dim(describe(task))}`);
  console.log('');

  if (!execute) {
    console.log(c.dim('  Dry run. Nothing executed. Add --execute to run it for real.'));
    console.log('');
    appendRun({
      taskId: task.id,
      event: 'planned',
      dryRun: true,
      plannedStart: plan.window.start,
      plannedEnd: plan.window.end,
      spotEurPerMwh: plan.spotEurPerMwh,
    });
    return 0;
  }

  /* core/exec.mjs refuses a disabled task too, and that check is the one that
     matters. This one exists so the refusal is printed before "running", not
     after it: a user reading the log should never see this tool claim to have
     started something it then declined to start. */
  if (!task.enabled) {
    console.log(
      `  ${c.red('refused')}  task is disabled. Set enabled: true in your task file to allow it to run.`,
    );
    console.log('');
    appendRun({ taskId: task.id, event: 'refused', note: 'task disabled' });
    return 1;
  }

  if (waitForWindow && plan.window.start > Date.now()) {
    const waitMs = plan.window.start - Date.now();
    console.log(
      `  ${c.cyan('waiting')} until ${hhmm(plan.window.start)} ${c.dim(`(${untilPhrase(plan.window.start)})`)}. Ctrl+C to cancel.`,
    );
    appendRun({
      taskId: task.id,
      event: 'waiting',
      plannedStart: plan.window.start,
      plannedEnd: plan.window.end,
    });
    await sleep(waitMs);
  }

  return execAndRecord(task, plan, { timeoutMinutes: num(flags.timeout, null) });
}

export async function execAndRecord(task, plan, { timeoutMinutes = null } = {}) {
  console.log(`  ${c.cyan('running')} ${c.dim(describe(task))}`);
  const started = Date.now();

  let result;
  try {
    result = await runTask(task, {
      dryRun: false,
      timeoutMinutes,
      env: planEnv(task, plan),
      onLine: (line) => console.log(c.dim(`    | ${line}`)),
    });
  } catch (err) {
    if (err instanceof ExecRefused) {
      console.log(`  ${c.red('refused')}  ${err.message}`);
      appendRun({ taskId: task.id, event: 'refused', note: err.message });
      return 1;
    }
    throw err;
  }

  const ok = result.exitCode === 0;
  const secs = ((result.endedAt - started) / 1000).toFixed(1);

  console.log(
    ok
      ? `  ${c.green('done')}  ${c.dim(`exit 0 in ${secs}s`)}`
      : `  ${c.red('failed')}  ${c.dim(`exit ${result.exitCode}${result.timedOut ? ', timed out' : ''} after ${secs}s`)}`,
  );
  if (result.error) console.log(c.red(`    ${result.error}`));
  console.log('');

  appendRun({
    taskId: task.id,
    event: 'ran',
    dryRun: false,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    plannedStart: plan.window.start,
    plannedEnd: plan.window.end,
    spotEurPerMwh: plan.spotEurPerMwh,
    baselineSpot: plan.baselineSpotEurPerMwh,
    kw: task.kw,
    minutes: task.durationMinutes,
    savedEur: plan.savings ? plan.savings.savedEur : 0,
    renewableSharePct: plan.renewableSharePct ?? null,
  });
  markRan(task.id);

  return ok ? 0 : 1;
}

/* A pending timer is what keeps the process alive while it waits, so this must
   not be unref'd. The clamp is belt and braces: the longest wait this tool can
   produce is under 48 hours, well inside the 32-bit limit. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 2 ** 31 - 1))));
}
