#!/usr/bin/env node
/* Network smoke test. Not part of `npm test`.
 *
 * Checks that the two public APIs still answer in the shape the parsers expect.
 * Run it when you suspect an upstream change, and after any edit to sources/.
 *
 * It refreshes the captured fixtures with --update, which is the honest way to
 * keep offline tests testing the real API rather than a memory of it. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as energyCharts from '../sources/energy-charts.mjs';
import * as awattar from '../sources/awattar.mjs';
import { resolutionMinutes, stats } from '../core/series.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const update = process.argv.includes('--update');

let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    report(name, true, detail);
  } catch (err) {
    report(name, false, err.message);
  }
}

console.log('whenrun live check: hitting the real APIs\n');

await check('energy-charts price DE-LU', async () => {
  const s = await energyCharts.fetchPrices({ zone: 'DE-LU' });
  const st = stats(s.slots);
  if (s.slots.length < 20) throw new Error(`only ${s.slots.length} slots`);
  if (update) {
    const raw = await (await fetch('https://api.energy-charts.info/price?bzn=DE-LU')).json();
    fs.writeFileSync(path.join(FIXTURES, 'energy-charts-de-lu.json'), JSON.stringify(raw), 'utf8');
  }
  return `${s.slots.length} slots @ ${resolutionMinutes(s.slots)}min, ` +
    `${st.min.toFixed(1)} to ${st.max.toFixed(1)} EUR/MWh`;
});

await check('energy-charts renewable share DE', async () => {
  const s = await energyCharts.fetchRenewableShare({ country: 'de' });
  const st = stats(s.slots);
  if (update) {
    const raw = await (await fetch('https://api.energy-charts.info/ren_share_forecast?country=de')).json();
    fs.writeFileSync(path.join(FIXTURES, 'energy-charts-ren-share.json'), JSON.stringify(raw), 'utf8');
  }
  return `${s.slots.length} slots, ${st.min.toFixed(0)}% to ${st.max.toFixed(0)}%`;
});

await check('awattar price DE', async () => {
  const s = await awattar.fetchPrices({ zone: 'DE' });
  const st = stats(s.slots);
  if (update) {
    const raw = await (await fetch('https://api.awattar.de/v1/marketdata')).json();
    fs.writeFileSync(path.join(FIXTURES, 'awattar-de.json'), JSON.stringify(raw), 'utf8');
  }
  return `${s.slots.length} slots @ ${resolutionMinutes(s.slots)}min, ` +
    `${st.min.toFixed(1)} to ${st.max.toFixed(1)} EUR/MWh`;
});

await check('the two sources agree within 25 EUR/MWh', async () => {
  const [ec, aw] = await Promise.all([
    energyCharts.fetchPrices({ zone: 'DE-LU' }),
    awattar.fetchPrices({ zone: 'DE' }),
  ]);
  let worst = 0;
  let compared = 0;
  for (const hour of aw.slots) {
    const inside = ec.slots.filter((s) => s.start >= hour.start && s.end <= hour.end);
    if (!inside.length) continue;
    const mean = inside.reduce((a, s) => a + s.value, 0) / inside.length;
    worst = Math.max(worst, Math.abs(mean - hour.value));
    compared += 1;
  }
  if (compared === 0) throw new Error('no overlapping hours to compare');
  if (worst >= 25) throw new Error(`disagree by ${worst.toFixed(2)} EUR/MWh`);
  return `${compared} hours compared, worst gap ${worst.toFixed(2)} EUR/MWh`;
});

console.log(`\n${failures === 0 ? 'all live checks passed' : `${failures} live check(s) failed`}`);
if (update) console.log('fixtures refreshed');
process.exit(failures === 0 ? 0 : 1);
