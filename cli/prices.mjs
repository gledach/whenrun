import { getPrices, getRenewableShare, DEFAULT_SOURCE, DEFAULT_ZONE } from '../core/collect.mjs';
import { bestWindow, slice, stats, resolutionMinutes, HOUR } from '../core/series.mjs';
import { deliveredCentPerKwh, DEFAULT_TARIFF } from '../core/money.mjs';
import { c, colourSparkline, hhmm, dayLabel, range, coverageLine, table } from '../core/format.mjs';
import { bool } from '../core/args.mjs';

export default async function prices({ flags }) {
  const zone = flags.zone || DEFAULT_ZONE;
  const source = flags.source || DEFAULT_SOURCE;
  const offline = bool(flags.offline);
  const now = Date.now();

  const { series, coverage, from } = await getPrices({ zone, source, offline, now });
  if (!series) {
    console.error(`No price data for ${zone}.`);
    for (const w of coverage.warnings) console.error(`  ${w}`);
    return 1;
  }

  const ren = await getRenewableShare({ offline, now }).catch(() => ({ series: null }));

  if (bool(flags.json)) {
    console.log(JSON.stringify({ series, coverage, renewable: ren.series }, null, 2));
    return 0;
  }

  const future = slice(series.slots, now, Infinity);
  const shown = future.length ? future : series.slots;
  const st = stats(shown);
  const res = resolutionMinutes(shown);

  console.log('');
  console.log(
    `${c.bold(zone)} ${c.dim(`· ${source} · ${res}min slots · ${from}`)}  ${coverageLine(coverage)}`,
  );
  for (const w of coverage.warnings) console.log(c.yellow(`  ! ${w}`));
  console.log('');

  // One row per day, hour-resolution sparkline so a 96-slot day stays readable.
  const byDay = new Map();
  for (const slot of shown) {
    const key = new Date(slot.start).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(slot);
  }

  for (const [, daySlots] of byDay) {
    const hours = toHourly(daySlots);
    const label = dayLabel(daySlots[0].start, now);
    const dSt = stats(hours);
    console.log(
      `  ${c.bold(label.padEnd(9))} ${colourSparkline(hours.map((h) => h.value))}  ` +
        c.dim(
          `${dSt.min.toFixed(0)} to ${dSt.max.toFixed(0)} EUR/MWh` +
            (hours.length < 24 ? `  (${hours.length}h published)` : ''),
        ),
    );
    console.log(`  ${' '.repeat(9)} ${c.dim(hourAxis(hours))}`);
  }

  console.log('');
  console.log(
    c.dim(
      `  spread ${st.min.toFixed(1)} to ${st.max.toFixed(1)} EUR/MWh` +
        `  ·  mean ${st.mean.toFixed(1)}  ·  median ${st.median.toFixed(1)}`,
    ),
  );

  // Cheapest windows at the lengths people actually schedule.
  const rows = [];
  for (const mins of [60, 120, 180, 240]) {
    const w = bestWindow(shown, { durationMinutes: mins, notBefore: now });
    if (!w) continue;
    const ct = deliveredCentPerKwh(w.mean, DEFAULT_TARIFF);
    rows.push([
      `${mins / 60}h`,
      range(w.start, w.end, now),
      `${w.mean.toFixed(1)} EUR/MWh`,
      c.green(`${ct.toFixed(1)} ct/kWh delivered`),
    ]);
  }
  if (rows.length) {
    console.log('');
    console.log(c.bold('  Cheapest window from now'));
    console.log('');
    console.log(
      table(rows, { headers: ['len', 'when', 'spot', 'you pay'] })
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  if (ren.series) {
    const greenest = bestWindow(slice(ren.series.slots, now, Infinity), {
      durationMinutes: 120,
      notBefore: now,
      direction: 'max',
    });
    if (greenest) {
      console.log('');
      console.log(
        `  ${c.bold('Greenest 2h')}  ${range(greenest.start, greenest.end, now)}  ` +
          c.green(`${greenest.mean.toFixed(0)}% renewable`),
      );
    }
  }

  console.log('');
  console.log(c.dim('  Delivered price assumes the default tariff. Set yours in config/tariff.local.mjs.'));
  console.log('');
  return 0;
}

/** Average sub-hour slots up to hours so a 96-point day fits a terminal. */
function toHourly(slots) {
  const buckets = new Map();
  for (const s of slots) {
    const key = Math.floor(s.start / HOUR) * HOUR;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s.value);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, values]) => ({
      start,
      end: start + HOUR,
      value: values.reduce((a, b) => a + b, 0) / values.length,
    }));
}

/** A sparse axis under the sparkline: one marker every six hours. */
function hourAxis(hours) {
  let out = '';
  for (let i = 0; i < hours.length; i++) {
    const h = new Date(hours[i].start).getHours();
    if (h % 6 === 0) {
      const label = hhmm(hours[i].start);
      out += label;
      i += label.length - 1;
    } else {
      out += ' ';
    }
  }
  return out;
}
