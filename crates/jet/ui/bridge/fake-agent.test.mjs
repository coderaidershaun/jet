import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeAgent } from './fake-agent.js';
import { ADDED_HITS } from './fixtures/quanty-search.js';
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

const request = (text) => ({ text, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' }, localTime: 'Wed 14 Oct 2026, 09:00', claudePath: null, mcp: defaultSettings().mcp });

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

test('a reply emits started, mood, text and finished with usage, in order', async () => {
  const { agent, clock } = fastAgent();
  const first = await ask(agent, 'hello about Friday');

  assert.equal(first.user.role, 'user');
  assert.equal(first.user.html, '');
  assert.equal(first.user.text, 'hello about Friday');

  const events = first.events;
  assert.equal(events[0].kind, 'started');
  assert.equal(events[0].fresh, true, 'the first reply ever starts a session');
  assert.equal(typeof events[0].model, 'string');

  const moodAt = kinds(events).indexOf('mood');
  const firstText = kinds(events).indexOf('text');
  assert.ok(moodAt > 0 && moodAt < firstText, 'the mood comes before any text');
  assert.equal(events[moodAt].mood, 'hello');
  assert.equal(kinds(events).filter((kind) => TERMINAL.has(kind)).length, 1);
  assert.equal(events.at(-1).kind, 'finished');

  const text = events.filter((event) => event.kind === 'text').map((event) => event.delta).join('');
  assert.ok(text.length > 20);
  assert.ok(!text.includes('mood:'), 'the mood line is removed from the text');
  const finished = events.at(-1);
  assert.equal(finished.entry.role, 'jet');
  assert.equal(finished.entry.status, 'complete');
  assert.equal(finished.entry.mood, 'hello');
  assert.equal(finished.entry.text, text);
  assert.ok(finished.entry.html.startsWith('<p>'));
  assert.ok(finished.usage.cacheCreation1hTokens > 0 && finished.usage.cacheReadTokens === 0, 'a new session writes the cache');
  assert.ok(finished.costUsd > 0);
  assert.ok(finished.usage.outputTokens > 0);
  assert.equal(finished.usage.thinkingTokens, 0);
  assert.equal(finished.usage.model, 'claude-sonnet-5-5');
  assert.equal(finished.usage.model, events[0].model);

  clock.t += 5 * 60 * 1000;
  const second = await ask(agent, 'And what about Saturday?');
  assert.equal(second.events[0].fresh, false);
  assert.equal(second.events[0].sessionId, events[0].sessionId);
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
  const { events } = await ask(agent, 'what does quanty say about vega?', () => {}, {
    mcp: { quanty: { enabled: true }, polysim: { enabled: true } },
  });

  assert.deepEqual(events.find((event) => event.kind === 'started').mcp, [{ name: 'polysim', status: 'connected' }, { name: 'quanty', status: 'connected' }]);
  const order = ['started', 'toolStarted', 'toolFinished', 'text', 'finished'].map((kind) => kinds(events).indexOf(kind));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the search runs before the answer starts');
  assert.ok(!order.includes(-1));

  const started = events.find((event) => event.kind === 'toolStarted');
  assert.deepEqual(started, { kind: 'toolStarted', id: call.id, server: 'quanty', tool: 'search', input: call.input });
  const finished = events.find((event) => event.kind === 'toolFinished');
  assert.equal(finished.id, call.id);
  assert.equal(finished.ok, true);
  const structured = returned.tool_use_result.structuredContent;
  assert.deepEqual(finished.result, { ...structured, results: [...structured.results, ...ADDED_HITS] }, 'the recorded results come first, then the hits added by hand');
  assert.equal(finished.summary, 'quanty · search · 8 results');
  assert.equal(typeof finished.durationMs, 'number');

  const text = events.filter((event) => event.kind === 'text').map((event) => event.delta).join('');
  assert.equal(text, answer);
  const saved = events.at(-1).entry.tools;
  assert.deepEqual(saved, [{ id: call.id, server: 'quanty', tool: 'search', input: call.input, ok: true, result: finished.result, summary: finished.summary, durationMs: finished.durationMs }]);
  assert.deepEqual((await agent.history()).at(-1).tools, saved);
});

test('"fresh" starts a fresh session with a notice', async () => {
  const { agent } = fastAgent();
  const before = await ask(agent, 'Hi there');
  const after = await ask(agent, 'please start fresh');

  assert.equal(after.events[0].kind, 'started');
  assert.equal(after.events[0].fresh, true);
  assert.notEqual(after.events[0].sessionId, before.events[0].sessionId);
  assert.deepEqual(after.events[1], { kind: 'notice', message: "Started a fresh conversation so your changes apply. Jet's memory is kept." });
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

test('history, notes and context persist in the given storage', async () => {
  const storage = memoryStorage();
  const clock = { t: START };
  const make = () => createFakeAgent({ storage, now: () => clock.t, wait: () => Promise.resolve() });
  const agent = make();
  assert.equal((await agent.status()).context.usedTokens, null);
  await ask(agent, 'remember this');
  clock.t += 1000;

  const relaunched = make();
  const history = await relaunched.history();
  assert.deepEqual(history.map((entry) => entry.role), ['user', 'jet']);
  assert.ok(history[1].id > history[0].id, 'ids increase');
  const status = await relaunched.status();
  assert.equal(status.context.model, 'sonnet');
  assert.ok(status.context.usedTokens > 30000);
  assert.equal(status.context.limitTokens, null);
  assert.equal(status.context.estimated, true);
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
  assert.equal((await relaunched.status()).context.usedTokens, null);
});


test('feel waits 400 ms and classifies greetings insults and ordinary messages; replies follow it', async () => {
  const waits = [];
  let release;
  let blocked = true;
  const { agent } = fastAgent({ wait: (ms) => {
    waits.push(ms);
    if (blocked) return new Promise((resolve) => { release = resolve; });
    return Promise.resolve();
  } });
  let resolved = false;
  const first = agent.feel('hi').then((value) => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false, 'classification waits for its 400 ms pause');
  assert.equal(waits.at(-1), 400);
  blocked = false;
  release();
  assert.equal((await first).mood, 'hello');
  for (const [text, mood] of [['hi', 'hello'], ['you useless thing', 'insulted'], ['explain this', 'neutral']]) {
    const feeling = await agent.feel(text);
    assert.equal(waits.at(-1), 400);
    assert.equal(feeling.mood, mood);
    const { events } = await ask(agent, text, () => {}, { feeling: mood });
    assert.equal(events.find((event) => event.kind === 'mood').mood, mood);
  }
});
