// Decides, from speech probabilities alone, where the user's phrases and thoughts begin and end.
// It never reads a clock: every pause is counted from the time stamps of the hops it is given, so
// a hidden tab with slow timers cannot stretch a pause.

import { judge } from './complete.js';
import { HOP_SAMPLES } from './vad.js';

export const SETTINGS = Object.freeze({
  HOP_MS: 16, // the voice detector scores 256 samples at 16 kHz
  ON_P: 0.6, // a hop counts as speech once the chance of speech passes this
  OFF_P: 0.4, // and stops counting once it falls under this, so one dip does not split a word
  START_MS: 96, // speech must last this long to be announced, which rejects clicks
  GUARD_START_MS: 400, // while Jet is audible, only a committed interruption counts
  GUARD_ON_P: 0.75, // and every hop of it must be this sure
  GUARD_TAIL_MS: 1000, // Jet's voice leaves an echo in the room for a second after it stops
  PRE_ROLL_MS: 300, // sound kept from before the speech, so the first consonant is not clipped
  PHRASE_GAP_MS: 320, // a natural breath, enough to cut a long phrase
  MIN_UTTERANCE_MS: 1000, // a phrase shorter than this waits for the longer gap
  SHORT_GAP_MS: 600, // a pause that closes a phrase of any length, so "Yes." alone is sent
  MAX_UTTERANCE_MS: 8000, // a long run-on is cut so its words still show up as it goes
  CUT_WINDOW_MS: 1200, // the cut is made at the quietest moment of this much of the end
  POST_ROLL_MS: 300, // the most of the pause that goes into a clip
  GAP_COMPLETE_MS: 700, // silence that ends a thought whose words end a sentence
  GAP_NEUTRAL_MS: 1000, // silence that ends a thought whose words give no sign
  GAP_OPEN_MS: 1500, // silence that ends a thought whose words are plainly unfinished
  WORDS_LATE_MS: 6000, // after this the turn goes on without the words that did not come
  TOO_SHORT_MS: 200, // less speech than this is a click or a cough, never sent
  ECHO_MATCH: 0.6, // six in ten words shared with what Jet just said means the mic heard Jet
  STRIKES_TO_HALF_DUPLEX: 2, // echoes before the mic stops listening while Jet speaks
  SLEEP_AFTER_MS: 600000, // ten minutes without a message
  LEVEL_FLOOR_RISE_PER_S: 1, // dB per second that the room's noise floor is allowed to drift up
  LEVEL_RANGE_DB: 30, // the level reads full this far above the floor
});

export const WORDS_LATE_MS = SETTINGS.WORDS_LATE_MS;

const { HOP_MS, ON_P, OFF_P, GUARD_ON_P } = SETTINGS;
const hopsIn = (ms) => Math.ceil(ms / HOP_MS);
const PRE_ROLL_HOPS = hopsIn(SETTINGS.PRE_ROLL_MS);
const POST_ROLL_HOPS = Math.floor(SETTINGS.POST_ROLL_MS / HOP_MS);
const RING_HOPS = PRE_ROLL_HOPS + hopsIn(SETTINGS.GUARD_START_MS);
const END_GAP_MS = { complete: SETTINGS.GAP_COMPLETE_MS, neutral: SETTINGS.GAP_NEUTRAL_MS, open: SETTINGS.GAP_OPEN_MS };
const HAS_LETTERS = /[\p{L}\p{N}]/u;

/**
 * @param {{ newTurn: () => string, onEvent: (event: object) => void }} options
 *   `newTurn` gives the id of each turn the moment speech opens one. Events: `level`, `speech`
 *   (with `interrupts`), `utterance` (with its `pcm`), `pausing`, `turn` and `discarded`.
 */
