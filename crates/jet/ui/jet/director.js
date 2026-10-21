// Decides which clip Jet plays for each thing that happens in a chat: a message going
// out, a mood arriving, the reply starting, finishing, failing or being stopped. It only
// chooses and orders clips. It has no DOM and no timers, and it reads time only from the
// `now` it is given, so a host can drive it from any clock.

import { CLIPS } from './clips/catalogue.js';
import { RING } from './state.js';

/** Every mood word a reply may start with. */
export const MOODS = ['neutral','happy','excited','thinking','curious','sorry','alert','annoyed','hello'];

/** The moods that play a clip. Every other word only closes the loop. */
const MOOD_CLIPS = {
  hello: { clip: 'hello', options: { brief: true } },
};

const STATUS_OF_CLIP = {
  zoom: 'travelling',
  working: 'working',
  workingEnd: 'working',
};

/**
 * @typedef {object} Step
 * @property {string} clip           a key of `CLIPS`
 * @property {object} [options]      what the clip builder is given
 */

/**
 * @param {{
 *   player: ReturnType<typeof import('./player.js').createPlayer>,
 *   rig: import('./rig.js').Rig,
 *   params: () => import('./clip.js').Params,
 * }} deps   `params` is read each time a clip is built, so the dials are always the current ones
 */
export function createDirector({ player, rig, params }) {
  /** @type {Step | null} */
  let current = null;
  /** @type {Step | null} */
  let queued = null;
  let running = false;
  let answered = false;
  let loopStart = 0;

  const loopPlays = () => player.playing && current !== null && current.clip === 'working';

  /** @param {Step} step @param {number} now */
  function start(step, now) {
    current = step;
    const clip = CLIPS[step.clip].build(rig, params(), step.options);
    player.play(clip, now);
    return clip;
  }

  function startLoop(now) {
    loopStart = now;
    start({ clip: 'working' }, now);
  }

  function endLoop(now) {
    start({ clip: 'workingEnd', options: { rotate: player.state.ring[RING.ROTATE] } }, now);
  }

  /** The reply is over. Anything waiting is dropped, and the loop closes if it is playing. */
  function dropReply(now) {
    running = false;
    queued = null;
    if (loopPlays()) endLoop(now);
  }

  /** @returns {'idle' | 'travelling' | 'working' | 'reacting'} */
  function statusNow() {
    if (!player.playing) return 'idle';
    return STATUS_OF_CLIP[current.clip] ?? 'reacting';
  }

  return {
    /**
     * Plays hello, unless a reply is running.
     * @param {number} now
     * @param {{ brief?: boolean }} [options]
     */
    hello(now, { brief = false } = {}) {
      if (running) return;
      start({ clip: 'hello', options: { brief } }, now);
    },

    /**
     * A message went out and a reply is on its way. Jet zooms to the reply, then works.
     * With reduced motion there is no zoom, and the host moves nothing.
     * @param {{ cruiseMs: number }} job   how long the zoom's cruise lasts
     * @param {number} now
     * @returns {{ moveAt: number, moveMs: number }}   when the host moves the thread, in ms from `now`, and for how long
     */
    send({ cruiseMs }, now) {
      running = true;
      answered = false;
      queued = null;
      if (params().reducedMotion) {
        startLoop(now);
        return { moveAt: 0, moveMs: 0 };
      }
      const [launch, cruise] = start({ clip: 'zoom', options: { cruiseMs } }, now).phases;
      return { moveAt: launch.end, moveMs: cruise.end - launch.end };
    },

    /**
     * The reply's mood word arrived. Hello plays its clip, after the zoom or after the loop
     * has ended, if either is playing. Any other word, or none, only closes the loop.
     * @param {string} word
     * @param {number} now
     */
    mood(word, now) {
      answered = true;
      const key = String(word ?? '').trim().toLowerCase();
      const entry = Object.hasOwn(MOOD_CLIPS, key) ? MOOD_CLIPS[key] : null;
      if (loopPlays()) endLoop(now);
      if (!entry) return;
      const step = { clip: entry.clip, options: entry.options };
      if (player.playing) queued = step;
      else start(step, now);
    },

    /**
     * The first text of the reply arrived. If no mood came, the loop closes now.
     * @param {number} now
     */
    replying(now) {
      if (answered) return;
      answered = true;
      if (loopPlays()) endLoop(now);
    },

    /**
     * The reply finished. The loop closes if it is playing, and a queued hello still plays.
     * @param {number} now
     */
    done(now) {
      running = false;
      if (loopPlays()) endLoop(now);
    },

    /** @param {number} now */
    failed(now) {
      dropReply(now);
    },

    /** @param {number} now */
    stopped(now) {
      dropReply(now);
    },

    /**
     * Moves Jet to time `now`. Call it once per frame, before drawing. When the clip that was
     * playing has ended, it starts the next one: after the loop ran out of spin, a continuation
     * of it if the reply is still running with no answer yet; else the queued clip; else, after
     * the zoom, the loop if the reply is still running with no answer yet; else nothing.
     * @param {number} now
     * @returns {{ clip: string | null, busy: boolean }}
     *   `clip` is the catalogue name of the clip playing after this tick, or null;
     *   `busy` is true while a clip plays or is queued, so a host knows to draw every frame
     */
    tick(now) {
      const wasPlaying = player.playing;
      player.tick(now);
      if (wasPlaying && !player.playing) {
        const ended = current;
        const loopWanted = running && !answered;
        if (ended.clip === 'working' && loopWanted) {
          start({ clip: 'working', options: { continueFrom: { rotate: player.state.ring[RING.ROTATE], elapsedMs: now - loopStart } } }, now);
        } else if (queued) {
          const next = queued;
          queued = null;
          start(next, now);
        } else if (ended.clip === 'zoom' && loopWanted) {
          startLoop(now);
        }
      }
      return { clip: player.playing ? current.clip : null, busy: player.playing || queued !== null };
    },

    /** @returns {'idle' | 'travelling' | 'working' | 'reacting'} */
    get status() {
      return statusNow();
    },
  };
}
