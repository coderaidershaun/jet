// The eyes. Every eye is drawn in its own space whose origin sits on the lower
// lid line, with x to the right and y down, so any kind of eye can replace
// another and a lid can close by squashing it towards that line.

import { CENTRE } from './forms.js';
import { fmtPoint, roundedPolygon } from '../geometry.js';

export const KINDS = ['round', 'lid', 'B', 'C'];
export const EYE_DX = 15.5;
export const LID_Y = 89.9;
export const ARCH = 'M-8.5 0 Q0 -3.2 8.5 0';
export const ARCH_WIDTH = 3.2;

const HALF_WIDTH = 8.5;
const HEIGHT = 17;
const ROUND_RADIUS = 7.5;
const CIRCLE_KAPPA = 0.5523;
const C_HALF_WIDTH = 4.89;

/**
 * Where the eye's own space sits on the page.
 * @param {1 | -1} side  -1 for the left eye, 1 for the right
 * @returns {number[]}
 */
export const eyeOrigin = (side) => [CENTRE[0] + side * EYE_DX, LID_Y];

function roundEye() {
  const r = ROUND_RADIUS;
  const k = CIRCLE_KAPPA * r;
  const curve = (c1, c2, end) => 'C' + [c1, c2, end].map(fmtPoint).join(' ');
  return [
    'M0 0',
    curve([-k, 0], [-r, -r + k], [-r, -r]),
    curve([-r, -r - k], [-k, -2 * r], [0, -2 * r]),
    curve([k, -2 * r], [r, -r - k], [r, -r]),
    curve([r, -r + k], [k, 0], [0, 0]),
  ].join(' ') + ' Z';
}

function lidEye(side, anger, squint) {
  const inner = -side * HALF_WIDTH;
  const outer = side * HALF_WIDTH;
  const shift = -side * 1.5 * anger;
  const outerTopStart = outer * 0.9 + inner * 0.1;
  const innerTop = [inner + shift, -HEIGHT + 13.5 * anger];
  const innerBottom = [inner + shift, 0];
  const outerBottom = [outer + shift, 0];
  const outerTop = [outerTopStart + shift + anger * (outer - outerTopStart), -1.7 + anger * (-10.5 + 1.7)];
  const squash = 1 - 0.4 * squint;
  return roundedPolygon([[innerTop[0], innerTop[1] * squash], innerBottom, outerBottom, [outerTop[0], outerTop[1] * squash]], 1);
}

function triangleB(side) {
  const inner = -side * HALF_WIDTH;
  const outer = side * HALF_WIDTH;
  return roundedPolygon([[inner, -HEIGHT], [outer, -HEIGHT], [inner, 0]], 1);
}

function triangleC(side) {
  const inner = -side * C_HALF_WIDTH;
  const outer = side * C_HALF_WIDTH;
  return roundedPolygon([[inner, -19.55], [inner, 0], [outer, -9.78]], 1);
}

/**
 * The open eye's outline in the eye's own space.
 *
 * `lid` is the lid-shaped eye the animations use: with `anger` 0 it is the
 * rest triangle, with `anger` 1 the lids slant into a scowl, and `squint`
 * shortens the whole eye. `anger` and `squint` only affect `lid`.
 * @param {1 | -1} side  -1 for the left eye, 1 for the right
 * @param {{ kind: string, anger?: number, squint?: number }} look
 * @returns {string}
 */
export function eyePath(side, { kind, anger = 0, squint = 0 }) {
  switch (kind) {
    case 'round':
      return roundEye();
    case 'lid':
      return lidEye(side, anger, squint);
    case 'B':
      return triangleB(side);
    case 'C':
      return triangleC(side);
    default:
      throw new Error(`unknown eye kind "${kind}"; expected one of ${KINDS.join(', ')}`);
  }
}

/**
 * How a lid closing by `closure` (0 open, 1 shut) draws: the open shape is
 * squashed towards the lid line and fades out as the shallow arch fades in.
 * @param {number} closure
 * @returns {{ scaleY: number, shapeOpacity: number, archOpacity: number }}
 */
export function lidState(closure) {
  return {
    scaleY: Math.max(0.04, 1 - closure),
    shapeOpacity: closure < 0.9 ? 1 : Math.max(0, 1 - (closure - 0.9) / 0.08),
    archOpacity: closure < 0.6 ? 0 : Math.min(1, (closure - 0.6) / 0.3),
  };
}
