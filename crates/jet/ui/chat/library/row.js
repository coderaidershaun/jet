// One file as a row of a list, the same in the library and in the plan pane: its sheet, its name, its facts,
// and a download button. A tap opens the file dialog; while files are being chosen, a tap anywhere chooses it.

import { h, icon } from '../../dom.js';
import { KINDS, fileLinks, fileSheet } from '../files.js';
import { viewOnClick } from '../file-view.js';
import { factsWords } from './words.js';

/**
 * @param {import('./store.js').File} file
 * @param {{ now: number, titleOf: (chatId: number) => string, choosing?: { chosen: boolean, toggle: () => void } }} parts
 *   `choosing` is there only while the library chooses files
 */
export function fileRow(file, { now, titleOf, choosing }) {
  const links = fileLinks(file.id);
  const words = [
    fileSheet(KINDS[file.kind]?.tag ?? 'FILE', { small: true }),
    h('span', { class: 'file-row-text' }, h('span', { class: 'file-row-name', text: file.name }), h('span', { class: 'file-row-facts', text: factsWords(file, now, titleOf) })),
  ];
  const item = h('li', { class: 'file-row', 'data-id': file.id, title: file.name });
  if (choosing) {
    const box = h('input', { type: 'checkbox', class: 'file-row-check', 'data-key': `pick-${file.id}`, 'aria-label': `Choose ${file.name}`, onChange: choosing.toggle });
    box.checked = choosing.chosen;
    item.dataset.chosen = String(choosing.chosen);
    item.append(h('label', { class: 'file-row-open' }, h('span', { class: 'file-row-box' }, box), ...words));
    return item;
  }
  item.append(
    h('a', { class: 'file-row-open', href: file.kind === 'html' ? links.frame : links.view, target: '_blank', rel: 'noopener', 'data-key': `file-${file.id}`, onClick: viewOnClick(file) }, ...words),
    h('a', { class: 'icon-button file-row-download', href: links.download, download: file.name, 'data-key': `download-${file.id}`, 'aria-label': `Download ${file.name}`, title: 'Download' }, icon('download')),
  );
  return item;
}
