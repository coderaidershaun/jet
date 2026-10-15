// A row of buttons of which one is chosen. The toolbar and the charts both use it, so the two look and
// act the same, as in the desktop app this copies.

import { h } from '../../chat/dom.js';
import { linkStylesheet } from './stylesheet.js';
import { writeAttribute } from './write.js';

/**
 * Builds the strip. A click only reports the pick: the area shows the value its frame carries, because
 * the bridge decides what is chosen.
 * @param {{ label: string, options: Array<[string, string]>, onPick: (value: string) => void }} spec
 *   `options` are `[value, text]` pairs
 * @returns {{ element: HTMLElement, show: (value: string) => void }}
 */
export function createSegmented({ label, options, onPick }) {
  linkStylesheet(new URL('./segmented.css', import.meta.url).href);
  const buttons = options.map(([value, text]) =>
    h('button', { type: 'button', 'data-value': value, 'aria-pressed': 'false', onClick: () => onPick(value) }, text),
  );
  const element = h('div', { class: 'ws-seg', role: 'group', 'aria-label': label }, ...buttons);

  return {
    element,
    show(value) {
      for (const button of buttons) writeAttribute(button, 'aria-pressed', String(button.dataset.value === value));
    },
  };
}
