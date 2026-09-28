/* The shipped task list.
 *
 * Every task here is disabled and every command is harmless, on purpose. A
 * fresh clone must be able to run `whenrun plan` and see something real without
 * being one typo away from executing anything.
 *
 * To make it yours:
 *   cp config/tasks.default.mjs config/tasks.local.mjs
 * tasks.local.mjs is gitignored and wins over this file, so you can pull
 * upstream forever without a conflict in the one file you edited.
 *
 * FIELDS
 *   id                unique, short, used in the ledger and on the CLI
 *   label             what a human calls it
 *   command           a string run through your shell, or { cmd, args } for no shell
 *   cwd               working directory, relative to the repo root
 *   durationMinutes   how long it takes. Be generous: the window is reserved
 *   kw                average power draw while running. Used for cost only
 *   earliest          "HH:MM" local, optional. Not before this
 *   deadline          "HH:MM" local. Must be finished by this
 *   interruptible     true if it can run in scattered slots rather than one block
 *   objective         "cheapest" | "greenest" | "balanced"
 *   enabled           false means plan it, never run it
 */

export default [
  {
    id: 'demo-backup',
    label: 'Demo: nightly backup',
    command: 'node -e "console.log(\'whenrun demo task: pretend backup\')"',
    cwd: '.',
    durationMinutes: 45,
    kw: 0.3,
    earliest: '20:00',
    deadline: '07:00',
    interruptible: false,
    objective: 'cheapest',
    enabled: false,
  },
  {
    id: 'demo-ev',
    label: 'Demo: EV charge, 20 kWh',
    command: 'node -e "console.log(\'whenrun demo task: pretend charge\')"',
    cwd: '.',
    // 11 kW for 110 minutes is roughly 20 kWh. Keep these two consistent: the
    // cost line is computed from kw and duration, not from the label.
    durationMinutes: 110,
    kw: 11,
    earliest: '18:00',
    deadline: '06:30',
    interruptible: true,
    objective: 'balanced',
    enabled: false,
  },
];
