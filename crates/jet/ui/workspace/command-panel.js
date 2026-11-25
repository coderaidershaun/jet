// What a /command answers shows under the thread of the chat it was typed in, until the user closes it or opens another chat.

import { h, icon } from '../dom.js';

/**
 * @param {{ after: Element, page: HTMLElement, field: HTMLElement }} options
 *   the panel goes right after `after`; `field` takes the focus back when the panel closes
 */
export function createCommandPanel({ after, page, field }) {
  const body = h('div', { class: 'command-body', role: 'status' });
  const closeButton = h('button', { type: 'button', class: 'icon-button command-close', 'aria-label': 'Close', title: 'Close', onClick: dismiss }, icon('close'));
  const panel = h('section', { class: 'command-panel', 'aria-label': 'Command result', hidden: true }, body, closeButton);
  after.after(panel);

  /** @param {string | { heading: string, rows: { command: string, args: string, description: string }[] }} result '' clears the panel */
  function show(result) {
    if (typeof result === 'string') body.replaceChildren(...(result ? [h('p', { class: 'command-line', text: result })] : []));
    else body.replaceChildren(h('h2', { class: 'command-heading', text: result.heading }), h('dl', { class: 'command-help' }, ...result.rows.flatMap(helpRow)));
    panel.hidden = body.children.length === 0;
    page.classList.toggle('has-command-result', !panel.hidden);
    if (!panel.hidden && !page.hidden) panel.scrollIntoView({ block: 'nearest' });
  }

  function dismiss() {
    show('');
    field.focus();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || panel.hidden || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    dismiss();
  });
  document.addEventListener('jet:chat-opened', () => show(''));
  return { show };
}

function helpRow({ command, args, description }) {
  const term = h('dt', {}, h('code', { text: command }), args ? h('span', { class: 'command-args', text: ' ' + args }) : null);
  return [term, h('dd', { text: description })];
}
