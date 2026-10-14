// Builds the clips for typing: Jet leans toward the composer while the user types, and
// leans back when they stop. The lean is a hold: it ends away from the circle on
// purpose and stays there until the host plays the lean back. Neither clip adds a
// face, colour or any extra beat, because Jet is only being attentive.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { RING_HIDDEN } from '../state.js';

/** @typedef {import('../clip.js').Clip & { info: LeanInfo }} LeanClip */

/**
 * @typedef {object} LeanInfo
 * @property {boolean} held   true when reduced motion keeps Jet at the circle instead of leaning
 * @property {number} shapeAmplitude
 */

const ease = {
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
};

const LEAN_MS = 280;
const LEAN_BACK_MS = 320;
// Both clips are short, so the ring and the ground are cleared before they end.
const RING_AWAY_MS = 100;
const GROUND_STOPPED_MS = 240;

function build(rig, p, { phase, ms, label, leans }) {
  const { ks, reduced, circle, rest, pose, hiddenEyes } = readDials(rig, p);
  const { clip, body, eye, colour, scale, ring, speed, t } = createClip(1);
  // Reduced motion keeps Jet at the circle: leaning is a movement, and the hold is enough to say "I am listening".
  const held = leans && reduced;

  ring(RING_AWAY_MS, RING_HIDDEN.slice(), ease.inOut);
  speed(GROUND_STOPPED_MS, 0, ease.settle);
  body(ms, leans && !held ? pose('lean') : circle, ease.settle);
  eye(t(), hiddenEyes('circle'), ease.inOut);
  colour(t(), rest, ease.inOut);
  scale(t(), 1, ease.settle);
  clip.phases.push({ name: phase, end: t() });
  clip.total = t();

  clip.info = { held, shapeAmplitude: ks };
  clip.readout = [
    { label, value: (ms / 1000).toFixed(2) + ' s' },
    { label: 'Holds still', ...onOff(held) },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {LeanClip}
 */
export function buildLean(rig, p) {
  return build(rig, p, { phase: 'lean', ms: LEAN_MS, label: 'Leans in', leans: true });
}

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {LeanClip}
 */
export function buildLeanBack(rig, p) {
  return build(rig, p, { phase: 'recover', ms: LEAN_BACK_MS, label: 'Leans back', leans: false });
}
