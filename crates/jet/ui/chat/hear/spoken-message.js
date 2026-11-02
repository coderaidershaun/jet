// Follows the person's spoken turns through the listening engine's events and decides what becomes of the spoken
// message: it sends itself when they have finished, moves into the field when they take over, or goes when the turn is
// thrown away. It also quiets Jet's voice while they speak over it.

import { createDictation } from './dictation.js';

/**
 * @param {{
 *   forming: { text: string, write: (text: string) => void, drop: () => void },
 *   field: { text: string, write: (text: string) => void },
 *   clock: { after: (fn: () => void, ms: number) => () => void },
 *   reducedMotion: () => boolean,
 *   liveWords: { dropFinished: () => void, dropAll: () => void },
 *   voice: { audible: () => boolean, duck: () => void, unduck: () => void },
 *   silence: () => void,
 *   composer: { sendNow: () => boolean, setPending: (on: boolean) => void },
 * }} options   `forming` is the spoken message in the thread and `field` the message field, as the words land in them;
 *   `silence` quiets the voice of the reply that is running; `composer.sendNow` sends the spoken message as Enter would and says whether it went
 */
export function createSpokenMessage({ forming, field, clock, reducedMotion, liveWords, voice, silence, composer }) {
  const dictation = createDictation({ forming, field, clock, reducedMotion });
  let pausing = false;
  let duckedTurn = null;
  /** Turns that began with speech and have not ended: a key pressed in one of them is the person taking over. */
  const openTurns = new Set();

  function paintHalo() {
    composer.setPending(pausing && dictation.autoSend);
  }

  function takeOver() {
    dictation.takeOver();
    paintHalo();
  }

  function unduckFor(turnId) {
    if (duckedTurn !== turnId) return;
    duckedTurn = null;
    voice.unduck();
  }

  /** @returns {boolean} whether the turn was still open */
  function forgetTurn(turnId) {
    // A turn the mic cut short can be thrown away as an echo after the next turn has begun,
    // and must not take the new turn's live words with it.
    const wasOpen = openTurns.delete(turnId);
    if (wasOpen) liveWords.dropAll();
    unduckFor(turnId);
    // SMELL: this runs even for a turn that was no longer open, so throwing away a turn the mic cut short turns off
    // the Send halo of the next turn while it pauses, and Esc does nothing until that turn pauses again.
    pausing = false;
    paintHalo();
    return wasOpen;
  }

  return {
    /** Takes one event of the listening engine: speech, words, pausing, turn or discarded. Its other events are not about the message. */
    hear(event) {
      switch (event.kind) {
        case 'speech':
          if (!event.on) break;
          if (!openTurns.has(event.turnId)) {
            openTurns.add(event.turnId);
            // A turn the mic cut short is never forgotten, and its words can still land,
            // so each new turn starts its live words afresh.
            liveWords.dropFinished();
            dictation.open();
          }
          if (voice.audible()) {
            voice.duck();
            duckedTurn = event.turnId;
          }
          break;
        case 'words':
          if (event.interrupts) silence();
          unduckFor(event.turnId);
          // Words of a turn the mic cut short arrive after the turn is gone. They belong in the field if the person took over,
          // and nowhere else, or they would start a spoken message that no turn will ever send.
          if (openTurns.has(event.turnId) || !dictation.autoSend) dictation.append(event.text);
          break;
        case 'pausing':
          pausing = event.on;
          paintHalo();
          break;
        case 'turn':
          forgetTurn(event.turnId);
          dictation.end();
          // A message that cannot go yet, such as one waiting for a file to upload, moves to the field instead of staying in the thread.
          if (dictation.autoSend && !composer.sendNow()) takeOver();
          break;
        case 'discarded':
          if (forgetTurn(event.turnId)) dictation.discard();
          break;
      }
    },

    /** The mic stopped listening, or paused for Jet's voice. A turn cut short by the mic stopping moves its words to the field but never sends itself. */
    micStopped() {
      if (openTurns.size > 0) dictation.takeOver();
      openTurns.clear();
      pausing = false;
      if (duckedTurn !== null) unduckFor(duckedTurn);
      paintHalo();
    },

    /** The browser's live words. Text that arrives outside a turn may be Jet's own voice heard through the speakers. */
    showLive(text) {
      if (openTurns.size > 0) dictation.showLive(text);
    },

    /** The person edited the field, which now holds `text`; while they speak, that is a take-over. */
    typed(text) {
      if (text !== '' && openTurns.size > 0) takeOver();
    },

    /** Esc while the person pauses stops the message from sending itself and moves it into the field. @returns {boolean} whether it did */
    escape() {
      if (!pausing || !dictation.autoSend) return false;
      takeOver();
      return true;
    },

    /** The forming message was taken to be sent by Send, Enter or the end of the turn, so the rest of that turn is dropped. */
    formingTaken() {
      dictation.spend();
      paintHalo();
    },

    /** The field's text changed; an empty field lets the next message send itself again. */
    fieldChanged(text) {
      if (text !== '') return;
      dictation.reset();
      paintHalo();
    },
  };
}
