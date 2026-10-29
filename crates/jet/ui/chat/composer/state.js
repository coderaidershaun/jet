// The composer's rules, apart from the DOM: where it sits, what its button
// says, what Enter does, and what Escape does. The view asks and obeys.

import { MOST_FILES, emptyTray } from './tray.js';

/**
 * @param {{ empty: boolean, tray?: { counts: () => { uploading: number, failed: number, ready: number } } }} options
 *   `empty` is true when there is no conversation yet; `tray` holds the files going with the next message
 */
export function createComposer({ empty, tray = emptyTray }) {
  let centred = empty;

  // Send waits while a file uploads, while a failed one is still in the tray, and while the tray
  // holds more files than one message may carry.
  const waiting = () => {
    const { uploading, failed, ready } = tray.counts();
    return uploading + failed > 0 || ready > MOST_FILES;
  };
  const hasMessage = (text) => text.trim() !== '' || tray.counts().ready > 0;

  const composer = {
    /** True while Jet's reply runs. */
    replying: false,

    /** True once Jet has written the whole reply and the voice is still saying it. */
    speaking: false,

    get layout() {
      return centred ? 'centred' : 'bottom';
    },

    /** The first send drops the composer to the bottom. */
    sent() {
      centred = false;
    },

    /** Forgetting the conversation brings the empty state back. */
    reset() {
      centred = true;
    },

    /** @param {string} text   what is in the field @returns {'send' | 'stop' | 'disabled'} */
    button(text) {
      // While Jet only speaks, a message in the field cuts in, and an empty field lets the button stop the voice.
      if (composer.replying) return composer.speaking && !waiting() && hasMessage(text) ? 'send' : 'stop';
      return waiting() || !hasMessage(text) ? 'disabled' : 'send';
    },

    /**
     * What the Enter key should do in the field.
     * 'newline' leaves the key to the browser; 'ignore' swallows it.
     * @param {{ shiftKey: boolean, isComposing: boolean }} event
     * @param {string} text
     * @returns {'send' | 'hold' | 'newline' | 'ignore'}
     */
    enter(event, text) {
      if (event.shiftKey || event.isComposing) return 'newline';
      if (waiting() || !hasMessage(text)) return 'ignore';
      return composer.replying ? 'hold' : 'send';
    },

    /** @param {{ sheetOpen: boolean }} open @returns {'closeSheet' | 'stop' | 'none'} */
    escape({ sheetOpen }) {
      if (sheetOpen) return 'closeSheet';
      return composer.replying ? 'stop' : 'none';
    },
  };
  return composer;
}
