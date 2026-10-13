// Advances Jet through time. It owns the current state (body, eyes, colour,
// scale, ring, speed) and plays clips from wherever Jet is at that moment, so
// a new clip blends in instead of cutting. It knows nothing about the DOM.

import { RING_HIDDEN, TRACKS } from './state.js';
import { sample } from './track.js';

/**
 * @typedef {object} Progress
 * @property {number} t                 ms into the clip
 * @property {number[]} phases          0..1 per phase, same order as clip.phases
 */

const IDLE_BREATH_PERIOD_MS = 3400;
const IDLE_BREATH_DEPTH = 0.012;

/**
 * @param {import('./rig.js').Rig} rig
 */
export function createPlayer(rig) {
  /** @type {import('./state.js').JetState} */
  const state = {
    body: rig.poses.circle.slice(),
    eyes: [...rig.eyes.circle, 0, 0],
    colour: rig.palette.rest.slice(),
    scale: 1,
    ring: RING_HIDDEN.slice(),
    speed: 0,
  };
  /** @type {import('./clip.js').Clip | null} */
  let clip = null;
  let clipStart = 0;
  let idleStart = 0;
  let breathDepth = IDLE_BREATH_DEPTH;

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const snapshot = (name) => (Array.isArray(state[name]) ? state[name].slice() : state[name]);

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

    /**
     * Starts a clip now. Every track gets the current state as its first key,
     * and a track the clip does not mention holds its current value.
     * @param {import('./clip.js').Clip} next
     * @param {number} now   performance.now()
     */
    play(next, now) {
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
        return null;
      }
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
      }
      return { t, phases };
    },
  };
}
