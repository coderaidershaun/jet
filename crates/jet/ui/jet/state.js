// Jet at one moment. The shape of a state, the names of the seven tracks that
// change it, how the ring and the props are stored as numbers, and how a
// colour becomes CSS.

/**
 * @typedef {object} JetState
 * @property {number[]} body     one pose, 60 numbers
 * @property {number[]} eyes     left x,y · right x,y · rx · ry · tint (0 the ground colour, 1 the body colour lightened toward white)
 * @property {number[]} colour   r,g,b
 * @property {number} scale      about the foot
 * @property {number[]} ring     see RING below
 * @property {number} speed      ground speed for scenery, units per second
 * @property {number[]} prop     two prop slots, see PROP below
 * @property {(string | null)[]} propKinds   what each prop slot draws, named by the clip that is playing
 */

export const TRACKS = /** @type {const} */ (['body', 'eyes', 'colour', 'scale', 'ring', 'speed', 'prop']);

/**
 * The ring is the one stroked element beside the body: the working loop, and
 * the spin grooves when Jet rolls. Stored as eleven numbers so it tweens:
 * cx, cy, rx, ry, rotate (degrees), stroke width, dash on, dash off,
 * dash offset, opacity, colour mix (0 = ground colour, 1 = body colour).
 */
export const RING = { CX: 0, CY: 1, RX: 2, RY: 3, ROTATE: 4, WIDTH: 5, DASH_ON: 6, DASH_OFF: 7, OFFSET: 8, OPACITY: 9, MIX: 10 };
export const RING_HIDDEN = Object.freeze([50, 56, 0, 0, 0, 0, 1, 0, 0, 0, 0]);

/**
 * Props are things Jet holds or uses, such as an umbrella. There are two
 * slots, each stored as five numbers so it tweens: x, y, rotate (degrees),
 * scale, opacity. `PROP` gives the place of each number inside a slot, and
 * slot `i` starts at `i * PROP_STRIDE`. A hidden prop has opacity 0 and stays
 * in the page, so it can fade back in. The clip names what each slot draws,
 * from `PROP_KINDS`.
 */
export const PROP = { X: 0, Y: 1, ROTATE: 2, SCALE: 3, OPACITY: 4 };
export const PROP_STRIDE = 5;
export const PROP_SLOTS = 2;
export const PROP_HIDDEN = Object.freeze([50, 56, 0, 1, 0, 50, 56, 0, 1, 0]);
export const PROP_KINDS = Object.freeze(['umbrella', 'bat', 'ball', 'rope']);

/**
 * @param {number[]} rgb
 * @returns {string}
 */
export function cssColour(rgb) {
  return 'rgb(' + rgb.map((v) => Math.round(v)).join(',') + ')';
}
