// A track is how one part of Jet changes during a clip: keys in time order.
// This turns a track and a moment in time into the value Jet has then.

import { linear } from './easing.js';
import { lerp } from './maths.js';

/**
 * @typedef {object} Key
 * @property {number} t   milliseconds from the start of the clip
 * @property {number | number[]} v
 * @property {(progress: number) => number} [e]   easing used while arriving at this key
 */

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
