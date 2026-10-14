// Advances Jet through time. It owns the current state (body, eyes, colour,
// scale, ring, speed, props) and plays clips from wherever Jet is at that
// moment, so a new clip blends in instead of cutting. At rest Jet breathes and
// shows faint eyes that blink now and then. It knows nothing about the DOM.

import { eyeSizeFor } from './clip.js';
import { cubicBezier } from './easing.js';
import { PROP, PROP_HIDDEN, PROP_SLOTS, PROP_STRIDE, RING_HIDDEN, TRACKS } from './state.js';
import { sample } from './track.js';

/**
 * @typedef {object} Progress
 * @property {number} t                 ms into the clip
 * @property {number[]} phases          0..1 per phase, same order as clip.phases
 */

const IDLE_BREATH_PERIOD_MS = 3400;
const IDLE_BREATH_DEPTH = 0.018;
const FAINT_EYE_SIZE = 2.2;
const FAINT_EYES_IN_MS = 240;
const AT_REST_TOLERANCE = 1e-6;
const BLINK_CLOSE_MS = 60;
const BLINK_OPEN_MS = 80;
const BLINK_GAP_MIN_MS = 4000;
const BLINK_GAP_MAX_MS = 9000;
const PROP_FADE_MS = 200;

const easeOut = cubicBezier(0.2, 0.8, 0.4, 1);

/**
 * @param {import('./rig.js').Rig} rig
 * @param {{ random?: () => number }} [options]   `random` gives a number in [0, 1); a test passes its own to choose the blink times
 */
export function createPlayer(rig, { random = Math.random } = {}) {
  /** @type {import('./state.js').JetState} */
  const state = {
    body: rig.poses.circle.slice(),
    eyes: [...rig.eyes.circle, 0, 0, 1],
    colour: rig.palette.rest.slice(),
    scale: 1,
    ring: RING_HIDDEN.slice(),
    speed: 0,
    prop: PROP_HIDDEN.slice(),
    propKinds: [null, null],
  };
  /** @type {import('./clip.js').Clip | null} */
  let clip = null;
  let clipStart = 0;
  let idleStart = 0;
  let breathDepth = IDLE_BREATH_DEPTH;
  let eyesDial = 0;
  let reduced = false;
  // Faint eyes belong to the circle alone. A hold such as the lean ends away
  // from the circle and keeps the eyes it ended with.
  let atRest = true;
  let eyesMoved = false;
  // A random gap, so the blinks never fall into a rhythm you could count.
  const blinkGap = () => BLINK_GAP_MIN_MS + random() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS);
  let blinkAt = blinkGap();

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const snapshot = (name) => (Array.isArray(state[name]) ? state[name].slice() : state[name]);
  const propsFaded = () => {
    const prop = state.prop.slice();
    for (let slot = 0; slot < PROP_SLOTS; slot++) prop[slot * PROP_STRIDE + PROP.OPACITY] = 0;
    return prop;
  };
  function isAtRest() {
    const round = state.body.every((v, i) => Math.abs(v - rig.poses.circle[i]) <= AT_REST_TOLERANCE);
    const [, , , , radiusX, radiusY] = state.eyes;
    return round && radiusX <= AT_REST_TOLERANCE && radiusY <= AT_REST_TOLERANCE;
  }

  /** How open the faint eyes are at `now`, from 0 (shut) to 1 (open). */
  function blinkOpenness(now) {
    if (reduced) return 1;
    // A blink that is over, or that was missed because no tick came during it, plans the next one.
    if (now >= blinkAt + BLINK_CLOSE_MS + BLINK_OPEN_MS) blinkAt = now + blinkGap();
    const into = now - blinkAt;
    if (into < 0) return 1;
    if (into < BLINK_CLOSE_MS) return 1 - into / BLINK_CLOSE_MS;
    return (into - BLINK_CLOSE_MS) / BLINK_OPEN_MS;
  }

  /** The faint eyes grow in place from nothing once Jet comes to rest, then blink now and then. */
  function restEyes(now) {
    const grown = easeOut(clamp01((now - idleStart) / FAINT_EYES_IN_MS));
    const size = FAINT_EYE_SIZE * eyeSizeFor(eyesDial) * grown;
    return [...rig.eyes.circle, size, size * blinkOpenness(now), 1];
  }

  return {
    state,

    get playing() {
      return clip !== null;
    },

    get clip() {
      return clip;
    },

    /** How much the idle breathing moves; the motion channel sets it. */
    set breathing(motion0to10) {
      breathDepth = IDLE_BREATH_DEPTH * (motion0to10 / 10);
    },

    /** How big the faint eyes are at rest; the eyes channel sets it, and below 1.5 there are none. */
    set eyes(eyes0to10) {
      eyesDial = eyes0to10;
    },

    /** With reduced motion the faint eyes never blink. */
    set reducedMotion(on) {
      reduced = on;
    },

    /** True when the last tick moved the faint eyes, so a host that draws rarely while idle draws this frame. */
    get eyesMoved() {
      return eyesMoved;
    },

    /**
     * Starts a clip now. Every track gets the current state as its first key,
     * and a track the clip does not mention holds its current value. The props
     * are the exception: a clip that does not move them fades them out within
     * 200 ms, so a prop never outlives its clip.
     * @param {import('./clip.js').Clip} next
     * @param {number} now   performance.now()
     */
    play(next, now) {
      // SMELL: this changes the clip it is given. It adds a start key to every
      // track, creates a missing track and gives a clip with no props a key
      // that fades them out, so a clip object played twice has two start keys,
      // and its second run jumps to where Jet was when the first run started.
      state.propKinds = next.props ? next.props.slice() : [null, null];
      if (!next.prop?.length) next.prop = [{ t: Math.min(PROP_FADE_MS, next.total), v: propsFaded() }];
      for (const name of TRACKS) {
        const keys = next[name] || (next[name] = []);
        keys.unshift({ t: 0, v: snapshot(name) });
        keys.sort((a, b) => a.t - b.t);
      }
      clip = next;
      clipStart = now;
    },

    /**
     * Moves the state to time `now`.
     * @param {number} now   performance.now()
     * @returns {Progress | null}   null while idle
     */
    tick(now) {
      if (!clip) {
        const seconds = (now - idleStart) / 1000;
        state.scale = 1 + breathDepth * Math.sin((seconds * 2 * Math.PI * 1000) / IDLE_BREATH_PERIOD_MS);
        if (!atRest) {
          eyesMoved = false;
          return null;
        }
        const eyes = restEyes(now);
        eyesMoved = eyes.some((v, i) => v !== state.eyes[i]);
        state.eyes = eyes;
        return null;
      }
      eyesMoved = false;
      const t = now - clipStart;
      for (const name of TRACKS) state[name] = sample(clip[name], t);
      let start = 0;
      const phases = clip.phases.map((phase) => {
        const value = clamp01((t - start) / (phase.end - start));
        start = phase.end;
        return value;
      });
      if (t >= clip.total) {
        clip = null;
        idleStart = now;
        atRest = isAtRest();
        blinkAt = now + blinkGap();
      }
      return { t, phases };
    },
  };
}
