// The hand: the lifted corner drawn as a folded-over lighter face with a
// crease, and the two short arcs that trail it when it moves fast. The face and
// crease are built from the kite's own outline, so they always sit on the body.

import { smoothstep } from '../easing.js';
import { fmt, fmtPoint, resample, walk } from '../geometry.js';
import { CENTRE, HALF_WIDTH, LEFT_HAND, PIVOT_DX, POINTS, RIGHT_HAND } from './forms.js';
import { clamp } from '../maths.js';

const HAND_LENGTH = 26;
const HAND_SAMPLES = 16;
const CREASE_BOW = 3;

/**
 * The hand's fill and crease paths, and a 0..1 strength that fades both in as
 * the corner lifts (nothing below 3 degrees, everything above 13).
 *
 * The paths are always returned, even at strength 0, so their shape stays the
 * same from frame to frame. Both end on the outline, at the points 26 units
 * either side of the corner, and the crease bows 3 units into the body.
 * @param {number[][]} outline  the kite's 52 points
 * @param {1 | -1} side         -1 for the left corner, 1 for the right
 * @param {number} lift         degrees
 * @returns {{ fill: string, crease: string, strength: number }}
 */
export function fold(outline, side, lift) {
  const corner = side > 0 ? RIGHT_HAND : LEFT_HAND;
  const towardTop = side > 0 ? -1 : 1;
  const upper = walk(outline, corner, towardTop, HAND_LENGTH);
  const lower = walk(outline, corner, -towardTop, HAND_LENGTH);

  const edge = [upper.point];
  for (let i = upper.index; ; i = (i - towardTop + POINTS) % POINTS) {
    edge.push(outline[i]);
    if (i === lower.index) break;
  }
  edge.push(lower.point);
  const hand = resample(edge, HAND_SAMPLES);

  const mid = [(upper.point[0] + lower.point[0]) / 2, (upper.point[1] + lower.point[1]) / 2];
  const toCorner = [outline[corner][0] - mid[0], outline[corner][1] - mid[1]];
  const length = Math.hypot(toCorner[0], toCorner[1]);
  const control = [mid[0] - (CREASE_BOW * toCorner[0]) / length, mid[1] - (CREASE_BOW * toCorner[1]) / length];

  const bend = ' Q' + fmtPoint(control) + ' ' + fmtPoint(upper.point);
  return {
    fill: 'M' + hand.map(fmtPoint).join(' L') + bend + ' Z',
    crease: 'M' + fmtPoint(lower.point) + bend,
    strength: smoothstep((lift - 3) / 10),
  };
}

const LINES = [
  { extraRadius: 6, behindDegrees: 6, spanDegrees: 12, share: 1 },
  { extraRadius: 12, behindDegrees: 9, spanDegrees: 10, share: 0.65 },
];

/**
 * Two short arcs just outside the hand, trailing its motion: below a rising
 * corner, above a falling one. Both always exist; they are invisible (opacity
 * 0) until the corner moves faster than 35 degrees a second.
 * @param {1 | -1} side
 * @param {number} lift       degrees
 * @param {number} liftSpeed  degrees per second; positive is rising
 * @returns {{ d: string, opacity: number }[]}
 */
export function speedLines(side, lift, liftSpeed) {
  const strength = clamp((Math.abs(liftSpeed) - 35) / 90, 0, 1);
  const pivot = [CENTRE[0] + side * PIVOT_DX, CENTRE[1]];
  const reach = HALF_WIDTH - PIVOT_DX;
  const trailing = liftSpeed > 0 ? 1 : -1;
  const onCircle = (radius, degrees) => {
    const angle = (degrees * Math.PI) / 180;
    return [pivot[0] + side * radius * Math.cos(angle), pivot[1] + radius * Math.sin(angle)];
  };
  return LINES.map(({ extraRadius, behindDegrees, spanDegrees, share }) => {
    const radius = reach + extraRadius;
    const near = onCircle(radius, -lift + trailing * behindDegrees);
    const far = onCircle(radius, -lift + trailing * (behindDegrees + spanDegrees));
    const sweep = (trailing > 0) === (side > 0) ? 1 : 0;
    return {
      d: 'M' + fmtPoint(near) + ' A' + fmt(radius) + ' ' + fmt(radius) + ' 0 0 ' + sweep + ' ' + fmtPoint(far),
      opacity: 0.85 * share * strength,
    };
  });
}
