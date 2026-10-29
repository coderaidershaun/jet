// Joins the listening engine to the page: the mic button, the message field, the send, Jet's voice
// and Jet on the stage. The engine is loaded and built on the first start, so a page that never
// listens never downloads the voice detector. This needs a browser, so it only passes events along;
// the decisions worth a test are made by the mic button and the dictation.

import { displayName } from '../../bridge/settings.js';
import { realClock } from '../clock.js';
import { createCapture } from './capture.js';
import { createDictation } from './dictation.js';
import { createHearing } from './engine/hearing.js';
import { createVad } from './engine/vad.js';
import { createHearToggle } from './hear-toggle.js';

const NO_HEARING = { available: false, reason: 'The voice could not be reached' };
const JET_WORDS_KEPT_MS = 10000;
const MOST_NAMES = 20;
const JET_CHECK_MS = 100;
/** The mic still works while it pauses for Jet's voice, so the field says it is listening then too. */
const LISTENING_STATES = new Set(['listening', 'halfDuplexPause']);

/**
 * @param {{
 *   agent: { hear: Function, voiceStatus: () => Promise<{ hear?: { available: boolean, reason: string | null } }> },
 *   status: { available: boolean, reason: string | null } | undefined,
 *   button: HTMLButtonElement, pill: HTMLElement, field: HTMLTextAreaElement,
 *   composerView: ReturnType<typeof import('../composer/view.js').createComposerView>,
 *   thread: ReturnType<typeof import('../thread/store.js').createThread>,
 *   turn: ReturnType<typeof import('../turn.js').createTurn>,
 *   live: ReturnType<typeof import('../stage/live.js').createLive>,
 *   voicePlayer: ReturnType<typeof import('../voice/player.js').createVoicePlayer>,
 *   speakerOn: () => boolean,
 *   settings: import('../../bridge/settings.js').Settings,
 *   appLabels: () => string[],
 *   announce: (message: string) => void,
 *   reducedMotion: () => boolean,
 *   clock?: { now: () => number, after: (fn: () => void, ms: number) => () => void },
 * }} parts   `status` is the server's word on hearing, and may be missing when the voice could not be reached
 * @returns {{ repaint: () => void, replyEnded: () => void, fieldChanged: (text: string) => void, userActive: () => void }}
 */
