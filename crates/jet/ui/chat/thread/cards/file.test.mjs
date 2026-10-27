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
});
