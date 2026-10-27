// The files sent with a message, drawn above its bubble: pictures as thumbnails, everything else as
// chips on a small paper sheet. Each opens in a new tab; a workbook, which a browser cannot show,
// is downloaded instead.

import { h } from '../../dom.js';
import { KINDS, fileLinks, fileSheet, sizeOf } from '../files.js';

/** @param {import('./store.js').Attachment} file */
function chip(file) {
  const kind = KINDS[file.kind];
  const links = fileLinks(file.id);
  const what = h(
    'span',
    { class: 'attach-text' },
    h('span', { class: 'attach-name', text: file.name }),
    h('span', { class: 'attach-meta', text: [kind?.tag ?? 'FILE', file.details, sizeOf(file.bytes)].filter(Boolean).join(' · ') }),
  );
  const content = [fileSheet(kind?.tag ?? 'FILE', { small: true }), what];
  if (!links) return h('span', { class: 'attach-chip' }, ...content);
  const opens = file.kind === 'xlsx'
    ? { href: links.download, download: file.name }
    : { href: links.view, target: '_blank', rel: 'noopener' };
  return h('a', { class: 'attach-chip', 'data-file': true, title: file.name, ...opens }, ...content);
}

/** @param {import('./store.js').Attachment} file */
function thumbnail(file) {
  const links = fileLinks(file.id);
  const picture = h('img', { class: 'attach-image', src: links.view, alt: file.name, loading: 'lazy' });
  const link = h('a', { class: 'attach-thumb', 'data-file': true, href: links.view, target: '_blank', rel: 'noopener', title: file.name }, picture);
  // A picture that cannot be loaded is still a file the user sent, so it becomes a chip.
  picture.addEventListener('error', () => link.replaceWith(chip(file)));
  return link;
}

/**
 * Fills `container` with the files of a message, pictures first.
 * @param {HTMLElement} container
 * @param {import('./store.js').Attachment[]} files
 */
export function fillAttachments(container, files) {
  const isPicture = (file) => KINDS[file.kind]?.image === true && fileLinks(file.id) !== null;
  const pictures = files.filter(isPicture);
  const others = files.filter((file) => !isPicture(file));
  container.replaceChildren(
    ...(pictures.length > 0 ? [h('div', { class: 'attach-row' }, ...pictures.map(thumbnail))] : []),
    ...(others.length > 0 ? [h('div', { class: 'attach-row' }, ...others.map(chip))] : []),
  );
}
