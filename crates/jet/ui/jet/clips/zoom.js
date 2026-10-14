// Builds the "zoom" clip: Jet winds up, launches, rolls along as a ball
// stretched in its direction of travel while the ground rushes past, then
// brakes and settles back into the circle. Like the hello, every keyframe is
// written from the dials; the scenery only reads the speed track.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { clamp, lerp } from '../maths.js';
import { RING_HIDDEN } from '../state.js';

/** @typedef {import('../clip.js').Clip & { info: ZoomInfo }} ZoomClip */

/**
 * @typedef {object} ZoomInfo
 * @property {number} cruiseSpeed   near-layer units per second
 * @property {number} launchOvershoot
 * @property {number} bobDepth
 * @property {boolean} grooves
 * @property {boolean} squint
 * @property {number} cool
 * @property {number} tempo
 * @property {number} cruiseMs
 * @property {number} shapeAmplitude
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  down: cubicBezier(0.5, 0, 0.8, 0.6),
  tuck: cubicBezier(0.3, 0, 0.6, 1),
};

const CRUISE_SPEED = 220; // near-layer units per second at neutral settings
const BOB_HALF_PERIOD_MS = 260;
const SPIN_TURNS_PER_SECOND = 2.4;
// Spin grooves: short dashes near the rim, like surface blur on a rolling ball.
// Kept thin and well away from the eyes so they never read as a mouth or cheeks.
const GROOVE_RATIO = 0.8; // grooves ring radius as a share of the body's
const GROOVE_WIDTH = 2.4;
const GROOVE_COUNT = 6;
const GROOVE_OPACITY = 0.32;
// Coral blended far toward blue turns mauve, so the zoom only cools a little.
const COOL_SHIFT_MAX = 0.2;

// These are the rolling poses as ellipses, so that the grooves ring can follow
// them. The circle entry is what shape 0 blends to.
// SMELL: these numbers are a second copy, kept in step by hand, of the ellipses
// that the rig's circle and rolling poses are generated from. If a pose changes
// and this table does not, the grooves no longer follow the body, and no test
// fails. This table should be read from the rig.
const BALL = {
  circle: { cx: 50, cy: 56, rx: 32, ry: 32, tilt: 0 },
  zoom: { cx: 52, cy: 60, rx: 38, ry: 27, tilt: -18 },
  zoom_bob: { cx: 52, cy: 58, rx: 39, ry: 26, tilt: -20 },
};

/**
 * The timing every travel clip shares with the zoom, so the host's move fits whichever travel plays.
 * `tempo` scales every beat. `cruise` is the cruise length before the tempo: a whole number of bob half
 * periods (`halves`), at least two, as close to `cruiseMs` as that allows. Every travel's launch must
 * last 500 ms and its brake 710 ms, both before the tempo.
 * @param {{ x: number, y: number }} dials   candid and playful, as readDials gives them
 * @param {number} cruiseMs
 * @returns {{ tempo: number, halves: number, cruise: number }}
 */
export function travelTiming({ x, y }, cruiseMs) {
  const halves = Math.max(2, Math.round(cruiseMs / BOB_HALF_PERIOD_MS));
  return { tempo: clamp(1 - 0.1 * y - 0.1 * x, 0.75, 1.2), halves, cruise: halves * BOB_HALF_PERIOD_MS };
}

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ cruiseMs?: number }} [options]   how long the job takes; the host decides
 * @returns {ZoomClip}
 */
