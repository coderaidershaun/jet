// The body's outline in the hovering pose, and how far the body moves down
// when the kite stands. Both shapes the body takes, the kite and the loading
// spinner, are 52 points in the same order, so any blend of the two is just a
// point-by-point mix and draws as a smooth closed shape.

import { arc, quadrantAffine } from '../geometry.js';
import { clamp, lerp } from '../maths.js';

export const POINTS = 52;
// Point 0 is the top; the points run clockwise.
export const TOP = 0;
export const RIGHT_HAND = 13;
export const TIP = 26;
export const LEFT_HAND = 39;

export const CENTRE = [100, 88];
export const HALF_WIDTH = 73;
export const PIVOT_DX = 22;
// The hovering kite is the reference pose; standing moves it down by this much.
export const HOVER_Y = 58.8;
const HEIGHT_ABOVE = 71;
const HEIGHT_BELOW = 85;
const EXPONENT_ABOVE = 1.3;
const EXPONENT_BELOW = 1.2;
const FULL_LIFT = 33;

/**
 * The kite's outline: 52 points, with a corner optionally lifted.
 *
 * A lifted corner swings on an arc about a pivot inside the body. The two sides
 * that meet at it are redrawn: the upper side tightens and the lower side bows
 * out, like a sheet whose corner is held up. A negative lift swings the corner
 * below the horizontal.
 * @param {object} [options]
 * @param {number} [options.liftLeft]   degrees
 * @param {number} [options.liftRight]  degrees
 * @param {number|number[]} [options.stretch]  units added to a lifted corner's reach: one number for both corners, or [left, right]
 * @returns {number[][]}
 */
export function kite({ liftLeft = 0, liftRight = 0, stretch = 0 } = {}) {
  const [stretchLeft, stretchRight] = Array.isArray(stretch) ? stretch : [stretch, stretch];
  const top = [CENTRE[0], CENTRE[1] - HEIGHT_ABOVE];
  const tip = [CENTRE[0], CENTRE[1] + HEIGHT_BELOW];

  /** @param {1 | -1} side */
  function corner(side, lift, extraReach) {
    const pivot = [CENTRE[0] + side * PIVOT_DX, CENTRE[1]];
    const reach = HALF_WIDTH - PIVOT_DX + extraReach;
    const angle = (-lift * Math.PI) / 180;
    const lifted = clamp(lift / FULL_LIFT, 0, 1);
    return {
      point: [pivot[0] + side * reach * Math.cos(angle), pivot[1] + reach * Math.sin(angle)],
      exponentAbove: Math.max(1.04, EXPONENT_ABOVE - 0.24 * lifted),
      exponentBelow: EXPONENT_BELOW + 0.18 * lifted,
    };
  }
  const right = corner(1, liftRight, stretchRight);
  const left = corner(-1, liftLeft, stretchLeft);

  const quadrants = [
    quadrantAffine(CENTRE, top, right.point, right.exponentAbove),
    quadrantAffine(CENTRE, right.point, tip, right.exponentBelow),
    quadrantAffine(CENTRE, tip, left.point, left.exponentBelow),
    quadrantAffine(CENTRE, left.point, top, left.exponentAbove),
  ];
  return quadrants.flatMap((quadrant) => quadrant.slice(0, -1));
}

const BAND_RADIUS = 52;
const BAND_THICKNESS = 22;
const GAP_DEGREES = 79;
const OUTER_FIRST = 6;
const OUTER_LAST = 46;
// Where the points sit around a rounded end, in degrees from its outer side towards its inner side.
const CAP_DEGREES = [60, 120];
const INNER_POINTS = 7;

/**
 * The loading spinner's outline: a C-shaped band about the kite's centre with
 * its opening at the top, as 52 points matching the kite's.
 *
 * The kite's points 6 to 46 become the outer edge. The other 11 run back along
 * the band's inner side (a rounded end, the inner edge, a rounded end), so the
 * kite's top folds down into the hole.
 * @returns {number[][]}
 */
export function spinner() {
  const half = BAND_THICKNESS / 2;
  const rightEdge = -90 + GAP_DEGREES / 2;
  // The left edge is written past 180 degrees so the angles keep rising as the band runs clockwise.
  const leftEdge = 270 - GAP_DEGREES / 2;
  const onCircle = (centre, radius, degrees) => {
    const angle = (degrees * Math.PI) / 180;
    return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)];
  };
  const leftEnd = onCircle(CENTRE, BAND_RADIUS, leftEdge);
  const rightEnd = onCircle(CENTRE, BAND_RADIUS, rightEdge);

  const outer = arc(CENTRE[0], CENTRE[1], BAND_RADIUS + half, BAND_RADIUS + half, rightEdge, leftEdge, OUTER_LAST - OUTER_FIRST + 1);
  // The return path gets its points by shape, not by length: with evenly spaced points
  // each rounded end would get about one and the curve through them would swing wide.
  const back = [
    ...CAP_DEGREES.map((degrees) => onCircle(leftEnd, half, leftEdge + degrees)),
    ...arc(CENTRE[0], CENTRE[1], BAND_RADIUS - half, BAND_RADIUS - half, leftEdge, rightEdge, INNER_POINTS),
    ...CAP_DEGREES.map((degrees) => onCircle(rightEnd, half, rightEdge + 360 - degrees)).reverse(),
  ];

  const points = new Array(POINTS);
  outer.forEach((point, k) => (points[OUTER_FIRST + k] = point));
  back.forEach((point, k) => (points[(OUTER_LAST + 1 + k) % POINTS] = point));
  return points;
}

/**
 * A point-by-point blend of two outlines: `k` 0 gives `a`, 1 gives `b`.
 * @param {number[][]} a
 * @param {number[][]} b
 * @param {number} k
 * @returns {number[][]}
 */
export function morph(a, b, k) {
  return a.map((point, i) => lerp(point, b[i], k));
}
