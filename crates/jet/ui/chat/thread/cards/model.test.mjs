import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDED_HITS, QUANTY_DOWN, QUANTY_SEARCH } from '../../../bridge/fixtures/quanty-search.js';
import { cardOf, pageLabel, showOf, sourceTitle } from './model.js';

const call = (server, tool, input, rest = {}) => ({ id: server + '-' + tool, server, tool, input, ...rest });
const finished = (server, tool, input, result, rest = {}) => call(server, tool, input, { ok: true, result, durationMs: 800, ...rest });
const SEARCHED = finished('quanty', 'search', QUANTY_SEARCH.use.input, { ...QUANTY_SEARCH.result, results: [...QUANTY_SEARCH.result.results, ...ADDED_HITS] });
const VEGA = 'What is vega, the sensitivity of an option price to volatility?';

test('each tool reads as what it is doing while it runs, and sums up what came back when it finishes', () => {
  const running = (server, tool, input, earlier) => cardOf(call(server, tool, input), earlier);

  const search = running('quanty', 'search', { question: VEGA });
  assert.equal(search.state, 'running');
  assert.equal(search.line, 'Searching quanty · “' + VEGA + '”');
  assert.deepEqual([search.head, search.tone, search.body], [search.line, 'quiet', null]);
  assert.equal(running('quanty', 'search', {}).line, 'Searching quanty');
  assert.equal(running('quanty', 'answer', { question: 'What is gamma?' }).line, 'Answering · “What is gamma?”');
  assert.equal(running('quanty', 'answer', {}).line, 'Answering');
  assert.equal(running('quanty', 'list_documents', {}).line, 'Listing the library');
  assert.equal(running('quanty', 'health', {}).line, 'Checking the library');
  assert.equal(running('quanty', 'ingest_status', { job_id: 'j1' }).line, 'Checking the ingest');
  assert.equal(running('quanty', 'ingest_pdf', { path: '/Users/me/books/chapter-3-greeks.pdf' }).line, 'Adding a PDF · chapter-3-greeks.pdf');
  assert.equal(running('quanty', 'ingest_pdf', { file_name: 'paper.pdf' }).line, 'Adding a PDF · paper.pdf');
  assert.equal(running('quanty', 'ingest_pdf', {}).line, 'Adding a PDF');
  assert.equal(running('polysim', 'list_strategies', {}).line, 'Calling polysim · list_strategies');

  const vegaChapter = QUANTY_SEARCH.result.results[0];
  const pageInput = { document_id: vegaChapter.document_id, page: 14 };
  assert.equal(running('quanty', 'read_page', pageInput).line, 'Reading page 14 of a document');
  assert.equal(running('quanty', 'read_page', pageInput, [SEARCHED]).line, 'Reading page 14 of ' + vegaChapter.document, 'the title comes from a search above');
  const listed = finished('quanty', 'list_documents', {}, { documents: [{ document_id: 'd9', title: 'Paper on skew', authors: ['A. Writer', 'B. Writer'], pages: 12 }], unreadable_chapters: [] });
  assert.equal(running('quanty', 'read_page', { document_id: 'd9', page: 2 }, [SEARCHED, listed]).line, 'Reading page 2 of Paper on skew', 'or from the library list above');

  const searched = cardOf(SEARCHED, []);
  const registered = cardOf({ ...SEARCHED, server: 'b5e97310-4825-4b89-ace2-e330a4ed8509' });
  assert.deepEqual(registered.body, searched.body, 'registered app IDs retain source cards');
  assert.equal(cardOf(finished('other-app', 'search', {}, { results: ['plain result'] })).body.kind, 'fields', 'unrelated shapes keep the generic card');
  assert.equal(searched.state, 'done');
  assert.equal(searched.head, 'quanty · search · 8 sources · 0.8 s');
  assert.equal(searched.meta, '8 sources · 0.8 s');
  assert.equal(searched.line, 'Searching quanty · “' + VEGA + '”', 'the card keeps what the call was');
  assert.equal(searched.tone, 'quiet');
  assert.equal(searched.body.kind, 'sources');
  assert.equal(searched.body.asked, VEGA);
  assert.equal(searched.body.rows.length, 8);
  assert.equal(cardOf(finished('quanty', 'search', { question: 'x' }, { results: [] }, { durationMs: 12400 })).head, 'quanty · search · 0 sources · 12 s');
  assert.equal(cardOf(finished('quanty', 'search', { question: 'x' }, { results: [ADDED_HITS[0]] }, { durationMs: undefined })).head, 'quanty · search · 1 source');

  const page = cardOf(finished('quanty', 'read_page', pageInput, {
    document_id: vegaChapter.document_id, media: 'Option Volatility & Pricing', chapter_number: 7, chapter_name: 'Risk Measurement I',
    page: 14, pages: 40, printed_page: '110', pieces: [{ number: 1, kind: 'text', section: [], content: 'One.' }, { number: 2, kind: 'text', section: [], content: 'Two.' }],
  }));
  assert.equal(page.head, 'quanty · read_page · p.110 · 2 pieces · 0.8 s');
  assert.deepEqual([page.body.kind, page.body.title, page.body.place], ['page', 'Option Volatility & Pricing, chapter 7: Risk Measurement I', 'p.110 · page 14 of 40']);
  const unprinted = cardOf(finished('quanty', 'read_page', pageInput, { media: 'A Paper', document_title: 'A Paper', page: 3, pages: 9, pieces: [{ number: 1, kind: 'text', section: [], content: 'x' }] }));
  assert.equal(unprinted.head, 'quanty · read_page · page 3 · 1 piece · 0.8 s', 'with no printed page the place in the chapter is not called a page number');
  assert.equal(unprinted.body.title, 'A Paper');
  assert.equal(unprinted.body.place, 'page 3 of 9');

  const answered = cardOf(finished('quanty', 'answer', { question: 'What is vega?' }, {
    answered: true, title: 'Vega', claims: [{ heading: 'Meaning', text: 'Vega is **sensitivity**.', sources: [1] }, { text: 'It peaks at the money.', sources: [2, 3] }],
    sources: [{ number: 1, ...QUANTY_SEARCH.result.results[0] }, { number: 2, ...QUANTY_SEARCH.result.results[1] }, { number: 3, ...QUANTY_SEARCH.result.results[2] }], follow_ups: ['What is volga?'], cost_usd: null,
  }));
  assert.equal(answered.head, 'quanty · answer · 2 claims · 3 sources · 0.8 s');
  assert.deepEqual(answered.body.claims, [{ heading: 'Meaning', text: 'Vega is **sensitivity**.', sources: [1] }, { heading: null, text: 'It peaks at the money.', sources: [2, 3] }]);
  assert.deepEqual([answered.body.title, answered.body.followUps, answered.body.rows.map((row) => row.n)], ['Vega', ['What is volga?'], [1, 2, 3]]);
  const unanswered = cardOf(finished('quanty', 'answer', { question: 'x' }, { answered: false, claims: [], sources: [], follow_ups: [] }));
  assert.equal(unanswered.head, 'quanty · answer · no answer · 0.8 s');
  assert.equal(unanswered.body.answered, false);

  const documents = cardOf(finished('quanty', 'list_documents', {}, { documents: [{ document_id: 'd1', title: 'Skew', authors: ['A', 'B'], pages: 12 }, { document_id: 'd2', title: 'Smile', authors: [] }], unreadable_chapters: ['chapter-3: page.json is missing'] }));
  assert.equal(documents.head, 'quanty · list_documents · 2 documents · 0.8 s');
  assert.deepEqual(documents.body, { kind: 'documents', documents: [{ title: 'Skew', authors: 'A, B', pages: '12' }, { title: 'Smile', authors: '', pages: '' }], unreadable: ['chapter-3: page.json is missing'] });

  const healthy = cardOf(finished('quanty', 'health', {}, { healthy: true, report: 'Qdrant: ready\nFalkorDB: ready\n' }));
  assert.deepEqual([healthy.head, healthy.tone], ['quanty · health · healthy · 0.8 s', 'ok']);
  const unwell = cardOf(finished('quanty', 'health', {}, { healthy: false, report: 'Qdrant: ready\nFalkorDB: FAILED connection refused' }));
  assert.deepEqual([unwell.head, unwell.tone], ['quanty · health · not healthy · 0.8 s', 'invalid']);
  assert.deepEqual(unwell.body.lines, [{ text: 'Qdrant: ready', ok: true }, { text: 'FalkorDB: FAILED connection refused', ok: false }]);

  const ingest = (result) => cardOf(finished('quanty', 'ingest_status', { job_id: 'j1' }, result));
  const underway = ingest({ job_id: 'j1', state: 'running', stage: 'converting', media: 'M', file: 'chapter-3.pdf' });
  assert.deepEqual([underway.head, underway.tone], ['quanty · ingest_status · running · converting · 0.8 s', 'quiet']);
  assert.deepEqual(underway.body.fields, [{ term: 'State', text: 'running' }, { term: 'Stage', text: 'converting' }, { term: 'Media', text: 'M' }, { term: 'File', text: 'chapter-3.pdf' }]);
  const done = ingest({ state: 'done', media: 'M', file: 'f.pdf', document_id: 'd1', items: 312, summary: 'Ingested 312 items.\nTwo figures.', cost_usd: 0.4567 });
  assert.deepEqual([done.head, done.tone], ['quanty · ingest_status · done · 312 items · 0.8 s', 'ok']);
  assert.deepEqual(done.body.fields.map((field) => field.term), ['State', 'Media', 'File', 'Document', 'Items', 'Cost', 'Summary']);
  assert.deepEqual(done.body.fields.find((field) => field.term === 'Cost'), { term: 'Cost', text: '$0.46' });
  assert.deepEqual(done.body.fields.find((field) => field.term === 'Summary'), { term: 'Summary', text: 'Ingested 312 items.\nTwo figures.', pre: true });
  assert.equal(ingest({ state: 'done', cost_usd: null, items: null }).body.fields.some((field) => field.term === 'Cost' || field.term === 'Items'), false, 'a missing price or count is left out, not shown as a number');
  assert.equal(ingest({ state: 'already_ingested', items: 40 }).head, 'quanty · ingest_status · already in the library · 0.8 s');
  assert.deepEqual([ingest({ state: 'failed', error: 'disk full' }).tone, ingest({ state: 'failed', error: 'disk full' }).head], ['invalid', 'quanty · ingest_status · failed · 0.8 s']);
  assert.deepEqual(ingest({ state: 'failed', error: 'disk full' }).body.fields.at(-1), { term: 'Error', text: 'disk full' });
  assert.equal(ingest({ state: 'queued' }).head, 'quanty · ingest_status · queued · 0.8 s');

  const saved = cardOf(finished('jet', 'apps_update', {}, { app: { label: 'Notebook' }, apps: [], change: { appId: 'notes', change: 'added' }, discovery: { status: 'unavailable', message: 'offline' } }, { summary: 'jet · apps_update · 0 apps' }));
  assert.equal(saved.head, 'jet · apps_update · added · Notebook · 0.8 s');
  assert.equal(saved.state, 'done');
  assert.match(saved.body.fields.find(field => field.term === 'discovery').text, /offline/);
  const removed = cardOf(finished('jet', 'apps_update', {}, { app: null, apps: [], change: { appId: 'notes', change: 'removed' } }));
  assert.equal(removed.head, 'jet · apps_update · removed · notes · 0.8 s');

  const engine = cardOf(finished('polysim', 'list_strategies', {}, { strategies: ['momentum', 'carry'], count: 2, note: null }, { summary: 'polysim · list_strategies · 2 strategies' }));
  assert.equal(engine.head, 'polysim · list_strategies · 2 strategies · 0.8 s');
  assert.deepEqual(engine.body, { kind: 'fields', fields: [{ term: 'strategies', text: 'momentum, carry' }, { term: 'count', text: '2' }, { term: 'note', text: 'null' }] });
  assert.equal(cardOf(finished('polysim', 'run', {}, { ok: true })).head, 'polysim · run · done · 0.8 s', 'with no summary the outcome is done');
  assert.equal(cardOf(finished('quanty', 'search', { question: 'x' }, 'not an object')).body.kind, 'fields', 'a result of the wrong shape falls back to the plain card');
  for (const odd of [null, 7, [1], { results: 'no', pieces: 3, documents: null }]) {
    for (const tool of ['search', 'answer', 'read_page', 'list_documents', 'health', 'ingest_pdf']) {
      assert.doesNotThrow(() => cardOf(finished('quanty', tool, odd, odd)), tool + ' with ' + JSON.stringify(odd));
    }
  }
});

