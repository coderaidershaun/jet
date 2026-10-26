// Moves the kite through time. It owns the state and plays a clip from wherever
// the kite is, so a new clip blends in instead of cutting. On top of the
// state it adds what no clip should have to write: the body answering the
// hand, the stretch of a fast corner, the idle bob and sway, the wandering and
// gusts of a kite the wind has, blinks, eyes that change kind only while shut,
// and the string. It knows nothing about the DOM.

import { bodyPoint, restingFrame } from './draw/paint.js';
import { easeInOut, easeOut, pulse } from './easing.js';
import { clamp, lerp } from './maths.js';
import { CENTRE, HOVER_Y, kite, TIP } from './parts/forms.js';
import { createChain, raiseBlend, SEGMENTS, wind } from './parts/string.js';
import { restState, STEP_TRACKS, TRACKS } from './state.js';
import { heldKey, hold, sample } from './track.js';

/**
 * @typedef {object} Progress
 * @property {number} t          ms into the clip
 * @property {number[]} phases   0..1 per phase, in the order of `clip.phases`
 */

// The body answers the hand: it rolls a tenth of the lift, a little late.
const ROLL_PER_LIFT = -0.1;
const ROLL_LAG_MS = 100;
// How far back the lift is remembered. It only has to cover the roll lag.
const LIFT_HISTORY_MS = 250;
const SPEED_HALF_WINDOW_MS = 20;
const MAX_STRETCH = 2.5;
const FULL_STRETCH_SPEED = 250;
// An eye that is not closing squints this much in sympathy with the other one.
const SYMPATHY = 0.18;

const HOVER_FULL_Y = 8;
const BOB_UNITS = 1.6;
const BOB_PERIOD_MS = 3000;
const HOVER_SWAY_PER_WIND = 0.12;
const HOVER_SWAY_LAG_MS = 150;
const STAND_SWAY_DEGREES = 0.6;
const STAND_SWAY_PERIOD_MS = 6100;
// The string lies to the left and holds the standing kite up, so the top leans that way.
const STAND_LEAN_DEGREES = -2;

// Slow sines as [amplitude, period in ms, phase]. The periods only line up again after
// minutes, so the wandering never visibly repeats. Units are page units, roll is in degrees.
const WANDER_X = [[18, 9700, 0], [7, 4300, 1.3]];
const WANDER_Y = [[11, 7300, 0.6], [4, 3100, 2.1]];
const WANDER_ROLL = [[2, 8300, 2], [0.6, 3700, 0]];

const GUST_GAP_MIN_MS = 11000;
const GUST_GAP_RANGE_MS = 13000;
const GUST_MS = 2800;
const NO_GUST = { lift: 0, roll: 0, x: 0, drag: 0 };

const BLINK_GAP_MIN_MS = 4000;
const BLINK_GAP_RANGE_MS = 5000;
const BLINK_SHUT_MS = 60;
const BLINK_HOLD_END_MS = 100;
const BLINK_OPEN_END_MS = 200;
const BLINK_END_MS = 340;
// SMELL: the lid curve (shut, open 0.07 past, settle) is typed here and again in three clips;
// one shared curve would keep them in step.
const BLINK_OVERSHOOT = -0.07;
const SHUT_ENOUGH = 0.9;
const ROUND_AFTER_CLIP_MS = 3000;

const CARRY_SMOOTHING_S = 0.08;
const LEAN_PER_SPEED = 0.01;
const MAX_LEAN_DEGREES = 10;

const TIP_POINT = kite()[TIP];
const NO_BLEND = Array(SEGMENTS).fill(0);

/**
 * How much a corner stretches out at a given speed: up to 2.5 units at 250 degrees a second.
 * @param {number} degreesPerSecond
 */
export const stretchFromSpeed = (degreesPerSecond) => MAX_STRETCH * Math.min(1, Math.abs(degreesPerSecond) / FULL_STRETCH_SPEED);

const copyOf = (value) => (Array.isArray(value) ? value.slice() : value);

// The blink's closure: shut fast, held a moment, opened slower with a small overshoot, then settled.
function blinkClosure(into) {
  if (into < 0 || into >= BLINK_END_MS) return 0;
  if (into < BLINK_SHUT_MS) return easeInOut(into / BLINK_SHUT_MS);
  if (into < BLINK_HOLD_END_MS) return 1;
  if (into < BLINK_OPEN_END_MS) return lerp(1, BLINK_OVERSHOOT, easeOut((into - BLINK_HOLD_END_MS) / (BLINK_OPEN_END_MS - BLINK_HOLD_END_MS)));
  return lerp(BLINK_OVERSHOOT, 0, easeInOut((into - BLINK_OPEN_END_MS) / (BLINK_END_MS - BLINK_OPEN_END_MS)));
}

