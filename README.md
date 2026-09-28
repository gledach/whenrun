# whenrun

**Run it when the power is cheap.**

Watches day-ahead electricity prices and the renewable-share forecast, works out the
cheapest or greenest window that still meets your deadline, and starts your job there.

Zero runtime dependencies. No account, no API key, no build step. Everything stays on your
machine.

```bash
git clone https://github.com/gledach/whenrun.git && cd whenrun
node bin/whenrun.mjs prices
```

That works on a fresh clone with nothing installed. There is no `npm install` because there
is nothing to install.

## Why this is worth doing

German power prices move by a factor of three or more within a single day. These are real
figures from one evening, captured by `whenrun prices`:

```
  today     ▄                          176 EUR/MWh  (1h left)
  tomorrow  ▆▅▅▅▅▅▇█▇▆▅▃▂▁▁▃▅▇██▇▅▅▄     72 to 231 EUR/MWh
            00:00 06:00 12:00 18:00

  len  when                     spot          you pay
  1h   tomorrow 13:15 to 14:15  68.3 EUR/MWh  31.3 ct/kWh delivered
  4h   tomorrow 11:30 to 15:30  86.6 EUR/MWh  33.5 ct/kWh delivered

  Greenest 2h  tomorrow 12:30 to 14:30  101% renewable
```

Since January 2025 every German electricity supplier has had to offer a dynamic tariff, and
the day-ahead auction is public. The information has been free the whole time. What was
missing was something that acts on it without tying you to one supplier's app.

## What it does

```bash
whenrun prices                                      # today and tomorrow, with cheap windows
whenrun plan --duration=45m --kw=2 --by=07:00       # when should this run, what will it cost
whenrun plan --duration=2h --kw=11 --objective=greenest
whenrun plan                                        # every task in your config
whenrun run --task=backup                           # dry run
whenrun run --task=backup --execute                 # wait for the window, then run it
whenrun daemon --execute                            # all enabled tasks, continuously
whenrun daemon --once --execute                     # one pass, for cron or Task Scheduler
whenrun report                                      # what it actually saved
whenrun doctor                                      # config, connectivity, data freshness
```

Three objectives: `cheapest` minimises price, `greenest` maximises renewable share, and
`balanced` blends the two. A job marked `interruptible` may be scattered across
non-adjacent slots; otherwise it gets one unbroken block.

## Making it yours

```bash
cp config/tasks.default.mjs  config/tasks.local.mjs    # what to run
cp config/tariff.default.mjs config/tariff.local.mjs   # what you pay
```

Both `.local.mjs` files are gitignored and override the defaults, so you can pull upstream
forever without a conflict in the files you edited.

A task looks like this:

```js
{
  id: 'backup',
  label: 'Nightly backup',
  command: 'npm run backup',   // or { cmd, args } to skip the shell
  durationMinutes: 45,
  kw: 0.3,                     // average draw, used for the cost estimate
  earliest: '20:00',
  deadline: '07:00',           // must be finished by then
  objective: 'cheapest',
  enabled: true,
}
```

Your task is told what it was scheduled into, through the environment:
`WHENRUN_WINDOW_START`, `WHENRUN_WINDOW_END`, `WHENRUN_SPOT_EUR_MWH`,
`WHENRUN_RENEWABLE_PCT`, `WHENRUN_SLOTS`.

## Safety

This tool runs commands unattended. The rules it holds to:

- **The command comes from your task file.** Never from a price feed, never from an
  argument, never from the network. There is no code path that builds a command out of
  fetched data.
- **Two independent locks.** A task needs `enabled: true` *and* the command needs
  `--execute`. Dry run is the default everywhere.
- **It refuses rather than guesses.** Stale price data, an impossible deadline, or a window
  that closed while the daemon was asleep all produce a refusal with a reason, not a
  best effort.
- **The MCP server is read-only.** An agent can ask when power is cheap. It cannot start
  anything.

## What the savings number means

The figure everyone quotes is the spot price. It is not your bill. A German bill is roughly
spot plus supplier markup plus grid fees plus levies plus taxes plus VAT, and only the first
of those moves by the hour.

So if spot halves, your bill does not. `whenrun` reports both numbers and labels which is
which:

```
saving   0.04 EUR (31.5% of this job's bill)   11% of its energy component
```

The flattering number is always the one labelled as the energy component. `whenrun report`
also prints your standing charge for the period, because no amount of load shifting changes
it and a savings figure without that context flatters the tool.

## What it cannot see

- **Your actual tariff.** It uses the numbers in your tariff file. If those are wrong, every
  euro it reports is wrong by the same proportion. `doctor` warns while you are still on the
  shipped defaults.
- **Whether you are on a dynamic tariff at all.** On a fixed tariff it will still tell you
  when power is cheap, and you will still be charged the same.
- **Your own generation.** Solar on your roof changes the answer completely and is not
  modelled.
- **Grid fees that vary by time.** Modelled as flat. Where a time-varying network tariff
  applies, the cheap window may not be exactly where this says.
- **Whether your job really draws what you declared.** `kw` is your estimate, not a
  measurement.
- **It cannot pause a running command.** `interruptible` shapes which slots are chosen and
  passes the list to your task in `WHENRUN_SLOTS`. Honouring the split is your script's job.

## For agents

```bash
node mcp-server.mjs
```

Six read-only tools: `get_prices`, `cheapest_window`, `greenest_window`, `list_tasks`,
`plan_task`, `savings_report`. Every result carries a coverage block with a freshness status
and a `trustEmptyResult` flag, so an agent can tell "prices are flat" from "I have not been
able to look since Tuesday".

## Data

| Source | Zone | Key needed | Resolution |
|---|---|---|---|
| [Energy-Charts](https://api.energy-charts.info) (Fraunhofer ISE) | DE-LU, AT, FR, NL and more | no | 15 min |
| [aWATTar](https://www.awattar.de) | DE, AT | no | 60 min |

Price data is CC BY 4.0 from Bundesnetzagentur | SMARD.de via Energy-Charts. `doctor`
cross-checks the two sources against each other and warns when they disagree by more than a
rounding error.

## Tests

```bash
npm test          # the gate: 108 tests, fully offline, no network
node test/live.mjs          # checks the real APIs still answer in the expected shape
node test/live.mjs --update # and refreshes the captured fixtures
```

Offline fixtures are captured from the live APIs rather than handwritten, so they test what
the API does rather than what I remember it doing.

## Docs

- [docs/running-it.md](./docs/running-it.md) — cron, systemd, Task Scheduler, and exactly
  when it will refuse to run something
- [docs/roadmap.md](./docs/roadmap.md) — what works, what is missing, what is deliberately
  not being built

## Licence

MIT. See [LICENSE](./LICENSE).
