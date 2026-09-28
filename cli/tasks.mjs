import { loadTasks } from '../core/tasks.mjs';
import { lastRunAt } from '../core/store.mjs';
import { describe } from '../core/exec.mjs';
import { c, table, dayLabel, hhmm } from '../core/format.mjs';
import { bool } from '../core/args.mjs';

export default async function tasks({ flags }) {
  const { file, tasks: list } = await loadTasks();

  if (bool(flags.json)) {
    console.log(JSON.stringify({ file, tasks: list }, null, 2));
    return 0;
  }

  console.log('');
  console.log(`${c.bold('tasks')}  ${c.dim(file)}`);
  console.log('');

  if (list.length === 0) {
    console.log(c.dim('  No tasks defined.'));
    console.log('');
    return 0;
  }

  const rows = list.map((t) => {
    const last = lastRunAt(t.id);
    return [
      t.enabled ? c.green('on') : c.dim('off'),
      t.id,
      `${t.durationMinutes}m`,
      t.kw ? `${t.kw} kW` : c.dim('-'),
      t.earliest || t.deadline
        ? `${t.earliest ?? '..'} to ${t.deadline ?? '..'}`
        : c.dim('anytime'),
      t.objective,
      t.interruptible ? 'split' : 'block',
      last ? c.dim(`${dayLabel(last)} ${hhmm(last)}`) : c.dim('never'),
    ];
  });

  console.log(
    table(rows, {
      headers: ['', 'id', 'len', 'load', 'window', 'objective', 'shape', 'last run'],
    })
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );

  console.log('');
  for (const t of list) {
    console.log(`  ${c.dim(t.id.padEnd(14))} ${c.dim(describe(t))}`);
  }

  const enabled = list.filter((t) => t.enabled).length;
  console.log('');
  console.log(
    c.dim(
      `  ${enabled} of ${list.length} enabled. A disabled task is planned but never executed.`,
    ),
  );
  if (file.endsWith('tasks.default.mjs')) {
    console.log(c.dim('  These are the shipped demos. cp config/tasks.default.mjs config/tasks.local.mjs'));
  }
  console.log('');
  return 0;
}
