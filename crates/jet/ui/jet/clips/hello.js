// Builds the "hello" clip from the user's dials. Nothing here is a stored
// animation: the keyframes are written fresh each time from the rig's poses,
// so the wheel and the expressiveness channels change the clip, not an asset.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { clamp, lerp } from '../maths.js';
import { RING_HIDDEN } from '../state.js';

/** @typedef {import('../clip.js').Clip & { info: HelloInfo }} HelloClip */

/**
 * @typedef {object} HelloInfo
 * @property {number} cycles
 * @property {number} reach
 * @property {number} tempo
 * @property {number} bounce
 * @property {boolean} dip
 * @property {boolean} lag
 * @property {boolean} tuck
 * @property {boolean} squint
 * @property {number} bow
 * @property {number} warm
 * @property {number} eyeSize
 * @property {number} shapeAmplitude
 * @property {boolean} brief
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  fall: cubicBezier(0.5, 0, 1, 1),
  land: cubicBezier(0.2, 0.8, 0.3, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  up: cubicBezier(0.2, 0.7, 0.3, 1),
  top: cubicBezier(0.2, 0.8, 0.3, 1),
  wave: cubicBezier(0.4, 0, 0.5, 1),
  down: cubicBezier(0.5, 0, 0.8, 0.6),
  tuck: cubicBezier(0.3, 0, 0.6, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  melt: cubicBezier(0.5, 0, 0.9, 0.6),
};

const EYE_OPEN = 4;
const EYE_POP = 4.6;
const EYE_SQUINT = [5, 1.6];
const EYE_BLINK = 0.4;

// Each beat of a brief hello takes this share of its time in the full hello.
const BRIEF_PACE = 0.65;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ brief?: boolean }} [options]   a brief hello is one wave with no bow, for relaunch
 * @returns {HelloClip}
 */