// One wind number for the whole string, the mean of its segments.
function meanWind(ms) {
  let sum = 0;
  for (let i = 0; i < SEGMENTS; i++) sum += wind(i, ms / 1000);
  return sum / SEGMENTS;
}

const wander = (now, sines) => sines.reduce((sum, [amplitude, periodMs, phase]) => sum + amplitude * Math.sin((2 * Math.PI * now) / periodMs + phase), 0);

// A stronger puff from the left: it lifts Jet, leans the top into the wind, carries it right and
// streams the string right. `into` is ms since the gust began.
function gustAt(into) {
  const t = into / 1000;
  return {
    lift: 9 * pulse(t, 0, 0.55, 2.3) - 2.5 * pulse(t, 1.7, 2.2, 2.8),
    roll: -3.5 * pulse(t, 0, 0.45, 1.8) + 0.9 * pulse(t, 1.5, 2, 2.8),
    x: 20 * pulse(t, 0.05, 0.75, 2.8),
    drag: -240 * pulse(t, 0, 0.35, 1.6),
  };
}

const squintWith = (own, other) => (own <= 0 && other > 0 ? Math.max(own, SYMPATHY * other) : own);

/**
 * @param {object} [options]
 * @param {() => number} [options.random]  a number in [0, 1); a test passes its own to choose the blink times
 * @param {boolean} [options.reducedMotion]
 * @param {boolean} [options.layers]  false turns off the idle bob, the sway, and the wind's wandering and gusts, for tests and renders
 * @param {boolean} [options.standing]  start standing instead of hovering
 */
