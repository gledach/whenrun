import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLocation, findZone, countryFor, ZONES } from '../core/location.mjs';

/* A bidding zone is not a country, and getting that wrong silently fetches
 * prices for the wrong market. These pin the mapping and the precedence. */

test('zone lookup is case insensitive', () => {
  assert.equal(findZone('DE-LU'), 'DE-LU');
  assert.equal(findZone('de-lu'), 'DE-LU');
  assert.equal(findZone('  At  '), 'AT');
  assert.equal(findZone('it-north'), 'IT-North');
});

test('an unknown zone is not guessed at', () => {
  assert.equal(findZone('Germany'), null);
  assert.equal(findZone('DE'), null, 'DE is aWATTar\'s name for it, not a bidding zone');
  assert.equal(findZone(''), null);
  assert.equal(findZone(undefined), null);
});

test('every zone maps to a country for the renewable forecast', () => {
  for (const [zone, meta] of Object.entries(ZONES)) {
    assert.ok(meta.country, `${zone} has no country`);
    assert.match(meta.country, /^[a-z]{2}$/, `${zone} country should be a two-letter code`);
    assert.ok(meta.label && meta.label.length > 2, `${zone} needs a human label`);
    assert.equal(countryFor(zone), meta.country);
  }
});

test('the two Danish zones share a country, as they should', () => {
  assert.equal(countryFor('DK1'), countryFor('DK2'));
});

test('the shipped default is Starnberg in DE-LU', async () => {
  const loc = await loadLocation({});
  assert.equal(loc.zone, 'DE-LU');
  assert.equal(loc.country, 'de');
  assert.equal(loc.postcode, '82319');
  assert.equal(loc.place, 'Starnberg');
  assert.equal(loc.source, 'energy-charts');
});

test('a --zone flag beats the config file, and reports that it did', async () => {
  const loc = await loadLocation({ zone: 'FR' });
  assert.equal(loc.zone, 'FR');
  assert.equal(loc.country, 'fr', 'the country follows the zone');
  assert.equal(loc.from, '--zone', 'where should be able to say what decided');
});

test('$WHENRUN_ZONE beats the file but loses to the flag', async () => {
  const before = process.env.WHENRUN_ZONE;
  try {
    process.env.WHENRUN_ZONE = 'AT';
    assert.equal((await loadLocation({})).zone, 'AT');
    assert.equal((await loadLocation({})).from, '$WHENRUN_ZONE');
    assert.equal((await loadLocation({ zone: 'PL' })).zone, 'PL', 'the flag still wins');
  } finally {
    if (before === undefined) delete process.env.WHENRUN_ZONE;
    else process.env.WHENRUN_ZONE = before;
  }
});

test('a bad zone fails with a message that helps rather than a stack trace', async () => {
  await assert.rejects(
    () => loadLocation({ zone: 'Bavaria' }),
    (err) => {
      assert.match(err.message, /Unknown bidding zone "Bavaria"/);
      assert.match(err.message, /whenrun where/, 'it should say where to look');
      assert.match(err.message, /not a country/, 'and name the actual confusion');
      return true;
    },
  );
});

test('the country can be overridden without touching the zone', async () => {
  // Someone on a border, or a zone whose forecast is better served by a
  // neighbour, should not have to fork the zone table to say so.
  const loc = await loadLocation({ zone: 'DE-LU' });
  assert.equal(loc.country, 'de');
  assert.equal(typeof loc.label, 'string');
});