test("a failed call shows the server's advice with the health hint split off, and a call the reply outran says it stopped", () => {
  const down = QUANTY_DOWN.result;
  const failed = cardOf(call('quanty', 'search', QUANTY_DOWN.use.input, { ok: false, result: down, durationMs: 1530 }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.tone, 'invalid');
  assert.equal(failed.head, 'quanty · search · failed · 1.5 s');
  assert.equal(failed.advice, 'could not connect to the graph: FalkorDB at 127.0.0.1:6379 refused the connection.');
  assert.equal(failed.hint, 'Ask for a health check to see which service is down.');
  assert.equal(failed.body, null);
  assert.equal(failed.line, 'Searching quanty · “' + VEGA + '”', 'the card still says what was asked');

  const plain = cardOf(call('quanty', 'read_page', { document_id: 'x', page: 99 }, { ok: false, result: 'page 99 is out of range: the chapter has 40 pages, numbered from 1.' }));
  assert.equal(plain.advice, 'page 99 is out of range: the chapter has 40 pages, numbered from 1.');
  assert.equal(plain.hint, null, 'advice that does not point at health gets no hint');
  assert.equal(plain.head, 'quanty · read_page · failed');
  assert.equal(cardOf(call('polysim', 'run', {}, { ok: false, result: { error: 'no such strategy' } })).advice, '{"error":"no such strategy"}', 'advice that is not text is shown as it came');
  assert.equal(cardOf(call('polysim', 'run', {}, { ok: false })).advice, '', 'a failure with no result still has a card');

  const outran = cardOf(call('quanty', 'search', { question: 'What is gamma?' }, { unfinished: true }));
  assert.equal(outran.state, 'unfinished');
  assert.equal(outran.head, 'quanty · search · stopped');
  assert.equal(outran.line, 'Searching quanty · “What is gamma?”');
  assert.deepEqual([outran.tone, outran.body, outran.advice], ['quiet', null, null]);
  assert.equal(cardOf(call('quanty', 'search', {}, { ok: true, result: { results: [] }, unfinished: true })).state, 'unfinished', 'once the reply ended the call is stopped even if a result came');
});

test('each kind of hit is shown its own way, and an unknown kind as plain text', () => {
  const rows = cardOf(SEARCHED).body.rows;
  const [chunk, , , , , formula, table, figure] = rows;

  assert.deepEqual(
    { ...chunk, show: undefined, score: Number(chunk.score.toFixed(3)) },
    {
      n: 1, document: 'Option Volatility & Pricing, chapter 7: Risk Measurement I', page: 'p.110', kind: 'chunk', reason: 'nearest', why: 'nearest', score: 0.849,
      byline: 'Sheldon Natenberg · book', title: 'Option Volatility & Pricing, chapter 7: Risk Measurement I · p.110', show: undefined,
    },
    'a row says its number, document, printed page, kind, why it is there and how near it is',
  );
  assert.deepEqual(chunk.show, { as: 'markdown', text: QUANTY_SEARCH.result.results[0].text });

  assert.deepEqual(formula.show, { as: 'formula', tex: 'C = S e^{(b-r)t} N(d_1) - X e^{-rt} N(d_2)', label: null });
  assert.deepEqual([formula.n, formula.page, formula.kind, formula.reason], [6, 'p.350', 'formula', 'via Black-Scholes model']);
  assert.equal(table.show.as, 'table');
  assert.equal(table.show.label, 'Figure 18-6');
  assert.ok(table.show.text.startsWith('| | Call | Put |\n|---|---|---|'));
  assert.deepEqual([table.reason, table.why], ['cited by [4]', 'cited']);
  assert.deepEqual(figure.show, { as: 'figure', picture: ADDED_HITS[2].picture, text: ADDED_HITS[2].text, label: 'Figure 7-10' });
  assert.deepEqual([figure.page, figure.reason], ['p.111', 'cited by [1]']);

  assert.deepEqual(showOf('code', 'price = $x$ * \\(y\\)', { language: 'c++', label: 'Listing 2.1' }), { as: 'code', text: 'price = $x$ * \\(y\\)', language: 'c++', label: 'Listing 2.1' }, 'code is kept exactly as printed');
  assert.deepEqual(showOf('code', 'x = 1', {}), { as: 'code', text: 'x = 1', language: null, label: null });
  assert.deepEqual(showOf('footnote', 'A note.'), { as: 'markdown', text: 'A note.', footnote: true });
  assert.deepEqual(showOf('heading', 'Vega'), { as: 'heading', text: 'Vega' });
  assert.deepEqual(showOf('figure', 'A chart.', { label: 'Figure 1' }), { as: 'figure', picture: null, text: 'A chart.', label: 'Figure 1' }, 'a figure with no stored picture says so');
  assert.deepEqual(showOf('sidebar', '<b>raw</b>'), { as: 'plain', text: '<b>raw</b>' }, 'a kind the page does not know is plain text');
  assert.deepEqual(showOf(undefined, undefined), { as: 'plain', text: '' });

  const unprinted = cardOf(finished('quanty', 'search', {}, { results: [{ number: 3, document: 'A Paper', page: 4, kind: 'sidebar', text: 'Aside.', score: 'high', reason: { why: 'surprise' } }] })).body.rows[0];
  assert.deepEqual([unprinted.page, unprinted.title, unprinted.byline, unprinted.score, unprinted.reason, unprinted.show], ['page 4', 'A Paper · page 4', '', null, '', { as: 'plain', text: 'Aside.' }]);
  assert.deepEqual([pageLabel({ page: 15 }), pageLabel({ page: 15, printed_page: '' }), pageLabel({ page: 15, printed_page: 'xii' })], ['page 15', 'page 15', 'p.xii']);
  assert.equal(sourceTitle(QUANTY_SEARCH.result.results[1]), 'Option Volatility & Pricing, chapter 9: Risk Measurement II · p.145');

  const pieces = cardOf(finished('quanty', 'read_page', { document_id: 'x', page: 3 }, {
    media: 'Book', page: 3, pages: 9, printed_page: '50', pieces: [
      { number: 1, kind: 'heading', section: ['Chapter 7', 'Vega'], content: 'Vega' },
      { number: 2, kind: 'text', section: ['Chapter 7', 'Vega'], content: 'Vega is the slope.' },
      { number: 3, kind: 'formula', section: ['Chapter 7', 'Vega'], label: '(7.3)', content: '\\nu = S n(d_1)\\sqrt{t}\n' },
      { number: 4, kind: 'code', section: ['Chapter 7', 'Code'], language: 'python', content: 'vega = 0.15' },
      { number: 5, kind: 'footnote', section: [], content: 'Marked with a star.' },
      { number: 6, kind: 'text', section: [], content: 'No section at all.' },
    ],
  })).body.pieces;
  assert.deepEqual(pieces.map((piece) => piece.crumb), ['Chapter 7 › Vega', null, null, 'Chapter 7 › Code', null, null], 'a breadcrumb shows only where the section changes');
  assert.deepEqual(pieces.map((piece) => piece.show.as), ['heading', 'markdown', 'formula', 'code', 'markdown', 'markdown']);
  assert.deepEqual(pieces[2].show, { as: 'formula', tex: '\\nu = S n(d_1)\\sqrt{t}', label: '(7.3)' });
  assert.deepEqual([pieces[3].show.language, pieces[4].show.footnote, pieces[0].n, pieces[5].n], ['python', true, 1, 6]);
});
