// The files sent with a message, drawn above its bubble: pictures as thumbnails, everything else as
// chips on a small paper sheet. Each opens in the file dialog. A file deleted since stays as a chip that says so.

import { h } from '../../dom.js';
import { KINDS, fileLinks, fileSheet, sizeOf } from '../files.js';
import { openProps } from '../file-view.js';
import { files } from '../library/store.js';

/** What each drawn chip or thumbnail shows, so it can be drawn again once its file is deleted. */
const shown = new WeakMap();

/** @param {import('./store.js').Attachment} file */
function chip(file) {
  const kind = KINDS[file.kind];
  const gone = files.isGone(file.id);
  const opens = gone ? null : openProps(file);
  const what = h(
    'span',
    { class: 'attach-text' },
    h('span', { class: 'attach-name', text: file.name }),
    h('span', { class: 'attach-meta', text: gone ? 'This file was deleted.' : [kind?.tag ?? 'FILE', file.details, sizeOf(file.bytes)].filter(Boolean).join(' · ') }),
  );
  const content = [fileSheet(kind?.tag ?? 'FILE', { small: true }), what];
  const el = opens ? h('a', { class: 'attach-chip', 'data-file': true, title: file.name, ...opens }, ...content) : h('span', { class: 'attach-chip', 'data-gone': String(gone) }, ...content);
  shown.set(el, file);
  return el;
}

/** @param {import('./store.js').Attachment} file */
function thumbnail(file) {
  if (files.isGone(file.id)) return chip(file);
  const picture = h('img', { class: 'attach-image', src: fileLinks(file.id).view, alt: file.name, loading: 'lazy' });
  const link = h('a', { class: 'attach-thumb', 'data-file': true, title: file.name, ...openProps(file) }, picture);
  // A picture that cannot be loaded is still a file the user sent, so it becomes a chip.
  picture.addEventListener('error', () => link.replaceWith(chip(file)));
  shown.set(link, file);
  return link;
}

files.subscribe(() => {
  for (const el of document.querySelectorAll('a.attach-chip, a.attach-thumb')) {
    const file = shown.get(el);
    if (file && files.isGone(file.id)) el.replaceWith(chip(file));
  }
});

/**
 * Fills `container` with the files of a message, pictures first.
 * @param {HTMLElement} container
 * @param {import('./store.js').Attachment[]} sent
 */
export function fillAttachments(container, sent) {
  const isPicture = (file) => KINDS[file.kind]?.image === true && fileLinks(file.id) !== null;
  const pictures = sent.filter(isPicture);
  const others = sent.filter((file) => !isPicture(file));
  container.replaceChildren(
    ...(pictures.length > 0 ? [h('div', { class: 'attach-row' }, ...pictures.map(thumbnail))] : []),
    ...(others.length > 0 ? [h('div', { class: 'attach-row' }, ...others.map(chip))] : []),
  );
}
