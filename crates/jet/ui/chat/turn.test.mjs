// Tests of the chat turn: a message's flight, its feeling wait, reactions, holds and restores.
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
  const page = { announce: {} };
  let event;
  const requests = [];
  const reacts = [];
  let stopped = 0;
  const noop = () => {};
  let relaunched = 0;
  let settled = 0;
  const chips = [];
  const live = { feel: () => ({ revealAt: 1000 }), measure: () => ({}), send: noop, mood: () => ({ revealAt: 1650 }), replying: noop, done: () => { settled++; }, failed: noop, stopped: noop, showInLane: () => { relaunched++; } };
  const turn = createTurn({
    agent: { serverEvents: options.serverEvents, chatId: () => 7, feel: options.feel ?? (async () => ({ mood: 'neutral' })), send: (request, receive) => { requests.push(request); event = receive; return Promise.resolve({}); }, react: (request) => { reacts.push(request); return Promise.resolve({}); }, stop: () => { stopped++; return Promise.resolve(); }, renderMarkdown: async (text) => '<p>' + text + '</p>' },
    settings: { persona: { name: 'Jet' } }, thread, composer, page,
    view: { render: noop, liveLane: noop }, follow: { onSend: noop },
    composerView: { refresh: noop, setLayout: noop, setHeld: (held) => { chips.push(held); } },
    live,
    afterReply: noop, activeAppId: options.activeAppId, voice: options.voice,
  });
  const advance = async (ms) => { now += ms; t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); };
  const entry = { id: 2, role: 'jet', text: 'Hello', html: '<p>Hello final</p>', status: 'complete', at: 0 };
  const sending = turn.send('hi');
  if (!options.pending) await sending;
  return { sending, live, turn, thread, composer, page, advance, entry, requests, reacts, chips, settled: () => settled, stops: () => stopped, relaunched: () => relaunched, captureEvent: () => event, event: (value) => event(value) };
}

test("the page that sent a message keeps Jet's flight on its own accepted event, and restores on another page's", async (t) => {
  const { turn, thread, requests, relaunched } = await setup(t, { serverEvents: true });
  const requestId = requests[0].requestId;
  const snapshot = { history: [], active: null };
  turn.observe({ turn: { requestId, turnId: 'turn-1' }, event: { kind: 'accepted', snapshot } });
  assert.equal(relaunched(), 0, 'its own send does not put Jet back in the lane');
  assert.equal(thread.replying, true);
  turn.observe({ turn: { requestId, turnId: 'turn-1' }, event: { kind: 'text', delta: 'Hi' } });
  assert.equal(thread.slot.text, 'Hi', 'the reply reaches the slot by the turn id the accepted event gave');
  turn.observe({ turn: { requestId: 'elsewhere', turnId: 'turn-2' }, event: { kind: 'accepted', snapshot } });
  assert.equal(thread.replying, false, "another page's turn replaces this one");
});

test('Stop and a failure both end a held successful terminal at once, without a backend event', async (t) => {
  const { turn, thread, page, advance, entry, event } = await setup(t);
  const lastJet = () => thread.rows().filter((row) => row.entry?.role === 'jet').at(-1).entry;
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'text', delta: 'Hello' });
  event({ kind: 'finished', entry });
  turn.stop();
  assert.equal(thread.replying, false);
  await advance(1000);
  assert.equal(page.announce.textContent, 'Jet is replying');
  assert.deepEqual([lastJet().status, lastJet().text, lastJet().html], ['stopped', 'Hello', '']);

  await turn.send('again');
  const second = { ...entry, id: 3 };
  event({ kind: 'mood', mood: 'hello' });
  event({ kind: 'finished', entry: second });
  event({ kind: 'failed', failure: { kind: 'io', message: 'offline' }, entry: { ...second, html: '', status: 'failed' } });
  assert.equal(thread.replying, false);
  await advance(1000);
  assert.equal(page.announce.textContent, 'Jet is replying');
  assert.equal(lastJet().status, 'failed');
});

