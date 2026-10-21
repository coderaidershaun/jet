import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectAgent } from './agent.js';

/** A stand-in for `window.__TAURI__` that records every call the agent makes. */
function stubTauri() {
  const calls = [];
  const replies = new Map();
  const failures = new Map();
  const listens = [];

  class Channel {}

  const core = {
    Channel,
    async invoke(command, args) {
      calls.push([command, args]);
      if (failures.has(command)) throw failures.get(command);
      const reply = replies.get(command);
      return typeof reply === 'function' ? reply(args) : reply;
    },
  };
  const event = {
    listen(name, handler) {
      return new Promise((resolve) => {
        const entry = { name, handler, unlistened: 0, resolve: () => resolve(() => { entry.unlistened += 1; }) };
        listens.push(entry);
      });
    },
  };
  return { tauri: { core, event }, calls, replies, failures, listens, Channel };
}

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const request = {
  text: 'hello',
  model: 'sonnet',
  effort: 'medium',
  budgetUsd: 1,
  persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' },
  localTime: 'Wed 14 Oct 2026, 09:00',
  claudePath: null,
};

test('with window.__TAURI__ the agent calls each command with its argument keys and gives callers { kind, message } errors', async (t) => {
  const stub = stubTauri();
  globalThis.window = { __TAURI__: stub.tauri };
  t.after(() => { delete globalThis.window; });
  const agent = connectAgent();

  const userEntry = { id: 7, role: 'user', text: 'hello', html: '', status: 'complete', at: 1 };
  stub.replies.set('send_message', (args) => {
    args.events.onmessage({ kind: 'rawLine', line: '{}' });
    args.events.onmessage({ kind: 'text', delta: 'Hi' });
    return userEntry;
  });

  const seen = [];
  const consoleError = console.error;
  const swallowed = [];
  console.error = (...args) => swallowed.push(args);
  let user;
  try {
    user = await agent.send(request, (event) => {
      seen.push(event);
      if (event.kind === 'rawLine') throw new Error('a listener bug');
    });
  } finally {
    console.error = consoleError;
  }
  assert.equal(user, userEntry);
  assert.deepEqual(seen.map((event) => event.kind), ['rawLine', 'text'], 'a throwing listener does not stop the stream');
  assert.equal(swallowed.length, 1);

  stub.replies.set('render_markdown', '<p>x</p>');
  stub.replies.set('read_library_image', 'data:image/png;base64,AAAA');
  await agent.status();
  await agent.history();
  await agent.stop();
  await agent.forget();
  await agent.loadMemory();
  await agent.saveMemory({ memory: 'm', user: 'u', recent: 'r', limits: { memory: 1, user: 1, recent: 1 } });
  assert.equal(await agent.renderMarkdown('*x*'), '<p>x</p>');
  await agent.openLink('https://example.com');
  assert.equal(await agent.readLibraryImage('content/a.png'), 'data:image/png;base64,AAAA');
  stub.replies.set('mcp_call', { engines: [] });
  assert.deepEqual(await agent.mcpCall('polysim', 'list_strategies', {}), { engines: [] });
  await agent.reloadLibraries();

  const commands = stub.calls.map(([command]) => command);
  assert.deepEqual(commands, [
    'send_message', 'agent_status', 'load_history', 'stop_reply', 'forget_conversation',
    'load_memory', 'save_memory', 'render_markdown', 'open_link', 'read_library_image', 'mcp_call', 'mcp_reload',
  ]);
  const argsOf = (command) => stub.calls.find(([name]) => name === command)[1];
  assert.deepEqual(Object.keys(argsOf('send_message')).sort(), ['events', 'request']);
  assert.equal(argsOf('send_message').request, request);
  assert.ok(argsOf('send_message').events instanceof stub.Channel);
  assert.deepEqual(argsOf('save_memory'), { notes: { memory: 'm', user: 'u', recent: 'r' } });
  assert.deepEqual(argsOf('render_markdown'), { text: '*x*' });
  assert.deepEqual(argsOf('open_link'), { url: 'https://example.com' });
  assert.deepEqual(argsOf('read_library_image'), { path: 'content/a.png' });
  assert.deepEqual(argsOf('mcp_call'), { server: 'polysim', tool: 'list_strategies', args: {} });
  for (const command of ['agent_status', 'load_history', 'stop_reply', 'forget_conversation', 'load_memory', 'mcp_reload']) {
    assert.equal(argsOf(command), undefined, command + ' takes no arguments');
  }

  stub.failures.set('stop_reply', 'the disk is full');
  await assert.rejects(agent.stop(), { kind: 'io', message: 'the disk is full' });
  stub.failures.set('stop_reply', new Error('the bridge fell over'));
  await assert.rejects(agent.stop(), { kind: 'io', message: 'the bridge fell over' });
  const busy = { kind: 'busy', message: 'Jet is still answering' };
  stub.failures.set('forget_conversation', busy);
  await assert.rejects(agent.forget(), (error) => error.kind === 'busy' && error.message === busy.message);
  const notShared = { kind: 'library', message: 'Jet is not running polysim itself' };
  stub.failures.set('mcp_call', notShared);
  await assert.rejects(agent.mcpCall('polysim', 'start_strategy', {}), (error) => error.kind === 'library' && error.message === notShared.message);

  const notes = [];
  const stopFirst = agent.onMemoryUpdated((payload) => notes.push(payload));
  const [first] = stub.listens;
  assert.equal(first.name, 'memory-updated');
  first.resolve();
  await settle();
  first.handler({ payload: { memory: 'a', user: 'b', recent: 'c' } });
  assert.deepEqual(notes, [{ memory: 'a', user: 'b', recent: 'c' }]);
  stopFirst();
  assert.equal(first.unlistened, 1);

  const late = [];
  const stopEarly = agent.onMemoryUpdated((payload) => late.push(payload));
  const [, early] = stub.listens;
  stopEarly();
  early.handler({ payload: { memory: 'x', user: 'y', recent: 'z' } });
  assert.deepEqual(late, [], 'an update after the stop never reaches the listener');
  early.resolve();
  await settle();
  assert.equal(early.unlistened, 1, 'stopping before the listener is ready still unlistens');
});

test('without window.__TAURI__ connectAgent gives the pretend agent', async (t) => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  delete globalThis.window;
  t.after(() => { delete globalThis.localStorage; });

  const { dataDir } = await connectAgent().status();
  assert.equal(dataDir, 'browser storage');
});
