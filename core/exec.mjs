/* Running the command.
 *
 * This is the only module in the tool that executes anything, which makes it
 * the only place a mistake here can cost you something real. The rules it
 * enforces:
 *
 *   1. The command comes from the task list on disk. Never from a price feed,
 *      never from an argument, never from the network. There is no code path
 *      that constructs a command out of fetched data.
 *   2. Dry run is the default everywhere upstream of this. Actually executing
 *      takes an explicit flag, and a disabled task cannot be executed at all.
 *   3. { cmd, args } form skips the shell entirely. The string form is run
 *      through the shell because that is what the user wrote in their own
 *      file, but nothing is interpolated into it.
 *   4. A run is bounded. A task that hangs does not hold the window forever.
 */

import { spawn } from 'node:child_process';

export class ExecRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecRefused';
  }
}

/**
 * @param {object} task
 * @param {{ dryRun?: boolean, timeoutMinutes?: number, onLine?: (line: string) => void }} opts
 */
export function runTask(task, { dryRun = true, timeoutMinutes = null, onLine = null, env = {} } = {}) {
  if (!task.enabled) {
    return Promise.reject(
      new ExecRefused(
        `task "${task.id}" is disabled. Set enabled: true in your task file to allow it to run.`,
      ),
    );
  }

  if (dryRun) {
    return Promise.resolve({
      dryRun: true,
      exitCode: 0,
      startedAt: Date.now(),
      endedAt: Date.now(),
      describe: describe(task),
    });
  }

  const isStruct = typeof task.command === 'object';
  const cap = timeoutMinutes ?? Math.max(task.durationMinutes * 2, 10);

  const handle = {};
  const promise = new Promise((resolve) => {
    const startedAt = Date.now();

    /* The task is told what it was scheduled into. A script that wants to do
       its own thing with the slot plan can read WHENRUN_SLOTS; nothing is
       interpolated into the command string itself, so a price cannot become
       part of a command line. */
    const childEnv = { ...process.env, ...env };

    const child = isStruct
      ? spawn(task.command.cmd, task.command.args ?? [], {
          cwd: task.cwd,
          shell: false,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(task.command, {
          cwd: task.cwd,
          shell: true,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    let killedForTime = false;
    const timer = setTimeout(() => {
      killedForTime = true;
      child.kill('SIGTERM');
      // A process that ignores SIGTERM still has to go, or the next window
      // starts with the previous one still running.
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
    }, cap * 60_000);

    const emit = (buf) => {
      if (!onLine) return;
      for (const line of buf.toString().split('\n')) {
        if (line.trim()) onLine(line);
      }
    };
    /* Held so a daemon shutting down can stop what it started. Without it a
       forced exit leaves the command running and removes the lock, so the next
       daemon starts alongside an orphan. */
    handle.child = child;

    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        dryRun: false,
        exitCode: -1,
        /* Distinguish "the command failed" from "no process ever existed".
           The second consumed no power, so it must not be credited with a
           saving. On Windows this is also the common case: shell:false cannot
           launch a .cmd shim, which is what npm, npx, pnpm and yarn are. */
        neverStarted: true,
        error:
          err.code === 'ENOENT' && isStruct
            ? `${err.message}. The { cmd, args } form skips the shell, so on Windows it cannot ` +
              `launch a .cmd shim such as npm, npx, pnpm or yarn. Use the string form, or cmd: 'npm.cmd'.`
            : err.message,
        startedAt,
        endedAt: Date.now(),
        describe: describe(task),
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        dryRun: false,
        exitCode: code ?? -1,
        signal: signal ?? null,
        timedOut: killedForTime,
        startedAt,
        endedAt: Date.now(),
        describe: describe(task),
      });
    });
  });

  promise.child = handle;
  return promise;
}

/** Stop a run started by runTask, if it is still going. */
export function killRun(promise) {
  const child = promise?.child?.child;
  if (!child || child.killed) return false;
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000).unref?.();
  return true;
}

/**
 * What a task is told about the window it was scheduled into.
 *
 * Lives here rather than in the callers so `run` and `daemon` cannot drift:
 * a task must see the same environment however it was started.
 */
export function planEnv(task, plan) {
  const pct = plan?.renewableSharePct;
  return {
    WHENRUN_TASK: task.id,
    WHENRUN_WINDOW_START: plan?.window ? new Date(plan.window.start).toISOString() : '',
    WHENRUN_WINDOW_END: plan?.window ? new Date(plan.window.end).toISOString() : '',
    WHENRUN_SPOT_EUR_MWH:
      typeof plan?.spotEurPerMwh === 'number' ? plan.spotEurPerMwh.toFixed(2) : '',
    WHENRUN_RENEWABLE_PCT: typeof pct === 'number' ? pct.toFixed(0) : '',
    /* Interruptible tasks get their slot plan here. This tool starts a command,
       it cannot pause one, so the split is advisory: a script that wants to
       honour it has to do that itself. */
    WHENRUN_SLOTS: plan?.window?.scattered ? JSON.stringify(plan.window.scattered) : '',
  };
}

export function describe(task) {
  return typeof task.command === 'object'
    ? `${task.command.cmd} ${(task.command.args ?? []).join(' ')}`.trim()
    : task.command;
}
