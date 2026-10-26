import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUANTY_SEARCH } from './quanty-search.js';
import { findSource, splitCitations } from './cite.js';

const finished = (id, tool, result, rest = {}) => ({ id, server: 'quanty', tool, input: {}, ok: true, result, durationMs: 500, ...rest });
const item = (number, document, page) => ({ number, document, document_id: 'd' + number, page, printed_page: String(page * 10), kind: 'chunk', text: 'Text ' + number });

test("[n] in Jet's text links to the nearest earlier card that holds source n", () => {
  assert.deepEqual(splitCitations('Vega is positive [1], and peaks at the money [2][3].'), ['Vega is positive ', 1, ', and peaks at the money ', 2, 3, '.']);
  assert.deepEqual(splitCitations('[7]'), [7]);
  assert.deepEqual(splitCitations('no citations here'), ['no citations here']);
  assert.deepEqual(splitCitations('a [0] b [x] c [1234] d [12]'), ['a [0] b [x] c [1234] d ', 12], 'only one to three digits count, and 0 is not a citation');

  const first = finished('c1', 'search', QUANTY_SEARCH.result);
  const second = finished('c2', 'search', { results: [item(1, 'Newer book, chapter 2', 4), item(2, 'Newer book, chapter 3', 5)] });
  const pieces = finished('c3', 'read_page', { page: 1, pages: 2, pieces: [{ number: 1, kind: 'text', section: [], content: 'x' }, { number: 4, kind: 'text', section: [], content: 'y' }] });
  const answer = finished('c4', 'answer', { answered: true, claims: [], sources: [item(2, 'Answer book, chapter 1', 7)] });

  const registered = { ...second, server: 'b5e97310-4825-4b89-ace2-e330a4ed8509' };
  assert.equal(findSource([first, registered], 1).callId, 'c2', 'registered app IDs retain citations');
  const found = findSource([first, second], 1);
  assert.equal(found.callId, 'c2', 'the nearest card above wins');
  assert.equal(found.item.document, 'Newer book, chapter 2');
  assert.equal(found.title, 'Newer book, chapter 2 · p.40');
  assert.equal(findSource([first, second], 5).callId, 'c1', 'a source the newer card lacks is found in the older one');
  assert.equal(findSource([first, second], 5).title, 'Option Volatility & Pricing, chapter 7: Risk Measurement I · p.116');
  assert.equal(findSource([first, second, pieces], 4).callId, 'c1', 'the numbers of a page\'s pieces are not source numbers');
  assert.equal(findSource([first, second, answer], 2).callId, 'c4', 'the sources of an answer count');
  assert.equal(findSource([first, second], 6), null, 'no card holds source 6');
  assert.equal(findSource([], 1), null);

  const running = { id: 'c5', server: 'quanty', tool: 'search', input: {} };
  const failed = finished('c6', 'search', 'could not connect', { ok: false });
  const stopped = finished('c7', 'search', { results: [item(1, 'Never finished', 1)] }, { unfinished: true });
  const polysim = { ...finished('c8', 'list_strategies', { results: [item(1, 'Not a library', 1)] }), server: 'polysim' };
  assert.equal(findSource([first, running, failed, stopped, polysim], 1).callId, 'c1', 'only a finished library search or answer holds sources');
  assert.equal(findSource([finished('c9', 'search', { results: 'none' })], 1), null, 'a result of the wrong shape holds nothing');
});
