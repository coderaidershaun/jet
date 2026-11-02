// Joins the listening engine to the page: the mic button, the trail of loudness across the empty message
// field, the spoken message forming in the thread with the browser's live words in it, the field the
// words move to when the person takes over, the send, Jet's voice and Jet on the stage. The engine is
// loaded and built on the first start, so a page that never listens never downloads the voice detector.
// This file needs a browser, so it has no test.

import { displayName } from '../../bridge/settings.js';
import { realClock } from '../clock.js';
import { createCapture } from './capture.js';
import { createHearing } from './engine/hearing.js';
import { createVad } from './engine/vad.js';
import { createHearToggle } from './hear-toggle.js';
import { createLiveWords } from './live-words.js';
import { createSpokenMessage } from './spoken-message.js';
import { createTrail } from './trail.js';

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
 *   button: HTMLButtonElement, pill: HTMLElement, trailCanvas: HTMLCanvasElement, field: HTMLTextAreaElement,
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
 * @returns {{ repaint: () => void, replyEnded: () => void, fieldChanged: (text: string) => void, formingTaken: () => void, userActive: () => void }}
 */
export function connectHearing({ agent, status, button, pill, trailCanvas, field, composerView, thread, turn, live, voicePlayer, speakerOn, settings, appLabels, announce, reducedMotion, clock = realClock }) {
  const trail = createTrail({ canvas: trailCanvas, reducedMotion });
  const toggle = createHearToggle({
    button,
    status: status ?? NO_HEARING,
    check: async () => (await agent.voiceStatus()).hear ?? NO_HEARING,
    announce,
    onStart: () => { unlockVoice(); start(); },
    onStop: stop,
  });

  let hearing = null;
  let loading = null;
  let generation = 0;
  let jetEndedAt = -Infinity;
  let jetAudible = false;
  let cancelJetCheck = null;
  const liveWords = createLiveWords({ onWords: (text) => spoken.showLive(text) });
  const spoken = createSpokenMessage({
    forming: {
      get text() { return thread.forming ?? ''; },
      write(text) { thread.form(text); turn.paint(); },
      drop() { thread.dropForming(); turn.paint(); },
    },
    field: { get text() { return field.value; }, write: composerView.dictate },
    clock,
    reducedMotion,
    liveWords,
    voice: voicePlayer,
    silence: () => turn.silence(),
    composer: composerView,
  });

  // With the speaker off Jet's voice needs no sound yet; switching the speaker on starts it then.
  function unlockVoice() {
    if (speakerOn()) voicePlayer.unlock();
  }

  function repaint() {
    pill.classList.toggle('has-on', speakerOn() || toggle.lit);
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
    // The browser's recognizer opens a microphone of its own, so it stops even while the mic only waits out Jet's voice.
    if (state === 'listening') liveWords.start();
    else liveWords.stop();
    if (state === 'halfDuplexPause') checkJetUntilResumed();
    if (state !== 'listening') spoken.micStopped();
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
        trail.add(event.level, event.speech);
        updateJetSpeaking();
        break;
      case 'speech':
        spoken.hear(event);
        if (event.on) live.typing();
        break;
      default:
        spoken.hear(event);
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
    spoken.typed(field.value);
  });
  document.addEventListener('keydown', (event) => {
    // An Esc inside a dialog, such as the settings sheet, is for that dialog.
    if (event.key === 'Escape' && !event.target.closest?.('dialog') && spoken.escape()) {
      event.preventDefault();
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

    formingTaken: spoken.formingTaken,
    fieldChanged: spoken.fieldChanged,

    /** The person is plainly here, so a mic that went to sleep listens again. */
    userActive() {
      hearing?.wake();
    },
  };
}