export function buildHello(rig, p, { brief = false } = {}) {
  const { ks, ke, kc, km, x, y, reduced, eyeSize, circle, rest, pose, eyes, hiddenEyes } = readDials(rig, p);
  const soft = rig.poses.soft;
  const warmColour = rig.palette.warm;

  const bounce = clamp(1 + 0.5 * y, 0.6, 1.3) * (0.45 + 0.55 * km);
  const reach = clamp(1 + 0.3 * x, 0.7, 1.3);
  const cycles = reduced ? 0 : brief ? 1 : clamp(Math.round(2 + 1.2 * y), 1, 3);
  const tempo = clamp(1 - 0.15 * y, 0.8, 1.25) * (brief ? BRIEF_PACE : 1);
  const dip = km > 0.35 && !reduced && !brief;
  const lag = km > 0.3 && !reduced;
  const tuck = km > 0.5 && !reduced && !brief;
  const bow = brief ? 0 : Math.max(0, -x) * 0.8;
  const hold = x > 0.3 && !brief ? 120 : 0;
  const squint = eyeSize > 0 && ke > 0.35 && y > 0.1;
  const warm = 0.6 * kc * (0.5 + 0.5 * Math.max(0, y));

  // The reach moves an arm pose further from the standing pose, or closer to
  // it. Only then does the shape dial blend the result from the circle.
  const arm = (name) => lerp(circle, lerp(soft, rig.poses[name], reach), ks);
  const peakEyes = (name) => (squint ? eyes(name, EYE_SQUINT[0], EYE_SQUINT[1]) : eyes(name, EYE_OPEN, EYE_OPEN));

  const { clip, body, eye, colour, scale, ring, speed, t } = createClip(tempo);

  // if this interrupts a zoom, the grooves fade and the ground stops before Jet stands up
  ring(150, RING_HIDDEN.slice(), ease.inOut);
  speed(300, 0, ease.settle);

  // stand up
  if (km > 0.2) {
    body(90, pose('squash', bounce), ease.drop);
    body(200, pose('stretch', Math.min(bounce, 1.15)), ease.pop);
    body(100, pose('land'), ease.fall);
  } else {
    body(300, pose('land'), ease.land);
  }
  eye(t(), hiddenEyes('land'));
  scale(t(), 1);
  scale(t() + 60 * tempo, 1 + 0.04 * km * bounce, ease.pop);
  body(140, pose('soft'), ease.land);
  eye(t(), eyes('soft', EYE_POP, EYE_POP), ease.pop);
  scale(t(), 1, ease.settle);
  clip.phases.push({ name: 'stand up', end: t() });

  // hello
  if (dip) {
    body(120, pose('dip'), ease.inOut);
    eye(t(), eyes('dip', EYE_OPEN, EYE_OPEN), ease.inOut);
  } else {
    body(60, pose('soft'), ease.linear);
    eye(t(), eyes('soft', EYE_OPEN, EYE_OPEN), ease.inOut);
  }
  body(160, arm('swing'), ease.up);
  eye(t(), eyes('swing', EYE_OPEN, EYE_OPEN), ease.up);
  body(140, arm('peak'), ease.top);
  eye(t(), peakEyes('peak'), ease.top);
  colour(t(), lerp(rest, warmColour, warm), ease.inOut);
  for (let i = 0; i < cycles; i++) {
    body(180, arm('out'), ease.wave);
    eye(t(), peakEyes('out'), ease.wave);
    body(220, arm('peak'), ease.wave);
    eye(t(), peakEyes('peak'), ease.wave);
  }
  if (reduced) {
    body(600, arm('peak'), ease.linear);
    eye(t(), eyes('peak', EYE_OPEN, EYE_OPEN), ease.linear);
  }
  if (hold) {
    body(hold, arm('peak'), ease.linear);
    eye(t(), peakEyes('peak'), ease.linear);
  }
  body(160, lag ? arm('downlag') : pose('swing', 0.6), ease.down);
  eye(t(), eyes(lag ? 'downlag' : 'swing', EYE_OPEN, EYE_OPEN), ease.down);
  colour(t(), rest, ease.inOut);
  if (tuck) {
    body(140, pose('tuck'), ease.tuck);
    eye(t(), eyes('tuck', EYE_OPEN, EYE_OPEN), ease.tuck);
  }
  body(tuck ? 140 : 200, pose('soft'), ease.settle);
  eye(t(), eyes('soft', EYE_OPEN, EYE_OPEN), ease.settle);
  eye(t() + 60 * tempo, eyes('soft', EYE_OPEN, EYE_BLINK), ease.linear);
  eye(t() + 130 * tempo, eyes('soft', EYE_OPEN, EYE_OPEN), ease.linear);
  if (bow > 0.05) {
    body(240, lerp(pose('soft'), pose('bow'), bow), ease.inOut);
    eye(t(), eyes('bow', EYE_OPEN, EYE_OPEN), ease.inOut);
    body(280, pose('soft'), ease.inOut);
    eye(t(), eyes('soft', EYE_OPEN, EYE_OPEN), ease.inOut);
  }
  body(260, pose('soft'), ease.linear);
  eye(t() - 110 * tempo, eyes('soft', EYE_OPEN, EYE_OPEN));
  eye(t(), hiddenEyes('soft'), ease.drop);
  clip.phases.push({ name: 'hello', end: t() });

  // melt back
  body(150, pose('relax'), ease.melt);
  body(200, pose('puddle', Math.min(1, bounce)), ease.inOut);
  body(180, pose('rebound', Math.min(1, bounce)), ease.pop);
  scale(t(), 1);
  scale(t() + 40 * tempo, 1 + 0.03 * km, ease.pop);
  body(200, circle, ease.inOut);
  scale(t(), 1, ease.settle);
  clip.phases.push({ name: 'melt', end: t() });
  clip.total = t();

  clip.info = { cycles, reach, tempo, bounce, dip, lag, tuck, squint, bow, warm, eyeSize, shapeAmplitude: ks, brief };
  clip.readout = [
    { label: 'Brief hello', ...onOff(brief) },
    { label: 'Wave cycles', value: String(cycles) },
    { label: 'Arm reach', value: Math.round(reach * 100) + '%' },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Squash & stretch', value: Math.round(bounce * 100) + '%' },
    { label: 'Anticipation dip', ...onOff(dip) },
    { label: 'Hand lags down', ...onOff(lag) },
    { label: 'Tuck past rest', ...onOff(tuck) },
    { label: 'Squint at peak', ...onOff(squint) },
    { label: 'Bow at the end', value: bow > 0.05 ? Math.round(bow * 100) + '%' : 'off', on: bow > 0.05 },
    { label: 'Warms at peak', value: Math.round(warm * 100) + '%', on: warm > 0.02 },
    { label: 'Eye size', value: eyeSize ? Math.round(eyeSize * 100) + '%' : 'none' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