test('the feeling is read within 2200 ms, falls back to neutral, and a late answer changes nothing', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const answers = [];
  const feel = () => new Promise((resolve, reject) => answers.push({ resolve, reject }));
  const s = await setup(t, { pending: true, feel });
  assert.equal(s.requests.length, 0, 'the flight starts while the message is classified');
  assert.equal(s.thread.replying, true);
  answers[0].resolve({ mood: 'insulted' });
  await s.sending;
  assert.equal(s.requests[0].feeling, 'insulted');
  s.event({ kind: 'finished', entry: s.entry });
  await s.advance(0);

  const slow = s.turn.send('again');
  await s.advance(2199);
  assert.equal(s.requests.length, 1);
  await s.advance(1);
  await slow;
  assert.equal(s.requests[1].feeling, 'neutral');
  answers[1].resolve({ mood: 'hello' });
  await s.advance(0);
  assert.equal(s.requests.length, 2);
  s.event({ kind: 'finished', entry: s.entry });
  await s.advance(0);

  const broken = s.turn.send('once more');
  answers[2].reject(new Error('unavailable'));
  await broken;
  assert.equal(s.requests[2].feeling, 'neutral');
  assert.equal(warnings.length, 1, 'the fallback warns once across turns');
});

test('stop before classification sends held text, and results and events of an old turn never touch the new one', async (t) => {
  let selected = 'app-a';
  const resolvers = [];
  const s = await setup(t, { pending: true, activeAppId: () => selected,
    feel: () => new Promise((done) => resolvers.push(done)),
  });
  s.turn.hold('next');
  s.turn.stop();
  assert.equal(s.stops(), 0);
  resolvers[0]({ mood: 'insulted' });
  await s.sending;
  assert.equal(s.requests.length, 0);
  resolvers[1]({ mood: 'hello' });
  await s.advance(0);
  assert.equal(s.requests[0].text, 'next');
  const oldEvent = s.captureEvent();
  s.turn.stop();
  s.event({ kind: 'stopped', entry: s.entry });
  const third = s.turn.send('third');
  resolvers[2]({ mood: 'neutral' });
  await third;
  oldEvent({ kind: 'text', delta: 'stale' });
  assert.equal(s.thread.slot.text, '');

  // Cancelling a held success does not stop the next held message.
  const stopsBefore = s.stops();
  s.event({ kind: 'mood', mood: 'hello' });
  s.event({ kind: 'finished', entry: s.entry });
  selected = 'app-b';
  s.turn.hold('after that');
  selected = 'app-c';
  s.turn.stop();
  resolvers[3]({ mood: 'neutral' });
  await s.advance(0);
  assert.deepEqual(s.requests.map((request) => request.text), ['next', 'third', 'after that']);
  assert.equal(s.requests[2].activeAppId, 'app-b');
  assert.equal(s.thread.replying, true);
  assert.equal(s.stops(), stopsBefore, 'the completed backend needs no stop, which would target the next message');
});

/** A voice that is still saying the reply when it has been written, and that keeps the finish until it is done or flushed. */
function speakingVoice() {
  const voice = { unlocked: 0, replies: [] };
  voice.part = {
    on: () => true,
    performsCues: () => true,
    cues: [{ tag: '<laugh>', weight: 8 }],
    unlock: () => { voice.unlocked++; },
    reveal: () => {
      let release = null;
      const reply = {
        speaking: true,
        flushed: 0,
        texts: [],
        text(full) { reply.texts.push(full); },
        holdUntil() {},
        finish(done) { release = done; },
        end() { reply.speaking = false; },
        flush() {
          reply.flushed++;
          if (reply.speaking) setTimeout(release, 20);
          reply.speaking = false;
        },
        endVoice() { reply.speaking = false; setTimeout(release, 20); },
      };
      voice.replies.push(reply);
      return { reveal: reply, spoken: true };
    },
  };
  return voice;
}

