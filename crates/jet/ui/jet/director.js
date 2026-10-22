// Decides which clip Jet plays for each thing that happens in a chat: a message
// going out, a mood arriving, the reply starting, finishing, failing or being
// stopped. It only chooses and orders clips. It has no DOM and no timers, and
// it reads time only from the `now` it is given, so a host can drive it from
// any clock.

import { CLIPS } from './clips/catalogue.js';
import { EMOTIONS } from './emotions.js';

/** Every mood word a reply may start with. */
export const MOODS = ['neutral', 'hello', 'insulted'];

// How long the text waits for a mood that plays no clip, in ms.
const MOOD_HOLD_MS = 300;

const STATUS_OF_CLIP = {
  fly: 'flying',
  settle: 'flying',
  working: 'working',
  workingEnd: 'working',
};

/** When the named phase of a clip ends, in ms from its start. */
function phaseEnd(clip, name) {
  const found = clip.phases.find((phase) => phase.name === name);
  if (!found) throw new Error(`the clip has no phase named ${name}; its phases are ${clip.phases.map((phase) => phase.name).join(', ')}`);
  return found.end;
}

/**
 * @typedef {object} Step
 * @property {string} clip           a key of `CLIPS`
 * @property {object} [options]      what the clip builder is given
 */

/**
 * @param {{ player: ReturnType<typeof import('./player.js').createPlayer> }} deps
 */
