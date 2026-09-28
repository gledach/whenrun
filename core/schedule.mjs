/* Deciding when a task should run.
 *
 * Three objectives, one search. "cheapest" minimises price, "greenest"
 * maximises renewable share, "balanced" maximises a normalised blend of both.
 * They all reduce to the same contiguous-window scan in core/series.mjs, which
 * is why there is one implementation of that scan and not three.
 *
 * Every plan carries its baseline, meaning what the same job would have cost
 * starting right now. A tool that only reports the cheap number it found is
 * grading its own homework. */

import { bestWindow, bestSlots, slice, stats, MIN } from './series.mjs';
import { jobCost, saving, DEFAULT_TARIFF } from './money.mjs';
import { taskBounds } from './tasks.mjs';

/** Normalise a series to 0..1 across the given horizon. Flat series map to 0.5. */
function normalise(slots) {
  const s = stats(slots);
  if (!s) return new Map();
  const span = s.max - s.min;
  const out = new Map();
  for (const slot of slots) {
    out.set(slot.start, span === 0 ? 0.5 : (slot.value - s.min) / span);
  }
  return out;
}

/**
 * A score series where higher is always better.
 * weight is the share given to price: 1 is pure cheapest, 0 is pure greenest.
 */
export function blend(priceSlots, renSlots, weight = 0.5) {
  const priceNorm = normalise(priceSlots);
  const renNorm = normalise(renSlots || []);

  // Renewable share is published at its own cadence and may not line up, so
  // each price slot takes the renewable value covering its midpoint rather
  // than assuming index alignment.
  const renAt = (t) => {
    const hit = (renSlots || []).find((r) => r.start <= t && r.end > t);
    return hit ? renNorm.get(hit.start) ?? 0.5 : null;
  };

  return priceSlots.map((p) => {
    const mid = p.start + (p.end - p.start) / 2;
    const r = renAt(mid);
    const cheapScore = 1 - (priceNorm.get(p.start) ?? 0.5);
    const greenScore = r === null ? cheapScore : r;
    return {
      start: p.start,
      end: p.end,
      value: weight * cheapScore + (1 - weight) * greenScore,
    };
  });
}

/** Mean value of a series across a window, time weighted. */
export function meanOver(slots, start, end) {
  const covering = slice(slots, start, end);
  if (covering.length === 0) return null;
  let weighted = 0;
  let total = 0;
  for (const s of covering) {
    const overlap = Math.min(s.end, end) - Math.max(s.start, start);
    if (overlap > 0) {
      weighted += s.value * overlap;
      total += overlap;
    }
  }
  return total === 0 ? null : weighted / total;
}

/**
 * @param {object} task            validated task
 * @param {object} ctx
 * @param {object} ctx.prices      price series
 * @param {object} [ctx.renewable] renewable share series
 * @param {number} [ctx.now]
 * @param {object} [ctx.tariff]
 * @param {number} [ctx.weight]    price weight for "balanced"
 */
export function planTask(task, ctx) {
  const {
    prices,
    renewable = null,
    now = Date.now(),
    tariff = DEFAULT_TARIFF,
    weight = 0.5,
  } = ctx;

  const { notBefore, notAfter } = taskBounds(task, now);
  const horizon = { notBefore, notAfter };

  const base = {
    taskId: task.id,
    label: task.label,
    objective: task.objective,
    durationMinutes: task.durationMinutes,
    kw: task.kw,
    notBefore,
    notAfter,
    enabled: task.enabled,
  };

  if (!prices || prices.slots.length === 0) {
    return { ...base, feasible: false, problem: 'no price data' };
  }

  const available = slice(prices.slots, notBefore, notAfter);
  const haveMinutes = available.reduce(
    (a, s) => a + (Math.min(s.end, notAfter) - Math.max(s.start, notBefore)) / MIN,
    0,
  );
  if (haveMinutes + 1e-6 < task.durationMinutes) {
    return {
      ...base,
      feasible: false,
      problem:
        `needs ${task.durationMinutes} min before ${new Date(notAfter).toLocaleString()}, ` +
        `but only ${Math.floor(haveMinutes)} min of published prices cover that window`,
    };
  }

  // Pick the window.
  let chosen = null;
  let scattered = null;

  if (task.interruptible) {
    const scoreSlots =
      task.objective === 'cheapest'
        ? available
        : blend(available, renewable?.slots, task.objective === 'greenest' ? 0 : weight);
    const direction = task.objective === 'cheapest' ? 'min' : 'max';
    scattered = bestSlots(scoreSlots, {
      durationMinutes: task.durationMinutes,
      notBefore,
      notAfter,
      direction,
    });
    if (scattered) {
      chosen = {
        start: scattered.slots[0].start,
        end: scattered.slots[scattered.slots.length - 1].end,
        scattered: scattered.slots.map((s) => ({ start: s.start, end: s.end })),
      };
    }
  } else if (task.objective === 'cheapest') {
    chosen = bestWindow(available, {
      durationMinutes: task.durationMinutes,
      notBefore,
      notAfter,
      direction: 'min',
    });
  } else {
    const scoreSlots = blend(
      available,
      renewable?.slots,
      task.objective === 'greenest' ? 0 : weight,
    );
    chosen = bestWindow(scoreSlots, {
      durationMinutes: task.durationMinutes,
      notBefore,
      notAfter,
      direction: 'max',
    });
  }

  if (!chosen) {
    return {
      ...base,
      feasible: false,
      problem: 'no unbroken window of that length exists inside the allowed hours',
    };
  }

  // Score the chosen window against the real price series, whatever objective
  // selected it. A greenest window still has a price and you still pay it.
  const spot = task.interruptible
    ? meanOverSlots(available, chosen.scattered)
    : meanOver(available, chosen.start, chosen.end);

  const baselineWindow = bestWindow(prices.slots, {
    durationMinutes: task.durationMinutes,
    notBefore: now,
    notAfter: now + task.durationMinutes * MIN,
    direction: 'min',
  });
  const baselineSpot = baselineWindow ? baselineWindow.mean : null;

  const cost = jobCost(
    { spotEurPerMwh: spot, kw: task.kw, minutes: task.durationMinutes },
    tariff,
  );
  const savings =
    baselineSpot === null
      ? null
      : saving(
          {
            fromSpot: baselineSpot,
            toSpot: spot,
            kw: task.kw,
            minutes: task.durationMinutes,
          },
          tariff,
        );

  const renShare = renewable
    ? task.interruptible
      ? meanOverSlots(renewable.slots, chosen.scattered)
      : meanOver(renewable.slots, chosen.start, chosen.end)
    : null;

  return {
    ...base,
    feasible: true,
    problem: null,
    window: {
      start: chosen.start,
      end: chosen.end,
      scattered: chosen.scattered ?? null,
    },
    spotEurPerMwh: spot,
    baselineSpotEurPerMwh: baselineSpot,
    renewableSharePct: renShare,
    cost,
    savings,
    horizon,
  };
}

function meanOverSlots(series, windows) {
  if (!windows || windows.length === 0) return null;
  let weighted = 0;
  let total = 0;
  for (const w of windows) {
    const m = meanOver(series, w.start, w.end);
    if (m === null) continue;
    const dur = w.end - w.start;
    weighted += m * dur;
    total += dur;
  }
  return total === 0 ? null : weighted / total;
}
