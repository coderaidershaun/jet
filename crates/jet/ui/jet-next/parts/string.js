// The string. It is a chain of 16 short segments hanging from the kite's tip,
// each with its own angle. The angles come from a gentle wind, how fast the
// kite is carried sideways, and an optional pose the chain is blended into
// with lag and overshoot. The free end can also write a route, such as a fist.
// The chain keeps no state: the same inputs always give the same points, at
// any frame rate.

import { easeOutBack } from '../easing.js';
import { bezier, resample } from '../geometry.js';
import { clamp } from '../maths.js';

export const SEGMENTS = 16;
export const SEGMENT_LENGTH = 3.75;
export const REST_LENGTH = SEGMENTS * SEGMENT_LENGTH;
// SMELL: the floor is typed in to fit a standing kite's string; a new hover height leaves it behind.
export const FLOOR = 237.5;
export const WRITTEN_SAMPLES = 130;

const DRAG_PER_UNIT = 0.08;
const MAX_DRAG_DEGREES = 60;
const WIND_SHARE_IN_POSE = 0.3;
const HAND_TILT = 0.25;

/** The wind's two speeds in hertz: the slow lean, then the travelling ripple. */
export const WIND_HZ = [0.35, 0.55];

const alongChain = (i) => (i + 0.5) / SEGMENTS;

/**
 * Degrees away from straight down for segment `i`, from a slow lean to the left
 * that breathes plus a faster ripple that travels towards the free end.
 * @param {number} i  0 at the tip, 15 at the free end
 * @param {number} t  seconds
 * @param {number[]} [hz]  the speeds of the lean and of the ripple
 */
export function wind(i, t, hz = WIND_HZ) {
  const along = alongChain(i);
  return (
    -7 * Math.sin(Math.PI * along) * (0.6 + 0.4 * Math.sin(2 * Math.PI * hz[0] * t - 2.5 * along)) +
    4.5 * along * Math.sin(2 * Math.PI * hz[1] * t - 3.0 * along)
  );
}

/**
 * How far segment `i` has moved from hanging into a pose at time `t`: 0 hanging,
 * 1 in the pose, above 1 while it overshoots. Each segment starts a little after
 * the one before it, so the string whips.
 * @param {number} i
 * @param {number} t
 * @param {object} timing
 * @param {number} timing.start      seconds when the first segment to move starts
 * @param {number} timing.lag        seconds between one segment starting and the next
 * @param {number} timing.duration   seconds each segment takes
 * @param {number} timing.overshoot  how far past the pose it swings
 * @param {'base' | 'tip'} [timing.order]  which end moves first
 */
export function raiseBlend(i, t, { start, lag, duration, overshoot, order = 'base' }) {
  const rank = order === 'base' ? i : SEGMENTS - 1 - i;
  return easeOutBack(overshoot)(clamp((t - (start + rank * lag)) / duration, 0, 1));
}

/**
 * The angles of a pose that follows a line of 17 points, and the length of the
 * line. `proportions` are the chords divided by their mean, so a chain in the
 * pose keeps their slight unevenness.
 * @param {number[][]} points
 * @returns {{ angles: number[], proportions: number[], length: number }}
 */
export function poseFromPoints(points) {
  const chords = points.slice(1).map((p, i) => [p[0] - points[i][0], p[1] - points[i][1]]);
  const lengths = chords.map(([dx, dy]) => Math.hypot(dx, dy));
  const length = lengths.reduce((sum, chordLength) => sum + chordLength, 0);
  return {
    angles: chords.map(([dx, dy]) => (Math.atan2(dy, dx) * 180) / Math.PI),
    proportions: lengths.map((chordLength) => (chordLength * SEGMENTS) / length),
    length,
  };
}

/**
 * The J the string is raised into when the kite is insulted: down from the tip,
 * across and up into a wrist at (166, 192). Its length is 95.54, so a chain in
 * it needs a payout of about 1.59.
 */
export function jPose() {
  const tip = [100, 173];
  const wrist = [166, 192];
  const curve = bezier(tip, [tip[0], tip[1] + 38], [wrist[0], wrist[1] + 32], wrist);
  return poseFromPoints(resample(curve, SEGMENTS + 1));
}

