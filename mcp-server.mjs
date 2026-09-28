#!/usr/bin/env node
/* MCP over stdio. Zero dependencies, so the protocol is implemented directly:
 * newline-delimited JSON-RPC 2.0 on stdin and stdout.
 *
 * Read-only by design. There is no tool here that runs anything. An agent can
 * ask when power is cheap and what a job would cost, and that is the whole
 * surface. Executing a command is a decision a person makes at a terminal with
 * an explicit flag, not something a model can reach through a tool call.
 *
 * Every result carries a coverage block. Without it an agent reading a stale
 * cache cannot tell "prices are flat" from "I have not been able to look since
 * Tuesday", and those lead to opposite advice.
 */

import { getPrices, getRenewableShare, coverageFor, DEFAULT_ZONE, DEFAULT_SOURCE } from './core/collect.mjs';
import { bestWindow, slice, stats, resolutionMinutes } from './core/series.mjs';
import { planTask } from './core/schedule.mjs';
import { loadTasks } from './core/tasks.mjs';
import { loadTariff } from './core/tariff.mjs';
import { deliveredCentPerKwh, jobCost } from './core/money.mjs';
import { readLedger } from './core/store.mjs';

const SERVER = { name: 'whenrun', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'get_prices',
    description:
      'Day-ahead electricity prices for a bidding zone, with statistics and a coverage block. ' +
      'Use this to answer "what does power cost today" or "when is it cheap".',
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', description: 'Bidding zone, default DE-LU' },
        source: { type: 'string', enum: ['energy-charts', 'awattar'] },
      },
    },
  },
  {
    name: 'cheapest_window',
    description:
      'The cheapest contiguous window of a given length, optionally before a deadline. ' +
      'Returns the window, the spot price, and what it would cost at a given load.',
    inputSchema: {
      type: 'object',
      properties: {
        durationMinutes: { type: 'number', description: 'How long the job runs' },
        kw: { type: 'number', description: 'Average load in kW, for the cost estimate' },
        byIso: { type: 'string', description: 'ISO timestamp the job must finish by' },
        zone: { type: 'string' },
      },
      required: ['durationMinutes'],
    },
  },
  {
    name: 'greenest_window',
    description:
      'The window with the highest forecast renewable share. Note the share is of domestic ' +
      'load and can legitimately exceed 100% when renewables are exported.',
    inputSchema: {
      type: 'object',
      properties: {
        durationMinutes: { type: 'number' },
        byIso: { type: 'string' },
      },
      required: ['durationMinutes'],
    },
  },
  {
    name: 'list_tasks',
    description: 'The configured tasks, whether each is enabled, and its scheduling constraints.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'plan_task',
    description:
      'What a configured task would do: its window, spot price, cost and saving against ' +
      'starting now. This plans only. It never runs anything.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'savings_report',
    description: 'What has actually been run and what it saved, from the append-only ledger.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Lookback window, default 30' } },
    },
  },
];

