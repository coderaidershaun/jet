// Decides which clip Jet plays for each thing that happens in a chat: the user typing,
// a message going out, a mood arriving, the reply finishing or failing, the user
// stopping it. It only chooses and orders clips. It has no DOM and no timers, and it
// reads time only from the `now` it is given, so a host can drive it from any clock.

import { CLIPS } from './clips/catalogue.js';
import { RING } from './state.js';

export const MOODS = ['neutral','happy','excited','thinking','curious','sorry','alert','annoyed','hello'];

/** What each mood plays. A mood that plays nothing only closes the loop. */
const MOOD_CLIPS = {
  neutral: null,
  happy: { clip: 'done', options: { long: true } },
  excited: { clip: 'excited' },
  thinking: { clip: 'thinking' },
  curious: { clip: 'needsYou' },
  sorry: { clip: 'error', options: { exclaim: false } },
  alert: { clip: 'error' },
  annoyed: { clip: 'annoyed' },
  hello: { clip: 'hello', options: { brief: true } },
};

// A job that took at least this long gets the long done clip.
const LONG_JOB_MS = 8000;

/**
 * Each clip Jet can travel to the reply with, and how the host flies Jet while it plays.
 * Every travel clip must have the zoom's three phases, launch, cruise and brake, because the
 * host flies Jet across the page during the cruise.
 */
const TRAVELS = { zoom: 'roll' };
const isTravel = (clipName) => Object.hasOwn(TRAVELS, clipName);

const STATUS_OF_CLIP = {
  working: 'working',
  workingEnd: 'working',
  interrupted: 'stopped',
  lean: 'typing',
  leanBack: 'typing',
};

/**
 * @typedef {object} Step
 * @property {string} clip           a key of `CLIPS`
 * @property {object} [options]      what the clip builder is given
 * @property {boolean} [failed]      true for the error that reports a failed reply
 */

/**
 * @template T
 * @param {T[]} list
 * @param {() => number} random   a number in [0, 1)
 * @returns {T}
 */
function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

/**
 * @param {{
 *   player: ReturnType<typeof import('./player.js').createPlayer>,
 *   rig: import('./rig.js').Rig,
 *   params: () => import('./clip.js').Params,
 *   random?: () => number,
 * }} deps   `params` is read each time a clip is built, so the dials are always the current ones;
 *   `random` gives a number in [0, 1) for every choice, and a test passes its own
 */
