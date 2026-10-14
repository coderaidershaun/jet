// The composer's field and button, and the hop it makes from the middle of the
// screen to the bottom on the first send. It reads the field, asks the
// composer's rules what to do, and does it.

import { icon } from '../dom.js';

const MAX_FIELD_PX = 198;
const HOP_MS = 420;

/**
 * @param {{
 *   page: HTMLElement, composer: HTMLElement, field: HTMLTextAreaElement, button: HTMLButtonElement,
 *   heldChip: HTMLElement, heldCancel: HTMLElement,
 *   state: ReturnType<typeof import('./state.js').createComposer>,
 *   reducedMotion: () => boolean,
 *   handlers: { send: (text: string) => void, hold: (text: string) => void, stop: () => void, cancelHold: () => void, typing: (text: string) => void },
 * }} options
 */
export function createComposerView({ page, composer, field, button, heldChip, heldCancel, state, reducedMotion, handlers }) {
  const sendIcon = icon('send');
  const stopIcon = icon('stop');

  function grow() {
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, MAX_FIELD_PX) + 'px';
  }

  function refresh() {
    const mode = state.button(field.value);
    button.replaceChildren(mode === 'stop' ? stopIcon : sendIcon);
    button.disabled = mode === 'disabled';
    button.dataset.mode = mode;
    button.setAttribute('aria-label', mode === 'stop' ? 'Stop' : 'Send');
  }

  function take() {
    const text = field.value.trim();
    field.value = '';
    grow();
    refresh();
    handlers.typing('');
    return text;
  }

  field.addEventListener('input', () => {
    grow();
    refresh();
    handlers.typing(field.value);
  });

  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const action = state.enter(event, field.value);
    if (action === 'newline') return;
    event.preventDefault();
    if (action === 'send') handlers.send(take());
    else if (action === 'hold') handlers.hold(take());
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
    },

    setHeld(text) {
      heldChip.hidden = text === null;
      heldChip.title = text ?? '';
    },

    setPlaceholder(text) {
      field.placeholder = text;
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
