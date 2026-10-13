// The shape maths every clip and renderer shares: blending poses, turning a
// pose into an SVG path, and sampling a keyframe track at a moment in time.

import { linear } from './easing.js';

export const ANCHORS = 10;
export const STRIDE = 6; // point x,y · outgoing handle x,y · incoming handle x,y

/**
 * @typedef {object} Rig
 * @property {number} version
 * @property {number} unit
 * @property {number} stroke
 * @property {[number, number]} foot
 * @property {Record<string, number[]>} poses   60 numbers each
 * @property {Record<string, [number, number, number, number]>} eyes   left x,y · right x,y
 * @property {Record<string, [number, number, number]>} palette   r,g,b
 */

/**
 * @typedef {object} Key
 * @property {number} t   milliseconds from the start of the clip
 * @property {number | number[]} v
 * @property {(progress: number) => number} [e]   easing used while arriving at this key
 */

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The ring is the one stroked element beside the body: the working loop, and
 * the spin grooves when Jet rolls. Stored as eleven numbers so it tweens:
 * cx, cy, rx, ry, rotate (degrees), stroke width, dash on, dash off,
 * dash offset, opacity, colour mix (0 = ground colour, 1 = body colour).
 */
export const RING = { CX: 0, CY: 1, RX: 2, RY: 3, ROTATE: 4, WIDTH: 5, DASH_ON: 6, DASH_OFF: 7, OFFSET: 8, OPACITY: 9, MIX: 10 };
export const RING_HIDDEN = Object.freeze([50, 56, 0, 0, 0, 0, 1, 0, 0, 0, 0]);

/**
 * Linear blend of two numbers or two equal-length arrays. `t` may run past
 * 0..1; that is how a pose gets exaggerated beyond the way it was drawn.
 * @template {number | number[]} T
 * @param {T} a
 * @param {T} b
 * @param {number} t
 * @returns {T}
 */
export function lerp(a, b, t) {
  if (typeof a === 'number') return /** @type {T} */ (a + (/** @type {number} */ (b) - a) * t);
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (/** @type {number[]} */ (b)[i] - a[i]) * t;
  return /** @type {T} */ (out);
}

/**
 * @param {number[]} pose
 * @returns {string} SVG path data
 */
export function pathFrom(pose) {
  let d = 'M' + pose[0].toFixed(1) + ' ' + pose[1].toFixed(1);
  for (let i = 0; i < ANCHORS; i++) {
    const j = (i + 1) % ANCHORS;
    d += ' C' + pose[i * STRIDE + 2].toFixed(1) + ' ' + pose[i * STRIDE + 3].toFixed(1)
      + ' ' + pose[j * STRIDE + 4].toFixed(1) + ' ' + pose[j * STRIDE + 5].toFixed(1)
      + ' ' + pose[j * STRIDE].toFixed(1) + ' ' + pose[j * STRIDE + 1].toFixed(1);
  }
  return d + ' Z';
}

/**
 * Value of a track at time `t`. Keys must be sorted by time. Before the first
 * key the first value holds; after the last key the last value holds.
 * @param {Key[]} track
 * @param {number} t
 */
export function sample(track, t) {
  if (t <= track[0].t) return track[0].v;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t <= b.t) {
      const u = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return lerp(a.v, b.v, (b.e || linear)(u));
    }
  }
  return track[track.length - 1].v;
}

/**
 * @param {number[]} rgb
 * @returns {string}
 */
export function cssColour(rgb) {
  return 'rgb(' + rgb.map((v) => Math.round(v)).join(',') + ')';
}
