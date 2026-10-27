// What the page knows about the kinds of file: their names on a paper sheet, the links that
// reach a saved file, and the paper sheet itself. The card of a file Jet wrote, the chips of
// files being attached and the chips of files already sent all draw from here.

import { h } from '../dom.js';

/**
 * Keyed by the kind the server names. `tag` is the band on the sheet; `writing` is how a
 * file Jet writes is described while it is being written.
 * @type {Record<string, { tag: string, label: string, image?: boolean, writing?: string }>}
 */
export const KINDS = {
  pdf: { tag: 'PDF', label: 'PDF', writing: 'a PDF' },
  markdown: { tag: 'MD', label: 'Markdown', writing: 'a Markdown file' },
  html: { tag: 'HTML', label: 'HTML page', writing: 'an HTML page' },
  xlsx: { tag: 'XLSX', label: 'Excel workbook' },
  csv: { tag: 'CSV', label: 'CSV' },
  text: { tag: 'TXT', label: 'Text' },
  png: { tag: 'PNG', label: 'PNG image', image: true },
  jpeg: { tag: 'JPG', label: 'JPEG image', image: true },
  gif: { tag: 'GIF', label: 'GIF image', image: true },
  webp: { tag: 'WEBP', label: 'WebP image', image: true },
};

const EXTENSIONS = {
  pdf: 'pdf', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', xlsx: 'xlsx', csv: 'csv', txt: 'text',
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp',
};

/** The extensions the file picker offers, written as its `accept` list. */
export const ACCEPT = Object.keys(EXTENSIONS).map((extension) => '.' + extension).join(',');

// A saved file is reached only by this shape of id, so a link is never built from anything else in a result.
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What follows the last dot of a file name, as written, or '' when there is none. @param {string} name */
export function extensionOf(name) {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
}

/** The kind a file name asks for, by its extension in any case, or null. @param {string} name */
export function kindOfName(name) {
  const extension = extensionOf(name).toLowerCase();
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : null;
}

/** The links to a saved file, or null when `id` is not the id of one. @param {unknown} id */
export function fileLinks(id) {
  if (typeof id !== 'string' || !FILE_ID.test(id)) return null;
  const lower = id.toLowerCase();
  return { download: '/api/files/' + lower, view: '/api/files/' + lower + '/view' };
}

/** @param {number} bytes */
export function sizeOf(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * The paper sheet with its folded corner and the band in the colour of the format.
 * @param {string} tag   the band's text, such as "PDF"
 * @param {{ small?: boolean }} [options]
 */
export function fileSheet(tag, { small = false } = {}) {
  return h(
    'span',
    { class: small ? 'file-sheet is-small' : 'file-sheet', 'data-format': tag.toLowerCase(), 'aria-hidden': 'true' },
    h('span', { class: 'file-tag', text: tag }),
  );
}
