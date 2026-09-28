/* Loading and validating the task list.
 *
 * Resolution order, same shape as the rest of the house:
 *   $WHENRUN_TASKS  →  config/tasks.local.mjs  →  config/tasks.default.mjs
 *
 * Validation is strict and refuses rather than repairs. A task with a missing
 * duration is not defaulted to an hour, because this module is the last thing
 * standing between a typo and a command running unattended at 3am. */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR, ROOT } from './paths.mjs';

const OBJECTIVES = new Set(['cheapest', 'greenest', 'balanced']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function loadTasks() {
  const candidates = [
    process.env.WHENRUN_TASKS ? path.resolve(process.env.WHENRUN_TASKS) : null,
    path.join(CONFIG_DIR, 'tasks.local.mjs'),
    path.join(CONFIG_DIR, 'tasks.default.mjs'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    /* ESM caches module records per URL for the life of the process, so the
       daemon calling this every tick read the disk exactly once, at the first
       tick. Enabling a task or fixing a deadline had no effect until a
       restart, silently. The mtime in the query string makes an edited file a
       different URL. */
    const stamp = fs.statSync(file).mtimeMs;
    const mod = await import(`${pathToFileURL(file).href}?v=${stamp}`);
    const list = mod.default;
    if (!Array.isArray(list)) {
      throw new Error(`${file}: default export must be an array of tasks`);
    }
    return { file, tasks: list.map((t, i) => validateTask(t, i, file)) };
  }

  throw new Error('No task list found. Expected config/tasks.default.mjs to exist.');
}

export function validateTask(task, index, file) {
  const where = `${file ? `${file} ` : ''}task[${index}]${task?.id ? ` (${task.id})` : ''}`;
  const fail = (msg) => {
    throw new Error(`${where}: ${msg}`);
  };

  if (!task || typeof task !== 'object') fail('is not an object');
  if (!task.id || !/^[a-z0-9][a-z0-9-]*$/i.test(task.id)) {
    fail('needs an id matching [a-z0-9][a-z0-9-]*');
  }

  const hasString = typeof task.command === 'string' && task.command.trim();
  const hasStruct =
    task.command && typeof task.command === 'object' && typeof task.command.cmd === 'string';
  if (!hasString && !hasStruct) {
    fail('needs command: a string, or { cmd, args } to skip the shell');
  }
  if (hasStruct && task.command.args && !Array.isArray(task.command.args)) {
    fail('command.args must be an array');
  }

  if (!Number.isFinite(task.durationMinutes) || task.durationMinutes <= 0) {
    fail('needs a positive durationMinutes');
  }
  if (task.durationMinutes > 24 * 60) {
    fail('durationMinutes longer than a day cannot be scheduled against a day-ahead horizon');
  }
  if (task.kw !== undefined && (!Number.isFinite(task.kw) || task.kw < 0)) {
    fail('kw must be a non-negative number');
  }
  if (task.deadline !== undefined && !TIME_RE.test(task.deadline)) {
    fail('deadline must be "HH:MM" in 24-hour local time');
  }
  if (task.earliest !== undefined && !TIME_RE.test(task.earliest)) {
    fail('earliest must be "HH:MM" in 24-hour local time');
  }
  if (task.objective !== undefined && !OBJECTIVES.has(task.objective)) {
    fail(`objective must be one of: ${[...OBJECTIVES].join(', ')}`);
  }
  if (task.cwd !== undefined && typeof task.cwd !== 'string') fail('cwd must be a string');

  return {
    id: task.id,
    label: task.label || task.id,
    command: task.command,
    cwd: path.resolve(ROOT, task.cwd ?? '.'),
    durationMinutes: task.durationMinutes,
    kw: task.kw ?? 0,
    earliest: task.earliest ?? null,
    deadline: task.deadline ?? null,
    interruptible: Boolean(task.interruptible),
    objective: task.objective ?? 'cheapest',
    enabled: task.enabled === true, // opt in, never infer
  };
}

/**
 * Next occurrence of a local "HH:MM" at or after `from`.
 * Local time on purpose: people describe deadlines in the clock on their wall,
 * and that clock moves twice a year while UTC does not.
 */
export function nextLocalTime(hhmm, from = Date.now()) {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new Error(`Not a HH:MM time: ${hhmm}`);
  const [, hh, mm] = m;

  const d = new Date(from);
  const candidate = new Date(
    d.getFullYear(), d.getMonth(), d.getDate(), Number(hh), Number(mm), 0, 0,
  );
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/**
 * Most recent occurrence of a local "HH:MM" at or before `at`.
 * Counterpart to nextLocalTime, and the piece that makes an overnight window
 * resolve backwards from its deadline rather than forwards from now.
 */
export function previousLocalTime(hhmm, at) {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new Error(`Not a HH:MM time: ${hhmm}`);
  const d = new Date(at);
  const candidate = new Date(
    d.getFullYear(), d.getMonth(), d.getDate(), Number(m[1]), Number(m[2]), 0, 0,
  );
  if (candidate.getTime() > at) candidate.setDate(candidate.getDate() - 1);
  return candidate.getTime();
}

/**
 * The window a task is allowed to occupy, as epoch ms.
 *
 * Resolved from the deadline backwards, not from now forwards. The deadline is
 * the next time that clock reading comes round; the window opens at the most
 * recent `earliest` at or before it.
 *
 * That ordering is what makes the overnight case right. A task set to
 * 22:00 to 07:00, asked at 03:00, is already inside a window that opened last
 * night: its deadline is 07:00 this morning and it should run now. Resolving
 * `earliest` forwards instead gives tonight's 22:00, which pushes a backup that
 * could have run in the next four hours nineteen hours into the future.
 */
export function taskBounds(task, now = Date.now()) {
  const notAfter = task.deadline ? nextLocalTime(task.deadline, now) : now + 24 * 3600_000;
  const opensAt = task.earliest ? previousLocalTime(task.earliest, notAfter) : -Infinity;
  const notBefore = Math.max(now, opensAt);
  return { notBefore, notAfter };
}
