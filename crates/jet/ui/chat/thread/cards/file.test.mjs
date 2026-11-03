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

  const running = cardOf(call(undefined, { ok: undefined }));
  assert.equal(running.state, 'running');
  assert.equal(running.body ?? null, null, 'a file being written has no link yet');

  for (const id of ['../../settings', 'https://evil.example/x.pdf', ID + '/../..', '']) {
    const bad = cardOf(call({ id, name: 'x.pdf', title: 'x', format: 'pdf', bytes: 1 }));
    assert.equal(bad.state, 'failed', id);
    assert.equal(bad.body, null, id);
  }

  const failed = cardOf(call({ error: { message: 'could not make the PDF: boom' } }, { ok: false }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.advice, 'could not make the PDF: boom', 'a failure shows the reason it was given');

  // Reading and listing attached files are one-line cards with no body.
  const read = (result, rest = {}) => cardOf({ id: 'r1', server: 'jet', tool: 'files_read', input: { id: ID }, ok: true, result, durationMs: 400, ...rest });
  const pages = read({ type: 'text', id: ID, name: 'Q3 report.pdf', unit: 'pages', start: 1, end: 20, total: 48, more: true, sheets: [] });
  assert.equal(pages.state, 'done');
  assert.equal(pages.body, null);
  const unreadable = read({ error: { message: 'no file with id' } }, { ok: false });
  assert.equal(unreadable.advice, 'no file with id');
  const listed = cardOf({ id: 'l1', server: 'jet', tool: 'files_list', input: {}, ok: true, result: { files: [{ id: ID }, { id: ID }, { id: ID }] }, durationMs: 100 });
  assert.equal(listed.body, null);
});
