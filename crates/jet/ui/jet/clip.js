// What a clip is: the six tracks, the length, the phases and the readout that
// every clip builder returns, and the dials every builder is given.

/**
 * @typedef {object} Clip
 * @property {import('./track.js').Key[]} body
 * @property {import('./track.js').Key[]} eyes
 * @property {import('./track.js').Key[]} colour
 * @property {import('./track.js').Key[]} scale
 * @property {import('./track.js').Key[]} [ring]
 * @property {import('./track.js').Key[]} [speed]
 * @property {number} total                          clip length in ms
 * @property {{ name: string, end: number }[]} phases  in order, ends in ms
 * @property {{ label: string, value: string, on?: boolean }[]} readout
 */

/**
 * @typedef {object} Params
 * @property {number} candid    -1 (deferential) .. 1 (candid)
 * @property {number} playful   -1 (serious) .. 1 (playful)
 * @property {number} shape     0..10
 * @property {number} eyes      0..10
 * @property {number} colour    0..10
 * @property {number} motion    0..10
 * @property {boolean} reducedMotion
 */

export {};
