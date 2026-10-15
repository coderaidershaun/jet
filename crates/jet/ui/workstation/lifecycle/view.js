// The screen that covers the panels until the workstation is live. Until the first word about the
// screen arrives it is bare, so nothing is drawn that nobody said.

import { h } from '../../dom.js';

/**
 * @param {HTMLElement} root
 * @returns {{ paint(line: import('../../bridge/workstation.js').LifecycleLine): void }}
 */
export function createLifecycleView(root) {
  const title = h('div', { class: 'lc-title' });
  const detail = h('div', { class: 'lc-detail' });
  root.replaceChildren(h('div', { class: 'lc-screen', role: 'status' }, title, detail));
  root.hidden = false;

  function write(element, text, tone) {
    if (element.textContent !== text) element.textContent = text;
    if (element.getAttribute('data-tone') !== tone) element.setAttribute('data-tone', tone);
  }

  return {
    paint(line) {
      root.hidden = line.screen === 'live';
      write(title, line.title, line.titleTone);
      write(detail, line.detail, line.detailTone);
    },
  };
}
