// How the parts of a document are named and drawn, shared by every card that reads one: the label of a
// page, the title of a document, and the way a piece or an item is shown by its kind. Pure, with no DOM.

import { joined, listOf, orNull, recordOf, stringOf } from './guard.js';

/** 'p.145' when the book prints the page, else 'page 15': the place in the chapter, which is not a printed number. */
export function pageLabel(item) {
  const { printed_page: printed, page } = recordOf(item);
  if (typeof printed === 'string' && printed !== '') return 'p.' + printed;
  return 'page ' + (page ?? '?');
}

/**
 * How a hit or a page piece is drawn, by its kind. `item` supplies the label, picture and language.
 * @returns {import('./model.js').Show}
 */
export function showOf(kind, text, item = {}) {
  const { label, picture, language } = recordOf(item);
  const words = stringOf(text);
  switch (kind) {
    case 'chunk':
    case 'text':
      return { as: 'markdown', text: words };
    case 'footnote':
      return { as: 'markdown', text: words, footnote: true };
    case 'heading':
      return { as: 'heading', text: words };
    case 'formula':
      return { as: 'formula', tex: words.trim(), label: orNull(label) };
    case 'table':
      return { as: 'table', text: words, label: orNull(label) };
    case 'figure':
      return { as: 'figure', picture: orNull(picture), text: words, label: orNull(label) };
    case 'code':
      return { as: 'code', text: words, language: orNull(language), label: orNull(label) };
    default:
      return { as: 'plain', text: words };
  }
}

/** @returns {import('./model.js').Piece[]} */
export function piecesOf(pieces) {
  let previous = '';
  return listOf(pieces).map((raw, index) => {
    const piece = recordOf(raw);
    const section = listOf(piece.section).join(' › ');
    const crumb = section !== '' && section !== previous ? section : null;
    previous = section;
    return { n: typeof piece.number === 'number' ? piece.number : index + 1, kind: stringOf(piece.kind), crumb, show: showOf(piece.kind, piece.content, piece) };
  });
}

/** A paper's own title, else the media and its chapter: 'Option Volatility & Pricing, chapter 9: Risk Measurement II'. */
export function pageTitle(page) {
  const title = orNull(page.document_title);
  if (title) return title;
  const chapter = typeof page.chapter_number === 'number'
    ? 'chapter ' + page.chapter_number + (page.chapter_name ? ': ' + stringOf(page.chapter_name) : '')
    : '';
  return [stringOf(page.media), chapter].filter(Boolean).join(', ');
}