export function createEndpointer({ newTurn, onEvent }) {
  let state = 'quiet'; // quiet, speaking (an utterance is open) or pausing (the turn waits for its end)
  let turn = null;
  let utterance = null;
  let ring = [];
  let run = 0;
  let inSpeech = false;
  let jetSpeaking = false;
  let guardUntil = -Infinity;
  let guardTailStarts = false;
  let now = 0;
  let lastSpeechEnd = 0;
  let hopCount = 0;
  let floorDb = null;
  let recentLevel = 0;

  const guarded = () => jetSpeaking || now < guardUntil;
  const speechMs = () => utterance.speechHops * HOP_MS;

  function emitLevel(rms) {
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    floorDb = floorDb === null ? db : Math.min(db, floorDb + (SETTINGS.LEVEL_FLOOR_RISE_PER_S * HOP_MS) / 1000);
    const fraction = Math.min(1, Math.max(0, (db - floorDb) / SETTINGS.LEVEL_RANGE_DB));
    hopCount++;
    if (hopCount % 2 === 1) {
      recentLevel = fraction;
      return;
    }
    onEvent({ kind: 'level', level: Math.max(recentLevel, fraction) });
  }

  function emitSpeech(on) {
    onEvent({ kind: 'speech', on, turnId: turn.id, interrupts: turn.interrupts });
  }

  function openTurn() {
    turn = { id: newTurn(), interrupts: guarded(), nextIndex: 0, pending: new Map(), texts: new Map(), hadLateWords: false };
  }

  function startUtterance(runLength) {
    const hops = ring.slice(-(runLength + PRE_ROLL_HOPS));
    for (const record of hops.slice(-runLength)) record.speech = true;
    utterance = { hops, speechHops: runLength };
    lastSpeechEnd = now;
    inSpeech = true;
    run = 0;
    if (state === 'quiet') openTurn();
    if (state === 'pausing') onEvent({ kind: 'pausing', turnId: turn.id, on: false });
    state = 'speaking';
    emitSpeech(true);
  }

  function lookForStart(record) {
    const strict = guarded();
    const qualifies = strict ? record.p >= GUARD_ON_P : record.p >= (run > 0 ? OFF_P : ON_P);
    run = qualifies ? run + 1 : 0;
    if (run >= hopsIn(strict ? SETTINGS.GUARD_START_MS : SETTINGS.START_MS)) startUtterance(run);
  }

  function send(hops) {
    const index = turn.nextIndex++;
    const pcm = new Int16Array(hops.length * HOP_SAMPLES);
    hops.forEach((record, at) => pcm.set(record.hop, at * HOP_SAMPLES));
    turn.pending.set(index, now);
    onEvent({ kind: 'utterance', turnId: turn.id, index, pcm });
  }

  /** The open utterance up to its last speech, with a little of the pause after it. */
  function finishedClip() {
    const lastSpeech = utterance.hops.findLastIndex((record) => record.speech);
    return utterance.hops.slice(0, lastSpeech + 1 + POST_ROLL_HOPS);
  }

  function closeUtterance() {
    const clip = finishedClip();
    utterance = null;
    state = 'pausing';
    inSpeech = false;
    run = 0;
    emitSpeech(false);
    send(clip);
    onEvent({ kind: 'pausing', turnId: turn.id, on: true });
  }

  function dropUtterance() {
    utterance = null;
    inSpeech = false;
    run = 0;
    emitSpeech(false);
    if (turn.nextIndex > 0) {
      state = 'pausing';
      onEvent({ kind: 'pausing', turnId: turn.id, on: true });
    } else {
      discard('tooShort');
    }
  }

  /** A run-on is cut where it is quietest, and the rest of it heads the next utterance. */
  function cutRunOn() {
    const searchFrom = Math.max(0, utterance.hops.length - hopsIn(SETTINGS.CUT_WINDOW_MS));
    let quietest = searchFrom;
    for (let at = searchFrom; at < utterance.hops.length; at++) {
      if (utterance.hops[at].rms <= utterance.hops[quietest].rms) quietest = at;
    }
    const rest = utterance.hops.slice(quietest + 1);
    send(utterance.hops.slice(0, quietest + 1));
    utterance = { hops: rest, speechHops: rest.filter((record) => record.speech).length };
  }

  function whileSpeaking(record) {
    record.speech = inSpeech ? record.p >= OFF_P : record.p >= ON_P;
    inSpeech = record.speech;
    utterance.hops.push(record);
    if (record.speech) {
      utterance.speechHops++;
      lastSpeechEnd = now;
      if (speechMs() >= SETTINGS.MAX_UTTERANCE_MS) cutRunOn();
      return;
    }
    const gap = now - lastSpeechEnd;
    if (gap >= SETTINGS.SHORT_GAP_MS) {
      if (speechMs() >= SETTINGS.TOO_SHORT_MS) closeUtterance();
      else dropUtterance();
    } else if (gap >= SETTINGS.PHRASE_GAP_MS && speechMs() >= SETTINGS.MIN_UTTERANCE_MS) {
      closeUtterance();
    }
  }

  function discard(reason) {
    const turnId = turn.id;
    if (state === 'pausing') onEvent({ kind: 'pausing', turnId, on: false });
    turn = null;
    state = 'quiet';
    onEvent({ kind: 'discarded', turnId, reason });
  }

  function endTurn() {
    const turnId = turn.id;
    onEvent({ kind: 'pausing', turnId, on: false });
    turn = null;
    state = 'quiet';
    onEvent({ kind: 'turn', turnId });
  }

  /** The words of the latest utterance that had any, which say how finished the thought sounds. */
  function lastWords() {
    const indexes = [...turn.texts.keys()].sort((a, b) => b - a);
    const latest = indexes.find((index) => HAS_LETTERS.test(turn.texts.get(index)));
    return latest === undefined ? null : turn.texts.get(latest);
  }

  /** A clip whose words are late counts as one without words, so it cannot hold back the clips after it. */
  function giveUpLateWords() {
    for (const [index, sentAt] of turn.pending) {
      if (now - sentAt < SETTINGS.WORDS_LATE_MS) continue;
      turn.pending.delete(index);
      turn.hadLateWords = true;
    }
  }

  function judgeEnd() {
    if (state !== 'pausing') return;
    giveUpLateWords();
    if (turn.pending.size > 0) return;
    const words = lastWords();
    if (words === null) discard(turn.hadLateWords ? 'late' : 'noWords');
    else if (now - lastSpeechEnd >= END_GAP_MS[judge(words)]) endTurn();
  }

  /** Ends whatever is open with neither a `turn` nor a `discarded` event. */
  function dropOpen() {
    if (turn !== null) {
      if (state === 'speaking') emitSpeech(false);
      if (state === 'pausing') onEvent({ kind: 'pausing', turnId: turn.id, on: false });
    }
    turn = null;
    utterance = null;
    state = 'quiet';
    ring = [];
    run = 0;
    inSpeech = false;
  }

  return {
    /** @param {{ hop: Int16Array, p: number, rms: number, atMs: number }} frame   one 256-sample hop, its speech probability and loudness (0 to 1), and when it began */
    frame({ hop, p, rms, atMs }) {
      const record = { hop, p, rms, speech: false };
      now = atMs + HOP_MS;
      if (guardTailStarts) {
        guardUntil = now + SETTINGS.GUARD_TAIL_MS;
        guardTailStarts = false;
      }
      emitLevel(rms);
      ring.push(record);
      if (ring.length > RING_HOPS) ring.shift();
      if (state === 'speaking') {
        whileSpeaking(record);
      } else {
        lookForStart(record);
        // While speech may be starting again, the turn is not ended under it.
        if (run === 0) judgeEnd();
      }
    },

    /** The words of an utterance, empty when it had none. Words for a turn that has ended are ignored. */
    words({ index, text }) {
      if (turn === null || !turn.pending.has(index)) return;
      turn.pending.delete(index);
      turn.texts.set(index, text);
      judgeEnd();
    },

    /** While Jet's voice plays, and for a second after, only a committed interruption starts speech. */
    setGuard({ jetSpeaking: speaking }) {
      // The tail is counted from the next hop, because no hops arrive while the microphone is kept deaf during Jet's voice.
      if (jetSpeaking && !speaking) guardTailStarts = true;
      if (speaking) guardTailStarts = false;
      jetSpeaking = speaking;
    },

    /** The microphone is gone. The open utterance is still sent for its words, but the turn ends with no `turn` event, so it is never sent as a message. */
    end() {
      if (state === 'speaking' && speechMs() >= SETTINGS.TOO_SHORT_MS) send(finishedClip());
      dropOpen();
    },

    /** Forgets the open turn and what was heard before it. */
    abandon: dropOpen,
  };
}
