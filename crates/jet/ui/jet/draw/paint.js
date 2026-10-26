// Turns one moment of the kite, a Frame, into a tree of plain SVG nodes. The
// tree has the same shape every frame (parts that are not showing have opacity
// 0), so the view can mount it once and only change attributes. Nothing here
// touches the page.

import { ARCH, ARCH_WIDTH, eyeOrigin, eyePath, lidState } from '../parts/eyes.js';
import { closedCatmullRom, fmt, openCatmullRom } from '../geometry.js';
import { CENTRE, HOVER_Y, kite, morph, spinner } from '../parts/forms.js';
import { fold, speedLines } from '../parts/hand.js';
import { clamp } from '../maths.js';
import { BODY, CREASE, EYE, HAND, STRING } from './palette.js';

const STROKE_FLOOR_PX = 0.8;

const STRING_WIDTH = 1.6;
const CREASE_WIDTH = 1.6;
const SPEED_LINE_WIDTH = 1.7;
const CREASE_SHARE = 0.55;
const EYES_FADE_START = 0.1;
const EYES_FADE_LENGTH = 0.3;

// The bow at the kite's tip, drawn in the reference pose.
const BOW_D =
  'M91 170.3 Q91 168.8 92.34 169.47 L96.86 171.71 Q98.2 172.38 99.7 172.38 L100.3 172.38 ' +
  'Q101.8 172.38 103.14 171.71 L107.66 169.47 Q109 168.8 109 170.3 L109 177.7 Q109 179.2 ' +
  '107.66 178.53 L103.14 176.29 Q101.8 175.62 100.3 175.62 L99.7 175.62 Q98.2 175.62 ' +
  '96.86 176.29 L92.34 178.53 Q91 179.2 91 177.7 Z';

const SPINNER = spinner();

/**
 * @typedef {object} Frame
 * @property {number} x            sideways offset of the whole kite in units: 0 unless the wind has it
 * @property {number} y            tip height above its standing place: 0 standing, 58.8 hovering
 * @property {number} roll         degrees about the pivot, clockwise like SVG rotate
 * @property {number[]} squash     [sx, sy] about the pivot
 * @property {number} form         0 kite .. 1 spinner
 * @property {number[]} lift       [left, right] corner lift in degrees
 * @property {number|number[]} stretch  units added to a lifted corner's reach: one number for both, or [left, right]
 * @property {number[]} liftSpeed  [left, right] degrees per second (the speed lines)
 * @property {number[]} pivot      [x, y] in the reference pose: (100, 88) hovering .. (100, 173) standing
 * @property {{ kind: string, anger: number, squint: number, lids: number[] }} eyes   lids = [left, right] closure 0..1
 * @property {number[][]|null} string   the string's points in page units, or null for no string
 */

/**
 * @typedef {object} PaintNode
 * @property {string} tag
 * @property {Record<string, string | number>} attrs  SVG presentation attributes; never `style`
 * @property {PaintNode[]} [children]
 */

/**
 * The kite hovering at rest with no string: the frame everything else is a change of.
 * @returns {Frame}
 */
export function restingFrame() {
  return {
    x: 0,
    y: HOVER_Y,
    roll: 0,
    squash: [1, 1],
    form: 0,
    lift: [0, 0],
    stretch: 0,
    liftSpeed: [0, 0],
    pivot: [...CENTRE],
    eyes: { kind: 'round', anger: 0, squint: 0, lids: [0, 0] },
    string: null,
  };
}

const node = (tag, className, attrs, children) => ({ tag, attrs: { class: className, ...attrs }, ...(children && { children }) });

// Written with two decimals, rounded up so that the width never falls below the floor.
function strokeWidth(units, unitPx) {
  const wanted = Math.max(units, STROKE_FLOOR_PX / unitPx);
  return Math.ceil(wanted * 100 - 1e-6) / 100;
}

// Every stroke is built here, so none can miss the width floor.
const stroked = (colour, units, unitPx) => ({
  fill: 'none',
  stroke: colour,
  'stroke-width': strokeWidth(units, unitPx),
  'stroke-linecap': 'round',
});

const sideIndex = (side) => (side > 0 ? 1 : 0);
const sideName = (side) => (side > 0 ? 'right' : 'left');

