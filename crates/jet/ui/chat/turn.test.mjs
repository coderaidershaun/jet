import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurn } from './turn.js';
import { createThread } from './thread/store.js';
import { createComposer } from './composer/state.js';

function setup(t) {
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
  const live = { measure: () => ({}), send: noop, mood: () => ({ revealAt: 1650 }), replying: noop, done: noop, failed: noop, stopped: noop };
  const turn = createTurn({
    agent: { send: (request, receive) => { requests.push(request.text); event = receive; return Promise.resolve({}); }, stop: () => { stopped++; return Promise.resolve(); }, renderMarkdown: async (text) => '<p>' + text + '</p>' },
    settings: { persona: { name: 'Jet' } }, thread, composer, page,
    view: { render: noop, liveLane: noop }, follow: { onSend: noop },
    composerView: { refresh: noop, setLayout: noop, setHeld: noop },
    live, drawer: { setUsage: noop, addLine: noop },
    tracker: { sent: noop, snapshot: noop, finished: noop, failed: noop, stopped: noop },
    afterReply: noop, onToolFinished: noop, takePreface: () => null, giveBackPreface: noop,
  });
  const advance = async (ms) => { now += ms; t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); };
  const entry = { id: 2, role: 'jet', text: 'Hello', html: '<p>Hello final</p>', status: 'complete', at: 0 };
  turn.send('hi');
  return { turn, thread, page, advance, entry, requests, stops: () => stopped, event: (value) => event(value) };
}

test('a successful early terminal keeps final HTML and announcement behind the reveal deadline', async (t) => {
  const { thread, page, advance, entry, event } = setup(t);
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
  const { turn, thread, page, advance, entry, event } = setup(t);
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
  const { thread, page, advance, entry, event } = setup(t);
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'finished', entry });
  event({ kind: 'failed', failure: { kind: 'io', message: 'offline' }, entry: { ...entry, html: '', status: 'failed' } });
  assert.equal(thread.replying, false);
  await advance(1000);
  assert.equal(page.announce.textContent, 'Jet is replying');
  assert.equal(thread.rows().find((row) => row.entry?.role === 'jet').entry.status, 'failed');
});

test('cancelling a held success does not stop the next held message', async (t) => {
  const { turn, thread, advance, entry, event, requests, stops } = setup(t);
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'finished', entry });
  turn.hold('next message');
  turn.stop();
  await advance(0);
  assert.deepEqual(requests, ['hi', 'next message']);
  assert.equal(thread.replying, true);
  assert.equal(stops(), 0, 'the completed backend needs no stop, which would target the next message');
});
