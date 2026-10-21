// The path of the live Jet from where it was to its new place in the thread.
// The page moves Jet to the new place first and then draws it back at the old
// place, so the flight is the offset that shrinks to nothing: x and y are
// measured from the slot. It is pure; the page writes the numbers each frame.

const MIN_CRUISE_MS = 520;
const MAX_CRUISE_MS = 1400;
const TURN_SHARE = 0.18;
const MAX_TILT_DEG = 25;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** How long the cruise lasts for a flight of this many pixels. @param {number} distancePx */
export function cruiseMsFor(distancePx) {
  return clamp(260 + 0.8 * distancePx, MIN_CRUISE_MS, MAX_CRUISE_MS);
}

/**
 * Jet rolls there: it turns toward the way it goes, and mirrors when it goes left.
 * @param {{
 *   from: { x: number, y: number }, to: { x: number, y: number },
 *   fromScale: number, toScale: number, startAt: number, durationMs: number,
 * }} flight   points are the middle of Jet's body on screen
 * @returns {{ endsAt: number, sample: (now: number) => { x: number, y: number, rotate: number, mirror: boolean, scale: number } }}
 */
export function createFlight({ from, to, fromScale, toScale, startAt, durationMs }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const turn = clamp((Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI, -MAX_TILT_DEG, MAX_TILT_DEG);
  const mirror = dx < 0;

  return {
    /** The time at which Jet has landed on the slot. */
    endsAt: startAt + durationMs,

    sample(now) {
      const progress = durationMs <= 0 ? (now >= startAt ? 1 : 0) : clamp((now - startAt) / durationMs, 0, 1);
      const travelled = smooth(progress);
      const turned = Math.min(smooth(clamp(progress / TURN_SHARE, 0, 1)), smooth(clamp((1 - progress) / TURN_SHARE, 0, 1)));
      return {
        x: lerp(from.x, to.x, travelled) - to.x,
        y: lerp(from.y, to.y, travelled) - to.y,
        rotate: turn * turned,
        mirror,
        scale: Math.min(1, lerp(fromScale, toScale, travelled)),
      };
    },
  };
}
