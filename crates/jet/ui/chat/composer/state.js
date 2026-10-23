// The composer's rules, apart from the DOM: where it sits, what its button
// says, what Enter does, and what Escape does. The view asks and obeys.

/**
 * @param {{ empty: boolean }} options   true when there is no conversation yet
 */
export function createComposer({ empty }) {
  let centred = empty;
  const composer = {
    /** True while Jet's reply runs. */
    replying: false,

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
      if (composer.replying) return 'stop';
      return text.trim() === '' ? 'disabled' : 'send';
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
      if (text.trim() === '') return 'ignore';
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
