// Opens an HTML file in the page. A user's or Jet's HTML is untrusted, so it is never fetched and inserted. The
// dialog's frame holds Jet's own wrapper document (/api/files/{id}/frame), which holds the file in a frame of its
// own: sandboxed to scripts only (no origin, no forms, popups or navigation) and, by the wrapper's policy, unable
// to send itself to another site. The sandbox is there, and in the file's own response headers, not on this outer
// frame: a sandboxed wrapper would lose its origin, and its inner request would lose the sign-in.

import { h, icon } from '../dom.js';
import { fileLinks } from './files.js';

let dialog = null;
let opener = null;

function build() {
  const name = h('span', { class: 'file-view-name' });
  const download = h('a', { class: 'file-view-link', 'data-file': true, text: 'Download' });
  const tab = h('a', { class: 'file-view-link', 'data-file': true, target: '_blank', rel: 'noopener', text: 'Open in a new tab' });
  const close = h('button', { type: 'button', class: 'icon-button file-view-close', 'aria-label': 'Close', title: 'Close', onClick: () => dialog.close() }, icon('close'));
  const frame = h('div', { class: 'file-view-frame' });
  dialog = h('dialog', { class: 'file-view' }, h('header', { class: 'file-view-head' }, name, download, tab, close), frame);
  dialog.parts = { name, download, tab, frame };
  // A tap on the dim edge around the sheet closes it; closing removes the frame and gives the focus back.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    frame.replaceChildren();
    if (opener?.isConnected) opener.focus();
    opener = null;
  });
  document.body.append(dialog);
}

/** Shows the HTML file `id` in a sandboxed frame; nothing happens for an id that is not a saved file's. @param {{ id: string, name: string }} file */
export function viewFile({ id, name }) {
  const links = fileLinks(id);
  if (!links) return;
  if (!dialog) build();
  const { parts } = dialog;
  opener = document.activeElement;
  parts.name.textContent = name;
  parts.download.href = links.download;
  parts.download.download = name;
  parts.tab.href = links.frame;
  parts.frame.replaceChildren(h('iframe', { referrerpolicy: 'no-referrer', title: name, src: links.frame }));
  if (!dialog.open) dialog.showModal();
}

/** A plain click opens the file here; a middle or modified click keeps its link and opens the tab. @param {{ id: string, name: string }} file */
export const viewOnClick = (file) => (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  viewFile(file);
};

/** The link attributes that open a file the way its kind asks: HTML here, a workbook downloaded, the rest in a tab. Null for an id that is not a saved file's. */
export function openProps(file) {
  const links = fileLinks(file.id);
  if (!links) return null;
  if (file.kind === 'xlsx') return { href: links.download, download: file.name };
  if (file.kind === 'html') return { href: links.frame, target: '_blank', rel: 'noopener', onClick: viewOnClick(file) };
  return { href: links.view, target: '_blank', rel: 'noopener' };
}
