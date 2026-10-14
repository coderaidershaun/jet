// Builds the "drop" clip: Jet falls while the host drops it down the page, pops an umbrella
// open on the way, floats beneath it, and lands with a squash as the umbrella folds.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { clamp, lerp } from '../maths.js';
import { PROP_HIDDEN, PROP_STRIDE, RING_HIDDEN } from '../state.js';
import { EYE_POP } from './beats.js';
import { travelTiming } from './zoom.js';

/** @typedef {import('../clip.js').Clip & { info: DropInfo }} DropClip */

/**
 * @typedef {object} DropInfo
 * @property {boolean} umbrella
 * @property {number} openAt   when the umbrella opens, in ms from the start of the clip
 * @property {number} bobDepth
 * @property {boolean} wideEyes
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
const CROUCH_MS = 150;
const LIFT_MS = 130;
const FALL_MS = 220;
const LAND_MS = 170;
const SPREAD_MS = 150;
const REBOUND_MS = 170;
const SETTLE_MS = 220;
// SMELL: the umbrella must open just as the host's fall stops speeding up, and the host keeps its own
// copy of this share. The two are kept equal by hand, and no test checks that they match.
const OPEN_AT = 0.4;
const RELAX_MS = 160;
const RELAX_TOWARD_ROUND = 0.6;
const BOB_MS = 260;
const POP_MS = 90;
const POP_SETTLE_MS = 130;
// The handle's tip hides behind the head, so the canopy sits above it.
const UMBRELLA_X = 50;
const UMBRELLA_Y = 30;
// The head squashes down at the landing, so the handle comes down with it and stays hidden.
const UMBRELLA_LANDED_Y = 36;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ cruiseMs?: number }} [options]   how long the job takes; the host decides
 * @returns {DropClip}
 */
export function buildDrop(rig, p, { cruiseMs = 2400 } = {}) {
  const { ks, ke, km, x, y, reduced, eyeSize, circle, rest, pose, eyes, hiddenEyes } = readDials(rig, p);
  const { tempo, cruise } = travelTiming({ x, y }, cruiseMs);
  const umbrella = ks > 0 && km >= 0.3 && !reduced;
  const wideEyes = eyeSize > 0 && ke > 0.6;
  const bobDepth = reduced ? 0 : clamp((0.4 + 0.6 * km) * (1 + 0.6 * y), 0, 1.3);

  const fall = pose('zoom_fall');
  const float = lerp(fall, circle, RELAX_TOWARD_ROUND);
  const bobbed = lerp(float, fall, 0.35 * bobDepth);
  const fallingEyes = wideEyes ? eyes('zoom_fall', EYE_POP, EYE_POP) : hiddenEyes('zoom_fall');
  const floatingEyes = wideEyes ? lerp(eyes('zoom_fall', EYE_POP, EYE_POP), eyes('circle', EYE_POP, EYE_POP), RELAX_TOWARD_ROUND) : hiddenEyes('zoom_fall');
  const umbrellaAt = (umbrellaY, scale, opacity) => [UMBRELLA_X, umbrellaY, 0, scale, opacity, ...PROP_HIDDEN.slice(PROP_STRIDE)];

  const { clip, body, eye, colour, scale, ring, speed, prop, t } = createClip(tempo);

  body(CROUCH_MS, pose('squash', 0.8), ease.drop);
  eye(t(), hiddenEyes('circle'));
  ring(t(), RING_HIDDEN.slice());
  speed(t(), 0);
  colour(t(), rest, ease.inOut);
  scale(t(), 1);
  if (umbrella) prop(t(), umbrellaAt(UMBRELLA_Y, 0.3, 0));
  body(LIFT_MS, pose('zoom_fall', 1.15), ease.pop);
  body(FALL_MS, fall, ease.settle);
  eye(t(), fallingEyes, ease.pop);
  clip.phases.push({ name: 'launch', end: t() });

  body(OPEN_AT * cruise, pose('zoom_fall', 1.1), ease.inOut);
  const openAt = t();
  // Hold keys: without them the face and the umbrella would start to change long before the umbrella opens.
  eye(openAt, fallingEyes);
  if (umbrella) {
    prop(openAt, umbrellaAt(UMBRELLA_Y, 0.3, 0));
    prop(openAt + POP_MS * tempo, umbrellaAt(UMBRELLA_Y, 1.15, 1), ease.pop);
    prop(openAt + (POP_MS + POP_SETTLE_MS) * tempo, umbrellaAt(UMBRELLA_Y, 1, 1), ease.settle);
  }
  const afterOpen = cruise - OPEN_AT * cruise;
  const relax = Math.min(RELAX_MS, afterOpen / 2);
  body(relax, float, ease.settle);
  eye(t(), floatingEyes, ease.settle);
  const bobs = Math.max(1, Math.round((afterOpen - relax) / BOB_MS));
  const bobMs = (afterOpen - relax) / bobs;
  for (let i = 0; i < bobs; i++) body(bobMs, i % 2 === 0 ? bobbed : float, ease.inOut);
  clip.phases.push({ name: 'cruise', end: t() });

  const brakeStart = t();
  // Hold keys: without them the face and the umbrella would start to change long before the landing.
  eye(brakeStart, floatingEyes);
  if (umbrella) prop(brakeStart, umbrellaAt(UMBRELLA_Y, 1, 1));
  body(LAND_MS, pose('squash'), ease.drop);
  eye(t(), hiddenEyes('circle'), ease.drop);
  if (umbrella) prop(t(), umbrellaAt(UMBRELLA_LANDED_Y, 0.6, 0.6), ease.inOut);
  body(SPREAD_MS, pose('puddle'), ease.tuck);
  if (umbrella) prop(t(), umbrellaAt(UMBRELLA_LANDED_Y, 0.2, 0), ease.inOut);
  body(REBOUND_MS, pose('rebound'), ease.pop);
  scale(t(), 1);
  scale(t() + 40 * tempo, 1 + 0.03 * km, ease.pop);
  body(SETTLE_MS, circle, ease.inOut);
  scale(t(), 1, ease.settle);
  ring(t(), RING_HIDDEN.slice());
  speed(t(), 0);
  clip.phases.push({ name: 'brake', end: t() });
  clip.total = t();

  if (umbrella) clip.props = ['umbrella', null];
  clip.info = { umbrella, openAt, bobDepth, wideEyes, tempo, cruiseMs, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Umbrella', ...onOff(umbrella) },
    { label: 'Opens at', value: Math.round(OPEN_AT * 100) + '% of the cruise' },
    { label: 'Bob depth', value: Math.round(bobDepth * 100) + '%', on: bobDepth > 0 },
    { label: 'Wide eyes', ...onOff(wideEyes) },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Cruise length', value: (cruiseMs / 1000).toFixed(1) + ' s' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
