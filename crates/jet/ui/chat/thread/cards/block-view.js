// Draws the body of a research card from its blocks. Every word is set as text, never as markup;
// Markdown, formulas, code and pictures go through fillShow, as they do on a page card, and are drawn
// the first time the card opens.

import { h } from '../../../dom.js';
import { fillShow } from './show.js';

/** The term and the text of each field of a result. */
export const fieldNodes = (fields) => fields.flatMap((field) => [h('dt', { text: field.term }), h('dd', {}, field.pre ? h('pre', { text: field.text }) : field.text)]);

/** One row. An outline row also says how deep it sits. */
function rowNode(row) {
  return h(
    'li',
    { 'data-depth': row.depth },
    h('span', { class: 'row-text', text: row.text }),
    row.meta ? h('span', { class: 'row-meta', text: row.meta }) : null,
    row.detail ? h('span', { class: 'row-detail', text: row.detail }) : null,
  );
}

/**
 * @param {import('./block.js').Block} block
 * @param {Array<() => Promise<void>>} fills   the drawing to do when the card first opens; a block with Markdown or a picture adds to it
 */
function nodeOf(block, parts, fills) {
  switch (block.type) {
    case 'lead':
      return h('p', { class: 'card-asked', text: block.text });
    case 'facts':
      return h('dl', { class: 'fields' }, ...fieldNodes(block.fields));
    case 'list':
      return h(
        'div',
        { class: 'block' },
        block.heading ? h('h5', { class: 'block-heading', text: block.heading }) : null,
        block.rows.length > 0 ? h('ul', { class: 'rows' }, ...block.rows.map(rowNode)) : h('p', { class: 'card-empty', text: block.empty }),
      );
    case 'outline':
      return h('ul', { class: 'rows outline' }, ...block.rows.map(rowNode));
    case 'show': {
      const element = h('div', { class: 'piece', 'data-kind': block.kind });
      if (block.crumb) element.append(h('p', { class: 'crumb', text: block.crumb }));
      fills.push(() => fillShow(element, block.show, parts));
      return element;
    }
    case 'part':
      return h(
        'div',
        { class: 'part' },
        h('h5', { class: 'block-heading' }, h('span', { text: block.heading }), block.meta ? h('span', { class: 'row-meta', text: block.meta }) : null),
        ...block.blocks.map((inner) => nodeOf(inner, parts, fills)),
      );
    case 'note':
    default:
      return h('p', { class: 'card-note', text: block.text });
  }
}

/**
 * The nodes of a research card's body, and the drawing to do the first time the card opens.
 * @param {{ blocks: import('./block.js').Block[] }} body
 * @param {import('./view.js').Parts} parts
 */
export function blocksBody(body, parts) {
  const fills = [];
  const nodes = body.blocks.map((block) => nodeOf(block, parts, fills));
  return { nodes, fill: async () => void (await Promise.all(fills.map((fill) => fill()))) };
}
