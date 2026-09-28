# whenrun

Watches day-ahead electricity prices, schedules jobs into the cheapest or greenest window.
Node 22+, **zero runtime dependencies**, no build step.

## The rules that matter

- **Nothing executes without two independent opt-ins.** A task needs `enabled: true` in the
  user's own file, and the command needs `--execute`. Never collapse those into one.
- **Commands come only from the task file on disk.** There must be no code path that builds
  a command out of fetched data, an argument, or anything from the network. Prices reach a
  task through the environment (`planEnv` in `core/exec.mjs`), never through a command line.
- **Refuse rather than guess.** Stale prices, an impossible deadline, a gap in the published
  series: each returns a reason, not a best effort. `bestWindow` returns `null` rather than
  spanning a slot that was never published.
- **Report the honest number.** Savings are against the delivered bill, not the spot price.
  Both are shown, and the flattering one is always labelled as the energy component. See the
  comment block at the top of `core/money.mjs` for why this is not optional.
- **Zero dependencies is a feature.** Do not add one without a very good reason. The MCP
  server implements JSON-RPC directly for this reason.

## Layout

```
bin/whenrun.mjs      router, lazy-imports each command
cli/                 one file per command
core/
  series.mjs         slots, window search. The heart. Direction-agnostic
  schedule.mjs       task + prices -> a plan, with its baseline
  money.mjs          spot -> delivered price. The honesty lives here
  collect.mjs        fetch with cache fallback + coverage block
  exec.mjs           the only module that runs anything
  store.mjs          JSONL + JSON on disk, the only module that touches it
  tasks.mjs          load and validate. Refuses, never repairs
sources/             one file per API, keyless
config/              *.local.mjs overrides *.default.mjs, same as signals
test/                node:test, offline. test/live.mjs hits the real APIs
```

## Things already learned the hard way

- **The bare price endpoints return today only.** At 23:00 that is fifteen minutes of
  future data and useless for overnight scheduling. Both sources are asked for an explicit
  range. `priceUrl()` in each source is unit-tested for exactly this.
- **Renewable share can exceed 100%.** It is a share of domestic load, not of generation, so
  exported surplus pushes it above 100. That is real data. Do not clamp it.
- **German day-ahead is quarter-hourly.** Nothing may assume 60-minute slots;
  `resolutionMinutes()` derives it from the data.
- **Windows must be time-weighted.** A 90-minute job spanning two hourly slots is not the
  flat mean of the two.
- **The MCP server must drain its queue before exiting.** Exiting when stdin closes drops
  every response but the first for a client that pipes a batch.

## Testing

`npm test` is the gate and is fully offline. Network checks live in `test/live.mjs` and are
deliberately excluded: a gate that fails when a free public API has a bad afternoon teaches
people to ignore the gate.

Fixtures in `test/fixtures/` are captured from the real APIs. Refresh with
`node test/live.mjs --update` rather than editing them by hand.
