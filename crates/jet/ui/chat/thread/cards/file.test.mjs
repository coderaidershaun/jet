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

test('files_update: a made or changed file is a file card, the other changes are one line, a failure gives its reason', () => {
  const update = (command, result, rest = {}) => cardOf({ id: 'u1', server: 'jet', tool: 'files_update', input: { command }, ok: true, result, durationMs: 300, ...rest });
  const file = (extra = {}) => ({ id: ID.toUpperCase(), name: 'summary.html', kind: 'html', bytes: 3120, ...extra });

  const made = update({ action: 'create', name: 'summary.html' }, { change: 'created', file: file() });
  assert.equal(made.body.kind, 'file');
  assert.equal(made.body.meta, 'HTML page · 3 KB');
  assert.equal(update({ action: 'write' }, { change: 'written', file: file({ kind: 'markdown' }) }).body.meta, 'Markdown · 3 KB · changed');
  assert.equal(update({ action: 'restore' }, { change: 'restored', file: file() }).body.meta, 'HTML page · 3 KB · earlier version back');
  assert.equal(cardOf({ id: 'u2', server: 'jet', tool: 'files_update', input: { command: { action: 'create', name: 'summary.html' } } }).line, 'Making summary.html');

  const bad = update({ action: 'write' }, { change: 'written', file: file({ id: '../../settings' }) });
  assert.equal(bad.body, null);
  assert.equal(bad.state, 'failed');

  const words = (result) => {
    const card = update({}, result);
    assert.equal(card.body, null);
    return card.head.split(' · ')[0];
  };
  assert.equal(words({ change: 'described', file: file() }), 'Noted what summary.html is');
  assert.equal(words({ change: 'renamed', from: 'plan.md', file: file({ name: 'kite-plan.md' }) }), 'Renamed plan.md to kite-plan.md');
  assert.equal(words({ change: 'removed', file: { name: 'notes.txt' }, deleted: true }), 'Removed notes.txt');
  assert.equal(words({ change: 'removed', file: { name: 'notes.txt' }, deleted: false }), 'Took notes.txt out of this chat');
  assert.equal(update({ action: 'remove', chat: 3 }, { change: 'removed', file: { name: 'notes.txt' }, deleted: false }).head.split(' · ')[0], 'Took notes.txt out of another chat');
  assert.equal(words({ change: 'shared', file: file(), chat: { id: 3, title: 'Kite' } }), 'Shared summary.html with Kite');

  assert.equal(update({ action: 'remove' }, { error: { message: 'no such file' } }, { ok: false }).advice, 'no such file');
});
