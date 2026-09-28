import { loadLocation, ZONES } from '../core/location.mjs';
import { pretty } from '../core/paths.mjs';
import { c, table } from '../core/format.mjs';
import { bool } from '../core/args.mjs';

export default async function where({ flags }) {
  const loc = await loadLocation(flags);

  if (bool(flags.json)) {
    console.log(JSON.stringify({ ...loc, zones: ZONES }, null, 2));
    return 0;
  }

  console.log('');
  console.log(`${c.bold('where')}  ${c.dim('the location whenrun is asking about')}`);
  console.log('');
  if (loc.postcode || loc.place) {
    const where = [loc.postcode, loc.place].filter(Boolean).join(' ');
    console.log(`  place     ${c.bold(where)}`);
  }
  console.log(`  zone      ${c.bold(loc.zone)}  ${c.dim(loc.label)}`);
  console.log(`  country   ${loc.country}  ${c.dim('used for the renewable share forecast')}`);
  console.log(`  source    ${loc.source}`);
  console.log(`  set by    ${c.dim(loc.from)}${loc.file ? c.dim(`  (${pretty(loc.file)})`) : ''}`);
  console.log('');

  if (loc.isDefault && loc.from.endsWith('default.mjs')) {
    const shipped = [loc.postcode, loc.place].filter(Boolean).join(' ') || loc.label;
    console.log(c.yellow(`  You are on the shipped default: ${shipped}, zone ${loc.zone}.`));
    console.log(c.dim('  To change it for good:'));
    console.log(c.dim('    cp config/location.default.mjs config/location.local.mjs'));
    console.log(c.dim('  then edit the zone in the copy. Or for one command: --zone=AT'));
    console.log('');
  }

  const rows = Object.entries(ZONES).map(([key, v]) => [
    key === loc.zone ? c.green(key) : key,
    v.label,
    v.country,
    v.awattar ? c.dim('both sources') : c.dim('energy-charts'),
  ]);

  console.log(c.bold('  Available zones'));
  console.log('');
  console.log(
    table(rows, { headers: ['zone', 'covers', 'country', 'price data'] })
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );

  console.log('');
  if (loc.postcode) {
    console.log(
      c.dim('  The postcode labels output and nothing else yet. Network fees vary by grid'),
    );
    console.log(
      c.dim('  operator rather than by bidding zone, and are still modelled as flat.'),
    );
    console.log('');
  }
  console.log(
    c.dim('  A bidding zone is not a country. Germany and Luxembourg share DE-LU,'),
  );
  console.log(c.dim('  Denmark is split at the Great Belt, and Italy and Norway have several.'));
  console.log('');
  return 0;
}
