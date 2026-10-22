// Jet at one moment: what a state holds, the names of the tracks that change
// it, and the state Jet rests in, hovering or standing.

import { HOVER_Y } from './parts/forms.js';
import { lyingPose, SEGMENTS } from './parts/string.js';

/**
 * A string pose has two forms. In the state it is what the player drew:
 * `{ angles, proportions?, blend }`, or null for a hanging string. In a clip
 * key it can also be `{ angles, proportions?, raise: { to, lagMs, durationMs, overshoot, order } }`,
 * which moves every segment's blend from where it is to `to`, segment by
 * segment with lag and overshoot. A raise cannot be written as keys on one
 * array track, because each segment has its own start time, so the player
 * works the blend out and a clip only says when the raise starts.
 * @typedef {{ angles: number[], proportions?: number[], blend: number[] } | null} StringPose
 */

/**
 * @typedef {object} JetState
 * @property {number} y         tip height above its standing place: 0 standing, 58.8 hovering
 * @property {number} roll      body rotation, degrees, clockwise like SVG rotate; the spinner turns with it
 * @property {number[]} lift    [left, right] corner lift, degrees
 * @property {number[]} squash  [sx, sy] about the pivot
 * @property {number} form      0 kite .. 1 spinner
 * @property {number[]} lids    [left, right] closure 0..1 (a little below 0 during an overshoot)
 * @property {string} eyeKind   round | lid | B | C   (step track)
 * @property {number} anger     0..1, the lid polygon's scowl
 * @property {number} squint    0..1
 * @property {number} payout    string length factor, 1 at rest
 * @property {StringPose} stringPose   null hangs   (step track)
 * @property {{ route: { points: number[][], totalLength: number }, length: number, scale: number, tremor: number } | null} written   the route the string's free end writes   (step track)
 */

export const TRACKS = /** @type {const} */ (['y', 'roll', 'lift', 'squash', 'form', 'lids', 'eyeKind', 'anger', 'squint', 'payout', 'stringPose', 'written']);

/** The tracks whose value is a choice, not a quantity: they hold instead of blending. */
export const STEP_TRACKS = /** @type {const} */ (['eyeKind', 'stringPose', 'written']);

/**
 * Jet at rest. Hovering the string hangs; standing it lies on the floor.
 * @param {{ standing?: boolean }} [options]
 * @returns {JetState}
 */
export function restState({ standing = false } = {}) {
  const { angles, proportions } = lyingPose();
  return {
    y: standing ? 0 : HOVER_Y,
    roll: 0,
    lift: [0, 0],
    squash: [1, 1],
    form: 0,
    lids: [0, 0],
    eyeKind: 'round',
    anger: 0,
    squint: 0,
    payout: 1,
    stringPose: standing ? { angles, proportions, blend: Array(SEGMENTS).fill(1) } : null,
    written: null,
  };
}