export function createDirector({ player, rig, params, random = Math.random }) {
  /** @type {Step | null} */
  let current = null;
  /** @type {Step | null} */
  let queued = null;
  /** @type {{ long: boolean } | null} */
  let waitingDone = null;
  let running = false;
  let answered = false;
  let leaned = false;
  let loopStart = 0;

  const isPlaying = (name) => player.playing && current !== null && current.clip === name;
  const loopPlays = () => isPlaying('working');

  /** @returns {import('./clip.js').Clip} the clip now playing */
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

  function startDone(long, now) {
    start({ clip: 'done', options: { long } }, now);
  }

  /** @returns {'idle' | 'typing' | 'travelling' | 'working' | 'reacting' | 'stopped' | 'failed'} */
  function statusNow() {
    if (!player.playing) return leaned ? 'typing' : 'idle';
    if (current.failed) return 'failed';
    if (isTravel(current.clip)) return 'travelling';
    return STATUS_OF_CLIP[current.clip] ?? 'reacting';
  }

  function clearWaiting() {
    queued = null;
    waitingDone = null;
  }

  /**
   * The clip Jet plays as a message goes out, before it travels, or null for none.
   * @returns {Step | null}
   */
  function pickSendReaction() {
    return null;
  }

  /**
   * The clip Jet travels to the reply with.
   * @param {{ cruiseMs: number, dx: number, dy: number }} job   `dx` and `dy` are the pixels from Jet to the reply, for a travel that suits only some directions
   * @returns {Step}
   */
  function pickTravel({ cruiseMs }) {
    return { clip: pick(Object.keys(TRAVELS), random), options: { cruiseMs } };
  }

  return {
    /**
     * Plays hello, unless a reply is running, and drops any lean.
     * @param {number} now
     * @param {{ brief?: boolean }} [options]
     */
    hello(now, { brief = false } = {}) {
      if (running) return;
      leaned = false;
      start({ clip: 'hello', options: { brief } }, now);
    },

    /**
     * The user started or stopped typing. Jet leans in only when nothing else is going
     * on, and leans back only after it leaned in.
     * @param {boolean} active
     * @param {number} now
     */
    typing(active, now) {
      if (active && statusNow() === 'idle' && !running && !queued && !waitingDone) {
        leaned = true;
        start({ clip: 'lean' }, now);
      } else if (!active && leaned) {
        leaned = false;
        start({ clip: 'leanBack' }, now);
      }
    },

    /**
     * A message went out and a reply is on its way. Jet travels to the reply and then
     * works. With reduced motion there is no travel and the host moves nothing.
     * @param {{ cruiseMs: number, dx?: number, dy?: number }} job   how long the travel's cruise lasts,
     *   and the pixels from Jet to the reply (0 when unknown)
     * @param {number} now
     * @returns {{ moveAt: number, moveMs: number, profile: string }}   when the host moves the thread, and
     *   for how long, in ms from `now`, and how the host flies Jet there
     */
    send({ cruiseMs, dx = 0, dy = 0 }, now) {
      running = true;
      answered = false;
      leaned = false;
      clearWaiting();
      if (params().reducedMotion) {
        startLoop(now);
        return { moveAt: 0, moveMs: 0, profile: 'roll' };
      }
      // SMELL: the reaction is chosen but never played, because every choice is null for now. Playing one
      // means starting the travel only once the reaction has ended.
      const reaction = pickSendReaction();
      const travel = pickTravel({ cruiseMs, dx, dy });
      const clip = start(travel, now);
      return { moveAt: clip.phases[0].end, moveMs: clip.phases[1].end - clip.phases[0].end, profile: TRAVELS[travel.clip] };
    },

    /**
     * The reply's mood word arrived. An unknown or missing word is neutral, which only
     * closes the loop. Any other word plays its clip, after the zoom or after the loop
     * has ended if either is playing. The queue holds one clip, so a newer mood replaces an older one.
     * @param {string} word
     * @param {number} now
     */
    mood(word, now) {
      answered = true;
      const key = String(word ?? '').trim().toLowerCase();
      const entry = MOOD_CLIPS[Object.hasOwn(MOOD_CLIPS, key) ? key : 'neutral'];
      if (!entry) {
        if (loopPlays()) endLoop(now);
        return;
      }
      const step = { clip: entry.clip, options: entry.options };
      if (loopPlays()) {
        endLoop(now);
        queued = step;
      } else if (player.playing) {
        queued = step;
      } else {
        start(step, now);
      }
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
     * The reply finished. The done clip never cuts or replaces a mood: it waits for the
     * zoom, the loop closing and any mood to finish.
     * @param {{ elapsedMs: number }} job
     * @param {number} now
     */
    done({ elapsedMs }, now) {
      running = false;
      const long = elapsedMs >= LONG_JOB_MS;
      if (loopPlays()) {
        endLoop(now);
        waitingDone = { long };
      } else if (player.playing || queued) {
        waitingDone = { long };
      } else {
        startDone(long, now);
      }
    },

    /**
     * The reply failed. Anything waiting is dropped, the loop closes if it is playing or
     * finishes closing if it already is, and then the error plays.
     * @param {number} now
     */
    failed(now) {
      running = false;
      clearWaiting();
      const step = { clip: 'error', failed: true };
      if (loopPlays()) endLoop(now);
      if (isPlaying('workingEnd')) queued = step;
      else start(step, now);
    },

    /**
     * The user stopped the reply. Interrupted plays at once and everything waiting is dropped.
     * @param {number} now
     */
    stopped(now) {
      running = false;
      clearWaiting();
      start({ clip: 'interrupted', options: { rotate: player.state.ring[RING.ROTATE] } }, now);
    },

    /**
     * Moves Jet to time `now`. Call it once per frame, before drawing. When the clip that was
     * playing has ended, it starts the next one:
     * after a travel such as the zoom, the queued clip, else the waiting done, else the loop if a reply is still
     * running with no mood yet; after the loop ran out of spin, a continuation of it if the
     * reply is still running with no mood yet; after anything else, the queued clip, else the
     * waiting done, else nothing.
     * @param {number} now
     * @returns {{ clip: string | null, busy: boolean }}
     *   `clip` is the catalogue name of the clip playing after this tick, or null;
     *   `busy` is true while a clip plays, is queued or is waiting, so a host knows to draw every frame
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
        } else if (waitingDone) {
          const { long } = waitingDone;
          waitingDone = null;
          startDone(long, now);
        } else if (isTravel(ended.clip) && loopWanted) {
          startLoop(now);
        }
      }
      return { clip: player.playing ? current.clip : null, busy: player.playing || queued !== null || waitingDone !== null };
    },

    /** @returns {'idle' | 'typing' | 'travelling' | 'working' | 'reacting' | 'stopped' | 'failed'} */
    get status() {
      return statusNow();
    },
  };
}