export function connectHearing({ agent, status, button, pill, field, composerView, thread, turn, live, voicePlayer, speakerOn, settings, appLabels, announce, reducedMotion, clock = realClock }) {
  const dictation = createDictation({ field, composerView, clock, reducedMotion });
  const toggle = createHearToggle({
    button,
    status: status ?? NO_HEARING,
    check: async () => (await agent.voiceStatus()).hear ?? NO_HEARING,
    announce,
    onStart: () => { unlockVoice(); start(); },
    onStop: stop,
    reducedMotion,
  });

  let hearing = null;
  let loading = null;
  let generation = 0;
  let jetEndedAt = -Infinity;
  let jetAudible = false;
  let pausing = false;
  let duckedTurn = null;
  let cancelJetCheck = null;
  // SMELL: this bookkeeping of turns, clips and the ducked voice decides when a message sends itself, and
  // it has no test because this file needs a browser. A bug in how these events are joined shows up only by hand.
  /** Turns that began with speech and have not ended: a key pressed in one of them is the person taking over. */
  const openTurns = new Set();
  /** How many clips of each turn still wait for their words; a discarded turn never gets all of them back. */
  const inFlight = new Map();

  // With the speaker off Jet's voice needs no sound yet; switching the speaker on starts it then.
  function unlockVoice() {
    if (speakerOn()) voicePlayer.unlock();
  }

  function repaint() {
    pill.classList.toggle('has-on', speakerOn() || toggle.lit);
  }

  function paintHalo() {
    composerView.setPending(pausing && dictation.autoSend);
  }

  function takeOver() {
    dictation.takeOver();
    paintHalo();
  }

  function showBusy() {
    toggle.setBusy([...inFlight.values()].reduce((sum, count) => sum + count, 0));
  }

  function unduckFor(turnId) {
    if (duckedTurn !== turnId) return;
    duckedTurn = null;
    voicePlayer.unduck();
  }

  function forgetTurn(turnId) {
    openTurns.delete(turnId);
    inFlight.delete(turnId);
    unduckFor(turnId);
    pausing = false;
    showBusy();
    paintHalo();
  }

  /** Tells the engine whether Jet's voice is sounding, only when that changes. */
  function updateJetSpeaking() {
    const audible = voicePlayer.audible();
    if (audible === jetAudible) return;
    jetAudible = audible;
    hearing?.setJetSpeaking(audible);
  }

  // No level events arrive while the mic is paused for Jet's voice, so the end of the voice is looked for on a timer.
  function checkJetUntilResumed() {
    cancelJetCheck?.();
    cancelJetCheck = clock.after(() => {
      updateJetSpeaking();
      if (toggle.state === 'halfDuplexPause') checkJetUntilResumed();
    }, JET_CHECK_MS);
  }

  function showState(state, reason) {
    toggle.setState(state, reason);
    composerView.setListening(LISTENING_STATES.has(state));
    if (state === 'halfDuplexPause') checkJetUntilResumed();
    if (state !== 'listening') {
      // A turn cut short by the mic stopping keeps its words in the field but never sends itself.
      if (openTurns.size > 0) dictation.takeOver();
      openTurns.clear();
      pausing = false;
      if (duckedTurn !== null) unduckFor(duckedTurn);
      paintHalo();
    }
    if (!LISTENING_STATES.has(state)) {
      inFlight.clear();
      showBusy();
    }
    repaint();
  }

  function recentJetWords() {
    if (thread.slot) return thread.slot.text;
    if (clock.now() - jetEndedAt > JET_WORDS_KEPT_MS) return '';
    return thread.rows().findLast((row) => row.type === 'jet')?.entry.text ?? '';
  }

  function vocabulary() {
    const names = [displayName(settings), ...appLabels()].map((name) => name.trim()).filter(Boolean);
    return [...new Set(names)].slice(0, MOST_NAMES);
  }

  function onEvent(event) {
    switch (event.kind) {
      case 'state':
        showState(event.state, event.reason);
        break;
      case 'level':
        toggle.setLevel(event.level);
        updateJetSpeaking();
        break;
      case 'speech':
        if (!event.on) break;
        openTurns.add(event.turnId);
        live.typing();
        if (voicePlayer.audible()) {
          voicePlayer.duck();
          duckedTurn = event.turnId;
        }
        break;
      case 'utterance':
        inFlight.set(event.turnId, (inFlight.get(event.turnId) ?? 0) + 1);
        showBusy();
        break;
      case 'words':
        inFlight.set(event.turnId, Math.max(0, (inFlight.get(event.turnId) ?? 0) - 1));
        showBusy();
        if (event.interrupts) turn.silence();
        unduckFor(event.turnId);
        dictation.append(event.text);
        break;
      case 'pausing':
        pausing = event.on;
        paintHalo();
        break;
      case 'turn':
        forgetTurn(event.turnId);
        dictation.flush();
        if (dictation.autoSend) composerView.sendNow();
        break;
      case 'discarded':
        // SMELL: if an echo ends a turn after an earlier phrase of it has landed, those words stay in the field unsent.
        forgetTurn(event.turnId);
        break;
    }
  }

  /** Loads the voice detector once and builds the engine; a failed load can be tried again. */
  function loadEngine() {
    loading ??= (async () => {
      const { default: moduleFactory } = await import('../../vendor/ten-vad/ten_vad.js');
      const vad = await createVad({ moduleFactory });
      return createHearing({
        capture: createCapture(),
        vad,
        transcribe: (pcm, { vocabulary: names, signal }) => agent.hear(pcm, names, signal),
        vocabulary,
        recentJetWords,
        onEvent,
        clock,
      });
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  // SMELL: the voice detector downloads before the microphone is asked for, so on a first start the
  // click may be a second old by then. Chrome does not mind; Safari may leave the audio paused, and
  // then the mic waits for one more touch.
  async function start() {
    const mine = ++generation;
    showState('starting');
    try {
      const engine = await loadEngine();
      hearing = engine;
      if (mine === generation) await engine.start();
    } catch (error) {
      if (mine === generation) showState('problem', error?.message ?? 'Listening could not start.');
    }
  }

  function stop() {
    generation++;
    hearing?.stop();
    showState('off');
  }

  // A press on the mic itself is left to the mic's own click, which starts listening; starting here
  // as well would make that click see a mic on its way and switch it off.
  function firstTouch(event) {
    if (toggle.state !== 'waitingForTouch' || button.contains(event.target)) return;
    unlockVoice();
    start();
  }

  // Listening starts by itself on load only for a person who chose it and whose browser has already allowed the microphone.
  async function startFromMemory() {
    if (!toggle.wanted || !toggle.available) return;
    let permission = 'prompt';
    try {
      permission = (await navigator.permissions.query({ name: 'microphone' })).state;
    } catch { /* the browser cannot say, so the first click on the mic decides */ }
    // The person may have pressed the mic while the browser was being asked.
    if (!toggle.wanted || toggle.state !== 'off') return;
    if (permission === 'granted') {
      toggle.greet();
      start();
    } else if (permission === 'denied') {
      showState('blocked');
    }
  }

  field.addEventListener('input', () => {
    hearing?.wake();
    if (field.value !== '' && (openTurns.size > 0 || dictation.landing)) takeOver();
  });
  document.addEventListener('keydown', (event) => {
    // An Esc inside a dialog, such as the settings sheet, is for that dialog.
    if (event.key === 'Escape' && pausing && dictation.autoSend && !event.target.closest?.('dialog')) {
      event.preventDefault();
      takeOver();
      return;
    }
    firstTouch(event);
  }, { capture: true });
  document.addEventListener('pointerdown', firstTouch, { capture: true });

  repaint();
  startFromMemory();

  return {
    repaint,

    /** A reply has ended, so its words are what Jet said a moment ago. */
    replyEnded() {
      jetEndedAt = clock.now();
    },

    /** The field's text changed; an empty field lets the next message send itself again. */
    fieldChanged(text) {
      if (text !== '') return;
      dictation.reset();
      paintHalo();
    },

    /** The person is plainly here, so a mic that went to sleep listens again. */
    userActive() {
      hearing?.wake();
    },
  };
}
