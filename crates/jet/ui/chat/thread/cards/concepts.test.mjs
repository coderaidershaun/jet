import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';
import { createCardList } from './view.js';

// Through the facade the server is an app's ID, so the cards are found by the name of the tool.
const APP = 'b5e97310-4825-4b89-ace2-e330a4ed8509';
const call = (tool, result, rest = {}) => ({ id: 'c1', server: APP, tool, input: {}, ok: true, result, durationMs: 800, ...rest });
const read = (tool, result) => cardOf(call(tool, result));
const blocksOf = (card) => card.body.blocks;
const rowsOf = (card) => blocksOf(card).find((block) => block.type === 'list').rows;
const [BLACK_SCHOLES, VOLATILITY, STOCHASTIC] = ['8b1e', 'f00d', 'aa11'];
const concepts = [{ concept_id: BLACK_SCHOLES, name: 'Black–Scholes model', definition: '…' }, { concept_id: VOLATILITY, name: 'Volatility', definition: '…' }];

// Just enough of a page for the card list: elements that keep their attributes, children and text.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.parent = null; this.className = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener() {}
  append(...nodes) { for (const node of nodes) { if (typeof node === 'object') node.parent = this; this.children.push(node); } }
  get textContent() { return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join(''); }
  set textContent(text) { this.children = [String(text)]; }
  insertBefore(node) { node.parent = this; this.children.push(node); }
}
const tagsOf = (node) => (typeof node === 'string' ? [] : [node.tag, ...node.children.flatMap(tagsOf)]);

