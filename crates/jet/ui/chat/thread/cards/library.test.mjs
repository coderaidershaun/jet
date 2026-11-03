import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';

// Through the facade the server is an app's ID, so the cards are found by the name of the tool.
const APP = 'b5e97310-4825-4b89-ace2-e330a4ed8509';
const DOCUMENT = '5c3d0000-0000-4000-8000-000000000001';
const call = (tool, result, rest = {}) => ({ id: 'c1', server: APP, tool, input: {}, ok: true, result, durationMs: 800, ...rest });
const read = (tool, result) => cardOf(call(tool, result));
const blocksOf = (card) => card.body.blocks;
const header = { document_id: DOCUMENT, media: 'Option Volatility and Pricing', chapter_number: 24, chapter_name: 'Volatility Contracts', pages: 7 };

test('library cards read their results into blocks, show a failed part as a note, and keep a cut text marked', () => {
  const overview = read('document_overview', {
    document_id: DOCUMENT, media: 'Quanty Sample Notes', chapter_number: 2, chapter_name: 'Black Scholes In Depth', pages: 3,
    items: { formula: 6, figure: 0, table: 0, code: 1 },
    insights: { state: 'saved', takeaways: ['Volatility is the one unknown input.'] },
    concepts: [{ concept_id: 'c1', name: 'Long straddle', mentions: 3, definition: 'A bet that the price moves a lot.' }],
    related_documents: [{ document_id: 'd2', title: 'Quanty Sample Notes, chapter 1', shared: 4 }],
    ingested_whole: true,
  });
  assert.deepEqual(blocksOf(overview).map((block) => block.heading ?? block.type), ['lead', 'facts', 'Takeaways', 'Top concepts', 'Related documents']);
  // A part that failed shows as a note, and a paper is titled by its own title.
  const broken = read('document_overview', { document_id: DOCUMENT, document_title: 'A paper', pages: 1, insights: { error: 'no category' }, concepts: { error: 'graph is down' }, related_documents: { error: 'graph is down' } });
  assert.deepEqual(blocksOf(broken).map((block) => block.type), ['lead', 'note', 'note', 'note']);
  assert.ok(blocksOf(broken)[0].text.startsWith('A paper'));
  assert.ok(blocksOf(broken)[2].text.endsWith('graph is down'), 'a note says why the part failed');

  // The outline is flat; rank gives the depth, and the path does when there is no rank.
  const outline = read('document_outline', {
    ...header,
    sections: [
      { index: 0, path: ['24 Volatility Contracts'], rank: 1, pages: [1, 7], items: {} },
      { index: 1, path: ['24 Volatility Contracts', 'Volatility Surfaces'], rank: 2, printed_number: '24.1', pages: [1, 3] },
      { index: 2, path: ['24 Volatility Contracts', 'Volatility Surfaces', 'Skew'], pages: [4, 4] },
      { index: 3, path: ['Front matter'], rank: 9, pages: [0, 0] },
    ],
    concepts_error: 'graph is down',
  });
  const rows = blocksOf(outline).find((block) => block.type === 'outline').rows;
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2, 3]);
  assert.equal(blocksOf(read('document_outline', { ...header, sections: [] }))[1].type, 'note', 'no sections is said in a note');

  // A cut text says so and how to go on; a whole one carries no note.
  const section = read('read_section', { ...header, index: 1, path: ['24 Volatility Contracts', 'Volatility Surfaces'], pages: [1, 3], pictures: [], text: '## Volatility Surfaces\n\nA surface…', truncated: true, cursor: 'eyJ' });
  assert.deepEqual(blocksOf(section).map((block) => block.type), ['lead', 'show', 'note']);
  assert.deepEqual(blocksOf(section)[1].show, { as: 'markdown', text: '## Volatility Surfaces\n\nA surface…' });
  const whole = read('read_section', { ...header, path: [], pages: [2, 2], text: 'Text.', truncated: false });
  assert.equal(blocksOf(whole).some((block) => block.type === 'note'), false);

  // Pages come as Markdown or as pieces, which are drawn as a page card draws them.
  const pages = read('read_pages', {
    ...header, from: 1, to: 2, truncated: false,
    pieces: [
      { number: 1, kind: 'heading', section: ['24 Volatility Contracts'], content: 'Surfaces' },
      { number: 2, kind: 'formula', section: ['24 Volatility Contracts'], label: '(24.1)', content: ' \\sigma^2 ' },
    ],
  });
  assert.deepEqual(blocksOf(pages).slice(1).map((block) => [block.type, block.crumb, block.show.as]), [['show', '24 Volatility Contracts', 'heading'], ['show', null, 'formula']]);
  assert.deepEqual(blocksOf(pages)[2].show, { as: 'formula', tex: '\\sigma^2', label: '(24.1)' });
  assert.equal(blocksOf(read('read_pages', { ...header, from: 3, to: 3, text: '' }))[1].type, 'note');

  // An item shows by its kind; a figure keeps its picture address for the picture path to load.
  const figure = read('read_item', {
    ...header, item_id: 'e7a1', page: 7, printed_page: '500', number: 4, kind: 'figure', section: ['24 Volatility Contracts', 'Volatility Surfaces'],
    label: 'Figure 24-12', caption: 'FTSE 100 volatility surface.', content: 'The figure shows implied volatility rising…',
    picture: 'content/option-volatility-and-pricing/chapter-24/page-num-7/02-figure.png', section_index: 3,
    cited_by: [{ page: 7, printed_page: '500', number: 3, excerpt: 'As Figure 24-12 shows…' }, { page: 2, number: 1, excerpt: 'See below.' }], truncated: false,
  });
  assert.deepEqual(blocksOf(figure).map((block) => block.heading ?? block.type), ['lead', 'facts', 'show', 'Cited by']);
  assert.equal(blocksOf(figure)[2].show.picture, 'content/option-volatility-and-pricing/chapter-24/page-num-7/02-figure.png');
  const code = blocksOf(read('read_item', { ...header, item_id: 'x', page: 2, kind: 'code', language: 'python', content: 'x = 1', truncated: true }));
  assert.deepEqual(code.at(-2).show, { as: 'code', text: 'x = 1', language: 'python', label: null });
  assert.equal(code.at(-1).type, 'note');

  // Several reads in one: a part each, with its own words, and a mark on each that was cut short.
  const many = read('read_many', {
    used_chars: 24000,
    results: [
      { tool: 'read_item', truncated: false, result: { ...header, item_id: 'e7a1', page: 7, kind: 'formula', content: 'a^2', truncated: false } },
      { tool: 'read_section', truncated: true, result: { ...header, pages: [1, 3], text: 'Cut here', truncated: true, cursor: 'c' } },
      { tool: 'read_pages', truncated: true },
      { tool: 'read_section', truncated: false, error: '`document_id` is not valid.' },
      { tool: 'chapter_insights', truncated: false, result: { ...header, state: 'saved', insights: [{ text: 'Skew matters.', pages: [2, 3] }], takeaways: ['Smile.'] } },
      { tool: 'search', truncated: false, result: { results: [] } },
      { tool: 'read_pages', truncated: false, result: 'not a record' },
    ],
  });
  assert.deepEqual(blocksOf(many).map((part) => [part.type, part.heading]), [
    ['part', 'read_item'], ['part', 'read_section'], ['part', 'read_pages'], ['part', 'read_section'], ['part', 'chapter_insights'], ['part', 'search'], ['part', 'read_pages'],
  ]);
  assert.equal(blocksOf(many)[1].blocks.at(-1).type, 'note', 'a part that was cut short says so');
  assert.deepEqual(blocksOf(many)[3].blocks, [{ type: 'note', text: '`document_id` is not valid.' }], 'a failed read shows its error');
  assert.deepEqual(blocksOf(many)[4].blocks.map((block) => block.heading ?? block.type), ['lead', 'Takeaways', 'Insights']);

  // The media of the library, in full or by name only.
  const media = read('list_media', { media: [
    { title: 'Option Volatility and Pricing', category: 'book', authors: ['Sheldon Natenberg'], tags: [], documents: 1, pages: 7, items: 20, with_insights: 0 },
    { title: 'Quanty Sample Notes' },
  ], version: 1, nodes: [] });
  assert.deepEqual(blocksOf(media)[0].rows.map((row) => row.text), ['Option Volatility and Pricing', 'Quanty Sample Notes']);
  assert.ok(blocksOf(read('list_media', { media: [] }))[0].empty);

  // The check of a PDF: ready or blocked, and what an ingest would cost.
  const check = read('check_pdf', {
    media: 'Option Volatility and Pricing', title: 'Option Volatility and Pricing, chapter 1', category: 'book', file: 'chapter-1.pdf', document_id: DOCUMENT, pages: 7,
    state: 'new', blockers: [], estimate: { pages_to_convert: 7, usd_low: 0.42, usd_high: 0.61, minutes: 4 },
  });
  assert.equal(check.tone, 'ok');
  assert.ok(check.meta.includes('$0.42') && check.meta.includes('$0.61'), 'the estimate shows in the summary');
  const blocked = read('check_pdf', { media: 'M', file: 'f.pdf', pages: null, state: null, blockers: ['The folder holds another PDF.', 'Too big.'], estimate: { usd_low: null, usd_high: null, minutes: 1 } });
  assert.equal(blocked.tone, 'invalid');
  assert.equal(blocksOf(blocked)[1].rows.length, 2, 'each blocker is listed');
  // A stored document has nothing to convert, so the summary is its state, not a start.
  const repair = read('check_pdf', { state: 'ingested_without_insights', items: 41, pages: null, blockers: [], estimate: { pages_to_convert: 0, usd_low: 0, usd_high: 0, minutes: 0 } });
  assert.equal(repair.meta, 'ingested without insights · 0.8 s');
  assert.equal(read('check_pdf', { state: 'ingested', items: 41, pages: null, blockers: [] }).meta, 'already ingested · 0.8 s');

  // Results come from outside: a result of the wrong shape shows as plain fields, and nothing throws.
  const malformed = [{ pages: 'many' }, { document_id: 7, media: 7, sections: 'none', results: {}, blockers: 'x', item_id: 3 }, null, 'text', []];
  for (const tool of ['document_overview', 'document_outline', 'read_section', 'read_pages', 'read_item', 'read_many', 'list_media', 'check_pdf']) {
    for (const result of malformed) assert.equal(read(tool, result).body.kind, 'fields', tool + ' ' + JSON.stringify(result));
  }
  // A tool named like a built-in of every object finds no reader of its own.
  for (const tool of ['valueOf', 'hasOwnProperty', '__proto__']) assert.equal(read(tool, { a: 1 }).body.kind, 'fields', tool);
});
