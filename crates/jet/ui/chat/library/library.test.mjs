import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentName, chatsWords, deleteAsk, factsWords, matches, splitName, usageWords } from './words.js';
import { readLibrary } from './store.js';

const titles = { 1: 'Main chat', 2: 'Kite budget', 3: 'Spars' };
const titleOf = (id) => titles[id] ?? 'A chat';
const page = { id: 'a', name: 'kite-summary.html', kind: 'html', bytes: 1024, context: 'One-page summary of the kite plan.', changedAt: 0, chats: [2, 1, 3] };

test('a row says what the file is, when it changed and which chats hold it, the keeper first', () => {
  assert.equal(factsWords(page, 2 * 3600 * 1000, titleOf), 'HTML page · 1 KB · 2 h ago · Kite budget and 2 more');
  assert.equal(chatsWords([1], titleOf), 'Main chat');
});

test('search finds a file by any part of its name, note, kind or chat titles, in any case', () => {
  for (const query of ['SUMMARY', 'kite plan', 'html page', 'spars', '  ']) assert.ok(matches(page, query, titleOf), query);
  assert.ok(!matches(page, 'budgt', titleOf));
});

test('the usage line turns to a warning at 90 % and to a refusal when full', () => {
  const mb = 1024 * 1024;
  assert.deepEqual(usageWords(41 * mb, 256 * mb), { words: '41 MB of 256 MB used', tone: 'quiet' });
  assert.equal(usageWords(236 * mb, 256 * mb).tone, 'warn');
  assert.match(usageWords(236 * mb, 256 * mb).words, /Delete files you no longer need to make room\.$/);
  assert.deepEqual(usageWords(256 * mb, 256 * mb), { words: 'No room left for files. Delete files to make room.', tone: 'bad' });
});

test('delete asks with its effect, and a rename keeps the kind', () => {
  assert.equal(deleteAsk(3), 'Delete from 3 chats?');
  assert.equal(deleteAsk(1), 'Delete for good?');
  assert.deepEqual(splitName('kite.summary.html'), { stem: 'kite.summary', extension: 'html' });
  assert.deepEqual(splitName('README'), { stem: 'README', extension: '' });
});

test('a zip is saved under the name the server gives it', () => {
  assert.equal(attachmentName('attachment; filename="Jet files 2026-11-25.zip"; filename*=UTF-8\'\'Jet%20files%202026-11-25.zip', 'x.zip'), 'Jet files 2026-11-25.zip');
  assert.equal(attachmentName(null, 'Jet files.zip'), 'Jet files.zip');
});

test('the library keeps only files it can show and link to', () => {
  const read = readLibrary({ files: [{ ...page, id: '6b1f0c3e-2f43-4f0e-9d4e-1e0b8f1d2a77', by: 'jet', details: '', version: 2, earlier: [1] }, { id: 'nope' }, 'nonsense'], usedBytes: 10, limitBytes: 100 });
  assert.equal(read.files.length, 1);
  assert.deepEqual([read.usedBytes, read.limitBytes], [10, 100]);
  assert.deepEqual(readLibrary({}).files, []);
});
