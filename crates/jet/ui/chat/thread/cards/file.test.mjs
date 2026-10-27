import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';

const ID = '3f1c9a52-7b0e-4d6a-8f21-5c9e0b7a41d3';
const call = (result, rest = {}) => ({
  id: 'f1', server: 'jet', tool: 'files_export', input: { format: 'pdf', title: 'Volatility smile' }, ok: true, result, durationMs: 1200, ...rest,
});

test('file card links only to the saved file', () => {
  const done = cardOf(call({ id: ID, name: 'Volatility smile.pdf', title: 'Volatility smile', format: 'pdf', bytes: 188416 }));
  assert.equal(done.state, 'done');
  assert.equal(done.body.kind, 'file');
  assert.equal(done.body.download, '/api/files/' + ID);
  assert.equal(done.body.view, '/api/files/' + ID + '/view');
  assert.equal(done.body.name, 'Volatility smile.pdf');
  assert.equal(done.body.meta, 'PDF · 184 KB');

  const markdown = cardOf(call({ id: ID, name: 'Notes.md', title: 'Notes', format: 'markdown', bytes: 900 }, { input: { format: 'markdown', title: 'Notes' } }));
  assert.equal(markdown.body.meta, 'Markdown · 900 B');
  assert.equal(markdown.body.tag, 'MD');

  const running = cardOf(call(undefined, { ok: undefined }));
  assert.equal(running.state, 'running');
  assert.equal(running.line, 'Writing “Volatility smile” as a PDF');
  const lineOf = (input) => cardOf(call(undefined, { ok: undefined, input })).line;
  assert.equal(lineOf({ format: 'markdown', title: 'Notes' }), 'Writing “Notes” as a Markdown file');
  assert.equal(lineOf({ format: 'html', title: 'Notes' }), 'Writing “Notes” as an HTML page');
  assert.equal(lineOf({ format: 'html' }), 'Writing an HTML page');
  assert.equal(lineOf({ title: 'Notes' }), 'Writing a file');

  for (const id of ['../../settings', 'https://evil.example/x.pdf', ID + '/../..', '']) {
    const bad = cardOf(call({ id, name: 'x.pdf', title: 'x', format: 'pdf', bytes: 1 }));
    assert.equal(bad.state, 'failed', id);
    assert.equal(bad.body, null, id);
    assert.equal(bad.advice, "This file can't be found.");
  }

  const failed = cardOf(call({ error: { message: 'could not make the PDF: boom' } }, { ok: false }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.name, "Couldn't write the PDF");
  assert.equal(failed.advice, 'could not make the PDF: boom');

  // Reading and listing attached files are one-line cards with no body.
  const read = (result, rest = {}) => cardOf({ id: 'r1', server: 'jet', tool: 'files_read', input: { id: ID }, ok: true, result, durationMs: 400, ...rest });
  const pages = read({ type: 'text', id: ID, name: 'Q3 report.pdf', unit: 'pages', start: 1, end: 20, total: 48, more: true, sheets: [] });
  assert.equal(pages.state, 'done');
  assert.equal(pages.body, null);
  assert.equal(pages.meta, 'Q3 report.pdf · pages 1–20 of 48 · 0.4 s');
  assert.equal(read({ id: ID, name: 'a.csv', unit: 'rows', start: 1, end: 500, total: 1204 }).meta, 'a.csv · rows 1–500 of 1,204 · 0.4 s');
  assert.equal(read({ id: ID, name: 'a.txt', unit: 'lines', start: 3, end: 3, total: 3 }).meta, 'a.txt · line 3 of 3 · 0.4 s');
  assert.equal(read({ id: ID, name: 'a.txt', unit: 'lines', start: 5000, end: 1200, total: 1200 }).meta, 'a.txt · nothing from 5,000 · 1,200 lines in all · 0.4 s');
  assert.equal(read({ id: ID, name: 'shot.png', mime: 'image/jpeg', width: 1600, height: 900 }).meta, 'shot.png · 1600 × 900 picture · 0.4 s');
  assert.equal(cardOf({ id: 'r2', server: 'jet', tool: 'files_read', input: { id: ID } }).line, 'Reading a file');
  const unreadable = read({ error: { message: 'no file with id' } }, { ok: false });
  assert.equal(unreadable.name, "Couldn't read the file");
  assert.equal(unreadable.advice, 'no file with id');
  const listed = cardOf({ id: 'l1', server: 'jet', tool: 'files_list', input: {}, ok: true, result: { files: [{ id: ID }, { id: ID }, { id: ID }] }, durationMs: 100 });
  assert.equal(listed.meta, '3 files · 0.1 s');
  assert.equal(listed.body, null);
  assert.equal(cardOf({ id: 'l2', server: 'jet', tool: 'files_list', input: {} }).line, 'Listing files');
});
