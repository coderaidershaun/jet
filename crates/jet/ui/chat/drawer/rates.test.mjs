import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsd, modelLabel, rateFor } from './rates.js';

const none = { inputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0 };

test('the recorded sonnet turn costs 0.007334 at list price', () => {
  const turn = { ...none, inputTokens: 2, cacheWrite1hTokens: 1575, outputTokens: 103 };

  assert.ok(Math.abs(estimateUsd('claude-sonnet-5-5', turn) - 0.007334) < 1e-6);
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Sonnet 5.5');
});

test('Haiku 5.5 moves to its long-prompt prices at 100 000 prompt tokens', () => {
  const haiku = 'claude-haiku-5-5';

  assert.equal(rateFor(haiku, 99999).input, 0.1);
  assert.equal(rateFor(haiku, 100000).input, 0.5);
  const justBelow = estimateUsd(haiku, { ...none, inputTokens: 40000, cacheReadTokens: 59999, outputTokens: 1000000 });
  const atEdge = estimateUsd(haiku, { ...none, inputTokens: 40000, cacheReadTokens: 30000, cacheWrite5mTokens: 20000, cacheWrite1hTokens: 10000, outputTokens: 1000000 });
  assert.ok(Math.abs(justBelow - (40000 * 0.1 + 59999 * 0.01 + 0.5e6) / 1e6) < 1e-9);
  assert.ok(Math.abs(atEdge - (40000 * 0.5 + 30000 * 0.05 + 20000 * 0.625 + 10000 * 1 + 2.5e6) / 1e6) < 1e-9, 'both cache writes count toward the prompt');
});

test('a model with no published price has no rate and no estimate', () => {
  assert.equal(rateFor('claude-sonnet-4-0', 10), null);
  assert.equal(estimateUsd('claude-sonnet-4-0', { ...none, outputTokens: 5 }), null);
  assert.equal(modelLabel('claude-sonnet-4-0'), 'claude-sonnet-4-0');
});
