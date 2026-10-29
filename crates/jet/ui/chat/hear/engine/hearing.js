// The listening engine: it turns the microphone into a few small events about what the user said.
// It owns the turns, tells echoes of Jet's own voice from the user, and lets go of the microphone
// when nobody talks. It touches no page element, so it can be tested without a browser.

import { realClock } from '../../clock.js';
import { createEndpointer, SETTINGS } from './endpointer.js';
import { createUtterances } from './utterances.js';
import { HOP_SAMPLES } from './vad.js';

const STRIKES_KEY = 'jet.hear.strikes';
const SPOKEN_WORD = /[\p{L}\p{N}]+/gu;
/** For these reasons the microphone only waits for a touch; for the others it is blocked until the user acts. */
const WAITING_KINDS = new Set(['suspended', 'muted']);

const wordsOf = (text) => text.toLowerCase().match(SPOKEN_WORD) ?? [];

/** True when most of the heard words are words Jet itself said a moment ago. */
function isEcho(heard, jetWords) {
  const words = wordsOf(heard);
  if (words.length < 3) return false;
  const available = new Map();
  for (const word of wordsOf(jetWords)) available.set(word, (available.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of words) {
    if ((available.get(word) ?? 0) > 0) {
      available.set(word, available.get(word) - 1);
      shared++;
    }
  }
  return shared / words.length >= SETTINGS.ECHO_MATCH;
}

function turnText(texts) {
  const inOrder = [...texts.entries()].sort(([a], [b]) => a - b).map(([, words]) => words);
  const text = inOrder.join(' ').replace(/\s+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * @param {{
 *   capture: { start: () => Promise<unknown>, stop: () => void, onFrames: ((hops: Int16Array, rms: number[], atMs: number) => void) | null, onEnded: ((reason: { kind: string, message: string }) => void) | null },
 *   vad: { probability: (hop: Int16Array) => number, reset: () => void },
 *   transcribe: (pcm: Int16Array, options: { vocabulary: string[], signal: AbortSignal }) => Promise<{ text: string }>,
 *   vocabulary: () => string[],
 *   recentJetWords: () => string,
 *   onEvent: (event: object) => void,
 *   clock?: { after: (fn: () => void, ms: number) => () => void },
 *   storage?: { getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void } | null,
 * }} options   `capture.stop` must also cancel a start still under way; `storage` keeps the echo strikes between page
 *   loads and may be missing or blocked
 */
export function createHearing({ capture, vad, transcribe, vocabulary, recentJetWords, onEvent, clock = realClock, storage = defaultStorage() }) {
  let state = 'off';
  let jetSpeaking = false;
  let generation = 0;
  let cancelSleep = null;
  let turnsMade = 0;
  let strikes = readStrikes();
  /** @type {Map<string, { id: string, open: boolean, endedByMic: boolean, interrupts: boolean, inFlight: number, texts: Map<number, string> }>} */
  const turns = new Map();

  function readStrikes() {
    try { return Number.parseInt(storage?.getItem(STRIKES_KEY) ?? '0', 10) || 0; } catch { return 0; }
  }

  function saveStrikes() {
    try {
      if (strikes > 0) storage?.setItem(STRIKES_KEY, String(strikes));
      else storage?.removeItem(STRIKES_KEY);
    } catch { /* A blocked store only means the strikes are not remembered. */ }
  }

  const halfDuplex = () => strikes >= SETTINGS.STRIKES_TO_HALF_DUPLEX;

  function setState(next, reason) {
    state = next;
    onEvent(reason === undefined ? { kind: 'state', state } : { kind: 'state', state, reason });
  }

  function forgetIfDone(turn) {
    if (!turn.open && turn.inFlight === 0) turns.delete(turn.id);
  }

  function closeTurn(turn) {
    turn.open = false;
    turn.endedByMic = false;
    forgetIfDone(turn);
  }

  const findOpenTurn = () => [...turns.values()].find((turn) => turn.open);

  const makeEndpointer = () => createEndpointer({
    newTurn() {
      const id = `turn-${++turnsMade}`;
      turns.set(id, { id, open: true, endedByMic: false, interrupts: false, inFlight: 0, texts: new Map() });
      return id;
    },
    onEvent(event) {
      const turn = turns.get(event.turnId);
      switch (event.kind) {
        case 'level':
        case 'pausing':
          onEvent(event);
          break;
        case 'speech':
          turn.interrupts = event.interrupts;
          onEvent({ kind: 'speech', on: event.on, turnId: event.turnId });
          break;
        case 'utterance':
          turn.inFlight++;
          onEvent({ kind: 'utterance', turnId: event.turnId, index: event.index });
          utterances.enqueue(event.pcm, { turnId: event.turnId, index: event.index });
          break;
        case 'turn':
          closeTurn(turn);
          onEvent({ kind: 'turn', turnId: event.turnId, text: turnText(turn.texts) });
          armSleep();
          break;
        case 'discarded':
          closeTurn(turn);
          onEvent({ kind: 'discarded', turnId: event.turnId, reason: event.reason });
          break;
      }
    },
  });

  let endpointer = makeEndpointer();

  const utterances = createUtterances({
    transcribe,
    vocabulary,
    clock,
    onWords: ({ turnId, index, text, error }) => {
      const turn = turns.get(turnId);
      if (!turn) return;
      turn.inFlight--;
      if (!turn.open && !turn.endedByMic) {
        forgetIfDone(turn);
        return;
      }
      const heard = error ? '' : text.trim();
      if (heard !== '' && isEcho(heard, recentJetWords())) {
        discardAsEcho(turn);
        return;
      }
      turn.texts.set(index, heard);
      onEvent({ kind: 'words', turnId, index, text: heard, interrupts: turn.interrupts && heard !== '' });
      if (turn.open) endpointer.words({ index, text: heard });
      forgetIfDone(turn);
    },
    onFatal: (error) => {
      leave();
      setState('problem', error.message);
    },
  });

  function discardAsEcho(turn) {
    strikes++;
    saveStrikes();
    if (turn.open) endpointer.abandon();
    closeTurn(turn);
    onEvent({ kind: 'discarded', turnId: turn.id, reason: 'echo' });
    if (state === 'listening') pauseForJet();
  }

  /** After repeated echoes the microphone is deaf while Jet's voice plays. */
  function pauseForJet() {
    if (!halfDuplex() || !jetSpeaking) return;
    endTurnUnsent();
    setState('halfDuplexPause');
  }

  /** The open utterance is still sent and its words still arrive, but the turn never becomes a message. */
  function endTurnUnsent() {
    const turn = findOpenTurn();
    endpointer.end();
    if (!turn) return;
    turn.open = false;
    turn.endedByMic = true;
    forgetIfDone(turn);
  }

  function armSleep() {
    cancelSleep?.();
    cancelSleep = clock.after(sleep, SETTINGS.SLEEP_AFTER_MS);
  }

  /** Stops everything that listens and everything in flight. */
  function leave() {
    generation++;
    cancelSleep?.();
    cancelSleep = null;
    endpointer.abandon();
    utterances.stop();
    turns.clear();
    capture.stop();
  }

  function failedToListen(error) {
    setState(WAITING_KINDS.has(error?.kind) ? 'waitingForTouch' : 'blocked', error?.message ?? 'The microphone could not be used.');
  }

  async function listen({ announce }) {
    if (state === 'listening' || state === 'starting' || state === 'halfDuplexPause') return;
    const mine = ++generation;
    // Waking says nothing until it listens, but a second wake must still see that one is under way.
    if (announce) setState('starting');
    else state = 'starting';
    vad.reset();
    try {
      await capture.start();
    } catch (error) {
      if (mine === generation) failedToListen(error);
      return;
    }
    if (mine !== generation) return;
    // A new capture counts its time from zero, so the endpointer starts over with it.
    endpointer = makeEndpointer();
    endpointer.setGuard({ jetSpeaking });
    armSleep();
    setState('listening');
    if (jetSpeaking) pauseForJet();
  }

  function sleep() {
    if (state !== 'listening' && state !== 'halfDuplexPause') return;
    leave();
    setState('asleep');
  }

  capture.onFrames = (hops, rms, atMs) => {
    if (state !== 'listening') return;
    try {
      for (let half = 0; half < 2; half++) {
        const hop = hops.subarray(half * HOP_SAMPLES, (half + 1) * HOP_SAMPLES);
        endpointer.frame({ hop, p: vad.probability(hop), rms: rms[half], atMs: atMs + half * SETTINGS.HOP_MS });
      }
    } catch (error) {
      leave();
      setState('problem', error?.message ?? 'Voice detection stopped.');
    }
  };

  capture.onEnded = (reason) => {
    if (state !== 'listening' && state !== 'halfDuplexPause') return;
    endTurnUnsent();
    cancelSleep?.();
    cancelSleep = null;
    failedToListen(reason);
  };

  return {
    /** Asks for the microphone and starts listening. Failures arrive as `state` events. */
    start: () => listen({ announce: true }),

    /** The user switched listening off: everything stops and the echo strikes are forgotten. */
    stop() {
      leave();
      strikes = 0;
      saveStrikes();
      if (state !== 'off') setState('off');
    },

    /** Releases the microphone after quiet, so the browser's indicator is honest. */
    sleep,

    wake() {
      if (state === 'asleep') return listen({ announce: false });
    },

    /** Tells the engine that Jet's voice is audible now, or has stopped. */
    setJetSpeaking(speaking) {
      jetSpeaking = speaking;
      endpointer.setGuard({ jetSpeaking: speaking });
      if (!halfDuplex()) return;
      if (speaking && state === 'listening') pauseForJet();
      else if (!speaking && state === 'halfDuplexPause') {
        vad.reset();
        setState('listening');
      }
    },
  };
}
