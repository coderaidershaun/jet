// The link bar's elements: the chips, the engine chip that steps to the next engine, and the
// START/STOP button. The chips are rebuilt for each model, which arrives only when the link changes.

import { h } from '../../dom.js';
import { NEXT_PEER_TIP } from './chips.js';

/**
 * @param {{ send: (command: object) => void }} options
 * @returns {{ element: HTMLElement, paint: (model: ReturnType<typeof import('./chips.js').linkBarModel>) => void }}
 */
export function createLinkBar({ send }) {
  let buttonCommand = null;
  const chips = h('div', { class: 'linkbar-chips' });
  const button = h('button', {
    type: 'button',
    class: 'linkbar-button',
    hidden: true,
    onClick: () => {
      if (buttonCommand) send(buttonCommand);
    },
  });

  function createChip({ text, tone, isClickable }) {
    if (!isClickable) return h('span', { class: 'linkbar-chip', 'data-tone': tone }, text);
    return h('button', {
      type: 'button',
      class: 'linkbar-chip linkbar-peer',
      'data-tone': tone,
      title: NEXT_PEER_TIP,
      onClick: () => send({ cmd: 'next_peer' }),
    }, text);
  }

  return {
    element: h('div', { class: 'linkbar' }, chips, button),

    paint(model) {
      const hadFocus = chips.contains(document.activeElement);
      const note = model.note === null ? [] : [h('span', { class: 'linkbar-chip', 'data-tone': 'text2' }, model.note)];
      chips.replaceChildren(...note, ...model.chips.map(createChip));
      // Rebuilding the chips drops the keyboard focus, so the new engine chip takes it back.
      if (hadFocus) chips.querySelector('button')?.focus();
      buttonCommand = model.button?.command ?? null;
      button.hidden = model.button === null;
      button.textContent = model.button?.label ?? '';
    },
  };
}
