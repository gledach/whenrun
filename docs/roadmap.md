# whenrun roadmap

Honest status, and what is worth doing next. Nothing here is a commitment.

## What works today

- Day-ahead prices from two keyless sources, quarter-hourly or hourly, resolution derived
  from the data rather than assumed.
- Renewable-share forecast, 48 hours ahead.
- Cheapest, greenest and balanced window search, contiguous or scattered.
- Cost and saving against a configurable tariff, reported against the delivered bill.
- CLI: prices, plan, run, daemon, report, tasks, doctor.
- Daemon with replanning each tick, idempotency per cycle, a single-instance lock and
  `--once` for cron.
- Read-only MCP server, six tools, coverage block on every result.
- 108 tests, fully offline, plus a separate live check against the real APIs.

Verified against real data for DE-LU, AT, FR, CH, NL, ES and PL. Austria showed a negative
price during testing, which the money model handles: the delivered price stays positive
because the fixed components do not go away.

## Known gaps, roughly in the order they hurt

1. **No device control.** The tool starts a command. It cannot switch a heat pump on at
   14:00 and off at 16:00, which is what an interruptible load actually needs.
   `interruptible` currently shapes the plan and passes the slots in `WHENRUN_SLOTS`, and
   the script has to do the rest. An `onCommand` / `offCommand` pair per slot would close
   this properly, and is the single most valuable next thing.

2. **Time-varying grid fees are not modelled.** Fixed components are treated as flat. Where
   a network tariff varies by time of day, the cheapest window this picks may not be the
   cheapest window you are actually billed for.

3. **No self-generation.** Solar on your own roof changes the answer completely. Until it
   is modelled, anyone with a PV system should treat the output as advisory.

4. **The daemon has not been proven over a long run.** It has been tested a tick at a time
   and with `--once`. Signal handling on Windows in particular is emulated rather than real,
   and was not verified end to end.

5. **No notification.** A job that failed at 03:00 is discovered in the ledger, not by being
   told. A webhook or a desktop notification would be cheap.

6. **ENTSO-E is not wired up.** Both current sources cover Central and Western Europe well.
   ENTSO-E would add the rest, at the cost of requiring a free token, which breaks the
   "no account to start" promise unless it stays strictly optional.

7. **Tariff modelling is single-rate.** No day/night split, no per-kWh tiers, no feed-in.

## Deliberately not doing

- **Controlling anything over the network by default.** Smart-plug and inverter integrations
  turn a scheduler into something that can break your heating from a bug. If this ever
  happens it belongs behind an explicit opt-in per device.
- **A hosted version.** The entire argument is that it runs on your machine.
- **Predicting prices.** The day-ahead auction is published. Forecasting past that horizon
  is a different product with a different failure mode.
