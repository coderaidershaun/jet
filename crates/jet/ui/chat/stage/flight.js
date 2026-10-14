// The path of the live Jet from where it was to its new place in the thread.
// The page moves Jet to the new place first and then draws it back at the old
// place, so the flight is the offset that shrinks to nothing: x and y are
// measured from the slot. It is pure; the page writes the numbers each frame.

const MIN_CRUISE_MS = 520;
const MAX_CRUISE_MS = 1400;
const TURN_SHARE = 0.18;
const MAX_TILT_DEG = 25;
// SMELL: the drop's umbrella opens at this same share of its cruise, so that it opens as the fall
// starts to slow. The two are kept equal by hand, and no test checks that they match.
const DROP_FASTEST_AT = 0.4;
// SMELL: in the abseil Jet kicks once per step and pushes off just as each step's hang ends, and the
// clip keeps its own copy of both numbers. They are kept equal by hand, and no test checks that they match.
const ABSEIL_STEPS = 3;
const ABSEIL_HOLD = 0.6;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
// Speeds up like a falling thing until DROP_FASTEST_AT, then slows to land. The two halves meet at the same
// speed, so the fall never jolts.
const fall = (t) => (t < DROP_FASTEST_AT ? (t * t) / DROP_FASTEST_AT : 1 - ((1 - t) * (1 - t)) / (1 - DROP_FASTEST_AT));
// Goes down in steps: in each one Jet hangs still, then is lowered smoothly to the next height.
const steps = (t) => {
  if (t >= 1) return 1;
  const step = Math.floor(t * ABSEIL_STEPS);
  const within = t * ABSEIL_STEPS - step;
  return (step + smooth(clamp((within - ABSEIL_HOLD) / (1 - ABSEIL_HOLD), 0, 1))) / ABSEIL_STEPS;
};

// How far along the way Jet is at each moment of the move, and whether it turns toward the way it goes.
const PROFILES = {
  roll: { along: smooth, turns: true },
  drop: { along: fall, turns: false },
  abseil: { along: steps, turns: false },
};

/** How long the cruise lasts for a flight of this many pixels. @param {number} distancePx */
export function cruiseMsFor(distancePx) {
  return clamp(260 + 0.8 * distancePx, MIN_CRUISE_MS, MAX_CRUISE_MS);
}

/**
 * @param {{
 *   from: { x: number, y: number }, to: { x: number, y: number },
 *   fromScale: number, toScale: number, startAt: number, durationMs: number,
 *   profile?: 'roll' | 'drop' | 'abseil',
 * }} flight   points are the middle of Jet's body on screen; `profile` is how Jet flies:
 *   `'roll'` turns toward the way Jet goes and mirrors when it goes left, `'drop'` falls faster and
 *   faster and then slows to land, and `'abseil'` goes down in three steps; the last two never turn or mirror
 * @returns {{ endsAt: number, sample: (now: number) => { x: number, y: number, rotate: number, mirror: boolean, scale: number } }}
 */
export function createFlight({ from, to, fromScale, toScale, startAt, durationMs, profile = 'roll' }) {
  if (!Object.hasOwn(PROFILES, profile)) throw new RangeError('there is no flight profile called ' + profile);
  const { along, turns } = PROFILES[profile];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const turn = clamp((Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI, -MAX_TILT_DEG, MAX_TILT_DEG);
  const mirror = turns && dx < 0;

  return {
    /** The time at which Jet has landed on the slot. */
    endsAt: startAt + durationMs,

    sample(now) {
      const progress = durationMs <= 0 ? (now >= startAt ? 1 : 0) : clamp((now - startAt) / durationMs, 0, 1);
      const travelled = along(progress);
      const turned = Math.min(smooth(clamp(progress / TURN_SHARE, 0, 1)), smooth(clamp((1 - progress) / TURN_SHARE, 0, 1)));
      return {
        x: lerp(from.x, to.x, travelled) - to.x,
        y: lerp(from.y, to.y, travelled) - to.y,
        rotate: turns ? turn * turned : 0,
        mirror,
        scale: Math.min(1, lerp(fromScale, toScale, travelled)),
      };
    },
  };
}
