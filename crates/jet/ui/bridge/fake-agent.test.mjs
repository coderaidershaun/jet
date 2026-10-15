import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeAgent } from './fake-agent.js';
import { POLYSIM_ENGINES } from './fixtures/polysim-engines.js';
import { defaultSettings } from './settings.js';

const TERMINAL = new Set(['finished', 'failed', 'stopped']);
const START = new Date(2026, 9, 14, 9, 0).getTime();

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

function fastAgent(options = {}) {
  const clock = { t: START };
  const agent = createFakeAgent({ storage: memoryStorage(), now: () => clock.t, wait: () => Promise.resolve(), ...options });
  return { agent, clock };
}

const request = (text) => ({ text, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' }, behaviour: { candid: 0.55, playful: 0.35 }, localTime: 'Wed 14 Oct 2026, 09:00', claudePath: null, mcp: defaultSettings().mcp });

async function ask(agent, text, onEach = () => {}, extra = {}) {
  const events = [];
  let end;
  const ended = new Promise((resolve) => { end = resolve; });
  const user = await agent.send({ ...request(text), ...extra }, (event) => {
    events.push(event);
    onEach(event);
    if (TERMINAL.has(event.kind)) end();
  });
  await ended;
  return { user, events };
}

const kinds = (events) => events.map((event) => event.kind);

test('a reply emits raw lines, started, mood, text and finished with usage, in order', async () => {
  const { agent, clock } = fastAgent();
  const first = await ask(agent, 'I am so happy about Friday');

  assert.equal(first.user.role, 'user');
  assert.equal(first.user.html, '');
  assert.equal(first.user.text, 'I am so happy about Friday');

  const events = first.events;
  assert.equal(events[0].kind, 'rawLine');
  const init = JSON.parse(events[0].line);
  assert.equal(init.type, 'system');
  assert.equal(init.subtype, 'init');
  assert.equal(events[1].kind, 'started');
  assert.equal(events[1].sessionId, init.session_id);
  assert.equal(events[1].fresh, true, 'the first reply ever starts a session');
  assert.equal(typeof events[1].model, 'string');

  const moodAt = kinds(events).indexOf('mood');
  const firstText = kinds(events).indexOf('text');
  assert.ok(moodAt > 1 && moodAt < firstText, 'the mood comes before any text');
  assert.equal(events[moodAt].mood, 'happy');
  assert.equal(kinds(events).filter((kind) => TERMINAL.has(kind)).length, 1);
  assert.equal(events.at(-1).kind, 'finished');

  const text = events.filter((event) => event.kind === 'text').map((event) => event.delta).join('');
  assert.ok(text.length > 20);
  assert.ok(!text.includes('mood:'), 'the mood line is removed from the text');
  const lines = events.filter((event) => event.kind === 'rawLine').map((event) => JSON.parse(event.line));
  assert.deepEqual([...new Set(lines.map((line) => line.type))], ['system', 'stream_event', 'assistant', 'result']);
  const streamed = lines.filter((line) => line.event?.type === 'content_block_delta').map((line) => line.event.delta.text).join('');
  assert.equal(streamed, 'mood: happy\n' + text, 'the raw lines carry the mood line the text lost');
  assert.ok(kinds(events).lastIndexOf('rawLine') < events.length - 1, 'the result line comes before finished');

  const finished = events.at(-1);
  assert.equal(finished.entry.role, 'jet');
  assert.equal(finished.entry.status, 'complete');
  assert.equal(finished.entry.mood, 'happy');
  assert.equal(finished.entry.text, text);
  assert.ok(finished.entry.html.startsWith('<p>'));
  assert.ok(finished.usage.cacheCreation1hTokens > 0 && finished.usage.cacheReadTokens === 0, 'a new session writes the cache');
  assert.ok(finished.costUsd > 0);
  const result = lines.find((line) => line.type === 'result');
  assert.equal(result.is_error, false);
  assert.equal(result.usage.cache_creation.ephemeral_1h_input_tokens, finished.usage.cacheCreation1hTokens);
  assert.ok(finished.usage.outputTokens > 0);
  assert.equal(finished.usage.outputTokens, result.usage.output_tokens, 'the event and the raw line agree');
  assert.equal(finished.usage.thinkingTokens, 0);
  assert.equal(result.usage.output_tokens_details.thinking_tokens, 0);
  assert.equal(finished.usage.model, 'claude-sonnet-5-5');
  assert.equal(finished.usage.model, events[1].model);

  const starts = lines.filter((line) => line.event?.type === 'message_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].event.message.model, 'claude-sonnet-5-5');
  assert.ok(starts[0].event.message.usage.cache_creation_input_tokens > 0);
  assert.equal(starts[0].event.message.usage.cache_creation_input_tokens, result.usage.cache_creation_input_tokens);
  const firstDelta = lines.findIndex((line) => line.event?.type === 'content_block_delta');
  assert.ok(lines.indexOf(starts[0]) < firstDelta, 'message_start comes before the first text');
  const progress = lines.filter((line) => line.event?.type === 'message_delta');
  assert.ok(progress.length >= 1);
  const counts = progress.map((line) => line.event.usage.output_tokens);
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), 'output tokens never go down');
  assert.equal(counts.at(-1), result.usage.output_tokens);
  assert.equal(progress.at(-1).event.delta.stop_reason, 'end_turn');
  assert.equal(result.duration_api_ms, finished.durationMs);
  assert.equal(typeof result.ttft_ms, 'number');
  assert.equal(result.num_turns, 1);
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(Object.keys(result.modelUsage), [finished.usage.model]);

  clock.t += 5 * 60 * 1000;
  const second = await ask(agent, 'And what about Saturday?');
  assert.equal(second.events[1].fresh, false);
  assert.equal(second.events[1].sessionId, init.session_id);
  const usage = second.events.at(-1).usage;
  assert.ok(usage.cacheReadTokens > 30000, 'a warm session reads the cache');
  assert.equal(usage.cacheCreation1hTokens, usage.cacheCreationTokens);
  assert.ok(usage.cacheCreationTokens < usage.cacheReadTokens);
});

test('"quanty" replays a library search as tool events before the answer', async () => {
  const recorded = readFileSync(new URL('../../../agent/tests/fixtures/quanty-search-reply.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const call = recorded.flatMap((line) => (line.type === 'assistant' ? line.message.content : [])).find((block) => block.name === 'mcp__quanty__search');
  const returned = recorded.find((line) => line.type === 'user' && line.message.content[0].tool_use_id === call.id);
  const answer = recorded.at(-1).result.split('\n').slice(1).join('\n');

  const { agent } = fastAgent();
  const { events } = await ask(agent, 'what does quanty say about vega?');

  assert.deepEqual(events.find((event) => event.kind === 'started').mcp, [{ name: 'polysim', status: 'connected' }, { name: 'quanty', status: 'connected' }]);
  const order = ['started', 'toolStarted', 'toolFinished', 'text', 'finished'].map((kind) => kinds(events).indexOf(kind));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the search runs before the answer starts');
  assert.ok(!order.includes(-1));

  const started = events.find((event) => event.kind === 'toolStarted');
  assert.deepEqual(started, { kind: 'toolStarted', id: call.id, server: 'quanty', tool: 'search', input: call.input });
  const finished = events.find((event) => event.kind === 'toolFinished');
  assert.equal(finished.id, call.id);
  assert.equal(finished.ok, true);
  assert.deepEqual(finished.result, returned.tool_use_result.structuredContent);
  assert.equal(finished.summary, 'quanty · search · 5 results');
  assert.equal(typeof finished.durationMs, 'number');

  const raw = events.filter((event) => event.kind === 'rawLine').map((event) => JSON.parse(event.line));
  assert.equal(raw.filter((line) => line.type === 'assistant' && line.message.content.some((block) => block.type === 'tool_use')).length, 1);
  assert.equal(raw.filter((line) => line.type === 'user' && line.message.content.some((block) => block.type === 'tool_result')).length, 1);

  const text = events.filter((event) => event.kind === 'text').map((event) => event.delta).join('');
  assert.equal(text, answer);
  const saved = events.at(-1).entry.tools;
  assert.deepEqual(saved, [{ id: call.id, server: 'quanty', tool: 'search', input: call.input, ok: true, result: finished.result, summary: finished.summary, durationMs: finished.durationMs }]);
  assert.deepEqual((await agent.history()).at(-1).tools, saved);
});

test('the engines word lists the pretend fleet and mcpCall changes it', async () => {
  const { agent } = fastAgent();
  const first = await ask(agent, 'show me my engines');
  const listed = first.events.find((event) => event.kind === 'toolFinished');
  assert.deepEqual(first.events.find((event) => event.kind === 'toolStarted'), { kind: 'toolStarted', id: listed.id, server: 'polysim', tool: 'list_strategies', input: {} });
  assert.deepEqual([listed.ok, listed.result, listed.summary], [true, POLYSIM_ENGINES.result, 'polysim · list_strategies · 4 engines']);
  assert.deepEqual(first.events.at(-1).entry.tools.map((call) => call.id), [listed.id], 'the call is saved with the reply');
  const raw = first.events.filter((event) => event.kind === 'rawLine').map((event) => JSON.parse(event.line));
  assert.ok(raw.some((line) => line.type === 'assistant' && line.message.content.some((block) => block.name === 'mcp__polysim__list_strategies')));

  const fleet = async () => (await agent.mcpCall('polysim', 'list_strategies', {})).engines;
  const stateOf = async (teId) => (await fleet()).find((engine) => engine.te_id === teId);
  const off = { strategy_id: 'strat-micro-recorder', te_id: 'te-polymarket-btc-updown-5m' };
  const started = await agent.mcpCall('polysim', 'start_strategy', off);
  assert.equal(started.mode, 'off');
  assert.deepEqual([(await stateOf(off.te_id)).state, (await stateOf(off.te_id)).pid], ['running', started.pid]);
  await assert.rejects(agent.mcpCall('polysim', 'start_strategy', off), { kind: 'library', message: 'strat-micro-recorder · te-polymarket-btc-updown-5m is already running' });
  await assert.rejects(agent.mcpCall('polysim', 'set_execution_mode', { ...off, mode: 'sim' }), { kind: 'library', message: 'Stop strat-micro-recorder · te-polymarket-btc-updown-5m before changing its mode.' });
  await agent.mcpCall('polysim', 'stop_strategy', off);
  assert.deepEqual([(await stateOf(off.te_id)).state, (await stateOf(off.te_id)).pid], ['stopped', null]);
  await assert.rejects(agent.mcpCall('polysim', 'stop_strategy', off), { kind: 'library', message: 'strat-micro-recorder · te-polymarket-btc-updown-5m is not running' });
  const changed = await agent.mcpCall('polysim', 'set_execution_mode', { ...off, mode: 'sim' });
  assert.deepEqual([changed.previous, changed.mode, (await stateOf(off.te_id)).mode], ['off', 'sim', 'sim']);
  await assert.rejects(agent.mcpCall('polysim', 'set_execution_mode', { ...off, mode: 'paper' }), { kind: 'library' });
  await assert.rejects(agent.mcpCall('quanty', 'search', {}), { kind: 'library' });
  await assert.rejects(agent.mcpCall('polysim', 'start_strategy', { strategy_id: 'nobody', te_id: 'nowhere' }), { kind: 'library' });

  // The next listing shows the fleet as changed, under a new call id, and a preface is quoted back.
  const preface = '[Jet: the user started strat-micro-recorder · te-polymarket-btc-updown-5m at 22:41]';
  const second = await ask(agent, 'engines again', () => {}, { preface });
  const again = second.events.find((event) => event.kind === 'toolFinished');
  assert.notEqual(again.id, listed.id);
  assert.equal(again.result.engines.find((engine) => engine.te_id === off.te_id).mode, 'sim');
  assert.ok(second.events.at(-1).entry.text.startsWith('Noted: ' + preface + '\n\n'));
  assert.equal(second.user.text, 'engines again', 'the saved user words carry no preface');
});

test('"fresh" starts a fresh session with a notice', async () => {
  const { agent } = fastAgent();
  const before = await ask(agent, 'Hi there');
  const after = await ask(agent, 'please start fresh');

  assert.equal(after.events[1].kind, 'started');
  assert.equal(after.events[1].fresh, true);
  assert.notEqual(after.events[1].sessionId, before.events[1].sessionId);
  assert.deepEqual(after.events[2], { kind: 'notice', message: "Started a fresh conversation so your changes apply. Jet's memory is kept." });
  assert.equal(kinds(before.events).includes('notice'), false, 'a reply that does not ask for it has no notice');
});

test('the three failures end with failed and their kind', async () => {
  const { agent } = fastAgent();
  const expected = { 'there is an error': 'claudeFailed', 'it is missing': 'claudeMissing', 'a timeout please': 'timeout' };
  for (const [text, kind] of Object.entries(expected)) {
    const { events } = await ask(agent, text);
    const last = events.at(-1);
    assert.equal(last.kind, 'failed', text);
    assert.equal(last.failure.kind, kind);
    assert.equal(kinds(events).filter((k) => TERMINAL.has(k)).length, 1);
    assert.equal(last.entry.status, 'failed');
    assert.equal(last.entry.error, last.failure.message, 'the entry keeps the message for the restored thread');
  }
  const failed = (await ask(agent, 'error')).events.at(-1).failure.message;
  assert.match(failed, /log ?in/i, 'the Claude-side message mentions logging in');
  assert.match((await ask(agent, 'missing')).events.at(-1).failure.message, /^Claude Code was not found; looked in /);
  assert.equal((await ask(agent, 'timeout')).events.at(-1).failure.message, 'Claude stopped responding after 2 minutes.');
});

test('stop ends the reply with stopped and the partial text', async () => {
  const { agent } = fastAgent();
  const { events } = await ask(agent, 'please show me some code', (event) => {
    if (event.kind === 'text') agent.stop();
  });
  const last = events.at(-1);
  assert.equal(last.kind, 'stopped');
  assert.equal(kinds(events).includes('finished'), false);
  assert.equal(last.entry.status, 'stopped');
  const streamed = events.filter((event) => event.kind === 'text').map((event) => event.delta).join('');
  assert.equal(last.entry.text, streamed);
  assert.ok(streamed.length > 0);

  const full = (await ask(fastAgent().agent, 'please show me some code')).events.at(-1).entry.text;
  assert.ok(streamed.length < full.length, 'only part of the reply arrived');
});

test('history, notes and the cache status persist in the given storage', async () => {
  const storage = memoryStorage();
  const clock = { t: START };
  const make = () => createFakeAgent({ storage, now: () => clock.t, wait: () => Promise.resolve() });
  const agent = make();
  assert.equal((await agent.status()).cache.lastRequestAt, null);
  await ask(agent, 'remember this');
  clock.t += 1000;

  const relaunched = make();
  const history = await relaunched.history();
  assert.deepEqual(history.map((entry) => entry.role), ['user', 'jet']);
  assert.ok(history[1].id > history[0].id, 'ids increase');
  const status = await relaunched.status();
  assert.equal(status.cache.lastRequestAt, START, 'the last request is when the reply started');
  assert.equal(status.cache.ttlMinutes, 60);
  assert.ok(status.cache.contextTokens > 30000);
  assert.equal(status.busy, false);
  assert.deepEqual(status.claude.found, true);

  const empty = await relaunched.loadMemory();
  assert.deepEqual(empty, { memory: '', user: '', recent: '', limits: { memory: 2200, user: 1375, recent: 1500 } });
  await relaunched.saveMemory({ memory: 'a', user: 'b', recent: 'c' });
  assert.equal((await make().loadMemory()).user, 'b');

  clock.t += 2 * 60 * 60 * 1000;
  const cold = await ask(relaunched, 'back after a long while');
  assert.equal(cold.events.at(-1).usage.cacheReadTokens, 0, 'an expired cache is written again');
  assert.ok(cold.events.at(-1).usage.cacheCreation1hTokens > 30000);

  let busy = null;
  const running = await ask(relaunched, 'another one', (event) => {
    if (event.kind === 'started') relaunched.forget().catch((error) => { busy = error; });
  });
  assert.ok(running);
  assert.equal(busy.kind, 'busy');

  await relaunched.forget();
  assert.deepEqual(await relaunched.history(), []);
  assert.equal((await relaunched.loadMemory()).user, 'b', 'forgetting keeps the notes');
  assert.equal((await relaunched.status()).cache.lastRequestAt, null);
});
