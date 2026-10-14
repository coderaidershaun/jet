// Builds the "abseil" clip: Jet dangles from a rope while the host lowers it down the page in
// steps, kicks off once in each step, and lands with a squash as the rope whips away.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { clamp, lerp } from '../maths.js';
import { PROP_HIDDEN, PROP_STRIDE, RING_HIDDEN } from '../state.js';
import { EYE_OPEN } from './beats.js';
import { travelTiming } from './zoom.js';

/** @typedef {import('../clip.js').Clip & { info: AbseilInfo }} AbseilClip */

/**
 * @typedef {object} AbseilInfo
 * @property {boolean} rope
 * @property {number} kicks
 * @property {number} kickDepth
 * @property {boolean} openEyes
 * @property {number} tempo
 * @property {number} cruiseMs
 * @property {number} shapeAmplitude
 */

const ease = {
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  tuck: cubicBezier(0.3, 0, 0.6, 1),
};

// The launch beats add up to 500 ms and the brake beats to 710 ms, like the zoom's, so the host's move fits any travel.
const GRAB_MS = 150;
const LIFT_MS = 130;
const HANG_MS = 220;
const LAND_MS = 170;
const SPREAD_MS = 150;
const REBOUND_MS = 170;
const SETTLE_MS = 220;
// Each kick takes an equal share of the cruise, split into four beats: Jet hangs, pushes off, swings out
// as it goes down, and is caught.
// SMELL: Jet must kick once in each of the host's three steps and end its push-off just as the host starts
// to lower it, and the host keeps its own copy of both numbers. They are kept equal by hand, and no test
// checks that they match.
const KICKS = 3;
const HOLD_SHARE = 0.45;
const PUSH_SHARE = 0.15;
const SWING_SHARE = 0.2;
const CATCH_SHARE = 0.2;
// The rope's lower end hides behind the head, so it seems to come from above.
const ROPE_X = 50;
const ROPE_Y = 28;
// The head squashes down at the landing, so the rope's end comes down with it and stays hidden.
const ROPE_LANDED_Y = 36;
const WHIP_Y = -40;
const WHIP_SCALE = 0.8;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ cruiseMs?: number }} [options]   how long the job takes; the host decides
 * @returns {AbseilClip}
 */
export function buildAbseil(rig, p, { cruiseMs = 2400 } = {}) {
  const { ks, ke, km, x, y, reduced, eyeSize, circle, rest, pose, eyes, hiddenEyes } = readDials(rig, p);
  const { tempo, cruise } = travelTiming({ x, y }, cruiseMs);
  const rope = ks > 0 && km >= 0.3 && !reduced;
  const openEyes = eyeSize > 0 && ke > 0.6;
  const kickDepth = reduced ? 0 : clamp((0.4 + 0.6 * km) * (1 + 0.6 * y), 0, 1.3);

  const dangle = pose('zoom_dangle');
  // SMELL: the eyes hold still through each kick while the push-off squashes the head down, so with a face
  // from shape 8 up the eyes poke out over the top of the body. The eyes should follow the head down.
  const pushOff = lerp(dangle, pose('squash'), 0.6 * kickDepth);
  const swing = lerp(dangle, pose('zoom_dangle', 1.35), kickDepth);
  const hangingEyes = openEyes ? eyes('zoom_dangle', EYE_OPEN, EYE_OPEN) : hiddenEyes('zoom_dangle');
  const ropeAt = (ropeY, scale, opacity) => [ROPE_X, ropeY, 0, scale, opacity, ...PROP_HIDDEN.slice(PROP_STRIDE)];

  const { clip, body, eye, colour, scale, ring, speed, prop, t } = createClip(tempo);

  body(GRAB_MS, pose('squash', 0.4), ease.drop);
  eye(t(), hiddenEyes('circle'));
  ring(t(), RING_HIDDEN.slice());
  speed(t(), 0);
  colour(t(), rest, ease.inOut);
  scale(t(), 1);
  if (rope) prop(t(), ropeAt(ROPE_Y, 1, 0));
  body(LIFT_MS, pose('zoom_dangle', 1.15), ease.pop);
  body(HANG_MS, dangle, ease.settle);
  eye(t(), hangingEyes, ease.settle);
  if (rope) prop(t(), ropeAt(ROPE_Y, 1, 1), ease.inOut);
  clip.phases.push({ name: 'launch', end: t() });

  const kickMs = cruise / KICKS;
  for (let i = 0; i < KICKS; i++) {
    body(HOLD_SHARE * kickMs, dangle, ease.inOut);
    body(PUSH_SHARE * kickMs, pushOff, ease.drop);
    body(SWING_SHARE * kickMs, swing, ease.pop);
    body(CATCH_SHARE * kickMs, dangle, ease.settle);
  }
  clip.phases.push({ name: 'cruise', end: t() });

  const brakeStart = t();
  // Hold keys: without them the face and the rope would start to change long before the landing.
  eye(brakeStart, hangingEyes);
  if (rope) prop(brakeStart, ropeAt(ROPE_Y, 1, 1));
  body(LAND_MS, pose('squash'), ease.drop);
  eye(t(), hiddenEyes('circle'), ease.drop);
  if (rope) prop(t(), ropeAt(ROPE_LANDED_Y, 1, 1));
  body(SPREAD_MS, pose('puddle'), ease.tuck);
  if (rope) prop(t(), ropeAt(WHIP_Y, WHIP_SCALE, 0.6), ease.pop);
  body(REBOUND_MS, pose('rebound'), ease.pop);
  if (rope) prop(t(), ropeAt(WHIP_Y, WHIP_SCALE, 0), ease.inOut);
  scale(t(), 1);
  scale(t() + 40 * tempo, 1 + 0.03 * km, ease.pop);
  body(SETTLE_MS, circle, ease.inOut);
  scale(t(), 1, ease.settle);
  ring(t(), RING_HIDDEN.slice());
  speed(t(), 0);
  clip.phases.push({ name: 'brake', end: t() });
  clip.total = t();

  if (rope) clip.props = ['rope', null];
  clip.info = { rope, kicks: KICKS, kickDepth, openEyes, tempo, cruiseMs, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Rope', ...onOff(rope) },
    { label: 'Kicks', value: String(KICKS) },
    { label: 'Kick depth', value: Math.round(kickDepth * 100) + '%', on: kickDepth > 0 },
    { label: 'Open eyes', ...onOff(openEyes) },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Cruise length', value: (cruiseMs / 1000).toFixed(1) + ' s' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
