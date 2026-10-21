// Jet at one moment. The shape of a state, the names of the six tracks that
// change it, how the ring is stored as numbers, and how a colour becomes CSS.

/**
 * @typedef {object} JetState
 * @property {number[]} body     one pose, 60 numbers
 * @property {number[]} eyes     left x,y · right x,y · rx · ry, drawn in the ground colour
 * @property {number[]} colour   r,g,b
 * @property {number} scale      about the foot
 * @property {number[]} ring     see RING below
 * @property {number} speed      ground speed for scenery, units per second
 */

export const TRACKS = /** @type {const} */ (['body', 'eyes', 'colour', 'scale', 'ring', 'speed']);

/**
 * The ring is the one stroked element beside the body: the working loop, and
 * the spin grooves when Jet rolls. Stored as eleven numbers so it tweens:
 * cx, cy, rx, ry, rotate (degrees), stroke width, dash on, dash off,
 * dash offset, opacity, colour mix (0 = ground colour, 1 = body colour).
 */
export const RING = { CX: 0, CY: 1, RX: 2, RY: 3, ROTATE: 4, WIDTH: 5, DASH_ON: 6, DASH_OFF: 7, OFFSET: 8, OPACITY: 9, MIX: 10 };
export const RING_HIDDEN = Object.freeze([50, 56, 0, 0, 0, 0, 1, 0, 0, 0, 0]);

/**
 * @param {number[]} rgb
 * @returns {string}
 */
export function cssColour(rgb) {
  return 'rgb(' + rgb.map((v) => Math.round(v)).join(',') + ')';
}
