import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLog } from './log.js';

test('the log keeps the last 500 lines, tags each by type, and pretty-prints JSON', () => {
  const log = createLog();
  for (let i = 0; i < 520; i++) log.add(JSON.stringify({ type: 'stream_event', index: i }));
  assert.equal(log.lines().length, 500);
  assert.equal(JSON.parse(log.lines()[0].raw).index, 20, 'the oldest 20 were dropped');

  log.clear();
  const init = log.add('{"type":"system","subtype":"init","session_id":"5b0c"}');
  const assistant = log.add('{"type":"assistant","message":{}}');
  const done = log.add('{"type":"result","is_error":false}');
  const broken = log.add('{"type":"result","is_error":true}');
  const odd = log.add('not json at all');
  assert.deepEqual([init, assistant, done, broken, odd].map((line) => line.type), ['system', 'assistant', 'result', 'result', 'other']);
  assert.deepEqual([done.tone, broken.tone, init.tone], ['ok', 'danger', null]);
  assert.equal(init.pretty, '{\n  "type": "system",\n  "subtype": "init",\n  "session_id": "5b0c"\n}');
  assert.equal(odd.pretty, 'not json at all');
  assert.equal(log.text(), [init, assistant, done, broken, odd].map((line) => line.raw).join('\n'));
});
