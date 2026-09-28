# Running it for real

Three ways to keep `whenrun` working while you are not looking, in increasing order of
how much you have to trust it.

Start at step 0 whichever you pick.

## 0. Prove it first, for a week

```bash
node bin/whenrun.mjs doctor
node bin/whenrun.mjs plan
```

`doctor` will warn that you are on the shipped tariff defaults. Fix that before you believe
any euro figure:

```bash
cp config/tariff.default.mjs config/tariff.local.mjs
```

The number that matters most is `fixedCentPerKwh`: grid fees, levies, electricity tax and
metering. It is on your annual bill. It decides how much a cheap hour is actually worth,
and it is the difference between a real saving and a flattering one.

Then write your tasks and leave everything disabled for a few days:

```bash
cp config/tasks.default.mjs config/tasks.local.mjs
node bin/whenrun.mjs daemon        # dry run, prints what it would have done
```

Only once the windows it picks look sane should anything get `enabled: true`.

A note on times before you write any: **`earliest` and `deadline` are a 24-hour clock in
your local timezone**, written `HH:MM`. `19:00` is the evening, `07:00` is the morning, and
`7:00` is refused rather than guessed at. The clock on your wall is the one that matters,
which is also why a deadline stays at the same wall-clock time across a daylight-saving
change even though the night is an hour shorter or longer.

## 1. Cron or Task Scheduler, one pass at a time

The least trusting option, and the one to prefer if you already have a scheduler you
believe in. `--once` does a single pass and exits.

**Linux or macOS**, every fifteen minutes:

```cron
*/15 * * * * cd /path/to/whenrun && /usr/bin/node bin/whenrun.mjs daemon --once --execute >> /var/log/whenrun.log 2>&1
```

**Windows Task Scheduler**, from an elevated PowerShell:

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" `
             -Argument "bin\whenrun.mjs daemon --once --execute" `
             -WorkingDirectory "D:\path\to\whenrun"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName "whenrun" -Action $action -Trigger $trigger `
             -Description "Schedule jobs into cheap electricity windows"
```

A fifteen-minute cadence matches the market: German day-ahead settles in quarter-hours, so
checking more often gains nothing.

## 2. A resident daemon

```bash
node bin/whenrun.mjs daemon --execute
```

It ticks every minute, replans on each tick because tomorrow's prices can move a window
that was already chosen, and holds a lock file so two copies cannot both fire the same job.

**systemd**, as a user service at `~/.config/systemd/user/whenrun.service`:

```ini
[Unit]
Description=whenrun
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/whenrun
ExecStart=/usr/bin/node bin/whenrun.mjs daemon --execute
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now whenrun
journalctl --user -u whenrun -f
```

Note that a user service stops when you log out unless you enable lingering:
`sudo loginctl enable-linger $USER`.

**On Windows**, prefer option 1. Signals there are emulated rather than real, and a
long-lived console process is the less reliable of the two.

## 3. Watching what it did

```bash
node bin/whenrun.mjs report
node bin/whenrun.mjs report --days=7 --json
```

The ledger at `data/runs.jsonl` is append-only and one JSON object per line, so it pipes
into anything:

```bash
# every run that exited non-zero
grep '"event":"ran"' data/runs.jsonl | grep -v '"exitCode":0'
```

## When it will refuse

Worth knowing before you find out at 03:00.

| Situation | What happens |
|---|---|
| Prices older than 18 hours | Refuses to execute. `--force` overrides |
| No window long enough before the deadline | Refuses, and says how much time it did have |
| A gap in the published series | Refuses rather than scheduling across a slot that does not exist |
| The window closed while the daemon was down | Skips that cycle rather than starting late and overrunning |
| Task not `enabled: true` | Refuses, whatever flags you passed |

All of these land in the ledger as a `refused` or `missed` event with a reason, so `report`
tells you afterwards.

## The thing to check after a week

Compare what `report` claims against your actual bill. If they disagree, the tariff file is
wrong, not the market. That is the only number in this tool that comes from you rather than
from a published auction, and it is the only one that can quietly be wrong.
