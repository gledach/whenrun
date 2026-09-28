/* Where you are, resolved once.
 *
 * Bidding zones are not countries, which is the trap this module exists to
 * absorb. Germany and Luxembourg share one zone, Denmark has two, Italy and
 * Norway are split into several, and the renewable-share forecast is published
 * per country rather than per zone. Asking a user to know all that is asking
 * too much, so a zone is enough and the country is derived.
 *
 * Resolution order, highest first:
 *   --zone flag  →  $WHENRUN_ZONE  →  config/location.local.mjs  →  .default.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR } from './paths.mjs';

/** Zones served by the default source, with the country each maps to. */
export const ZONES = {
  'DE-LU': { label: 'Germany and Luxembourg', country: 'de', awattar: 'DE' },
  AT: { label: 'Austria', country: 'at', awattar: 'AT' },
  BE: { label: 'Belgium', country: 'be' },
  CH: { label: 'Switzerland', country: 'ch' },
  CZ: { label: 'Czechia', country: 'cz' },
  DK1: { label: 'Denmark, west of the Great Belt', country: 'dk' },
  DK2: { label: 'Denmark, east of the Great Belt', country: 'dk' },
  ES: { label: 'Spain', country: 'es' },
  FR: { label: 'France', country: 'fr' },
  'IT-North': { label: 'Italy, north', country: 'it' },
  NL: { label: 'Netherlands', country: 'nl' },
  NO2: { label: 'Norway, south', country: 'no' },
  PL: { label: 'Poland', country: 'pl' },
  PT: { label: 'Portugal', country: 'pt' },
  SE4: { label: 'Sweden, south', country: 'se' },
  SK: { label: 'Slovakia', country: 'sk' },
};

/** Case-insensitive lookup, so `de-lu` and `DE-LU` both work. */
export function findZone(input) {
  if (!input) return null;
  const want = String(input).trim().toLowerCase();
  for (const key of Object.keys(ZONES)) {
    if (key.toLowerCase() === want) return key;
  }
  return null;
}

export function countryFor(zone) {
  return ZONES[zone]?.country ?? null;
}

/**
 * @param {{ zone?: string, source?: string }} flags CLI flags, highest priority
 * @returns {Promise<{zone: string, country: string, source: string, file: string|null,
 *                    from: string, isDefault: boolean, label: string}>}
 */
export async function loadLocation(flags = {}) {
  let configured = {
    postcode: undefined,
    place: undefined,
    zone: 'DE-LU',
    country: undefined,
    source: 'energy-charts',
  };
  let file = null;
  let isDefault = true;

  for (const candidate of [
    path.join(CONFIG_DIR, 'location.local.mjs'),
    path.join(CONFIG_DIR, 'location.default.mjs'),
  ]) {
    if (!fs.existsSync(candidate)) continue;
    const mod = await import(pathToFileURL(candidate).href);
    if (!mod.default || typeof mod.default !== 'object') {
      throw new Error(`${candidate}: default export must be an object`);
    }
    configured = { ...configured, ...mod.default };
    file = candidate;
    isDefault = candidate.endsWith('location.default.mjs');
    break;
  }

  // Highest wins. Each step is reported so `where` and `doctor` can say which
  // one actually decided, rather than leaving a user guessing why a flag they
  // set in a file is being ignored.
  let from = file ? path.basename(file) : 'built-in default';
  let rawZone = configured.zone;

  if (process.env.WHENRUN_ZONE) {
    rawZone = process.env.WHENRUN_ZONE;
    from = '$WHENRUN_ZONE';
  }
  if (flags.zone && typeof flags.zone === 'string') {
    rawZone = flags.zone;
    from = '--zone';
  }

  const zone = findZone(rawZone);
  if (!zone) {
    throw new Error(
      `Unknown bidding zone "${rawZone}". Run \`whenrun where\` for the list. ` +
        'Note a zone is not a country: Germany is DE-LU, Denmark is DK1 or DK2.',
    );
  }

  const source =
    (typeof flags.source === 'string' && flags.source) ||
    process.env.WHENRUN_SOURCE ||
    configured.source ||
    'energy-charts';

  const postcode =
    process.env.WHENRUN_POSTCODE || (configured.postcode ? String(configured.postcode) : null);

  return {
    postcode,
    place: configured.place ?? null,
    zone,
    country: configured.country || countryFor(zone) || 'de',
    source,
    file,
    from,
    isDefault,
    label: ZONES[zone].label,
  };
}
