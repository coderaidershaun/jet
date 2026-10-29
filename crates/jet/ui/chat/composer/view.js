// The composer's field and button, and the hop it makes from the middle of the
// screen to the bottom on the first send. It reads the field, asks the
// composer's rules what to do, and does it.

import { icon } from '../../dom.js';

const HOP_MS = 420;
const LISTENING_PLACEHOLDER = 'Listening…';

/**
 * @param {{
 *   page: HTMLElement, composer: HTMLElement, field: HTMLTextAreaElement, button: HTMLButtonElement,
 *   heldChip: HTMLElement, heldCancel: HTMLElement,
 *   state: ReturnType<typeof import('./state.js').createComposer>,
 *   reducedMotion: () => boolean,
 *   handlers: { send: (text: string) => void, hold: (text: string) => void, stop: () => void, cancelHold: () => void, input?: (text: string) => void, keydown?: (event: KeyboardEvent) => boolean },
 * }} options
 */
export function createComposerView({ page, composer, field, button, heldChip, heldCancel, state, reducedMotion, handlers }) {
  const sendIcon = icon('send');
  const stopIcon = icon('stop');
  let basePlaceholder = field.placeholder;
  let listening = false;

  // The height must add the border, which scrollHeight leaves out, or even a one-line field shows a scrollbar.
  // The style sheet's max-height stops the growth at eight lines.
  function grow() {
    field.style.height = 'auto';
    field.style.height = field.scrollHeight + field.offsetHeight - field.clientHeight + 'px';
  }

  function refresh() {
    const mode = state.button(field.value);
    button.replaceChildren(mode === 'stop' ? stopIcon : sendIcon);
    button.disabled = mode === 'disabled';
    button.dataset.mode = mode;
    button.setAttribute('aria-label', mode === 'stop' ? (state.speaking ? 'Stop speaking' : 'Stop') : 'Send');
  }

  function take() {
    const text = field.value.trim();
    field.value = '';
    handlers.input?.('');
    grow();
    refresh();
    return text;
  }

  function sendOrHold(action) {
    if (action === 'send') handlers.send(take());
    else if (action === 'hold') handlers.hold(take());
  }

  field.addEventListener('input', () => {
    grow();
    refresh();
    handlers.input?.(field.value);
  });

  field.addEventListener('keydown', (event) => {
    if (handlers.keydown?.(event)) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key !== 'Enter') return;
    const action = state.enter(event, field.value);
    if (action === 'newline') return;
    event.preventDefault();
    sendOrHold(action);
  });

  button.addEventListener('click', () => {
    const mode = state.button(field.value);
    if (mode === 'stop') handlers.stop();
    else if (mode === 'send') handlers.send(take());
  });

  heldCancel.addEventListener('click', handlers.cancelHold);

  refresh();

  return {
    refresh,

    /** Puts text in the field, as when a held message is cancelled. */
    setText(text) {
      field.value = text;
      grow();
      refresh();
      field.focus();
      handlers.input?.(text);
    },

    /** Shows the message held until Jet finishes: its text as the tooltip, and how many files it carries. @param {{ text: string, attachments: unknown[] } | null} held */
    setHeld(held) {
      heldChip.hidden = held === null;
      heldChip.title = held?.text ?? '';
      const files = held?.attachments.length ?? 0;
      heldChip.querySelector('.held-files').textContent = files === 0 ? '' : ' · ' + files + (files === 1 ? ' file' : ' files');
    },

    setPlaceholder(text) {
      basePlaceholder = text;
      field.placeholder = listening ? LISTENING_PLACEHOLDER : text;
    },

    /** While the mic listens the empty field says so. @param {boolean} on */
    setListening(on) {
      listening = on;
      field.placeholder = on ? LISTENING_PLACEHOLDER : basePlaceholder;
    },

    /** Sends the field as pressing Enter would: a send, or a hold while Jet replies. It never stops the reply, and with nothing to send it leaves the field alone. */
    sendNow() {
      sendOrHold(state.enter({ shiftKey: false, isComposing: false }, field.value));
    },

    /**
     * Writes heard words: sets the text, grows the field and refreshes the button, but never focuses
     * the field or scrolls, so a phone's keyboard stays down. Where the caret was is kept while the
     * person is editing; otherwise it goes to the end.
     */
    dictate(text) {
      const editing = document.activeElement === field;
      const { selectionStart, selectionEnd } = field;
      field.value = text;
      if (editing) field.setSelectionRange(selectionStart, selectionEnd);
      else field.setSelectionRange(text.length, text.length);
      grow();
      refresh();
    },

    /** Tells the page that a burst of heard words has landed, as it is told of typing. */
    dictated() {
      handlers.input?.(field.value);
    },

    /** The halo on Send while the page waits out the end of a thought. @param {boolean} on */
    setPending(on) {
      button.classList.toggle('is-pending', on);
    },

    /** Moves the composer to its layout, hopping there unless motion is reduced. */
    setLayout(layout) {
      if (page.dataset.layout === layout) return;
      const before = composer.getBoundingClientRect();
      page.dataset.layout = layout;
      if (reducedMotion()) return;
      const after = composer.getBoundingClientRect();
      const lift = before.top - after.top;
      if (lift === 0) return;
      composer.animate(
        [{ transform: 'translateY(' + lift + 'px)' }, { transform: 'none' }],
        { duration: HOP_MS, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    },
  };
}
