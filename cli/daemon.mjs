/* The loop.
 *
 * Ticks once a minute. On each tick it refreshes prices if the cache has aged
 * out, replans every enabled task, and starts any whose window has arrived.
 *
 * Three things it is careful about:
 *
 *   Idempotency. A task runs once per its own cycle, tracked in the state file,
 *   so a restart at 03:00 does not run the 02:00 backup a second time.
 *
 *   Replanning. Tomorrow's prices arrive mid-afternoon and can move a window
 *   that was already chosen. A plan is therefore recomputed every tick until
 *   the moment it fires, rather than decided once and trusted.
 *
 *   Refusing. Stale prices mean the tool cannot see, which is different from
 *   seeing a flat market. It declines to execute rather than guessing.
 */

import fs from 'node:fs';
import { getPrices, getRenewableShare } from '../core/collect.mjs';
import { planTask } from '../core/schedule.mjs';
import { loadTasks } from '../core/tasks.mjs';
import { loadTariff } from '../core/tariff.mjs';
import { runTask, describe, planEnv, ExecRefused } from '../core/exec.mjs';
import { appendRun, markRan, lastRunAt, cacheAgeMs } from '../core/store.mjs';
import { paths, ensureDataDir, pretty } from '../core/paths.mjs';
import { formatEur } from '../core/money.mjs';
import { c, hhmm, range, untilPhrase } from '../core/format.mjs';
import { loadLocation } from '../core/location.mjs';
import { bool, num } from '../core/args.mjs';

const TICK_MS = 60_000;