export function buildZoom(rig, p, { cruiseMs = 2400 } = {}) {
  const { ks, ke, kc, km, x, y, reduced, eyeSize, circle, rest, pose, eyes, hiddenEyes } = readDials(rig, p);
  const coolColour = rig.palette.cool;

  const cruiseSpeed = CRUISE_SPEED * (1 + 0.25 * x) * (0.6 + 0.4 * km);
  const launchOvershoot = 1.12 + 0.18 * Math.max(0, y);
  const launchStretch = 1 + 0.25 * x;
  const bobDepth = reduced ? 0 : clamp((0.4 + 0.6 * km) * (1 + 0.6 * y), 0, 1.3);
  const grooves = km > 0.3 && !reduced;
  const squint = eyeSize > 0 && ke > 0.6; // eyes above 6 squint into the wind
  const cool = COOL_SHIFT_MAX * kc;
  const { tempo, halves } = travelTiming({ x, y }, cruiseMs);

  const ball = (name) => {
    const a = BALL.circle;
    const b = BALL[name];
    return { cx: lerp(a.cx, b.cx, ks), cy: lerp(a.cy, b.cy, ks), rx: lerp(a.rx, b.rx, ks), ry: lerp(a.ry, b.ry, ks), tilt: lerp(a.tilt, b.tilt, ks) };
  };
  const grooveRing = (name) => {
    const g = ball(name);
    const rx = g.rx * GROOVE_RATIO;
    const ry = g.ry * GROOVE_RATIO;
    return { g, rx, ry, length: 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2) };
  };
  const ringAt = (name, opacity, offset) => {
    const { g, rx, ry, length } = grooveRing(name);
    const dash = length / (2 * GROOVE_COUNT);
    return [g.cx, g.cy, rx, ry, g.tilt, GROOVE_WIDTH, dash, dash, offset, opacity, 0];
  };
  // a negative offset moves the dashes the way a ball rolling to the right would turn
  const spinOffset = (sinceCruiseMs) => -SPIN_TURNS_PER_SECOND * grooveRing('zoom').length * (sinceCruiseMs / 1000);

  const { clip, body, eye, colour, scale, ring, speed, t } = createClip(tempo);

  // wind up: crouch back, then launch forward past the cruising shape
  body(150, pose('zoom_crouch'), ease.drop);
  eye(t(), hiddenEyes('circle'));
  ring(t(), RING_HIDDEN.slice());
  speed(t(), 0);
  body(130, pose('zoom_launch', launchStretch), ease.pop);
  speed(t() + 120 * tempo, cruiseSpeed * launchOvershoot, ease.pop);
  body(220, pose('zoom'), ease.settle);
  const cruiseStart = t();
  speed(t() + 200 * tempo, cruiseSpeed, ease.inOut);
  ring(t() - 60 * tempo, ringAt('zoom', 0, 0));
  ring(t() + 140 * tempo, ringAt('zoom', grooves ? GROOVE_OPACITY : 0, spinOffset(140 * tempo)), ease.pop);
  colour(t(), lerp(rest, coolColour, cool), ease.inOut);
  eye(t(), squint ? eyes('zoom', 5, 1.4) : hiddenEyes('zoom'), ease.pop);
  clip.phases.push({ name: 'launch', end: t() });

  // cruise: a gentle bob while the grooves turn
  for (let i = 0; i < halves; i++) {
    const up = i % 2 === 0;
    const name = up ? 'zoom_bob' : 'zoom';
    body(BOB_HALF_PERIOD_MS, up ? lerp(pose('zoom'), pose('zoom_bob'), bobDepth) : pose('zoom'), ease.inOut);
    const bobbed = { cx: lerp(ball('zoom').cx, ball(name).cx, bobDepth), cy: lerp(ball('zoom').cy, ball(name).cy, bobDepth) };
    const r = ringAt('zoom', grooves ? GROOVE_OPACITY : 0, spinOffset(t() - cruiseStart));
    r[0] = bobbed.cx;
    r[1] = bobbed.cy;
    ring(t(), r, ease.inOut);
    eye(t(), squint ? eyes(up ? 'zoom_bob' : 'zoom', 5, 1.4) : hiddenEyes('zoom'), ease.inOut);
  }
  clip.phases.push({ name: 'cruise', end: t() });

  // brake: pile forward, drop the ground to a stop, settle back into the circle
  const brakeStart = t();
  speed(brakeStart, cruiseSpeed); // hold until here, otherwise the ground would slow across the whole cruise
  colour(brakeStart, lerp(rest, coolColour, cool));
  body(170, pose('zoom_brake'), ease.down);
  speed(brakeStart + 150 * tempo, 0, ease.settle);
  ring(t(), ringAt('zoom', 0, spinOffset(t() - cruiseStart)), ease.drop);
  eye(t(), hiddenEyes('zoom'), ease.drop);
  colour(t() + 200 * tempo, rest, ease.inOut);
  body(150, pose('squash', 0.9), ease.tuck);
  body(170, pose('rebound'), ease.pop);
  scale(t(), 1);
  scale(t() + 40 * tempo, 1 + 0.03 * km, ease.pop);
  body(220, circle, ease.inOut);
  scale(t(), 1, ease.settle);
  ring(t(), RING_HIDDEN.slice());
  clip.phases.push({ name: 'brake', end: t() });
  clip.total = t();

  clip.info = { cruiseSpeed, launchOvershoot, bobDepth, grooves, squint, cool, tempo, cruiseMs, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Cruise speed', value: Math.round(cruiseSpeed) + ' u/s' },
    { label: 'Launch overshoot', value: Math.round((launchOvershoot - 1) * 100) + '%' },
    { label: 'Launch stretch', value: Math.round(launchStretch * 100) + '%' },
    { label: 'Bob depth', value: Math.round(bobDepth * 100) + '%', on: bobDepth > 0 },
    { label: 'Spin grooves', ...onOff(grooves) },
    { label: 'Squints into the wind', ...onOff(squint) },
    { label: 'Cools at cruise', value: Math.round(cool * 100) + '%', on: cool > 0.02 },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Cruise length', value: (cruiseMs / 1000).toFixed(1) + ' s' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
