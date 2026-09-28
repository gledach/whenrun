/* Tariff resolution: $WHENRUN_TARIFF → config/tariff.local.mjs → config/tariff.default.mjs
 *
 * Same layering as the task list. Validated on load, because a tariff with a
 * string where a number should be produces a NaN saving that propagates all the
 * way to the report without ever throwing. */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR } from './paths.mjs';
import { DEFAULT_TARIFF } from './money.mjs';

export async function loadTariff() {
  const candidates = [
    process.env.WHENRUN_TARIFF ? path.resolve(process.env.WHENRUN_TARIFF) : null,
    path.join(CONFIG_DIR, 'tariff.local.mjs'),
    path.join(CONFIG_DIR, 'tariff.default.mjs'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    return { file, tariff: validateTariff(mod.default, file), isDefault: file.endsWith('tariff.default.mjs') };
  }
  return { file: null, tariff: DEFAULT_TARIFF, isDefault: true };
}

export function validateTariff(t, file = 'tariff') {
  if (!t || typeof t !== 'object') throw new Error(`${file}: default export must be an object`);

  const out = { ...DEFAULT_TARIFF, ...t };
  for (const key of ['markupCentPerKwh', 'fixedCentPerKwh', 'vatRate', 'basePriceEurPerMonth']) {
    if (!Number.isFinite(out[key])) {
      throw new Error(`${file}: ${key} must be a number, got ${JSON.stringify(t[key])}`);
    }
  }
  if (out.vatRate < 0 || out.vatRate > 1) {
    throw new Error(`${file}: vatRate is a fraction, so 0.19 not 19`);
  }
  if (out.fixedCentPerKwh < 0 || out.markupCentPerKwh < -50) {
    throw new Error(`${file}: negative components that large are almost certainly a typo`);
  }
  return out;
}
