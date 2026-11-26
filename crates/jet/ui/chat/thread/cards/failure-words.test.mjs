// Checks that the cards' patterns match a copy of the words quanty writes; when quanty rewords them, update the copy below by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';

// Copied word for word from quanty, read only: the health hint is HEALTH_HINT in
// quanty/crates/mcp/src/server/failure.rs, and a report line is formatted by the Display
// impl in quanty/crates/rag-ingestion/src/health.rs as "{name}: FAILED ({detail}): {error}".
const QUANTY_HEALTH_HINT = 'Call the `health` tool to see which service is not ready.';
const QUANTY_FAILED_LINE = 'qdrant: FAILED (vector store): connection refused';
const QUANTY_OK_LINE = 'postgres: ok (reachable)';

test('a failed quanty call shows the health hint in place of the sentence quanty adds', () => {
  const card = cardOf({ id: 'q1', server: 'quanty', tool: 'search', input: {}, ok: false, durationMs: 300, result: 'the store did not answer. ' + QUANTY_HEALTH_HINT });
  assert.equal(card.advice, 'the store did not answer.');
  assert.match(card.hint, /health check/);
});

test('a quanty health report shows a failed service as a red line', () => {
  const card = cardOf({ id: 'q2', server: 'quanty', tool: 'health', input: {}, ok: true, durationMs: 300, result: { report: QUANTY_OK_LINE + '\n' + QUANTY_FAILED_LINE } });
  assert.deepEqual(card.body.lines, [{ text: QUANTY_OK_LINE, ok: true }, { text: QUANTY_FAILED_LINE, ok: false }]);
  assert.equal(card.tone, 'invalid');
});
