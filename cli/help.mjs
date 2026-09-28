import { c } from '../core/format.mjs';

export default function help() {
  const b = c.bold;
  const d = c.dim;

  console.log(`
${b('whenrun')} ${d('· run it when the power is cheap')}

Watches day-ahead electricity prices and the renewable share forecast, then puts
your jobs in the cheapest or greenest window that still meets their deadline.

${b('COMMANDS')}

  ${b('prices')}                 Today and tomorrow, with the cheapest windows
  ${b('plan')}                   When would a job run, and what would it cost
  ${b('run')}                    Wait for the window, then run one task
  ${b('daemon')}                 Keep running, execute tasks at their windows
  ${b('report')}                 What it has actually saved you
  ${b('tasks')}                  List the task file and what is enabled
  ${b('doctor')}                 Check config, connectivity and data freshness
  ${b('help')}                   This

${b('QUICK START')}

  ${d('# what does power cost today')}
  whenrun prices

  ${d('# when should a 45-minute, 2 kW job run before 07:00')}
  whenrun plan --duration=45m --kw=2 --by=07:00

  ${d('# same question, but greenest rather than cheapest')}
  whenrun plan --duration=2h --kw=11 --by=06:30 --objective=greenest

  ${d('# see what your configured tasks would do. Nothing runs')}
  whenrun plan

${b('RUNNING THINGS')}

  Tasks live in ${b('config/tasks.local.mjs')}. Copy the default to start:

    cp config/tasks.default.mjs config/tasks.local.mjs

  Nothing executes unless a task sets ${b('enabled: true')} ${d('and')} you pass
  ${b('--execute')}. Dry run is the default everywhere.

    whenrun run --task=backup             ${d('# dry run, prints what it would do')}
    whenrun run --task=backup --execute   ${d('# actually runs it at the window')}
    whenrun daemon --execute              ${d('# all enabled tasks, continuously')}

${b('GLOBAL FLAGS')}

  --zone=DE-LU          Bidding zone. Default DE-LU
  --source=energy-charts|awattar
  --offline             Use the cache only, make no network call
  --json                Machine-readable output
  --no-colour           Also honours NO_COLOR

${b('WHAT IT WILL NOT DO')}

  It never takes a command from the network. It runs only what you wrote in your
  own task file, and only when you have enabled it and asked for execution.

${d('Prices: Bundesnetzagentur | SMARD.de via Energy-Charts (Fraunhofer ISE), CC BY 4.0.')}
${d('MIT licensed. No account. Runs on your machine.')}
`);
  return 0;
}
