/* Terminal rendering.
 *
 * Colour is opt-out via NO_COLOR and off automatically when stdout is not a
 * TTY, so piping to a file or a log collector gets clean text. Times are
 * rendered in local time because that is the clock the deadline was written in.
 */

const useColour =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code) => (s) => (useColour ? `[${code}m${s}[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
  magenta: wrap('35'),
  grey: wrap('90'),
};

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** A sparkline. Flat input renders as a flat middle row rather than all zeros. */
export function sparkline(values) {
  if (!values || values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v) => {
      if (span === 0) return BLOCKS[3];
      const idx = Math.round(((v - min) / span) * (BLOCKS.length - 1));
      return BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, idx))];
    })
    .join('');
}

/** Sparkline coloured by tercile: cheap green, middle plain, dear red. */
export function colourSparkline(values) {
  if (!values || values.length === 0) return '';
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length / 3)];
  const hi = sorted[Math.floor((sorted.length * 2) / 3)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  return values
    .map((v) => {
      const idx = span === 0 ? 3 : Math.round(((v - min) / span) * (BLOCKS.length - 1));
      const ch = BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, idx))];
      if (v <= lo) return c.green(ch);
      if (v >= hi) return c.red(ch);
      return ch;
    })
    .join('');
}

export function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dayLabel(ms, now = Date.now()) {
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return 'today';
  const tomorrow = new Date(now + 86400_000);
  if (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  ) {
    return 'tomorrow';
  }
  return d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit' });
}

export function range(startMs, endMs, now = Date.now()) {
  const sameDay = new Date(startMs).getDate() === new Date(endMs).getDate();
  return sameDay
    ? `${dayLabel(startMs, now)} ${hhmm(startMs)} to ${hhmm(endMs)}`
    : `${dayLabel(startMs, now)} ${hhmm(startMs)} to ${dayLabel(endMs, now)} ${hhmm(endMs)}`;
}

export function untilPhrase(ms, now = Date.now()) {
  const delta = ms - now;
  if (delta <= 0) return 'now';
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/** Left-aligned columns, sized to content. */
export function table(rows, { headers = null, gap = 2 } = {}) {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return '';
  const widths = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      const len = stripAnsi(String(cell)).length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    });
  }
  const line = (row) =>
    row
      .map((cell, i) => {
        const s = String(cell);
        const pad = widths[i] - stripAnsi(s).length;
        return i === row.length - 1 ? s : s + ' '.repeat(Math.max(0, pad));
      })
      .join(' '.repeat(gap));

  const out = [];
  if (headers) {
    out.push(c.dim(line(headers)));
    out.push(c.dim(line(widths.map((w) => '─'.repeat(w)))));
  }
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

export function coverageLine(coverage) {
  if (!coverage) return '';
  const tone =
    coverage.status === 'fresh' ? c.green : coverage.status === 'slowing' ? c.yellow : c.red;
  const bits = [`data ${tone(coverage.status)}`];
  if (coverage.ageMinutes !== null) bits.push(`${coverage.ageMinutes} min old`);
  if (coverage.horizonHours !== undefined) bits.push(`${coverage.horizonHours}h ahead`);
  return c.dim(bits.join(' · '));
}
