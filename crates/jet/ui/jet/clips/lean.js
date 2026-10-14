// Builds what Jet does while the user types: a typing hold (the lean, the peer on tiptoe or the
// creep closer) that stays until something else plays, and the lean back to the circle. Jet is
// only being attentive, so none of them adds colour or an extra beat.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { lerp } from '../maths.js';
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
// The typing clips are short, so the ring and the ground are cleared before they end.
const RING_AWAY_MS = 100;
const GROUND_STOPPED_MS = 240;
const PEER_MS = 340;
const CREEP_MS = 480;
const CREEP_SCALE = 1.1;
const PEEK = [2.6, 1.1];

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

const faint = (face) => [...face.slice(0, 6), 1];

// The creep grows its body about the foot rather than on the scale track, because the
// player puts the scale back to its breathing as soon as a clip ends, holds included.
const aboutFoot = ([footX, footY], pose, k) =>
  pose.map((v, i) => {
    const origin = i % 2 === 0 ? footX : footY;
    return origin + (v - origin) * k;
  });

function finishHold({ ks, rest }, { clip, colour, scale, ring, speed, t }, { phase, ms, label, held }) {
  ring(RING_AWAY_MS, RING_HIDDEN.slice(), ease.inOut);
  speed(GROUND_STOPPED_MS, 0, ease.settle);
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
 * Up on tiptoe, taller and narrower, peeking toward the composer with faint eyes.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {LeanClip}
 */
export function buildPeer(rig, p) {
  const dials = readDials(rig, p);
  const { reduced, circle, pose, eyes, hiddenEyes } = dials;
  const writers = createClip(1);
  const { body, eye, t } = writers;

  body(PEER_MS, reduced ? circle : pose('peer'), ease.settle);
  eye(t(), reduced ? hiddenEyes('circle') : faint(eyes('peer', PEEK[0], PEEK[1])), ease.settle);
  return finishHold(dials, writers, { phase: 'peer', ms: PEER_MS, label: 'Peers in', held: reduced });
}

/**
 * Leans like the lean and grows a little, in two steps, as if stepping closer.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {LeanClip}
 */
export function buildCreep(rig, p) {
  const dials = readDials(rig, p);
  const { ks, reduced, circle, hiddenEyes } = dials;
  const writers = createClip(1);
  const { body, eye, t } = writers;
  const closer = (k) => lerp(circle, aboutFoot(rig.foot, rig.poses.lean, k), ks);

  if (reduced) {
    body(CREEP_MS, circle, ease.settle);
  } else {
    body(CREEP_MS / 2, closer(1 + (CREEP_SCALE - 1) / 2), ease.settle);
    body(CREEP_MS / 2, closer(CREEP_SCALE), ease.settle);
  }
  eye(t(), hiddenEyes('circle'), ease.inOut);
  return finishHold(dials, writers, { phase: 'creep', ms: CREEP_MS, label: 'Creeps in', held: reduced });
}
