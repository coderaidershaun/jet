// Decides which clip Jet plays for each thing that happens in a chat: the user typing or stalling,
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
 * The drop and the abseil are only for a move mostly straight down.
 */
const TRAVELS = { zoom: 'roll', drop: 'drop', abseil: 'abseil' };
const isTravel = (clipName) => Object.hasOwn(TRAVELS, clipName);
// A fall or a climb down only makes sense when the reply lies below Jet, so any other move rolls.
const MAX_SIDEWAYS_PER_DOWN = 0.35;

const STATUS_OF_CLIP = {
  working: 'working',
  workingEnd: 'working',
  interrupted: 'stopped',
  lean: 'typing',
  leanBack: 'typing',
  peer: 'typing',
  creep: 'typing',
  batBall: 'typing',
  batBallEnd: 'typing',
  doze: 'typing',
  dozeEnd: 'typing',
};

/** The holds Jet plays when the user starts typing; one is picked at random each time. */
const TYPING_HOLDS = ['lean', 'peer', 'creep'];

/** The antics Jet passes the time with when the user stalls mid-message, each with the clip that ends it. */
const ANTIC_ENDS = { batBall: 'batBallEnd', doze: 'dozeEnd' };
const isAntic = (clipName) => Object.hasOwn(ANTIC_ENDS, clipName);

// An antic is a loop of this length, started again each time it runs out.
const ANTIC_LOOP_MS = 10000;

// SMELL: this repeats the rule the bat-and-ball clip uses to decide whether its props show, so the
// two can drift apart and Jet would stand holding nothing.
/** The antics the dials allow: none under reduced motion, and only the doze at shape 0 or below motion 3, where the bat and the ball cannot show. */
function anticsFor({ shape, motion, reducedMotion }) {
  if (reducedMotion) return [];
  const batBallShows = shape > 0 && motion >= 3;
  return batBallShows ? Object.keys(ANTIC_ENDS) : ['doze'];
}

/**
 * @typedef {object} Step
 * @property {string} clip           a key of `CLIPS`
 * @property {object} [options]      what the clip builder is given
 * @property {boolean} [failed]      true for the error that reports a failed reply
 */

/**
 * The clips Jet may play as a message goes out, before it travels, all equally likely. Null plays none, and it comes
 * first so that a draw near 0 is the plain choice, as it is for the travel.
 * Each lasts at most 350 ms, because the take-off waits for it.
 */