test('concept cards read their results into facts and lists', () => {
  const concept = read('concept', {
    version: 1, nodes: [{ label: 'Relations', kind: 'tool', tool: 'concept_neighbours', arguments: {} }],
    concept_id: BLACK_SCHOLES, name: 'Black–Scholes model', definition: 'A formula for the price of an option on a stock.', aliases: ['Black–Scholes–Merton model'], mentions: 5,
    documents: [{ document_id: '2f0c', title: 'Quanty Sample Notes, chapter 2', mentions: 3 }],
    top_items: [{ item_id: 'e7a1', document_id: '9d10', page: 2, printed_page: '14', kind: 'chunk', wording: 'Black–Scholes–Merton model' }],
  });
  assert.deepEqual(blocksOf(concept).map((block) => block.heading ?? block.type), ['lead', 'facts', 'Documents', 'Top items']);
  // With no argument the result is only nodes, and the concepts among them are listed.
  const discovered = read('concept', { version: 1, nodes: [
    { label: 'Itô’s lemma', kind: 'discover', tool: 'concept', arguments: { concept_id: 'c4d2' } },
    { label: 'Options', kind: 'tool', tool: 'concept_items', arguments: {} },
    { label: 'Volatility', kind: 'discover', tool: 'concept', arguments: { concept_id: VOLATILITY } },
  ] });
  assert.deepEqual(rowsOf(discovered).map((row) => row.text), ['Itô’s lemma', 'Volatility']);

  // An edge reads 'A —KIND→ B' with the page of the item that states it; an ID the result does not list shows as itself.
  const neighbours = read('concept_neighbours', {
    concept_id: BLACK_SCHOLES, concepts, truncated: true,
    edges: [
      { from: BLACK_SCHOLES, to: VOLATILITY, kind: 'ASSUMES', stated_by: { item_id: 'a1b2', document_id: '9d10', page: 3 } },
      { from: 'unlisted', to: BLACK_SCHOLES, kind: 'PART_OF', stated_by: null },
    ],
  });
  assert.deepEqual(rowsOf(neighbours).map((row) => row.text), ['Black–Scholes model —ASSUMES→ Volatility', 'unlisted —PART_OF→ Black–Scholes model']);
  assert.equal(blocksOf(neighbours).at(-1).type, 'note', 'a cut-short result says so');

  const path = read('concept_path', {
    from: { concept_id: STOCHASTIC, name: 'Stochastic calculus' }, to: { concept_id: VOLATILITY, name: 'Volatility' }, concepts,
    edges: [{ from: STOCHASTIC, to: BLACK_SCHOLES, kind: 'GENERALISES', stated_by: { page: 2 } }, { from: BLACK_SCHOLES, to: VOLATILITY, kind: 'ASSUMES', stated_by: { page: 3 } }],
  });
  assert.deepEqual(rowsOf(path).map((row) => row.text), ['Stochastic calculus —GENERALISES→ Black–Scholes model', 'Black–Scholes model —ASSUMES→ Volatility']);
  const unlinked = read('concept_path', { from: { concept_id: STOCHASTIC, name: 'Stochastic calculus' }, to: { concept_id: VOLATILITY, name: 'Volatility' }, edges: [], concepts: [] });
  assert.equal(blocksOf(unlinked)[1].type, 'note', 'no chain is said in a note');

  // Two documents: what they share, with the mentions in each, and what only one of them has.
  const compared = read('compare_documents', {
    documents: [{ document_id: '9d10', title: 'Chapter 1' }, { document_id: '2f0c', title: 'Chapter 2' }],
    shared: [{ concept_id: BLACK_SCHOLES, name: 'Black–Scholes model', mentions: { '9d10': 2, '2f0c': 3 } }, { concept_id: VOLATILITY, name: 'Volatility', mentions: { '2f0c': 1 } }],
    only_in: { '9d10': [{ concept_id: 'x', name: 'Time value', mentions: 1 }], '2f0c': [] }, truncated: true,
  });
  assert.deepEqual(blocksOf(compared).map((block) => block.heading ?? block.type), ['Shared', 'Only in Chapter 1', 'Only in Chapter 2', 'note']);
  assert.deepEqual(blocksOf(compared)[0].rows.map((row) => row.meta), ['Chapter 1: 2 · Chapter 2: 3', 'Chapter 2: 1']);

  const found = read('find_concepts', {
    concepts: [{ concept_id: VOLATILITY, name: 'Volatility', definition: 'How much a price moves.', aliases: [], mentions: 2, documents: 2, score: 0.995 }, { concept_id: 'x', name: 'Vega', mentions: 1, documents: 1 }],
    usage: [], cost_usd: 0.000001,
  });
  assert.deepEqual(rowsOf(found).map((row) => row.text), ['Volatility', 'Vega']);
  assert.equal(JSON.stringify(found.body).includes('0.000001'), false, 'the cost is not shown');

  const items = read('concept_items', { concept_id: BLACK_SCHOLES, items: [{ item_id: 'x', document_id: '9d10', page: 2, kind: 'chunk', wording: 'Black–Scholes model' }], next_cursor: '3' });
  assert.deepEqual(rowsOf(items).map((row) => row.text), ['Black–Scholes model']);
  const similar = read('similar_items', { item_id: 'e7a1', items: [{ item_id: 'b3c4', document_id: '9d10', document: 'Chapter 1', page: 1, kind: 'figure', label: 'Figure 1', score: 0.9 }] });
  assert.deepEqual(rowsOf(similar).map((row) => row.text), ['Chapter 1']);

  // Results come from outside: a result of the wrong shape shows as plain fields, and nothing throws.
  const malformed = [{ items: 'none' }, { concept_id: 7, name: 7, edges: {}, from: 'a', to: 'b', documents: 3, shared: 1, only_in: [], concepts: 'x', nodes: 5 }, null, 'text', []];
  for (const tool of ['concept', 'concept_neighbours', 'concept_path', 'concept_items', 'compare_documents', 'find_concepts', 'similar_items']) {
    for (const result of malformed) assert.equal(read(tool, result).body.kind, 'fields', tool + ' ' + JSON.stringify(result));
  }
  // Fields of the right shape with values of the wrong kind read as empty.
  assert.doesNotThrow(() => read('concept_neighbours', { concept_id: 'a', edges: [null, 3, { from: {}, to: [], kind: 7, stated_by: 'x' }], concepts: [null, { concept_id: 5 }] }));
  assert.doesNotThrow(() => read('compare_documents', { documents: [null, { document_id: 3 }], shared: [null, { mentions: [] }], only_in: { a: 'x' } }));

  // The words of a result are drawn as text, never as markup.
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const hostile = '<img src=x onerror=alert(1)>';
    const container = new Element('div');
    const cards = createCardList(container, { render: async () => '', readImage: async () => '', seal() {} });
    cards.sync([call('find_concepts', { concepts: [{ concept_id: 'a', name: hostile, definition: hostile, mentions: 1, documents: 1 }] })], []);
    const card = container.children[0];
    assert.equal(card.tag, 'details');
    assert.equal(tagsOf(card).includes('img'), false);
    assert.equal(card.textContent.includes(hostile), true);
  } finally {
    globalThis.document = previous;
  }
});
