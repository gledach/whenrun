/* The shape everything else speaks.
 *
 * A Slot is one market interval: { start, end, value }. Times are epoch ms,
 * UTC throughout. The market moved to 15-minute intervals in Germany, and the
 * two sources disagree about resolution, so nothing downstream is allowed to
 * assume an hour. Every function here derives resolution from the data.
 *
 * `value` is deliberately unnamed: a series is either prices (EUR/MWh, lower is
 * better) or renewable share (percent, higher is better). The window search is
 * the same problem in both directions, so it takes a direction rather than
 * having two copies that drift apart. */

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** @typedef {{ start: number, end: number, value: number }} Slot */
/** @typedef {{ kind: string, unit: string, zone: string, source: string,
 *              fetchedAt: number, slots: Slot[] }} Series */

export function makeSeries({ kind, unit, zone, source, slots, fetchedAt = Date.now() }) {
  const clean = (slots || [])
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && Number.isFinite(s.value))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // Two sources overlapping, or one re-publishing a corrected value, must not
  // produce two slots for the same instant. Last write wins, which matches the
  // market: a correction supersedes.
  const byStart = new Map();
  for (const s of clean) byStart.set(s.start, s);

  return {
    kind,
    unit,
    zone,
    source,
    fetchedAt,
    slots: [...byStart.values()].sort((a, b) => a.start - b.start),
  };
}

/** Modal slot length in minutes. Returns 0 for an empty series. */
export function resolutionMinutes(slots) {
  if (!slots || slots.length === 0) return 0;
  const counts = new Map();
  for (const s of slots) {
    const m = Math.round((s.end - s.start) / MIN);
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [m, c] of counts) {
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  return best;
}

/** Slots overlapping [from, to). Partial overlap counts: a job can start mid-slot. */
export function slice(slots, from, to) {
  return slots.filter((s) => s.end > from && s.start < to);
}

export function stats(slots) {
  if (!slots || slots.length === 0) return null;
  const values = slots.map((s) => s.value).sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mid = Math.floor(values.length / 2);
  return {
    count: values.length,
    min: values[0],
    max: values[values.length - 1],
    mean: sum / values.length,
    median: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
    from: slots[0].start,
    to: slots[slots.length - 1].end,
  };
}

/** True when the slots form an unbroken run with no gaps. */
export function isContiguous(slots) {
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].start !== slots[i - 1].end) return false;
  }
  return true;
}

/**
 * Cheapest (or greenest) contiguous window of at least `durationMinutes`.
 *
 * Returns null rather than a best-effort answer when the horizon cannot hold
 * the job. Callers have to handle "there is no window", because the honest
 * answer to "when should this run before 07:00" is sometimes "it cannot".
 *
 * @param {Slot[]} slots
 * @param {{ durationMinutes: number, notBefore?: number, notAfter?: number,
 *           direction?: 'min'|'max' }} opts
 */
export function bestWindow(slots, opts) {
  const {
    durationMinutes,
    notBefore = -Infinity,
    notAfter = Infinity,
    direction = 'min',
  } = opts;

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new TypeError('durationMinutes must be a positive number');
  }

  const durationMs = durationMinutes * MIN;
  const usable = slots
    .filter((s) => s.end > notBefore && s.start < notAfter)
    .sort((a, b) => a.start - b.start);

  if (usable.length === 0) return null;

  let best = null;

  for (let i = 0; i < usable.length; i++) {
    // A window may start inside a slot, but never before the constraint.
    const start = Math.max(usable[i].start, notBefore === -Infinity ? usable[i].start : notBefore);
    const end = start + durationMs;
    if (end > notAfter) break;

    // Walk forward, requiring an unbroken run that covers the whole duration.
    let covered = usable[i].end;
    let j = i;
    let weighted = 0;
    let broke = false;

    while (covered < end) {
      const next = usable[j + 1];
      if (!next || next.start !== usable[j].end) {
        broke = true;
        break;
      }
      j += 1;
      covered = usable[j].end;
    }
    if (broke || covered < end) continue;

    // Time-weighted average across the covered slots, so a 90-minute job
    // spanning two 60-minute slots is not scored as a flat mean.
    for (let k = i; k <= j; k++) {
      const overlap = Math.min(usable[k].end, end) - Math.max(usable[k].start, start);
      if (overlap > 0) weighted += usable[k].value * overlap;
    }
    const mean = weighted / durationMs;

    const better =
      best === null ||
      (direction === 'min' ? mean < best.mean - 1e-9 : mean > best.mean + 1e-9);

    if (better) {
      best = {
        start,
        end,
        mean,
        slots: usable.slice(i, j + 1),
      };
    }
  }

  return best;
}

/**
 * Cheapest N slots, not necessarily adjacent. For interruptible loads: an EV
 * charger or a dehumidifier does not care whether its hours touch.
 */
export function bestSlots(slots, opts) {
  const {
    durationMinutes,
    notBefore = -Infinity,
    notAfter = Infinity,
    direction = 'min',
  } = opts;

  /* Partial overlap, matching bestWindow and slice. Requiring strict
     containment here meant planTask could pass its minute-count feasibility
     check and then get null back, which was reported to the user as "no
     unbroken window exists" -- the wrong diagnosis for a task that was
     explicitly allowed to break up. */
  const usable = slots
    .filter((sl) => sl.end > notBefore && sl.start < notAfter)
    .map((sl) => ({
      start: Math.max(sl.start, notBefore === -Infinity ? sl.start : notBefore),
      end: Math.min(sl.end, notAfter === Infinity ? sl.end : notAfter),
      value: sl.value,
    }))
    .filter((sl) => sl.end > sl.start);

  if (usable.length === 0) return null;

  const ranked = [...usable].sort((a, b) =>
    direction === 'min' ? a.value - b.value : b.value - a.value,
  );

  /* Take slots until the duration is covered, measuring each one's real
     length. Using a count of modal-resolution slots misreports both the mean
     and the runtime on a mixed series: with 15-minute and 60-minute slots
     together it claimed 60 minutes while reserving 105, and mispriced it by
     over 40%. */
  const needMs = durationMinutes * MIN;
  const picked = [];
  let coveredMs = 0;
  for (const sl of ranked) {
    if (coveredMs >= needMs) break;
    picked.push(sl);
    coveredMs += sl.end - sl.start;
  }
  if (coveredMs + 1e-6 < needMs) return null;

  picked.sort((a, b) => a.start - b.start);

  // Time weighted, so a long cheap slot counts for more than a short one.
  let weighted = 0;
  let total = 0;
  for (const sl of picked) {
    const len = sl.end - sl.start;
    weighted += sl.value * len;
    total += len;
  }

  return {
    slots: picked,
    mean: total === 0 ? null : weighted / total,
    minutes: total / MIN,
  };
}

/**
 * What the same job would have cost if started immediately. This is the
 * baseline every saving claim is measured against, so it lives next to the
 * window search rather than in the reporting code where it could drift.
 */
export function runNowWindow(slots, { durationMinutes, now }) {
  return bestWindow(slots, {
    durationMinutes,
    notBefore: now,
    notAfter: now + durationMinutes * MIN,
    direction: 'min',
  });
}
