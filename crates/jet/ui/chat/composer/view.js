// The composer's field and button, and the hop it makes from the middle of the
// screen to the bottom on the first send. It reads the field, or the spoken
// message forming in the thread while the field is empty, asks the composer's
// rules what to do, and does it.

import { icon } from '../../dom.js';

const HOP_MS = 420;
const LISTENING_PLACEHOLDER = 'Listening…';

/**
 * @param {{
 *   page: HTMLElement, composer: HTMLElement, field: HTMLTextAreaElement, button: HTMLButtonElement,
 *   heldChip: HTMLElement, heldCancel: HTMLElement,
 *   state: ReturnType<typeof import('./state.js').createComposer>,
 *   reducedMotion: () => boolean,
 *   forming?: () => string,
 *   handlers: { send: (text: string) => void, hold: (text: string) => void, stop: () => void, cancelHold: () => void, formingTaken: () => void, input?: (text: string) => void, keydown?: (event: KeyboardEvent) => boolean },
 * }} options   `forming` gives the words of the spoken message forming in the thread, or an empty string; `formingTaken` says that Send, Enter or the end of the spoken turn took it to be sent
 */
export function createComposerView({ page, composer, field, button, heldChip, heldCancel, state, reducedMotion, forming = () => '', handlers }) {
  const sendIcon = icon('send');
  const stopIcon = icon('stop');
  let basePlaceholder = field.placeholder;
  let listening = false;

  // The height must add any border, which scrollHeight leaves out, or a field with a border shows a scrollbar.
  // The style sheet's max-height stops the growth.
  function grow() {
    field.style.height = 'auto';
    field.style.height = field.scrollHeight + field.offsetHeight - field.clientHeight + 'px';
  }

  const fieldEmpty = () => field.value.trim() === '';
  /** What Send and Enter would send: the field, or the forming message while the field is empty. */
  const message = () => (fieldEmpty() ? forming() : field.value);

  function refresh() {
    const mode = state.button(message());
    button.replaceChildren(mode === 'stop' ? stopIcon : sendIcon);
    button.disabled = mode === 'disabled';
    button.dataset.mode = mode;
    button.setAttribute('aria-label', mode === 'stop' ? (state.speaking ? 'Stop speaking' : 'Stop') : 'Send');
  }

  function takeForming() {
    const text = forming();
    handlers.formingTaken();
    return text;
  }

  function take() {
    if (fieldEmpty() && forming() !== '') return takeForming();
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
    const action = state.enter(event, message());
    if (action === 'newline') return;
    event.preventDefault();
    sendOrHold(action);
  });

  button.addEventListener('click', () => {
    const mode = state.button(message());
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

    /** While the mic listens the empty field says so, and the composer is marked so the style sheet can show the trail across the field in place of that text. @param {boolean} on */
    setListening(on) {
      listening = on;
      field.placeholder = on ? LISTENING_PLACEHOLDER : basePlaceholder;
      composer.classList.toggle('is-listening', on);
    },

    /**
     * Sends the forming spoken message as pressing Enter would: a send, or a hold while Jet replies. A draft in the
     * field stays there. It never stops the reply, and with nothing forming, or a file still uploading, it does nothing.
     * @returns {boolean} whether the message went
     */
    sendNow() {
      const text = forming();
      const action = text === '' ? 'ignore' : state.enter({ shiftKey: false, isComposing: false }, text);
      if (action !== 'send' && action !== 'hold') return false;
      handlers[action](takeForming());
      return true;
    },

    /**
     * Writes heard words that land in the field after a take-over, and tells the page as typing would, but never focuses
     * the field or scrolls, so a phone's keyboard stays down. The caret stays where the person left it only while it is
     * inside the text and the new text just adds to the end; otherwise it goes to the end.
     */
    dictate(text) {
      const keepCaret = document.activeElement === field && field.selectionEnd < field.value.length && text.startsWith(field.value);
      const { selectionStart, selectionEnd } = field;
      field.value = text;
      if (keepCaret) field.setSelectionRange(selectionStart, selectionEnd);
      else field.setSelectionRange(text.length, text.length);
      grow();
      refresh();
      // The key that started a take-over has already shown the command menu, which must see the words put before it.
      handlers.input?.(text);
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