export function createPlayer({ random = Math.random, reducedMotion = false, layers = true, standing = false } = {}) {
  /** @type {import('./state.js').JetState} */
  const state = restState({ standing: standing || reducedMotion });
  const chain = createChain();
  let reduced = reducedMotion;
  let frame = standing ? { ...restingFrame(), y: 0, pivot: [...TIP_POINT] } : restingFrame();

  /** The playing clip: a copy of the clip with the live state as the first key of every track. */
  let playing = null;
  let clipStart = 0;
  let lastClipEnd = -Infinity;
  let lastTickAt = null;

  // Where the lift was at any moment of the last 250 ms, even across a clip change.
  // Each source answers for the time from when it began; the first is the lift Jet had before any clip.
  let liftBeforeAnyClip = null;
  const liftSources = [{ since: -Infinity, liftAt: () => liftBeforeAnyClip ?? state.lift }];
  const liftAt = (at) => {
    const source = liftSources.findLast((candidate) => candidate.since <= at) ?? liftSources[0];
    return source.liftAt(at);
  };

  // The string pose is resolved here because a raise runs on after its clip ends.
  let poseTrack = null;
  let heldPoseKey = null;
  let raisedPose = null;
  let raiseFrom = NO_BLEND;
  let raiseSince = 0;

  let nextBlinkAt = null;
  let blink = null;
  let shownKind = null;

  let nextGustAt = null;
  let gust = null;

  let carriedX = 0;
  let carrySpeed = 0;

  function resolveStringPose(now) {
    if (!poseTrack) return;
    const key = heldKey(poseTrack, now - clipStart);
    if (key !== heldPoseKey) {
      heldPoseKey = key;
      raiseFrom = state.stringPose ? state.stringPose.blend : NO_BLEND;
      // A raise with no angles of its own works on whatever pose the string holds, so a clip need
      // not know what the string was doing. A hanging string then stays hanging.
      raisedPose = key.v?.angles ? key.v : state.stringPose;
      raiseSince = clipStart + key.t;
    }
    const pose = key.v;
    if (!pose?.raise) {
      state.stringPose = pose;
      return;
    }
    if (!raisedPose) {
      state.stringPose = null;
      return;
    }
    const { to, lagMs, durationMs, overshoot, order } = pose.raise;
    const timing = { start: 0, lag: lagMs / 1000, duration: durationMs / 1000, overshoot, order };
    const seconds = (now - raiseSince) / 1000;
    const blend = raiseFrom.map((from, i) => from + (to - from) * raiseBlend(i, seconds, timing));
    state.stringPose = { angles: raisedPose.angles, proportions: raisedPose.proportions, blend };
  }

  // The next blink is a random 4 to 9 s after the one before, so blinks never fall into a rhythm.
  const blinkGap = () => BLINK_GAP_MIN_MS + random() * BLINK_GAP_RANGE_MS;

  // Starts, ends and schedules the idle blinks. A blink only starts while no clip plays; one that
  // falls inside a clip is skipped.
  function advanceBlinks(now) {
    if (reduced) {
      blink = null;
      return;
    }
    nextBlinkAt ??= now + blinkGap();
    if (now >= nextBlinkAt) {
      if (!playing && now < nextBlinkAt + BLINK_END_MS) {
        blink = { start: nextBlinkAt, returnsToRound: nextBlinkAt - lastClipEnd >= ROUND_AFTER_CLIP_MS };
      }
      nextBlinkAt += blinkGap();
    }
    if (!blink) return;
    const into = now - blink.start;
    if (into >= BLINK_END_MS) {
      blink = null;
      return;
    }
    // The first blink at least 3 s after a clip turns the eyes back to round while the lid is shut.
    if (blink.returnsToRound && into >= BLINK_SHUT_MS && !playing) {
      state.eyeKind = 'round';
      state.anger = 0;
      blink.returnsToRound = false;
    }
  }

  const gustGap = () => GUST_GAP_MIN_MS + random() * GUST_GAP_RANGE_MS;

  // Like the blinks, each gust comes a random gap after the one before, so the gusts never fall into a
  // rhythm, and one that fell in a hidden tab is skipped. Gusts only exist while the wind has Jet.
  function advanceGusts(now) {
    if (reduced || state.drift === 0) {
      gust = null;
      nextGustAt = null;
      return;
    }
    nextGustAt ??= now + gustGap();
    if (now >= nextGustAt) {
      if (now < nextGustAt + GUST_MS) gust = { start: nextGustAt };
      nextGustAt += gustGap();
    }
    if (gust && now - gust.start >= GUST_MS) gust = null;
  }

  function smoothCarry(now) {
    const seconds = lastTickAt === null ? 0 : (now - lastTickAt) / 1000;
    if (seconds <= 0) return;
    carrySpeed += (carriedX / seconds - carrySpeed) * Math.min(1, seconds / CARRY_SMOOTHING_S);
    carriedX = 0;
  }

  // The lids as drawn: the clip's, with the sympathy squint and the idle blink added. A new eye kind
  // is taken up only under shut lids, so the shape never swaps in view.
  function eyesAt(now) {
    if (reduced) return { kind: 'round', anger: 0, squint: 0, lids: [0, 0] };
    const closure = blink ? blinkClosure(now - blink.start) : 0;
    const [leftLid, rightLid] = state.lids;
    const lids = [squintWith(leftLid, rightLid) + closure, squintWith(rightLid, leftLid) + closure];
    shownKind ??= state.eyeKind;
    if (lids.every((lid) => lid >= SHUT_ENOUGH)) shownKind = state.eyeKind;
    return { kind: shownKind, anger: state.anger, squint: state.squint, lids };
  }

  function composeFrame(now) {
    const hoverWeight = clamp(state.y / HOVER_FULL_Y, 0, 1);
    const standWeight = 1 - hoverWeight;
    const layerOn = layers && !reduced;

    const liftThen = liftAt(now - ROLL_LAG_MS);
    const before = liftAt(now - SPEED_HALF_WINDOW_MS);
    const after = liftAt(now + SPEED_HALF_WINDOW_MS);
    const speeds = [0, 1].map((side) => (after[side] - before[side]) / ((2 * SPEED_HALF_WINDOW_MS) / 1000));

    let roll = state.roll + ROLL_PER_LIFT * (liftThen[1] - liftThen[0]);
    let y = state.y;
    const drift = layerOn ? state.drift : 0;
    const gustNow = gust ? gustAt(now - gust.start) : NO_GUST;
    if (layerOn) {
      y += BOB_UNITS * Math.sin((2 * Math.PI * now) / BOB_PERIOD_MS) * hoverWeight;
      roll += HOVER_SWAY_PER_WIND * meanWind(now - HOVER_SWAY_LAG_MS) * hoverWeight;
      roll += (STAND_SWAY_DEGREES * Math.sin((2 * Math.PI * now) / STAND_SWAY_PERIOD_MS) + STAND_LEAN_DEGREES) * standWeight;
    }
    let x = 0;
    if (drift > 0) {
      x = drift * (wander(now, WANDER_X) + gustNow.x);
      y += drift * (wander(now, WANDER_Y) + gustNow.lift);
      roll += drift * (wander(now, WANDER_ROLL) + gustNow.roll);
    }
    if (!reduced) roll += clamp(LEAN_PER_SPEED * carrySpeed, -MAX_LEAN_DEGREES, MAX_LEAN_DEGREES);

    const eyes = eyesAt(now);
    const body = { x, y: Math.max(0, y), roll, squash: state.squash, pivot: lerp(TIP_POINT, CENTRE, hoverWeight) };
    const activeChain = playing?.windHz ? createChain({ windHz: playing.windHz }) : chain;
    const string = activeChain.points({
      tip: bodyPoint(body, TIP_POINT),
      t: reduced ? 0 : (playing?.windHz ? now - clipStart : now) / 1000,
      pose: state.stringPose,
      payout: state.payout * (1 - state.form),
      drag: reduced ? 0 : carrySpeed + drift * gustNow.drag,
      written: state.form > 0 ? null : state.written,
    });
    return {
      ...body,
      form: state.form,
      lift: state.lift,
      stretch: speeds.map(stretchFromSpeed),
      liftSpeed: speeds,
      eyes,
      string,
    };
  }

  return {
    state,

    get playing() {
      return playing !== null;
    },

    get clip() {
      return playing;
    },

    get frame() {
      return frame;
    },

    get standing() {
      return reduced || state.y < HOVER_Y / 2;
    },

    get reducedMotion() {
      return reduced;
    },

    set reducedMotion(on) {
      reduced = on;
    },

    /** Place an idle kite in its hero spot or on the lane floor. */
    rest({ standing }) {
      Object.assign(state, restState({ standing: standing || reduced }));
      playing = null;
      poseTrack = null;
      blink = null;
      shownKind = 'round';
      carriedX = 0;
      carrySpeed = 0;
      gust = null;
      nextGustAt = null;
    },

    stretchFromSpeed,

    /**
     * Starts a clip now. Every track gets the live state as its first key, so a
     * track the clip does not write holds. The clip itself is copied, never changed.
     * @param {import('./clip.js').Clip} clip
     * @param {number} now   ms on the clock the host ticks with
     */
    play(clip, now) {
      const copy = { total: clip.total, phases: [...clip.phases], revealFrom: clip.revealFrom ?? null, windHz: clip.windHz };
      for (const name of TRACKS) {
        copy[name] = [{ t: 0, v: copyOf(state[name]) }, ...(clip[name] ?? [])].sort((a, b) => a.t - b.t);
      }
      liftBeforeAnyClip ??= copyOf(state.lift);
      liftSources.push({ since: now, liftAt: (at) => sample(copy.lift, at - now) });
      playing = copy;
      poseTrack = copy.stringPose;
      heldPoseKey = null;
      clipStart = now;
      lastClipEnd = now + copy.total;
    },

    /**
     * Moves the state to time `now` and works out the frame.
     * @param {number} now   ms on the clock `play` was given
     * @returns {Progress | null}   null while no clip plays
     */
    tick(now) {
      let progress = null;
      if (playing) {
        const t = now - clipStart;
        for (const name of TRACKS) {
          if (name === 'stringPose') continue;
          state[name] = copyOf(STEP_TRACKS.includes(name) ? hold(playing[name], t) : sample(playing[name], t));
        }
        let start = 0;
        const phases = playing.phases.map((phase) => {
          const share = phase.end > start ? clamp((t - start) / (phase.end - start), 0, 1) : 1;
          start = phase.end;
          return share;
        });
        progress = { t, phases };
        if (t >= playing.total) playing = null;
      }
      resolveStringPose(now);
      if (reduced) {
        const rest = restState({ standing: true });
        state.y = 0;
        state.roll = 0;
        state.drift = 0;
        state.stringPose = rest.stringPose;
        if (!playing) {
          state.eyeKind = 'round';
          state.anger = 0;
          state.lids = [0, 0];
          shownKind = 'round';
        }
      }
      smoothCarry(now);
      advanceBlinks(now);
      advanceGusts(now);
      frame = composeFrame(now);
      while (liftSources.length > 1 && now - liftSources[1].since > LIFT_HISTORY_MS) liftSources.shift();
      lastTickAt = now;
      return progress;
    },

    /**
     * Tells the player how far the host moved the page node since the last
     * frame, in units. The string trails the motion and the body leans into it.
     * It adds no position: the host moves the node itself.
     * @param {number} dx
     * @param {number} [dy]  accepted and ignored
     */
    carry(dx, dy) {
      carriedX += dx;
    },
  };
}
