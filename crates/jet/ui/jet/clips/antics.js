// Builds the antics: the holds Jet plays to pass the time when the user stops typing
// with text still in the field, and the clips that end them.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { lerp } from '../maths.js';
import { RING_HIDDEN } from '../state.js';
import { startClip } from './beats.js';

/** @typedef {import('../clip.js').Clip & { info: BatBallInfo }} BatBallClip */

/**
 * @typedef {object} BatBallInfo
 * @property {number} bounceMs
 * @property {number} bounces
 * @property {number} swing          degrees the bat flicks up after each landing
 * @property {boolean} props         false when the dials allow no prop, so Jet only holds the stance
 * @property {boolean} continued     true when this clip carries on a loop that is already bouncing
 * @property {number} shapeAmplitude
 */

/** @typedef {import('../clip.js').Clip & { info: BatBallEndInfo }} BatBallEndClip */

/**
 * @typedef {object} BatBallEndInfo
 * @property {boolean} props         true when the bat and the ball were showing, so they drop
 * @property {number} tempo
 * @property {number} shapeAmplitude
 */

/** @typedef {import('../clip.js').Clip & { info: DozeInfo }} DozeClip */

/**
 * @typedef {object} DozeInfo
 * @property {number} sways
 * @property {number} swayDepth      how much bigger Jet gets at the top of each sleeping breath
 * @property {boolean} held          true when reduced motion keeps Jet at the circle
 * @property {boolean} continued     true when this clip carries on a doze that is already swaying
 * @property {number} shapeAmplitude
 */

/** @typedef {import('../clip.js').Clip & { info: DozeEndInfo }} DozeEndClip */

/**
 * @typedef {object} DozeEndInfo
 * @property {boolean} jolted        true when Jet wakes with a small startled hop
 * @property {number} tempo
 * @property {number} shapeAmplitude
 */