function stringNode(points, unitPx) {
  return node('path', 'jet-string', {
    d: points ? openCatmullRom(points) : '',
    ...stroked(STRING, STRING_WIDTH, unitPx),
    opacity: points ? 1 : 0,
  });
}

function bodyTransform({ x, y, roll, squash, pivot }) {
  const [px, py] = pivot.map(fmt);
  const [negX, negY] = pivot.map((v) => fmt(-v));
  return (
    `translate(${fmt(x)} ${fmt(HOVER_Y - y)}) translate(${px} ${py}) rotate(${fmt(roll)}) ` +
    `scale(${fmt(squash[0])} ${fmt(squash[1])}) translate(${negX} ${negY})`
  );
}

/**
 * Where a point of the kite, given in the reference pose, lands on the page
 * after the same move, turn and squash that the body is drawn with.
 * @param {Pick<Frame, 'x' | 'y' | 'roll' | 'squash' | 'pivot'>} frame
 * @param {number[]} point
 * @returns {number[]}
 */
export function bodyPoint({ x, y, roll, squash, pivot }, point) {
  const radians = (roll * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = (point[0] - pivot[0]) * squash[0];
  const dy = (point[1] - pivot[1]) * squash[1];
  return [x + pivot[0] + dx * cos - dy * sin, pivot[1] + HOVER_Y - y + dx * sin + dy * cos];
}

// The hand and its speed lines fade out as the body turns into the spinner.
function handNode(outline, side, { form, lift, liftSpeed }, unitPx) {
  const share = 1 - form;
  const cornerLift = lift[sideIndex(side)];
  const { fill, crease, strength } = fold(outline, side, cornerLift);
  const lines = speedLines(side, cornerLift, liftSpeed[sideIndex(side)]).map(({ d, opacity }) =>
    node('path', 'jet-line', { d, ...stroked(STRING, SPEED_LINE_WIDTH, unitPx), opacity: fmt(opacity * share) }),
  );
  return node('g', 'jet-hand-' + sideName(side), {}, [
    node('path', 'jet-fold', { d: fill, fill: HAND, opacity: fmt(strength * share) }),
    node('path', 'jet-crease', { d: crease, ...stroked(CREASE, CREASE_WIDTH, unitPx), opacity: fmt(CREASE_SHARE * strength * share) }),
    ...lines,
  ]);
}

function eyeNode(side, { eyes, form }, unitPx) {
  const share = clamp(1 - (form - EYES_FADE_START) / EYES_FADE_LENGTH, 0, 1);
  const { scaleY, shapeOpacity, archOpacity } = lidState(eyes.lids[sideIndex(side)]);
  const [originX, originY] = eyeOrigin(side);
  return node('g', 'jet-eye-' + sideName(side), { transform: `translate(${fmt(originX)} ${fmt(originY)})` }, [
    node('path', 'jet-eye-shape', {
      d: eyePath(side, eyes),
      fill: EYE,
      transform: `scale(1 ${fmt(scaleY)})`,
      opacity: fmt(shapeOpacity * share),
    }),
    node('path', 'jet-arch', { d: ARCH, ...stroked(EYE, ARCH_WIDTH, unitPx), opacity: fmt(archOpacity * share) }),
  ]);
}

/**
 * @param {Frame} frame
 * @param {{ unitPx: number }} view  how many screen pixels one unit is; thin strokes widen to stay visible
 * @returns {PaintNode}
 */
export function paint(frame, { unitPx }) {
  const outline = kite({ liftLeft: frame.lift[0], liftRight: frame.lift[1], stretch: frame.stretch });
  return node('g', 'jet', {}, [
    stringNode(frame.string, unitPx),
    node('g', 'jet-body', { transform: bodyTransform(frame) }, [
      node('path', 'jet-shape', { d: closedCatmullRom(morph(outline, SPINNER, frame.form)), fill: BODY }),
      handNode(outline, -1, frame, unitPx),
      handNode(outline, 1, frame, unitPx),
      node('path', 'jet-bow', { d: BOW_D, fill: STRING }),
      eyeNode(-1, frame, unitPx),
      eyeNode(1, frame, unitPx),
    ]),
  ]);
}
