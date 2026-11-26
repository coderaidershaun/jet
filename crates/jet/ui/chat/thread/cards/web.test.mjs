// Tests that a web card names the page or search and says when a read is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';

// The server's own words, which start with a fixed mark; the page matches the mark and never the prose.
const REFUSAL = 'PreToolUse:WebFetch hook error: [page-not-linked] Jet reads pages only on sites whose link the user wrote in this chat or that an objective of this chat names. The user can paste the link to this page here, so ask them to.';
const web = (tool, input, rest) => cardOf({ id: 'w1', server: 'web', tool, input, durationMs: 300, ...rest });

test('a web card names the page or the search, and a refused read says so', () => {
  const url = 'https://github.com/anthropics/claude-code';
  assert.equal(web('fetch', { url }, {}).line, 'Reading ' + url);
  const read = web('fetch', { url }, { ok: true, result: 'Claude Code is an agentic coding tool.' });
  assert.equal(read.head, 'Page · ' + url + ' · done');

  const refused = web('fetch', { url: 'https://docs.python.org/3/library/json.html' }, { ok: false, result: REFUSAL });
  assert.equal(refused.head, 'Page · https://docs.python.org/3/library/json.html · refused');
  assert.equal(refused.tone, 'invalid');
  assert.match(refused.advice, /Paste the link/);

  const searched = web('search', { query: 'claude code docs' }, { ok: true, result: 'Search results for claude code docs' });
  assert.equal(searched.head, 'Web search · “claude code docs” · done');
});