async function callTool(name, args = {}) {
  const now = Date.now();
  const zone = args.zone || DEFAULT_ZONE;
  const source = args.source || DEFAULT_SOURCE;

  if (name === 'get_prices') {
    const { series, coverage, from } = await getPrices({ zone, source, now });
    if (!series) return { coverage, error: 'no price data' };
    const future = slice(series.slots, now, Infinity);
    const st = stats(future.length ? future : series.slots);
    return {
      zone,
      source,
      from,
      resolutionMinutes: resolutionMinutes(series.slots),
      unit: series.unit,
      horizonHours: Number(((st.to - now) / 3600_000).toFixed(1)),
      statistics: {
        min: round(st.min), max: round(st.max), mean: round(st.mean), median: round(st.median),
      },
      slots: (future.length ? future : series.slots).map((s) => ({
        startIso: new Date(s.start).toISOString(),
        eurPerMwh: round(s.value),
      })),
      coverage,
      attribution: 'CC BY 4.0 Bundesnetzagentur | SMARD.de via Energy-Charts (Fraunhofer ISE)',
    };
  }

  if (name === 'cheapest_window' || name === 'greenest_window') {
    const durationMinutes = Number(args.durationMinutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return { error: 'durationMinutes must be a positive number' };
    }
    const notAfter = args.byIso ? Date.parse(args.byIso) : now + 48 * 3600_000;
    if (Number.isNaN(notAfter)) return { error: `byIso is not a valid timestamp: ${args.byIso}` };

    const { series: prices, coverage } = await getPrices({ zone, source, now });
    if (!prices) return { coverage, error: 'no price data' };

    const green = name === 'greenest_window';
    const { series: ren } = green
      ? await getRenewableShare({ now })
      : { series: null };

    if (green && !ren) {
      return { coverage, error: 'renewable share forecast unavailable' };
    }

    const target = green ? ren.slots : prices.slots;
    const window = bestWindow(target, {
      durationMinutes,
      notBefore: now,
      notAfter,
      direction: green ? 'max' : 'min',
    });
    if (!window) {
      return {
        coverage,
        found: false,
        reason: 'no unbroken window of that length exists before the deadline',
      };
    }

    const spotWindow = green
      ? bestWindow(prices.slots, {
          durationMinutes,
          notBefore: window.start,
          notAfter: window.end,
          direction: 'min',
        })
      : window;

    const { tariff } = await loadTariff();
    const kw = Number(args.kw) || 0;
    const spot = spotWindow ? spotWindow.mean : null;

    return {
      found: true,
      startIso: new Date(window.start).toISOString(),
      endIso: new Date(window.end).toISOString(),
      durationMinutes,
      ...(green
        ? { renewableSharePct: round(window.mean), spotEurPerMwh: spot === null ? null : round(spot) }
        : { spotEurPerMwh: round(window.mean) }),
      deliveredCentPerKwh: spot === null ? null : round(deliveredCentPerKwh(spot, tariff)),
      estimatedCostEur:
        kw && spot !== null
          ? round(jobCost({ spotEurPerMwh: spot, kw, minutes: durationMinutes }, tariff).eur, 3)
          : null,
      coverage,
    };
  }

  if (name === 'list_tasks') {
    const { file, tasks } = await loadTasks();
    return {
      file,
      tasks: tasks.map((t) => ({
        id: t.id, label: t.label, enabled: t.enabled,
        durationMinutes: t.durationMinutes, kw: t.kw,
        earliest: t.earliest, deadline: t.deadline,
        objective: t.objective, interruptible: t.interruptible,
      })),
      note: 'This server cannot run a task. Execution requires a person at a terminal with --execute.',
    };
  }

  if (name === 'plan_task') {
    const { tasks } = await loadTasks();
    const task = tasks.find((t) => t.id === args.taskId);
    if (!task) return { error: `no task "${args.taskId}"` };

    const [{ series: prices, coverage }, ren, { tariff }] = await Promise.all([
      getPrices({ zone, source, now }),
      getRenewableShare({ now }).catch(() => ({ series: null })),
      loadTariff(),
    ]);
    const plan = planTask(task, { prices, renewable: ren.series, now, tariff });

    return {
      ...plan,
      startIso: plan.window ? new Date(plan.window.start).toISOString() : null,
      endIso: plan.window ? new Date(plan.window.end).toISOString() : null,
      coverage,
    };
  }

  if (name === 'savings_report') {
    const days = Number(args.days) || 30;
    const rows = readLedger({ sinceMs: now - days * 86400_000 });
    const ran = rows.filter((r) => r.event === 'ran' && !r.dryRun);
    return {
      days,
      runs: ran.length,
      failedRuns: ran.filter((r) => r.exitCode !== 0).length,
      savedEur: round(ran.reduce((a, r) => a + (r.savedEur || 0), 0), 2),
      kwh: round(ran.reduce((a, r) => a + (r.kw || 0) * ((r.minutes || 0) / 60), 0), 2),
      note: 'Savings were computed at run time against the tariff then configured, not recomputed.',
    };
  }

  return { error: `unknown tool "${name}"` };
}

const round = (n, dp = 2) => (typeof n === 'number' ? Number(n.toFixed(dp)) : n);

/* ─── JSON-RPC plumbing ─────────────────────────────────────────────────── */

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions:
        'whenrun answers when electricity is cheapest or greenest, and what a job would cost ' +
        'in a given window. It is read-only: it cannot start anything.',
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'ping') return result(id, {});

  if (method === 'tools/list') return result(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const value = await callTool(name, params?.arguments ?? {});
      return result(id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        isError: Boolean(value && value.error),
      });
    } catch (err) {
      return result(id, {
        content: [{ type: 'text', text: `whenrun ${name} failed: ${err.message}` }],
        isError: true,
      });
    }
  }

  if (id !== undefined) failure(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
let stdinEnded = false;
let draining = false;
const queue = [];

/* Requests are handled one at a time in arrival order, and the server exits
   only when stdin has closed and the queue is empty. Tracking this per message
   instead would exit after the first response while the rest of a piped batch
   is still buffered, which is how a client that pipes its requests rather than
   holding the pipe open loses every answer but the first. */
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const msg = queue.shift();
      try {
        await handle(msg);
      } catch (err) {
        if (msg?.id !== undefined) failure(msg.id, -32603, err.message);
      }
    }
  } finally {
    draining = false;
    if (stdinEnded && queue.length === 0) process.exit(0);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      queue.push(JSON.parse(line));
    } catch {
      failure(null, -32700, 'Parse error');
    }
  }
  drain();
});

process.stdin.on('end', () => {
  stdinEnded = true;
  if (!draining && queue.length === 0) process.exit(0);
  drain();
});