test('while Jet only speaks, Jet settles after the voice and a new message cuts in at once', async (t) => {
  const voice = speakingVoice();
  const s = await setup(t, { voice: voice.part });
  const lastJet = () => s.thread.rows().filter((row) => row.entry?.role === 'jet').at(-1).entry;
  assert.equal(voice.unlocked, 1, 'sending is the touch that lets the page make sound');

  // The reply is written and the voice goes on: Jet has not settled, and the field's button stops the voice or sends over it.
  s.event({ kind: 'mood', mood: 'hello' });
  s.event({ kind: 'text', delta: 'Hello' });
  s.event({ kind: 'finished', entry: s.entry });
  assert.equal(s.settled(), 0);
  assert.equal(s.thread.replying, true);
  assert.deepEqual([s.composer.button(''), s.composer.button('next')], ['stop', 'send']);
  voice.replies[0].endVoice();
  await s.advance(50);
  assert.deepEqual([s.settled(), lastJet().status, s.thread.replying], [1, 'complete', false], 'Jet settles when the voice is done');

  // Stop while Jet speaks quiets the voice, and the reply ends as it was written, not as "Stopped".
  await s.turn.send('again');
  s.event({ kind: 'finished', entry: { ...s.entry, id: 3 } });
  s.turn.stop();
  assert.equal(voice.replies[1].flushed, 1);
  s.turn.stop();
  await s.advance(50);
  assert.deepEqual([s.settled(), lastJet().status, s.thread.replying, s.composer.speaking], [2, 'complete', false, false], 'a second Stop before the reply ends changes nothing');

  // A new message while Jet speaks cuts in: no chip shows, the voice stops, and the message goes at once.
  await s.turn.send('once more');
  s.event({ kind: 'finished', entry: { ...s.entry, id: 4 } });
  s.turn.hold('cut in');
  assert.equal(voice.replies[2].flushed, 1);
  assert.ok(s.chips.every((held) => held === null), 'no "Sends when Jet finishes" chip shows');
  await s.advance(50);
  await s.advance(0);
  assert.equal(s.requests.at(-1).text, 'cut in');
  assert.equal(s.thread.replying, true);

  // A tool call ends the paragraph before it, so the voice can say that sentence while the tool runs.
  s.event({ kind: 'text', delta: 'Let me look.' });
  s.event({ kind: 'toolStarted', id: 'call-1', server: 'quanty', tool: 'run', input: {} });
  assert.equal(voice.replies[3].texts.at(-1), 'Let me look.\n\n');
  s.event({ kind: 'text', delta: '\n\nPart' });

  // Stop while Jet is still writing takes the saved entry, which holds everything received and not only what was shown.
  s.turn.stop();
  assert.equal(s.stops(), 1);
  s.event({ kind: 'stopped', entry: { ...s.entry, text: 'Partial reply', html: '<p>Partial reply</p>', status: 'stopped' } });
  assert.deepEqual([lastJet().text, lastJet().html, lastJet().status], ['Partial reply', '<p>Partial reply</p>', 'stopped']);
});