/**
 * The string lying on the floor to the left of a standing kite, whose tip is at
 * (100, 231.8): it leaves the tip steeply downward, then runs flat.
 */
export function lyingPose() {
  const tip = [100, 231.8];
  const at = (dx, dy) => [tip[0] + dx, tip[1] + dy];
  return poseFromPoints(resample(bezier(tip, at(-3, 5.6), at(-15, 5.6), at(-58, 5.2)), SEGMENTS + 1));
}

// SMELL: a hanging chain has even segments, but the insult animation's string keeps
// the J pose's uneven segments from its first frame, so the two match only once the
// pose is fully blended in.
/**
 * One chain of 16 segments. It holds no state; it exists so that a caller has
 * one thing to keep and ask for points.
 * @param {object} [options]
 * @param {number[]} [options.windHz]  the wind's two speeds in hertz; the default is the character's own wind
 */
export function createChain({ windHz = WIND_HZ } = {}) {
  /**
   * The string's points, from the tip to the free end.
   * @param {object} input
   * @param {number[]} input.tip     where the tip is, in page units
   * @param {number} input.t         seconds, for the wind
   * @param {{ angles: number[], blend: number[], proportions?: number[] }|null} [input.pose]
   *   null hangs; otherwise each segment blends from hanging towards its pose angle by its own `blend`
   * @param {number} [input.payout]  scales every segment's length
   * @param {number} [input.drag]    the tip's sideways speed in units per second, already smoothed; the chain leans away from it
   * @param {{ route: { points: number[][], totalLength: number }, length: number, scale: number, tremor: number }|null} [input.written]
   *   the free end writes this much (`length`) of the route, in `scale` times the route's units, shaken sideways by `tremor`
   * @param {number} [input.floor]   no point goes lower on the page than this
   * @returns {number[][]}  17 points, or 16 plus 130 written points when `written` is given
   */
  function points({ tip, t, pose = null, payout = 1, drag = 0, written = null, floor = FLOOR }) {
    const chain = [tip];
    for (let i = 0; i < SEGMENTS; i++) {
      const windDegrees = wind(i, t, windHz);
      const rest = 90 + windDegrees + clamp(DRAG_PER_UNIT * drag * alongChain(i), -MAX_DRAG_DEGREES, MAX_DRAG_DEGREES);
      const blend = pose ? pose.blend[i] : 0;
      const degrees = pose ? rest + blend * (pose.angles[i] + WIND_SHARE_IN_POSE * windDegrees - rest) : rest;
      const proportion = pose && pose.proportions ? 1 + blend * (pose.proportions[i] - 1) : 1;
      const length = SEGMENT_LENGTH * payout * proportion;
      const radians = (degrees * Math.PI) / 180;
      const previous = chain[i];
      chain.push([previous[0] + length * Math.cos(radians), previous[1] + length * Math.sin(radians)]);
    }
    const all = written ? [...chain.slice(0, SEGMENTS), ...writtenPoints(chain, written)] : chain;
    return all.map(([x, y]) => [x, Math.min(y, floor)]);
  }
  return { points };
}

const unit = (v) => {
  const length = Math.hypot(v[0], v[1]);
  return [v[0] / length, v[1] / length];
};

// The hand sits on the end of the string, turned a quarter of the way towards
// the last segment's direction, so it shakes with the string.
function writtenPoints(chain, { route, length, scale, tremor }) {
  const wrist = chain[SEGMENTS];
  const last = [wrist[0] - chain[SEGMENTS - 1][0], wrist[1] - chain[SEGMENTS - 1][1]];
  // A string reeled in has no last segment to point along, so the hand stays upright.
  const end = Math.hypot(last[0], last[1]) === 0 ? [0, 1] : unit(last);
  const up = unit([HAND_TILT * end[0], HAND_TILT * end[1] - (1 - HAND_TILT)]);
  const right = [-up[1], up[0]];
  return resample(route.points, WRITTEN_SAMPLES, length / route.totalLength).map(([x, y]) => [
    wrist[0] + scale * ((x + tremor) * right[0] + y * up[0]),
    wrist[1] + scale * ((x + tremor) * right[1] + y * up[1]),
  ]);
}
