/* Argument parsing, deliberately small.
 *
 * Supports --key=value, --key value, --flag and -h. Unknown flags are kept
 * rather than rejected, because the router needs to pass some through, but
 * each command validates what it actually reads. */

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) {
      out._.push(a);
      continue;
    }
    const long = a.replace(/^--?/, '');
    if (long.includes('=')) {
      const [k, ...rest] = long.split('=');
      out.flags[k] = rest.join('=');
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      out.flags[long] = next;
      i += 1;
    } else {
      out.flags[long] = true;
    }
  }
  return out;
}

export function num(value, fallback = null) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** "90", "90m", "2h", "1h30" all mean minutes. */
export function minutes(value, fallback = null) {
  if (value === undefined || value === true || value === null) return fallback;
  const s = String(value).trim().toLowerCase();

  const hm = /^(\d+)h(?:\s*(\d+)m?)?$/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] ?? 0);

  const m = /^(\d+)\s*m(?:in)?$/.exec(s);
  if (m) return Number(m[1]);

  const plain = Number(s);
  return Number.isFinite(plain) ? plain : fallback;
}

export function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  return !/^(false|0|no|off)$/i.test(String(value));
}