export function createDirector({ player }) {
  /** Steps waiting to play, in order. A settle always waits last. @type {Step[]} */
  const queue = [];
  /** The step that is playing, or that played last, with the clip built for it. @type {{ step: Step, clip: import('./clip.js').Clip, startedAt: number } | null} */
  let current = null;
  let running = false;
  let answered = false;
  let workingStartedAt = 0;

  const startOf = () => ({ standing: player.standing, eyeKind: player.state.eyeKind, reducedMotion: player.reducedMotion });
  const build = (step) => CLIPS[step.clip].build(startOf(), step.options);
  const spinnerPlays = () => player.playing && current.step.clip === 'working';

  /** @param {Step} step @param {number} now */
  function start(step, now) {
    const clip = build(step);
    current = { step, clip, startedAt: now };
    player.play(clip, now);
    return clip;
  }

  function startSpinner(now) {
    workingStartedAt = now;
    start({ clip: 'working' }, now);
  }

  function closeSpinner(now) {
    if (!spinnerPlays()) return;
    start({ clip: 'workingEnd', options: { roll: player.state.roll, elapsedMs: now - workingStartedAt } }, now);
  }

  // Starts the next waiting step. Jet that already stands has nothing to settle, so that step is skipped.
  function startNext(now) {
    while (queue.length > 0) {
      const step = queue.shift();
      if (step.clip === 'settle' && player.standing) continue;
      start(step, now);
      return true;
    }
    return false;
  }

  // A step goes in before a waiting settle, so the settle stays last. It starts at once when nothing plays.
  function enqueue(step, now) {
    const settleAt = queue.findIndex((waiting) => waiting.clip === 'settle');
    queue.splice(step.clip === 'settle' || settleAt < 0 ? queue.length : settleAt, 0, step);
    if (!player.playing) startNext(now);
  }

  // Ms from the clip's start to the start of its reveal phase, where the text may show. A clip with no reveal phase shows it at once.
  const revealOffset = (clip) => {
    const at = clip.phases.findIndex((phase) => phase.name === clip.revealFrom);
    return at > 0 ? clip.phases[at - 1].end : 0;
  };

  /**
   * Ms from `now` until `step`, which is playing or waiting, reaches the start of its reveal phase.
   * @param {Step} step
   * @param {number} now
   */
  function msUntilReveal(step, now) {
    if (current?.step === step) return Math.max(0, revealOffset(current.clip) - (now - current.startedAt));
    let ms = player.playing ? Math.max(0, current.clip.total - (now - current.startedAt)) : 0;
    for (const waiting of queue) {
      const clip = build(waiting);
      if (waiting === step) return ms + revealOffset(clip);
      ms += clip.total;
    }
    throw new Error(`step ${step.clip} is neither playing nor waiting`);
  }

  function endReply(now) {
    running = false;
    closeSpinner(now);
    enqueue({ clip: 'settle' }, now);
  }

  return {
    /**
     * Plays hello, unless a reply is running.
     * @param {number} now
     * @param {{ brief?: boolean }} [options]
     */
    hello(now, { brief = false } = {}) {
      if (running) return;
      enqueue({ clip: 'hello', options: { brief } }, now);
    },

    /**
     * A message went out and a reply is on its way. Jet flies to the reply, then works.
     * With reduced motion there is no flight, and the host moves nothing.
     * @param {{ cruiseMs: number }} job   how long the flight's cruise lasts
     * @param {number} now
     * @returns {{ moveAt: number, moveMs: number }}   when the host moves the thread, in ms from `now`, and for how long
     */
    send({ cruiseMs }, now) {
      running = true;
      answered = false;
      queue.length = 0;
      if (player.reducedMotion) {
        startSpinner(now);
        return { moveAt: 0, moveMs: 0 };
      }
      const flight = start({ clip: 'fly', options: { cruiseMs } }, now);
      const launchEnd = phaseEnd(flight, 'launch');
      return { moveAt: launchEnd, moveMs: phaseEnd(flight, 'cruise') - launchEnd };
    },

    /**
     * The reply's mood word arrived, so the spinner closes. A word with a clip plays it, after the
     * flight or after the spinner has closed if either is playing.
     * @param {string} word
     * @param {number} now
     * @returns {{ revealAt: number }}   absolute monotonic deadline when the reply's text may show
     */
    mood(word, now) {
      answered = true;
      const key = String(word ?? '').trim().toLowerCase();
      const emotion = Object.hasOwn(EMOTIONS, key) ? EMOTIONS[key] : null;
      closeSpinner(now);
      if (!emotion) return { revealAt: now + MOOD_HOLD_MS };
      const step = { clip: emotion.clip, options: emotion.options };
      enqueue(step, now);
      return { revealAt: now + msUntilReveal(step, now) };
    },

    /**
     * The first text of the reply arrived. If no mood came, the spinner closes now.
     * @param {number} now
     */
    replying(now) {
      if (answered) return;
      answered = true;
      closeSpinner(now);
    },

    /**
     * The reply finished. The spinner closes if it is playing, a waiting reaction still plays, and Jet settles.
     * @param {number} now
     */
    done(now) {
      endReply(now);
    },

    /** The reply failed: whatever waited is dropped, and Jet settles. @param {number} now */
    failed(now) {
      queue.length = 0;
      endReply(now);
    },

    /** The user stopped the reply: whatever waited is dropped, and Jet settles. @param {number} now */
    stopped(now) {
      queue.length = 0;
      endReply(now);
    },

    /**
     * Moves Jet to time `now`. Call it once per frame, before drawing. When a clip ends, the next
     * one starts: the spinner goes on while the reply runs with no answer yet, else the next
     * waiting step plays, else after a flight the spinner starts if the reply has no answer yet.
     * @param {number} now
     * @returns {{ clip: string | null, busy: boolean }}
     *   `clip` is the catalogue name of the clip playing after this tick, or null;
     *   `busy` is true while a clip plays or a step waits, so a host knows to draw every frame
     */
    tick(now) {
      const wasPlaying = player.playing;
      player.tick(now);
      if (wasPlaying && !player.playing) {
        const ended = current.step.clip;
        const spinnerWanted = running && !answered;
        if (ended === 'working' && spinnerWanted) {
          start({ clip: 'working', options: { continueFrom: { roll: player.state.roll, elapsedMs: now - workingStartedAt } } }, now);
        } else if (!startNext(now) && ended === 'fly' && spinnerWanted) {
          startSpinner(now);
        }
      }
      return { clip: player.playing ? current.step.clip : null, busy: player.playing || queue.length > 0 };
    },

    /** @returns {'idle' | 'flying' | 'working' | 'reacting'} */
    get status() {
      if (!player.playing) return 'idle';
      return STATUS_OF_CLIP[current.step.clip] ?? 'reacting';
    },
  };
}
