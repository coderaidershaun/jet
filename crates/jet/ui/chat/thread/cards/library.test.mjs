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

test('library cards read document, outline, section, pages, item, many, media and check_pdf results', () => {
  const overview = read('document_overview', {
    document_id: DOCUMENT, media: 'Quanty Sample Notes', chapter_number: 2, chapter_name: 'Black Scholes In Depth', pages: 3,
    items: { formula: 6, figure: 0, table: 0, code: 1 },
    insights: { state: 'saved', takeaways: ['Volatility is the one unknown input.'] },
    concepts: [{ concept_id: 'c1', name: 'Long straddle', mentions: 3, definition: 'A bet that the price moves a lot.' }],
    related_documents: [{ document_id: 'd2', title: 'Quanty Sample Notes, chapter 1', shared: 4 }],
    ingested_whole: true,
  });
  assert.equal(overview.meta, '3 pages · 7 items · 0.8 s');
  assert.deepEqual(blocksOf(overview), [
    { type: 'lead', text: 'Quanty Sample Notes, chapter 2: Black Scholes In Depth · 3 pages' },
    { type: 'facts', fields: [{ term: 'Items', text: '6 formulas, 1 code listing' }, { term: 'Insights', text: 'insights saved' }] },
    { type: 'list', heading: 'Takeaways', rows: [{ text: 'Volatility is the one unknown input.', meta: '' }], empty: null },
    { type: 'list', heading: 'Top concepts', rows: [{ text: 'Long straddle', meta: '3 mentions', detail: 'A bet that the price moves a lot.' }], empty: null },
    { type: 'list', heading: 'Related documents', rows: [{ text: 'Quanty Sample Notes, chapter 1', meta: '4 shared concepts' }], empty: null },
  ]);
  // A part that failed shows as a note, and a paper is titled by its own title.
  const broken = read('document_overview', { document_id: DOCUMENT, document_title: 'A paper', pages: 1, insights: { error: 'no category' }, concepts: { error: 'graph is down' }, related_documents: { error: 'graph is down' } });
  assert.deepEqual(blocksOf(broken).map((block) => block.text), ['A paper · 1 page', 'The insights could not be read: no category', 'The concepts could not be read: graph is down', 'The related documents could not be read: graph is down']);
  assert.equal(broken.meta, '1 page · 0.8 s');
  assert.equal(blocksOf(read('document_overview', { document_id: DOCUMENT, insights: { state: 'none_for_book_part', takeaways: [] } }))[0].fields[0].text, 'no insights for this part');

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
  assert.equal(outline.meta, '4 sections · 0.8 s');
  assert.deepEqual(blocksOf(outline), [
    { type: 'lead', text: 'Option Volatility and Pricing, chapter 24: Volatility Contracts' },
    { type: 'note', text: 'The concepts could not be read: graph is down' },
    { type: 'outline', rows: [
      { text: '24 Volatility Contracts', meta: 'p. 1–7', depth: 0 },
      { text: '24.1 Volatility Surfaces', meta: 'p. 1–3', depth: 1 },
      { text: 'Skew', meta: 'p. 4', depth: 2 },
      { text: 'Front matter', meta: '', depth: 3 },
    ] },
  ]);
  assert.deepEqual(blocksOf(read('document_outline', { ...header, sections: [] }))[1], { type: 'note', text: 'This document has no sections.' });

  // A section's pages are its first and last; a cut text says so and how to go on.
  const section = read('read_section', { ...header, index: 1, path: ['24 Volatility Contracts', 'Volatility Surfaces'], pages: [1, 3], pictures: [], text: '## Volatility Surfaces\n\nA surface…', truncated: true, cursor: 'eyJ' });
  assert.equal(section.meta, 'pages 1–3 · cut short · 0.8 s');
  assert.deepEqual(blocksOf(section), [
    { type: 'lead', text: 'Option Volatility and Pricing, chapter 24: Volatility Contracts · 24 Volatility Contracts › Volatility Surfaces · pages 1–3' },
    { type: 'show', crumb: null, kind: '', show: { as: 'markdown', text: '## Volatility Surfaces\n\nA surface…' } },
    { type: 'note', text: 'Cut short. Reading again with the cursor this result gives continues from here.' },
  ]);
  const whole = read('read_section', { ...header, path: [], pages: [2, 2], text: 'Text.', truncated: false });
  assert.equal(whole.meta, 'page 2 · 0.8 s');
  assert.equal(blocksOf(whole).some((block) => block.type === 'note'), false);

  // Pages come as Markdown or as pieces, which are drawn as a page card draws them.
  const pages = read('read_pages', {
    ...header, from: 1, to: 2, truncated: false,
    pieces: [
      { number: 1, kind: 'heading', section: ['24 Volatility Contracts'], content: 'Surfaces' },
      { number: 2, kind: 'formula', section: ['24 Volatility Contracts'], label: '(24.1)', content: ' \\sigma^2 ' },
    ],
  });
  assert.equal(pages.meta, 'pages 1–2 · 0.8 s');
  assert.equal(blocksOf(pages)[0].text.endsWith('pages 1–2 of 7'), true);
  assert.deepEqual(blocksOf(pages).slice(1).map((block) => [block.type, block.crumb, block.show.as]), [['show', '24 Volatility Contracts', 'heading'], ['show', null, 'formula']]);
  assert.deepEqual(blocksOf(pages)[2].show, { as: 'formula', tex: '\\sigma^2', label: '(24.1)' });
  assert.deepEqual(blocksOf(read('read_pages', { ...header, from: 3, to: 3, text: '' }))[1], { type: 'note', text: 'Nothing was read.' });

  // An item shows by its kind; a figure keeps its picture address for the picture path to load.
  const figure = read('read_item', {
    ...header, item_id: 'e7a1', page: 7, printed_page: '500', number: 4, kind: 'figure', section: ['24 Volatility Contracts', 'Volatility Surfaces'],
    label: 'Figure 24-12', caption: 'FTSE 100 volatility surface.', content: 'The figure shows implied volatility rising…',
    picture: 'content/option-volatility-and-pricing/chapter-24/page-num-7/02-figure.png', section_index: 3,
    cited_by: [{ page: 7, printed_page: '500', number: 3, excerpt: 'As Figure 24-12 shows…' }, { page: 2, number: 1, excerpt: 'See below.' }], truncated: false,
  });
  assert.equal(figure.meta, 'figure · Figure 24-12 · p.500 · 0.8 s');
  assert.deepEqual(blocksOf(figure), [
    { type: 'lead', text: 'Option Volatility and Pricing, chapter 24: Volatility Contracts' },
    { type: 'facts', fields: [
      { term: 'Kind', text: 'figure' }, { term: 'Label', text: 'Figure 24-12' }, { term: 'Place', text: 'p.500' },
      { term: 'Section', text: '24 Volatility Contracts › Volatility Surfaces' }, { term: 'Caption', text: 'FTSE 100 volatility surface.' },
    ] },
    { type: 'show', crumb: null, kind: 'figure', show: { as: 'figure', picture: 'content/option-volatility-and-pricing/chapter-24/page-num-7/02-figure.png', text: 'The figure shows implied volatility rising…', label: 'Figure 24-12' } },
    { type: 'list', heading: 'Cited by', rows: [{ text: 'As Figure 24-12 shows…', meta: 'p.500' }, { text: 'See below.', meta: 'page 2' }], empty: null },
  ]);
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
  assert.equal(many.meta, '7 reads · 2 cut short · 0.8 s');
  assert.deepEqual(blocksOf(many).map((part) => [part.type, part.heading, part.meta]), [
    ['part', 'read_item', 'formula · page 7'], ['part', 'read_section', 'pages 1–3 · cut short'], ['part', 'read_pages', 'not read'],
    ['part', 'read_section', 'failed'], ['part', 'chapter_insights', 'insights saved'], ['part', 'search', ''], ['part', 'read_pages', ''],
  ]);
  assert.deepEqual(blocksOf(many)[1].blocks.at(-1), { type: 'note', text: 'Cut short. Reading again with the cursor this result gives continues from here.' });
  assert.deepEqual(blocksOf(many)[2].blocks, [{ type: 'note', text: 'Not read: the budget ran out.' }]);
  assert.deepEqual(blocksOf(many)[3].blocks, [{ type: 'note', text: '`document_id` is not valid.' }]);
  assert.deepEqual(blocksOf(many)[4].blocks.map((block) => block.heading ?? block.type), ['lead', 'Takeaways', 'Insights']);

  // The media of the library, in full or by name only.
  const media = read('list_media', { media: [
    { title: 'Option Volatility and Pricing', category: 'book', authors: ['Sheldon Natenberg'], tags: [], documents: 1, pages: 7, items: 20, with_insights: 0 },
    { title: 'Quanty Sample Notes' },
  ], version: 1, nodes: [] });
  assert.equal(media.meta, '2 media · 0.8 s');
  assert.deepEqual(blocksOf(media)[0].rows, [{ text: 'Option Volatility and Pricing', meta: 'book · Sheldon Natenberg · 1 document · 7 pages · 20 items' }, { text: 'Quanty Sample Notes', meta: '' }]);
  assert.equal(blocksOf(read('list_media', { media: [] }))[0].empty, 'The library has no media.');

  // The check of a PDF: the state in words, the blockers, and what an ingest would cost.
  const check = read('check_pdf', {
    media: 'Option Volatility and Pricing', title: 'Option Volatility and Pricing, chapter 1', category: 'book', file: 'chapter-1.pdf', document_id: DOCUMENT, pages: 7,
    state: 'new', blockers: [], estimate: { pages_to_convert: 7, usd_low: 0.42, usd_high: 0.61, minutes: 4 },
  });
  assert.equal(check.meta, 'ready to ingest · about $0.42–$0.61, 4 minutes · 0.8 s');
  assert.equal(check.tone, 'ok');
  assert.deepEqual(blocksOf(check), [{ type: 'facts', fields: [
    { term: 'Title', text: 'Option Volatility and Pricing, chapter 1' }, { term: 'Media', text: 'Option Volatility and Pricing' }, { term: 'File', text: 'chapter-1.pdf' },
    { term: 'Category', text: 'book' }, { term: 'State', text: 'new' }, { term: 'Pages', text: '7' }, { term: 'Estimate', text: 'about $0.42–$0.61, 4 minutes' },
  ] }]);
  const blocked = read('check_pdf', { media: 'M', file: 'f.pdf', pages: null, state: null, blockers: ['The folder holds another PDF.', 'Too big.'], estimate: { usd_low: null, usd_high: null, minutes: 1 } });
  assert.equal(blocked.meta, '2 blockers · 0.8 s');
  assert.equal(blocked.tone, 'invalid');
  assert.deepEqual(blocksOf(blocked)[0].fields.slice(-2), [{ term: 'State', text: 'different PDF in its folder' }, { term: 'Estimate', text: 'about 1 minute, cost unknown' }]);
  assert.equal(blocksOf(blocked)[1].rows.length, 2);
  const partly = read('check_pdf', { state: 'partly_converted', pages_done: 3, pages: 7, blockers: [] });
  assert.equal(blocksOf(partly)[0].fields[0].text, 'partly converted (3 pages done)');
  assert.equal(partly.meta, 'ready to ingest · 0.8 s');
  // A stored document has nothing to convert, so the summary is its state, not a start.
  const repair = read('check_pdf', { state: 'ingested_without_insights', items: 41, pages: null, blockers: [], estimate: { pages_to_convert: 0, usd_low: 0, usd_high: 0, minutes: 0 } });
  assert.equal(blocksOf(repair)[0].fields[0].text, 'ingested without insights');
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
