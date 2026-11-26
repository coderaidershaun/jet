// A clip is one stretch of movement: a track for each part of the state, a
// length and named phases. Every clip is written with the writers made here,
// so all clips are written the same way.

import { easeInOut, easeOut } from './easing.js';
import { HOVER_Y } from './parts/forms.js';
import { restState, TRACKS } from './state.js';

/**
 * @typedef {object} Clip
 * @property {import('./track.js').Key[]} [y]  and one track for each other name in `TRACKS`; a track a clip never writes is empty and holds when played
 * @property {number[]} [windHz]                  authored string wind speeds during the clip
 * @property {number} total                          clip length in ms
 * @property {{ name: string, end: number }[]} phases  in order, ends in ms
 * @property {string | null} revealFrom              the phase whose start is when a reply's text may show
 */

/**
 * @typedef {object} Start
 * @property {boolean} standing
 * @property {string} eyeKind
 * @property {boolean} reducedMotion
 */

/** By this time any clip has brought the tracks it does not own back to rest. */
const RETURN_TO_REST_MS = 200;

function checkTime(what, at) {
  if (Number.isFinite(at)) return;
  const got = typeof at === 'function' ? 'a function: write t() with its brackets' : String(at);
  throw new TypeError(what + ' needs a finite number as its time, got ' + got);
}

/**
 * Makes an empty clip and the writers that put keys on its tracks. Times are
 * in milliseconds from the start of the clip.
 *
 * `y(at, v, e)` and the twelve other writers named after the tracks each push a
 * key at the time `at`; `e` is the easing used while arriving at it. `t()` is
 * the latest key time written so far, so a clip can chain durations:
 * `y(t() + 320, 64, ease)`. Write `t()` with its brackets: a writer refuses a
 * time that is not a finite number, and a bare `t` is the function.
 *
 * `phase(name, end)` ends a phase at `end`, or at `t()` when no end is given.
 * `finish({ revealFrom })` sets the clip's length to the end of the last phase,
 * checks that `revealFrom` names a phase, and returns the clip.
 *
 * `returnToRest` is for the start of a builder: any clip can interrupt any
 * clip, so every clip brings the tracks it does not own back to rest early.
 * Its keys are not part of the clip's own timeline, so `t()` does not follow them.
 */
export function createClip() {
  /** @type {Clip} */
  const clip = { total: 0, phases: [], revealFrom: null };
  for (const name of TRACKS) clip[name] = [];
  let latest = 0;

  const writers = Object.fromEntries(
    TRACKS.map((name) => [
      name,
      (at, v, e) => {
        checkTime('a key on the ' + name + ' track', at);
        clip[name].push({ t: at, v, e });
        latest = Math.max(latest, at);
      },
    ]),
  );

  /**
   * @param {{ standing: boolean }} start
   * @param {string[]} [owned]  the tracks this clip writes itself; they get no key here
   */
  function returnToRest({ standing }, owned = []) {
    const toRest = (name, v, e) => {
      if (!owned.includes(name)) clip[name].push({ t: RETURN_TO_REST_MS, v, e });
    };
    toRest('y', standing ? 0 : HOVER_Y, easeOut);
    toRest('form', 0, easeInOut);
    toRest('squash', [1, 1], easeInOut);
    toRest('lift', [0, 0], easeInOut);
    toRest('lids', [0, 0], easeOut);
    toRest('roll', 0, easeOut);
    toRest('anger', 0, easeOut);
    toRest('squint', 0, easeOut);
    toRest('payout', 1, easeOut);
    toRest('drift', 0, easeOut);
    toRest('written', null);
    toRest('stringPose', restState({ standing }).stringPose);
  }

  const phase = (name, end = latest) => {
    checkTime('the end of phase ' + name, end);
    clip.phases.push({ name, end });
  };

  /** @param {{ revealFrom?: string }} [options] */
  function finish({ revealFrom } = {}) {
    if (revealFrom !== undefined && !clip.phases.some((p) => p.name === revealFrom)) {
      const names = clip.phases.map((p) => p.name).join(', ');
      throw new Error(`revealFrom "${revealFrom}" is not one of the clip's phases (${names || 'none'})`);
    }
    clip.total = clip.phases.length > 0 ? clip.phases[clip.phases.length - 1].end : 0;
    clip.revealFrom = revealFrom ?? null;
    return clip;
  }

  return { clip, ...writers, t: () => latest, phase, finish, returnToRest };
}