test('a send carries the time zone of the page', async (t) => {
  const s = await setup(t);
  assert.equal(s.requests[0].timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('a send says the reply is not spoken while the speaker is off', async (t) => {
  const s = await setup(t);
  assert.equal(s.requests[0].spoken, false);
});

test('a send says the reply is spoken, and the finished reply is announced without its vocal cues', async (t) => {
  const voice = speakingVoice();
  const s = await setup(t, { voice: voice.part });
  assert.equal(s.requests[0].spoken, true);
  s.event({ kind: 'text', delta: 'Ha <laugh> yes.' });
  s.event({ kind: 'finished', entry: { ...s.entry, text: 'Ha <laugh> yes.' } });
  voice.replies[0].endVoice();
  await s.advance(50);
  assert.equal(s.page.announce.textContent, 'Ha yes.');
  assert.equal(s.thread.rows().filter((row) => row.entry?.role === 'jet').at(-1).entry.text, 'Ha <laugh> yes.', 'the saved reply keeps its cues');
});

test('Jet may only react to a message: the waiting bubble leaves, and the emoji shows on the message', async (t) => {
  const s = await setup(t, { serverEvents: true });
  const turn = { requestId: s.requests[0].requestId, turnId: 'turn-1' };
  const user = { id: 1, role: 'user', text: 'hi', html: '', status: 'complete', at: 0 };
  s.turn.observe({ turn, event: { kind: 'accepted', snapshot: { history: [user], active: { identity: turn, user, text: '', mood: null, tools: [] } } } });
  const heart = { by: 'jet', emoji: '❤️', at: 1 };
  s.turn.observe({ turn, event: { kind: 'mood', mood: 'happy' } });
  s.turn.observe({ turn, event: { kind: 'reactions', entryId: 1, reactions: [heart] } });
  s.turn.observe({ turn, event: { kind: 'noReply' } });
  assert.deepEqual([s.thread.replying, s.composer.replying], [false, false]);
  const rows = s.thread.rows().filter((row) => row.entry);
  assert.deepEqual(rows.map((row) => row.type), ['user'], 'no empty Jet bubble is left');
  assert.deepEqual(rows[0].reactions, [heart], 'the message learnt its id from the accepted turn');
});

test("a reaction on Jet's message is saved with the settings of a send, and its list arrives outside any turn", async (t) => {
  const s = await setup(t, { serverEvents: true });
  s.event({ kind: 'finished', entry: { ...s.entry, id: 2 } });
  await s.advance(1000);
  await s.turn.react(2, '👍');
  const { text: _text, feeling: _feeling, requestId: _id, timeZone: _zone, chatId: _chat, ...settings } = s.requests[0];
  const { entryId, emoji, ...same } = s.reacts[0];
  assert.deepEqual([entryId, emoji], [2, '👍']);
  assert.deepEqual(same, settings, 'a reaction and a message start their turns the same way');

  const thumbs = { by: 'user', emoji: '👍', at: 5 };
  s.turn.observe({ turn: null, event: { kind: 'reactions', entryId: 2, reactions: [thumbs] } });
  s.turn.observe({ turn: null, event: { kind: 'reactions', entryId: 2, reactions: [thumbs] } });
  assert.deepEqual(s.thread.rows().find((row) => row.entry?.id === 2).reactions, [thumbs]);
});

test('a turn that a reaction started shows nothing until Jet writes, and nothing at all when Jet lets it be', async (t) => {
  const s = await setup(t, { serverEvents: true });
  s.event({ kind: 'finished', entry: { ...s.entry, id: 2 } });
  await s.advance(1000);
  const jetRows = () => s.thread.rows().filter((row) => row.type === 'jet');
  const reactionTurn = (turnId) => {
    const turn = { requestId: 'r-' + turnId, turnId };
    const active = { identity: turn, user: null, reaction: { entryId: 2, emoji: '👍' }, text: '', mood: null, tools: [] };
    s.turn.observe({ turn, event: { kind: 'accepted', snapshot: { history: [], active } } });
    return (event) => s.turn.observe({ turn, event });
  };

  const quiet = reactionTurn('turn-2');
  quiet({ kind: 'started', fresh: false });
  quiet({ kind: 'mood', mood: 'happy' });
  assert.equal(s.thread.replying, false, 'no Jet row opens for a mood alone');
  assert.equal(s.composer.replying, true, 'a message typed meanwhile is held');
  quiet({ kind: 'noReply' });
  assert.equal(s.composer.replying, false);
  assert.equal(jetRows().length, 1);

  const answer = reactionTurn('turn-3');
  answer({ kind: 'mood', mood: 'happy' });
  answer({ kind: 'text', delta: 'Glad it helped' });
  assert.deepEqual([jetRows().length, s.thread.slot.mood, s.thread.slot.text], [2, 'happy', 'Glad it helped']);
  answer({ kind: 'finished', entry: { ...s.entry, id: 3, text: 'Glad it helped' } });
  await s.advance(1000);
  assert.deepEqual([s.thread.replying, jetRows().at(-1).entry.id], [false, 3]);
});

/** The reaction turn the server starts as soon as a reply ends, because the user reacted while Jet replied. */
const reactionAccepted = (s) => {
  const turn = { requestId: 'r-react', turnId: 'turn-react' };
  const active = { identity: turn, user: null, reaction: { entryId: 2, emoji: '👍' }, text: '', mood: null, tools: [] };
  s.turn.observe({ turn, event: { kind: 'accepted', snapshot: { history: [], active } } });
  return (event) => s.turn.observe({ turn, event });
};

test('a held message that a reaction turn overtakes goes back to the hold and is sent when that turn ends', async (t) => {
  const answers = [];
  const s = await setup(t, { serverEvents: true, pending: true, feel: () => new Promise((resolve) => answers.push(resolve)) });
  answers[0]({ mood: 'neutral' });
  await s.sending;
  const own = { requestId: s.requests[0].requestId, turnId: 'turn-1' };
  const user = { id: 1, role: 'user', text: 'hi', html: '', status: 'complete', at: 0 };
  s.turn.observe({ turn: own, event: { kind: 'accepted', snapshot: { history: [user], active: { identity: own, user, text: '', mood: null, tools: [] } } } });
  s.turn.observe({ turn: own, event: { kind: 'text', delta: 'Hello' } });
  s.turn.hold('next');
  s.turn.observe({ turn: own, event: { kind: 'finished', entry: { ...s.entry, id: 2 } } });
  await s.advance(1000);
  assert.equal(answers.length, 2, 'the held message is being classified');

  const reaction = reactionAccepted(s);
  answers[1]({ mood: 'neutral' });
  await s.advance(0);
  assert.equal(s.requests.length, 1, 'the server would refuse it while Jet answers the reaction');
  assert.deepEqual(s.thread.held, { text: 'next', attachments: [] });
  assert.deepEqual(s.thread.rows().filter((row) => row.entry).map((row) => row.entry.text), ['hi', 'Hello'], 'its bubble waits as the held message');

  reaction({ kind: 'noReply' });
  answers[2]({ mood: 'neutral' });
  await s.advance(0);
  assert.equal(s.requests.at(-1).text, 'next', 'the held message is sent');
});

test('a reaction turn that starts while the last reply is still revealed waits for it, and the reply ends whole', async (t) => {
  const s = await setup(t, { serverEvents: true });
  s.turn.hold('next');
  s.event({ kind: 'text', delta: 'Hello' });
  s.event({ kind: 'finished', entry: { ...s.entry, id: 2 } });
  const reaction = reactionAccepted(s);
  reaction({ kind: 'mood', mood: 'happy' });
  assert.equal(s.relaunched(), 0, 'the thread is not reloaded');
  await s.advance(1000);
  const jet = s.thread.rows().filter((row) => row.type === 'jet');
  assert.deepEqual([jet.length, jet[0].entry.status], [1, 'complete'], 'the reply finished as it was written');
  assert.equal(s.composer.replying, true, 'the reaction turn now runs');
  assert.equal(s.requests.length, 1, 'the held message waits for it');
  reaction({ kind: 'noReply' });
  await s.advance(0);
  assert.equal(s.requests.at(-1).text, 'next');
});

test('a message typed in a chat still goes to that chat when the page opens another during the feeling wait', async (t) => {
  const answers = [];
  const feel = () => new Promise((resolve) => answers.push(resolve));
  const s = await setup(t, { pending: true, feel });
  s.turn.restore({ history: [], active: null }, { fresh: true });
  await s.advance(0);
  await s.sending;
  assert.equal(s.requests.length, 1, 'the message is sent');
  assert.deepEqual([s.requests[0].text, s.requests[0].chatId], ['hi', 7], 'to the chat it was typed in');
  assert.equal(s.thread.replying, false, 'and shows nothing in the chat now on screen');
});

test("a message waiting for its feeling is held when another page's message in the chat is accepted first", async (t) => {
  const answers = [];
  const feel = () => new Promise((resolve) => answers.push(resolve));
  const s = await setup(t, { pending: true, serverEvents: true, feel });
  const theirs = { identity: { requestId: 'other', turnId: 't2' }, user: { id: 1, role: 'user', text: 'theirs', at: 1 }, text: '', tools: [] };
  s.turn.observe({ turn: { requestId: 'other', turnId: 't2' }, event: { kind: 'accepted', snapshot: { history: [], active: theirs } } });
  for (const resolve of answers) resolve({ mood: 'neutral' });
  await s.advance(0);
  await s.sending;
  assert.equal(s.requests.length, 0, 'it waits for the other turn');
  assert.equal(s.thread.held?.text, 'hi', 'and is held, so it is shown and sent when that turn ends');
});

test('a message typed in a chat goes to that chat when another opens and the feeling settles before its snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createBrowserAgent } = await import('../bridge/browser-agent.js');
  const posted = [];
  let feelDone, snapshotDone;
  class Source { close() {} }
  const json = (value) => ({ ok: true, json: async () => value });
  const fetch = (path) => {
    if (path === '/api/feel') return new Promise((resolve) => { feelDone = () => resolve(json({ mood: 'neutral' })); });
    if (path === '/api/snapshot?chat=22') return new Promise((resolve) => { snapshotDone = () => resolve(json({ chatId: 22, epoch: 'e', cursor: 0, history: [], active: null })); });
    if (path === '/api/snapshot') return Promise.resolve(json({ chatId: 11, epoch: 'e', cursor: 0, history: [], active: null }));
    if (path.startsWith('/api/chat/send')) { posted.push(path); return Promise.resolve(json({ user: { id: 1 } })); }
    if (path === '/api/markdown') return Promise.resolve(json('<p></p>'));
    return Promise.resolve(json({}));
  };
  const agent = createBrowserAgent({ fetch, EventSource: Source, storage: null, uuid: () => 'id', delay: async () => {} });
  await agent.snapshot();
  const noop = () => {};
  const live = { feel: () => ({ revealAt: 0 }), measure: () => ({}), send: noop, mood: () => ({ revealAt: 0 }), replying: noop, done: noop, failed: noop, stopped: noop, showInLane: noop, showHero: noop };
  const turn = createTurn({
    agent, settings: { persona: { name: 'Jet' }, model: 'sonnet', effort: 'medium', turnBudgetUsd: 1 },
    thread: createThread(), composer: createComposer({ empty: true }), page: { announce: {} },
    view: { render: noop, liveLane: noop }, follow: { onSend: noop },
    composerView: { refresh: noop, setLayout: noop, setHeld: noop }, live, afterReply: noop,
  });
  const sending = turn.send('typed in chat A');
  await new Promise(setImmediate);
  const opening = agent.openChat(22, (snapshot) => turn.restore(snapshot, { fresh: true }));
  feelDone();
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  snapshotDone();
  await opening;
  await sending;
  assert.deepEqual(posted, ['/api/chat/send?chat=11'], 'the message is posted to chat A, where it was typed');
});

test('a reaction unlocks sound, as a sent message does', async (t) => {
  const voice = speakingVoice();
  const s = await setup(t, { voice: voice.part });
  const before = voice.unlocked;
  await s.turn.react(2, '👍');
  assert.equal(voice.unlocked, before + 1);
});
