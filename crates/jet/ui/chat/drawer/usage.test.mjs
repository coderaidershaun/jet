import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUsageTracker, tokenCount } from './usage.js';

const fixture = readFileSync(new URL('../../../../agent/tests/fixtures/sonnet-mood-reply.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line));
const kind = (line) => line.type === 'stream_event' ? line.event.type : line.type;
const lineOf = (name) => fixture.find((line) => kind(line) === name);

const finishedEvent = (extra = {}) => ({
  kind: 'finished',
  costUsd: 0.007334,
  usage: { inputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 1575, cacheCreation1hTokens: 1575, ...extra },
});

test('the recorded sonnet turn: live counts, then the reported cost and timings, then the totals', () => {
  const tracker = createUsageTracker();
  assert.equal(tracker.snapshot().current.status, 'idle');

  tracker.sent({ effort: 'medium', at: 1000 });
  for (const line of fixture) {
    tracker.raw(line);
    const { current } = tracker.snapshot();
    if (line === lineOf('message_start')) {
      assert.equal(current.status, 'streaming');
      assert.equal(current.effort, 'medium');
      assert.equal(current.startedAt, 1000);
      assert.equal(current.inputTokens, 2);
      assert.equal(current.cacheReadTokens, 0);
      assert.equal(current.cacheWrite5mTokens, 0);
      assert.equal(current.cacheWrite1hTokens, 1575);
      assert.equal(current.model, 'claude-sonnet-5-5');
      assert.notEqual(current.estimateUsd, null);
      assert.equal(current.reportedUsd, null);
    }
    if (line === lineOf('message_delta')) {
      assert.equal(current.outputTokens, 103);
      assert.equal(current.stopReason, 'end_turn');
      assert.ok(Math.abs(current.estimateUsd - 0.007334) < 1e-6);
    }
  }

  const { current } = tracker.snapshot();
  assert.equal(current.reportedUsd, 0.007334);
  assert.equal(current.durationMs, 2186);
  assert.equal(current.apiMs, 2139);
  assert.equal(current.ttftMs, 2168);
  assert.equal(current.numTurns, 1);
  assert.equal(current.stopReason, 'end_turn');
  assert.equal(current.sessionId, 'e7a911c5-f23e-4621-ae6b-9edca823abc7');
  assert.equal(current.model, 'claude-sonnet-5-5');
  assert.equal(current.status, 'streaming', 'the reply is over only when the agent says so');

  tracker.finished(finishedEvent());
  const { total, byModelEffort } = tracker.snapshot();
  assert.equal(tracker.snapshot().current.status, 'done');
  assert.equal(total.replies, 1);
  assert.equal(total.usd, 0.007334);
  assert.equal(total.cacheWriteTokens, 1575);
  assert.equal(tokenCount(total), 2 + 1575 + 103);
  assert.deepEqual(byModelEffort, [{
    model: 'claude-sonnet-5-5', effort: 'medium', replies: 1,
    inputTokens: 2, outputTokens: 103, cacheReadTokens: 0, cacheWriteTokens: 1575, usd: 0.007334,
  }]);

  tracker.finished(finishedEvent());
  tracker.failed();
  assert.equal(tracker.snapshot().total.replies, 1, 'a reply closes once');
  assert.equal(tracker.snapshot().current.status, 'done');
});

test('a second reply at another thinking level gets its own breakdown row', () => {
  const tracker = createUsageTracker();
  tracker.sent({ effort: 'medium', at: 2000 });
  for (const line of fixture) tracker.raw(line);
  tracker.finished(finishedEvent());

  tracker.sent({ effort: 'xhigh', at: 3000 });
  const fresh = tracker.snapshot().current;
  assert.equal(fresh.inputTokens, 0);
  assert.equal(fresh.reportedUsd, null);
  assert.equal(fresh.stopReason, null);
  assert.equal(fresh.model, 'claude-sonnet-5-5', 'the model carries over until the stream names one');
  assert.equal(fresh.sessionId, 'e7a911c5-f23e-4621-ae6b-9edca823abc7');

  for (const line of fixture) tracker.raw(line);
  tracker.finished(finishedEvent({ outputTokens: 250, thinkingTokens: 120, model: 'claude-opus-5-5' }));

  const { current, total, byModelEffort } = tracker.snapshot();
  assert.equal(current.outputTokens, 250, 'the finished event wins over the stream count');
  assert.equal(current.thinkingTokens, 120);
  assert.equal(current.model, 'claude-opus-5-5');
  assert.equal(total.replies, 2);
  assert.equal(total.thinkingTokens, 120);
  assert.deepEqual(byModelEffort.map((row) => [row.model, row.effort, row.replies]), [
    ['claude-sonnet-5-5', 'medium', 1],
    ['claude-opus-5-5', 'xhigh', 1],
  ]);
  assert.ok(Math.abs(total.usd - 0.014668) < 1e-9, 'each reply adds the cost Claude Code reported');
});

test('a stopped reply keeps its tokens in the totals with no reported cost', () => {
  const tracker = createUsageTracker();
  tracker.sent({ effort: 'medium', at: 1000 });
  for (const line of fixture.filter((line) => kind(line) === 'system' || kind(line) === 'message_start' || kind(line) === 'message_delta')) tracker.raw(line);

  tracker.stopped();

  const { current, total, byModelEffort } = tracker.snapshot();
  assert.equal(current.status, 'stopped');
  assert.equal(current.reportedUsd, null);
  assert.equal(total.replies, 1);
  assert.equal(tokenCount(total), 2 + 1575 + 103);
  assert.ok(Math.abs(total.usd - 0.007334) < 1e-6, 'the list-price estimate stands in for the missing report');
  assert.equal(byModelEffort.length, 1);

  tracker.sent({ effort: 'medium', at: 2000 });
  tracker.failed();
  assert.equal(tracker.snapshot().total.replies, 1, 'a reply that never reached the model is not counted');
  assert.equal(tracker.snapshot().current.status, 'failed');
});

test('lines that are not JSON values or carry no usage change nothing', () => {
  const tracker = createUsageTracker();
  tracker.sent({ effort: 'medium', at: 1000 });
  for (const line of fixture.slice(0, 3)) tracker.raw(line);
  const before = tracker.snapshot();

  const strays = [
    null, undefined, 42, 'not json', [], {},
    { type: 'rate_limit_event', rate_limit_info: {} },
    { type: 'system', subtype: 'status', status: 'requesting' },
    { type: 'assistant', message: { usage: { input_tokens: 99, output_tokens: 99 } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hi' } } },
    { type: 'stream_event', event: null },
    { type: 'stream_event' },
    { type: 'result', total_cost_usd: '0.5', session_id: 42 },
  ];
  for (const stray of strays) tracker.raw(stray);

  assert.deepEqual(tracker.snapshot(), before);

  tracker.finished(finishedEvent());
  const closed = tracker.snapshot();
  tracker.raw(lineOf('result'));
  assert.deepEqual(tracker.snapshot(), closed, 'lines after the reply ended are ignored');
});

test('Codex usage retains unknown dollars and does not count cached tokens twice', () => {
  const tracker = createUsageTracker();
  tracker.sent({ effort: 'medium', at: 0 });
  tracker.started({ sessionId: 'codex-session', model: 'gpt-6.1-sol' });
  tracker.raw({ type: 'result', usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 12 } });
  tracker.finished({ costUsd: 0, usage: { model: 'gpt-6.1-sol', outputTokens: 12 } });
  const snap = tracker.snapshot();
  assert.equal(tokenCount(snap.total), 112);
  assert.equal(snap.total.usd, null);
  assert.equal(snap.current.reportedUsd, null);
  assert.equal(snap.byModelEffort[0].usd, null);
});
