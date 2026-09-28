#!/usr/bin/env node
/* Router. Every command is its own file under cli/, imported lazily so a
 * command with a heavy import does not slow down `whenrun --help`. */

import { parseArgs } from '../core/args.mjs';

const COMMANDS = {
  prices: () => import('../cli/prices.mjs'),
  plan: () => import('../cli/plan.mjs'),
  run: () => import('../cli/run.mjs'),
  daemon: () => import('../cli/daemon.mjs'),
  report: () => import('../cli/report.mjs'),
  tasks: () => import('../cli/tasks.mjs'),
  doctor: () => import('../cli/doctor.mjs'),
  where: () => import('../cli/where.mjs'),
  help: () => import('../cli/help.mjs'),
};

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const name = args._[0] ?? (args.flags.help || args.flags.h ? 'help' : 'help');

const loader = COMMANDS[name];
if (!loader) {
  console.error(`whenrun: unknown command "${name}"`);
  console.error(`Try one of: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(2);
}

try {
  const mod = await loader();
  const code = await mod.default({ ...args, _: args._.slice(1) });
  process.exit(typeof code === 'number' ? code : 0);
} catch (err) {
  console.error(`whenrun ${name}: ${err.message}`);
  if (process.env.WHENRUN_DEBUG) console.error(err.stack);
  process.exit(1);
}