export default async function daemon({ flags }) {
  const execute = bool(flags.execute);
  const { zone, source, country } = await loadLocation(flags);
  const refreshMinutes = num(flags.refresh, 30);
  /* One pass and exit. For anyone who would rather drive this from cron or
     Task Scheduler than keep a process resident, which on Windows is often the
     more reliable of the two. */
  const once = bool(flags.once);
  const tickMs = num(flags.tick, null) ? num(flags.tick) * 1000 : TICK_MS;

  ensureDataDir();
  const release = acquireLock();
  if (!release) {
    console.error(`Another whenrun daemon holds ${pretty(paths.lock)}. Stop it first, or delete the file if it is stale.`);
    return 1;
  }

  let stopping = false;
  let wake = null;

  /* Waiting out a full tick before noticing a signal makes Ctrl+C feel broken
     at a 60 second tick. The sleep is therefore cancellable, and a second
     signal gives up immediately rather than waiting for a task to finish. */
  const stop = (sig) => {
    if (stopping) {
      log(c.red(`${sig} again, exiting now`));
      release();
      process.exit(130);
    }
    stopping = true;
    log(c.dim(`${sig} received, stopping`));
    if (wake) wake();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  /* Backstop: whatever happens, do not leave a lock behind that blocks the
     next start. */
  process.on('exit', () => release());

  const { tariff } = await loadTariff();

  log(c.bold('whenrun daemon'));
  log(
    `mode ${execute ? c.green('execute') : c.yellow('dry run')} · zone ${zone} · source ${source} · tick ${Math.round(tickMs / 1000)}s`,
  );
  if (!execute) log(c.dim('Dry run: windows are reported, nothing is started. Add --execute to run.'));

  try {
    while (!stopping) {
      await tick({ zone, source, country, refreshMinutes, execute, tariff, flags });
      if (once || stopping) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, tickMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    release();
  }

  log('stopped');
  return 0;
}

async function tick({ zone, source, country, refreshMinutes, execute, tariff, flags }) {
  const now = Date.now();

  const stale = cacheAgeMs('price', source, zone) > refreshMinutes * 60_000;
  const { series: prices, coverage } = await getPrices({
    zone,
    source,
    offline: !stale,
    now,
  });
  const ren = await getRenewableShare({ country, offline: !stale, now }).catch(() => ({ series: null }));

  if (!prices) {
    log(c.red(`no price data: ${coverage.warnings.join('; ')}`));
    return;
  }

  const { tasks } = await loadTasks();
  const enabled = tasks.filter((t) => t.enabled);
  if (enabled.length === 0) {
    logOnce('no-tasks', c.dim('no enabled tasks. Set enabled: true in your task file.'));
    return;
  }

  for (const task of enabled) {
    const plan = planTask(task, { prices, renewable: ren.series, now, tariff, weight: num(flags.weight, 0.5) });

    if (!plan.feasible) {
      logOnce(`infeasible:${task.id}:${dayKey(now)}`, c.yellow(`${task.id}: ${plan.problem}`));
      continue;
    }

    if (alreadyRanThisCycle(task, plan, now)) continue;

    const due = now >= plan.window.start;
    if (!due) {
      logOnce(
        `plan:${task.id}:${plan.window.start}`,
        `${c.bold(task.id)} scheduled ${range(plan.window.start, plan.window.end, now)} ` +
          c.dim(`${untilPhrase(plan.window.start, now)} · ${plan.spotEurPerMwh.toFixed(0)} EUR/MWh` +
            (plan.savings ? ` · saves ${formatEur(plan.savings.savedEur)}` : '')),
      );
      continue;
    }

    // The window has arrived, but a window that opened hours ago means the
    // daemon was asleep. Running a 45-minute job at the end of its window
    // spills past the deadline, so it is skipped rather than started late.
    if (now > plan.window.end) {
      logOnce(`missed:${task.id}:${dayKey(now)}`, c.yellow(`${task.id}: window closed at ${hhmm(plan.window.end)}, skipping`));
      appendRun({ taskId: task.id, event: 'missed', plannedStart: plan.window.start, plannedEnd: plan.window.end });
      markRan(task.id, now);
      continue;
    }

    if (!execute) {
      log(`${c.bold(task.id)} ${c.yellow('would start now')} ${c.dim(describe(task))}`);
      appendRun({
        taskId: task.id, event: 'planned', dryRun: true,
        plannedStart: plan.window.start, plannedEnd: plan.window.end,
        spotEurPerMwh: plan.spotEurPerMwh,
      });
      markRan(task.id, now);
      continue;
    }

    if (coverage.status === 'stale' && !bool(flags.force)) {
      logOnce(`stale:${dayKey(now)}`, c.red(`${task.id}: refusing to execute against stale prices`));
      appendRun({ taskId: task.id, event: 'refused', note: 'stale price data' });
      continue;
    }

    await execute1(task, plan);
  }
}

async function execute1(task, plan) {
  log(`${c.bold(task.id)} ${c.cyan('starting')} ${c.dim(describe(task))}`);
  const started = Date.now();

  let result;
  try {
    result = await runTask(task, {
      dryRun: false,
      onLine: (line) => log(c.dim(`  | ${line}`)),
      env: planEnv(task, plan),
    });
  } catch (err) {
    if (err instanceof ExecRefused) {
      log(c.red(`${task.id}: ${err.message}`));
      appendRun({ taskId: task.id, event: 'refused', note: err.message });
      return;
    }
    throw err;
  }

  const secs = ((result.endedAt - started) / 1000).toFixed(1);
  log(
    result.exitCode === 0
      ? `${c.bold(task.id)} ${c.green('done')} ${c.dim(`in ${secs}s`)}`
      : `${c.bold(task.id)} ${c.red('failed')} ${c.dim(`exit ${result.exitCode} after ${secs}s`)}`,
  );

  appendRun({
    taskId: task.id, event: 'ran', dryRun: false,
    exitCode: result.exitCode, timedOut: Boolean(result.timedOut),
    plannedStart: plan.window.start, plannedEnd: plan.window.end,
    spotEurPerMwh: plan.spotEurPerMwh, baselineSpot: plan.baselineSpotEurPerMwh,
    kw: task.kw, minutes: task.durationMinutes,
    savedEur: plan.savings ? plan.savings.savedEur : 0,
    renewableSharePct: plan.renewableSharePct ?? null,
  });
  markRan(task.id);
}

/* A task's cycle is the stretch its deadline defines. Comparing against the
   deadline rather than the calendar day is what makes an overnight job that
   finishes at 05:00 count as "already ran" for the cycle ending that morning.

   Without a deadline, taskBounds sets notAfter to now + 24h, so the old
   `notAfter - 24h` was exactly `now` and `last >= now` was false forever. The
   guard never fired and the task relaunched on every single tick: a 45-minute
   backup started dozens of times in overlapping processes, each one booking
   its full saving into the ledger. A missing deadline now means one run per
   local day, which is a policy rather than an accident. */
function alreadyRanThisCycle(task, plan, now) {
  const last = lastRunAt(task.id);
  if (!last) return false;
  const cycleStart = task.deadline
    ? plan.notAfter - 24 * 3600_000
    : startOfLocalDay(now);
  return last >= cycleStart;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

const seen = new Set();
function logOnce(key, message) {
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 500) seen.clear(); // a daemon runs for months
  log(message);
}

function log(message) {
  console.log(`${c.dim(hhmm(Date.now()))} ${message}`);
}

/** Coarse single-instance lock. Stale locks from a killed process are reclaimed. */
function acquireLock() {
  try {
    const existing = fs.readFileSync(paths.lock, 'utf8');
    const pid = Number(existing.trim());
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid) && pid !== process.pid) return null;
  } catch {
    // no lock file, or unreadable: proceed
  }
  fs.writeFileSync(paths.lock, String(process.pid), 'utf8');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (fs.readFileSync(paths.lock, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(paths.lock);
      }
    } catch {
      // nothing useful to do while shutting down
    }
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function dayKey(ms) {
  return new Date(ms).toDateString();
}