const ease = {
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  fall: cubicBezier(0.5, 0, 1, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  linear: cubicBezier(0, 0, 1, 1),
  // With these three the ball flies a true parabola through the bounce keys. They are
  // exact only for the key times below, so work them out again if those change.
  bounceLaunch: cubicBezier(1 / 3, 0.38519, 2 / 3, 0.71852),
  bounceRise: cubicBezier(1 / 3, 2 / 3, 2 / 3, 1),
  bounceFall: cubicBezier(1 / 3, 0, 2 / 3, 1 / 3),
};

const BOUNCE_MS = 520;
// After each landing: the squash at its deepest, the ball at the top, the next landing.
const BOUNCE_KEYS = [70, BOUNCE_MS / 2, BOUNCE_MS];
const APEX_RISE = 18;
const BAT_SCALE = 0.85;
const BALL_SCALE = 0.85;
// The bat points right, 14 degrees above level.
const BAT_REST_ROTATE = 76;
const BAT_SWING = 12;
const SQUASH_SHARE = 0.5;
const BAT_CONTACT_ALONG = 24;
const PICK_UP_MS = 320;
const PICK_UP_DIP_MS = 90;
const PROPS_APPEAR_MS = 120;
const NOD_MS = 420;
const SLUMP_MS = 520;
const SWAY_MS = 2800;
const SWAY_DEPTH = 0.03;
const DROWSY = [2.4, 1.2];
const SLIT = [2.6, 0.45];
const LET_GO_MS = 160;
const DROP_MS = 340;
// Lowered flat, the bat keeps the ball on top of it. A bat that tips over lets the
// falling ball pass through it.
const BAT_DROP_ROTATE = 90;
const JOLT_MS = 100;
const JOLT_HOP = 0.5;
const AWAKE_MS = 240;
const WIDE_HOLD_MS = 160;
const WIDE = 3.4;
const RING_AWAY_MS = 100;
const GROUND_STOPPED_MS = 240;

// SMELL: the bat's and the ball's sizes are written here and again where they are drawn,
// so a change to the drawing moves the ball off the bat and no test notices.
const BAT_LENGTH = 30;
const BAT_HALF_WIDTH_AT_GRIP = 1.4;
const BAT_HALF_WIDTH_AT_TOP = 3;
const BALL_RADIUS = 4;

const faint = (face) => [...face.slice(0, 6), 1];
const showsProps = ({ ks, km, reduced }) => ks > 0 && km >= 0.3 && !reduced;
const radians = (degrees) => (degrees * Math.PI) / 180;
const batDirection = (rotate) => [Math.sin(radians(rotate)), -Math.cos(radians(rotate))];
const batUpSide = (rotate) => [-Math.cos(radians(rotate)), -Math.sin(radians(rotate))];
const batHalfWidth = (along) => BAT_HALF_WIDTH_AT_GRIP + ((BAT_HALF_WIDTH_AT_TOP - BAT_HALF_WIDTH_AT_GRIP) * along) / BAT_LENGTH;
const rightHand = (body) => [body[12], body[13]];
const ballHeight = (sinceLanding) => APEX_RISE * (1 - ((sinceLanding - BOUNCE_KEYS[1]) / BOUNCE_KEYS[1]) ** 2);

/** Where the ball's centre is when it rests on a bat whose grip is at `grip`, turned to `rotate` degrees. */
function ballRestingOn([gripX, gripY], rotate) {
  const [alongX, alongY] = batDirection(rotate);
  const [upX, upY] = batUpSide(rotate);
  const along = BAT_CONTACT_ALONG * BAT_SCALE;
  const up = batHalfWidth(BAT_CONTACT_ALONG) * BAT_SCALE + BALL_RADIUS * BALL_SCALE;
  return [gripX + alongX * along + upX * up, gripY + alongY * along + upY * up];
}

/** The prop track's ten numbers: the bat in the first slot, the ball in the second. */
function propKey({ grip, rotate, ball, opacity }) {
  return [grip[0], grip[1], rotate, BAT_SCALE, opacity, ball[0], ball[1], 0, BALL_SCALE, opacity];
}

/**
 * Jet holds a bat in its right hand and bounces a ball on it, once every 520 ms, the body
 * giving a little with each landing. Every loop ends on a landing, so the next loop
 * carries on with no jump.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ loopMs?: number, continued?: boolean }} [options]   `loopMs` is about how long the loop lasts,
 *   in whole bounces; `continued` skips the pick-up for a loop that is already bouncing
 * @returns {BatBallClip}
 */
export function buildBatBall(rig, p, { loopMs = 10000, continued = false } = {}) {
  const dials = readDials(rig, p);
  const { ks, km, x, rest, pose, eyes, faintEyes } = dials;
  const { clip, body, eye, colour, scale, ring, speed, prop, t } = createClip(1);
  const show = showsProps(dials);
  const swing = BAT_SWING * (1 + 0.5 * Math.min(0, x));
  const bounces = Math.max(1, Math.round(loopMs / BOUNCE_MS));
  const stance = pose('soft');
  const stanceEyes = faintEyes('soft');
  const landing = ballRestingOn(rightHand(stance), BAT_REST_ROTATE);
  const ballAt = (sinceLanding) => [landing[0], landing[1] - ballHeight(sinceLanding)];

  ring(RING_AWAY_MS, RING_HIDDEN.slice(), ease.inOut);
  speed(GROUND_STOPPED_MS, 0, ease.settle);
  scale(GROUND_STOPPED_MS, 1, ease.settle);
  if (show) clip.props = ['bat', 'ball'];

  if (!continued) {
    if (km > 0.2) {
      body(PICK_UP_DIP_MS, pose('squash', 0.5), ease.drop);
      body(PICK_UP_MS - PICK_UP_DIP_MS, stance, ease.settle);
    } else {
      body(PICK_UP_MS, stance, ease.settle);
    }
    eye(t(), stanceEyes, ease.settle);
    colour(t(), rest, ease.inOut);
    if (show) {
      prop(PROPS_APPEAR_MS, propKey({ grip: rightHand(stance), rotate: BAT_REST_ROTATE, ball: landing, opacity: 0 }));
      prop(t(), propKey({ grip: rightHand(stance), rotate: BAT_REST_ROTATE, ball: landing, opacity: 1 }), ease.settle);
    }
    clip.phases.push({ name: 'pick up', end: t() });
  }

  if (show) {
    const squash = lerp(stance, pose('land'), SQUASH_SHARE);
    const squashEyes = lerp(stanceEyes, faintEyes('land'), SQUASH_SHARE);
    const beats = [
      { at: BOUNCE_KEYS[0], pose: squash, eyes: squashEyes, rotate: BAT_REST_ROTATE - swing, e: ease.bounceLaunch },
      { at: BOUNCE_KEYS[1], pose: stance, eyes: stanceEyes, rotate: BAT_REST_ROTATE, e: ease.bounceRise },
      { at: BOUNCE_KEYS[2], pose: stance, eyes: stanceEyes, rotate: BAT_REST_ROTATE, e: ease.bounceFall },
    ];
    for (let i = 0; i < bounces; i++) {
      let since = 0;
      for (const beat of beats) {
        body(beat.at - since, beat.pose, beat.e);
        since = beat.at;
        eye(t(), beat.eyes, beat.e);
        prop(t(), propKey({ grip: rightHand(beat.pose), rotate: beat.rotate, ball: ballAt(beat.at), opacity: 1 }), beat.e);
      }
    }
    clip.phases.push({ name: 'bounce', end: t() });
  } else {
    body(bounces * BOUNCE_MS, stance, ease.linear);
    eye(t(), stanceEyes, ease.linear);
    clip.phases.push({ name: 'hold', end: t() });
  }
  clip.total = t();

  clip.info = { bounceMs: BOUNCE_MS, bounces, swing, props: show, continued, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Bounce', value: BOUNCE_MS + ' ms' },
    { label: 'Bounces', value: String(bounces) },
    { label: 'Bat swing', value: Math.round(swing) + '°' },
    { label: 'Shows the bat and ball', ...onOff(show) },
    { label: 'Carries on a loop', ...onOff(continued) },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * Jet drops the bat with the ball still on it. Both fall flat to the ground, fading as
 * they go, and Jet melts back to the circle.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {BatBallEndClip}
 */
export function buildBatBallEnd(rig, p) {
  const c = startClip(rig, p);
  const { ks, tempo, pose, hiddenEyes, body, eye, prop, t, melt, phase, clip } = c;
  const show = showsProps(c);
  const stance = pose('soft');
  // The ground is the bottom of the body's outline: the foot plus half the stroke.
  const ground = rig.foot[1] + rig.stroke / 2;
  const batOnGround = [rightHand(stance)[0], ground - BAT_HALF_WIDTH_AT_TOP * BAT_SCALE];

  body(LET_GO_MS, stance, ease.settle);
  eye(t(), hiddenEyes('soft'), ease.drop);
  if (show) {
    clip.props = ['bat', 'ball'];
    const ball = ballRestingOn(batOnGround, BAT_DROP_ROTATE);
    prop(DROP_MS, propKey({ grip: batOnGround, rotate: BAT_DROP_ROTATE, ball, opacity: 0 }), ease.drop);
  }
  phase('drop');
  melt();
  phase('melt');
  clip.total = t();

  clip.info = { props: show, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Drops the bat and ball', ...onOff(show) },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * Jet nods off: it slumps, its faint eyes close to slits, and it sways slowly, a 3%
 * sleeping breath. Every loop ends at the bottom of a breath, so the next loop carries
 * on with no jump.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ loopMs?: number, continued?: boolean }} [options]   `loopMs` is about how long the loop lasts,
 *   in whole sways; `continued` skips the nodding off for a doze that is already swaying
 * @returns {DozeClip}
 */
export function buildDoze(rig, p, { loopMs = 10000, continued = false } = {}) {
  const { ks, km, reduced, circle, rest, pose, eyes } = readDials(rig, p);
  const { clip, body, eye, colour, scale, ring, speed, t } = createClip(1);
  // Reduced motion keeps Jet at the circle: slumping is a movement, and the closed eyes say enough.
  const held = reduced;
  const depth = km >= 0.3 && !reduced ? SWAY_DEPTH : 0;
  const sways = Math.max(1, Math.round(loopMs / SWAY_MS));
  const where = held ? 'circle' : 'doze';
  const slump = held ? circle : pose('doze');
  const slits = faint(eyes(where, SLIT[0], SLIT[1]));

  ring(RING_AWAY_MS, RING_HIDDEN.slice(), ease.inOut);
  speed(GROUND_STOPPED_MS, 0, ease.settle);

  if (!continued) {
    body(NOD_MS, held ? circle : pose('doze', 0.5), ease.inOut);
    eye(t(), faint(eyes(where, DROWSY[0], DROWSY[1])), ease.inOut);
    body(SLUMP_MS, slump, ease.settle);
    eye(t(), slits, ease.settle);
    colour(t(), rest, ease.inOut);
    scale(t(), 1, ease.settle);
    clip.phases.push({ name: 'nod off', end: t() });
  }

  for (let i = 0; i < sways; i++) {
    const from = t();
    scale(from + SWAY_MS / 2, 1 + depth, ease.inOut);
    scale(from + SWAY_MS, 1, ease.inOut);
    body(SWAY_MS, slump, ease.linear);
    eye(t(), slits, ease.linear);
  }
  clip.phases.push({ name: 'sway', end: t() });
  clip.total = t();

  clip.info = { sways, swayDepth: depth, held, continued, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Sway', value: (SWAY_MS / 1000).toFixed(1) + ' s, ' + Math.round(depth * 100) + '%' },
    { label: 'Sways', value: String(sways) },
    { label: 'Holds still', ...onOff(held) },
    { label: 'Carries on a loop', ...onOff(continued) },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * Jet jolts awake with a small startled hop and wide faint eyes, blinks them away, and
 * melts back to the circle.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {DozeEndClip}
 */
export function buildDozeEnd(rig, p) {
  const c = startClip(rig, p);
  const { ks, km, reduced, tempo, pose, eyes, hiddenEyes, body, eye, t, melt, phase, clip } = c;
  const jolted = km >= 0.3 && !reduced;
  const wide = (name) => faint(eyes(name, WIDE, WIDE));

  if (jolted) {
    body(JOLT_MS, pose('zoom_hop', JOLT_HOP), ease.pop);
    eye(t(), wide('zoom_hop'), ease.pop);
    phase('jolt');
  }
  body(AWAKE_MS, pose('soft'), jolted ? ease.fall : ease.settle);
  eye(t(), wide('soft'), jolted ? ease.fall : ease.settle);
  body(WIDE_HOLD_MS, pose('soft'), ease.linear);
  eye(t(), hiddenEyes('soft'), ease.drop);
  phase('wake');
  melt();
  phase('melt');
  clip.total = t();

  clip.info = { jolted, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Jolts awake', ...onOff(jolted) },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
