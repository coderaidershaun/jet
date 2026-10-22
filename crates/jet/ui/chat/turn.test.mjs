import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurn } from './turn.js';
import { createThread } from './thread/store.js';
import { createComposer } from './composer/state.js';

async function setup(t, options = {}) {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const thread = createThread();
  const composer = createComposer({ empty: true });
  const page = { headerStatus: {}, announce: {} };
  let event;
  const requests = [];
  let stopped = 0;
  const noop = () => {};
  const live = { feel: () => ({ revealAt: 1000 }), measure: () => ({}), send: noop, mood: () => ({ revealAt: 1650 }), replying: noop, done: noop, failed: noop, stopped: noop };
  const turn = createTurn({
    agent: { feel: options.feel ?? (async () => ({ mood: 'neutral' })), send: (request, receive) => { requests.push(request); event = receive; return Promise.resolve({}); }, stop: () => { stopped++; return Promise.resolve(); }, renderMarkdown: async (text) => '<p>' + text + '</p>' },
    settings: { persona: { name: 'Jet' } }, thread, composer, page,
    view: { render: noop, liveLane: noop }, follow: { onSend: noop },
    composerView: { refresh: noop, setLayout: noop, setHeld: noop },
    live, drawer: { setUsage: noop, addLine: noop },
    tracker: { sent: noop, snapshot: noop, finished: noop, failed: noop, stopped: noop },
    afterReply: noop, onToolFinished: noop, takePreface: options.takePreface ?? (() => null), giveBackPreface: options.giveBackPreface ?? noop,
  });
  const advance = async (ms) => { now += ms; t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); };
  const entry = { id: 2, role: 'jet', text: 'Hello', html: '<p>Hello final</p>', status: 'complete', at: 0 };
  const sending = turn.send('hi');
  if (!options.pending) await sending;
  return { sending, live, turn, thread, page, advance, entry, requests, stops: () => stopped, captureEvent: () => event, event: (value) => event(value) };
}

test('a successful early terminal keeps final HTML and announcement behind the reveal deadline', async (t) => {
  const { thread, page, advance, entry, event } = await setup(t);
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'text', delta: 'Hello' });
  event({ kind: 'finished', entry });
  await advance(649);
  assert.equal(thread.slot.html, '');
  assert.equal(page.announce.textContent, 'Jet is replying');
  await advance(1);
  assert.equal(thread.replying, false);
  assert.equal(thread.rows().find((row) => row.entry?.role === 'jet').entry.html, entry.html);
  assert.equal(page.announce.textContent, entry.text);
});

test('Stop cancels a held successful terminal without waiting for a backend event', async (t) => {
  const { turn, thread, page, advance, entry, event } = await setup(t);
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'text', delta: 'Hello' });
  event({ kind: 'finished', entry });
  turn.stop();
  assert.equal(thread.replying, false);
  await advance(1000);
  assert.equal(page.announce.textContent, 'Jet is replying');
  const stopped = thread.rows().find((row) => row.entry?.role === 'jet').entry;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.text, 'Hello');
  assert.equal(stopped.html, '');
});

test('failure clears the reveal hold immediately', async (t) => {
  const { thread, page, advance, entry, event } = await setup(t);
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'finished', entry });
  event({ kind: 'failed', failure: { kind: 'io', message: 'offline' }, entry: { ...entry, html: '', status: 'failed' } });
  assert.equal(thread.replying, false);
  await advance(1000);
  assert.equal(page.announce.textContent, 'Jet is replying');
  assert.equal(thread.rows().find((row) => row.entry?.role === 'jet').entry.status, 'failed');
});

test('cancelling a held success does not stop the next held message', async (t) => {
  const { turn, thread, advance, entry, event, requests, stops } = await setup(t);
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'finished', entry });
  turn.hold('next message');
  turn.stop();
  await advance(0);
  assert.deepEqual(requests.map((request) => request.text), ['hi', 'next message']);
  assert.equal(thread.replying, true);
  assert.equal(stops(), 0, 'the completed backend needs no stop, which would target the next message');
});


test('classification starts with flight and dispatches its mood', async (t) => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const s = await setup(t, { pending: true, feel: () => pending });
  assert.equal(s.requests.length, 0);
  assert.equal(s.thread.replying, true);
  resolve({ mood: 'insulted' });
  await s.sending;
  assert.equal(s.requests[0].feeling, 'insulted');
  s.event({ kind: 'finished', entry: s.entry });
  await s.advance(0);
});

test('the 2200 ms cap dispatches neutral and ignores a late classification', async (t) => {
  let resolve;
  t.mock.method(console, 'warn', () => {});
  const s = await setup(t, { pending: true, feel: () => new Promise((done) => { resolve = done; }) });
  await s.advance(2199);
  assert.equal(s.requests.length, 0);
  await s.advance(1);
  await s.sending;
  assert.equal(s.requests[0].feeling, 'neutral');
  resolve({ mood: 'hello' });
  await s.advance(0);
  assert.equal(s.requests.length, 1);
});

test('classification failure falls back to neutral and warns once across turns', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const s = await setup(t, { feel: async () => { throw new Error('unavailable'); } });
  assert.equal(s.requests[0].feeling, 'neutral');
  s.event({ kind: 'finished', entry: s.entry });
  await s.advance(0);
  await s.turn.send('again');
  assert.equal(warnings.length, 1);
  assert.equal(s.requests[1].feeling, 'neutral');
});

test('stop before classification restores the preface, sends held text, and drops old results and events', async (t) => {
  const resolvers = [];
  const returned = [];
  let preface = 'engine news';
  const s = await setup(t, { pending: true,
    feel: () => new Promise((done) => resolvers.push(done)),
    takePreface: () => { const value = preface; preface = null; return value; },
    giveBackPreface: (value) => { returned.push(value); preface = value; },
  });
  s.turn.hold('next');
  s.turn.stop();
  assert.deepEqual(returned, ['engine news']);
  assert.equal(s.stops(), 0);
  resolvers[0]({ mood: 'insulted' });
  await s.sending;
  assert.equal(s.requests.length, 0);
  resolvers[1]({ mood: 'hello' });
  await s.advance(0);
  assert.equal(s.requests[0].text, 'next');
  assert.equal(s.requests[0].preface, 'engine news');
  const oldEvent = s.captureEvent();
  s.turn.stop();
  s.event({ kind: 'stopped', entry: s.entry });
  const third = s.turn.send('third');
  resolvers[2]({ mood: 'neutral' });
  await third;
  oldEvent({ kind: 'text', delta: 'stale' });
  assert.equal(s.thread.slot.text, '');
});


test('a different reply mood extends the feeling hold for an early successful terminal', async (t) => {
  let resolve;
  const s = await setup(t, { pending: true, feel: () => new Promise((done) => { resolve = done; }) });
  s.live.feel = () => ({ revealAt: 1700 });
  s.live.mood = () => ({ revealAt: 3400 });
  resolve({ mood: 'hello' });
  await s.sending;
  s.event({ kind: 'text', delta: 'Hello' });
  await s.advance(100);
  s.event({ kind: 'mood', mood: 'insulted' });
  s.event({ kind: 'finished', entry: s.entry });
  await s.advance(2299);
  assert.equal(s.thread.slot.html, '');
  await s.advance(1);
  assert.equal(s.thread.replying, false);
  assert.equal(s.page.announce.textContent, s.entry.text);
});