const SEND_REACTIONS = [null, 'salute', 'nod', 'blink', 'hop'];
// A Jet more serious than this skips the blink.
const SERIOUS_BELOW = -0.3;

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
  // The travel waits here while a send reaction plays, in a slot of its own, so that a mood that arrives
  // meanwhile queues behind it instead of replacing it.
  /** @type {{ step: Step, clip: import('./clip.js').Clip } | null} */
  let queuedTravel = null;
  /** @type {{ long: boolean } | null} */
  let waitingDone = null;
  let running = false;
  let answered = false;
  let leaned = false;
  let loopStart = 0;

  const isPlaying = (name) => player.playing && current !== null && current.clip === name;
  const loopPlays = () => isPlaying('working');
  const anticPlays = () => player.playing && current !== null && isAntic(current.clip);
  const leaning = () => player.playing && current !== null && (TYPING_HOLDS.includes(current.clip) || current.clip === 'leanBack');
  const pickTypingHold = () => ({ clip: pick(TYPING_HOLDS, random) });

  /** Ends the antic that is playing. When the user is typing again, a typing hold follows it. */
  function endAntic(typingAgain, now) {
    start({ clip: ANTIC_ENDS[current.clip] }, now);
    if (typingAgain) {
      leaned = true;
      // SMELL: a hello that cuts in during the end clip keeps this hold queued, so the hold plays after
      // the hello with no lean back to follow it.
      queued = pickTypingHold();
    }
  }

  /** Starts an antic that ran out again where it left off, or ends it once the dials no longer allow it. */
  function carryOnAntic(antic, now) {
    if (anticsFor(params()).includes(antic)) start({ clip: antic, options: { loopMs: ANTIC_LOOP_MS, continued: true } }, now);
    else start({ clip: ANTIC_ENDS[antic] }, now);
  }

  const buildClip = (step) => CLIPS[step.clip].build(rig, params(), step.options);

  /**
   * @param {Step} step
   * @param {number} now
   * @param {import('./clip.js').Clip} [clip]   the step's clip when it is already built, else it is built now
   * @returns {import('./clip.js').Clip} the clip now playing
   */
  function start(step, now, clip = buildClip(step)) {
    current = step;
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
    queuedTravel = null;
    waitingDone = null;
  }

  /**
   * The clip Jet plays as a message goes out, before it travels, or null for none.
   * @returns {Step | null}
   */
  function pickSendReaction() {
    const choices = params().playful < SERIOUS_BELOW ? SEND_REACTIONS.filter((name) => name !== 'blink') : SEND_REACTIONS;
    const name = pick(choices, random);
    return name ? { clip: name } : null;
  }

  /**
   * The clip Jet travels to the reply with: the zoom, or for a move mostly straight down, any
   * travel at random.
   * @param {{ cruiseMs: number, dx: number, dy: number }} job   `dx` and `dy` are the pixels from Jet to the reply, for a travel that suits only some directions
   * @returns {Step}
   */
  function pickTravel({ cruiseMs, dx, dy }) {
    const straightDown = dy > 0 && Math.abs(dx) < MAX_SIDEWAYS_PER_DOWN * dy;
    const names = straightDown ? Object.keys(TRAVELS) : ['zoom'];
    return { clip: pick(names, random), options: { cruiseMs } };
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
     * The user started or stopped typing. Jet plays a typing hold, picked at random, only
     * when nothing else is going on, and leans back only after one. During an antic,
     * typing ends it and a typing hold follows, and an emptied field ends it with nothing after.
     * @param {boolean} active
     * @param {number} now
     */
    typing(active, now) {
      if (anticPlays()) {
        endAntic(active, now);
      } else if (active && statusNow() === 'idle' && !running && !queued && !waitingDone) {
        leaned = true;
        start(pickTypingHold(), now);
      } else if (!active && leaned) {
        leaned = false;
        if (queued && TYPING_HOLDS.includes(queued.clip)) queued = null;
        start({ clip: 'leanBack' }, now);
      }
    },

    /**
     * The user stopped typing with text still in the field. Jet passes the time with an
     * antic, but only when it is idle or leaning, no reply runs, nothing waits and motion
     * is not reduced.
     * @param {number} now
     */
    stall(now) {
      const antics = anticsFor(params());
      if (antics.length === 0 || running || queued || waitingDone || anticPlays()) return;
      if (player.playing && !leaning()) return;
      leaned = false;
      start({ clip: pick(antics, random), options: { loopMs: ANTIC_LOOP_MS } }, now);
    },

    /**
     * A message went out and a reply is on its way. Jet may play a short send reaction,
     * then travels to the reply, then works. With reduced motion there is no send reaction
     * and no travel, and the host moves nothing.
     * @param {{ cruiseMs: number, dx?: number, dy?: number }} job   how long the travel's cruise lasts,
     *   and the pixels from Jet to the reply (0 when unknown)
     * @param {number} now
     * @returns {{ moveAt: number, moveMs: number, profile: string }}   when the host moves the thread, in ms from
     *   `now` and after any send reaction, for how long, and how the host flies Jet there
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
      const reaction = pickSendReaction();
      const travel = pickTravel({ cruiseMs, dx, dy });
      const travelClip = buildClip(travel);
      let delay = 0;
      if (reaction) {
        delay = start(reaction, now).total;
        queuedTravel = { step: travel, clip: travelClip };
      } else {
        start(travel, now, travelClip);
      }
      const [launch, cruise] = travelClip.phases;
      return { moveAt: delay + launch.end, moveMs: cruise.end - launch.end, profile: TRAVELS[travel.clip] };
    },

    /**
     * The reply's mood word arrived. An unknown or missing word is neutral, which only
     * closes the loop. Any other word plays its clip, after the send reaction and the zoom, or after
     * the loop has ended, if any of them is playing. The queue holds one clip, so a newer mood replaces an older one.
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
     * after a send reaction, the travel waiting for it;
     * after a travel such as the zoom, the queued clip, else the waiting done, else the loop if a reply is still
     * running with no mood yet; after the loop ran out of spin, a continuation of it if the
     * reply is still running with no mood yet; after anything else, the queued clip, else the
     * waiting done, else the same antic again if an antic ran out (or its end clip once the dials no
     * longer allow it), else nothing.
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
        } else if (queuedTravel) {
          const { step, clip } = queuedTravel;
          queuedTravel = null;
          start(step, now, clip);
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
        } else if (isAntic(ended.clip)) {
          carryOnAntic(ended.clip, now);
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
