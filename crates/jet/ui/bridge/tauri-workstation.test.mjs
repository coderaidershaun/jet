import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectWorkstation } from './workstation.js';
import { defaultSettings } from './settings.js';

/** A stand-in for `window.__TAURI__` that records every call and lets a test hold a call open. */
function stubTauri() {
  const calls = [];
  const failures = new Map();
  const gates = [];

  class Channel {}

  const core = {
    Channel,
    async invoke(command, args) {
      calls.push([command, args]);
      if (failures.has(command)) throw failures.get(command);
      const gate = gates.shift();
      if (gate) await gate;
    },
  };
  return { tauri: { core }, calls, failures, gates, Channel };
}

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const workstation = defaultSettings().workstation;

test('with window.__TAURI__ the workstation calls its three commands in order with their keys; without it the pretend feed is used', async (t) => {
  const stub = stubTauri();
  globalThis.window = { __TAURI__: stub.tauri };
  t.after(() => { delete globalThis.window; });
  const feed = connectWorkstation();

  const seen = [];
  const consoleError = console.error;
  const swallowed = [];
  console.error = (...args) => swallowed.push(args);
  try {
    await feed.start(workstation, (line) => {
      seen.push(line);
      if (line.kind === 'hello') throw new Error('a listener bug');
    });
    const [first] = stub.calls;
    first[1].events.onmessage({ kind: 'hello', protocol: 1 });
    first[1].events.onmessage({ kind: 'tick', session: 1, seq: 1 });
  } finally {
    console.error = consoleError;
  }
  assert.deepEqual(seen.map((line) => line.kind), ['hello', 'tick'], 'a throwing listener does not stop the stream');
  assert.equal(swallowed.length, 1);

  await feed.command({ cmd: 'select', instrument: 1 });
  await feed.stop();
  assert.deepEqual(stub.calls.map(([command]) => command), ['workstation_start', 'workstation_command', 'workstation_stop']);
  const argsOf = (command) => stub.calls.find(([name]) => name === command)[1];
  assert.deepEqual(Object.keys(argsOf('workstation_start')).sort(), ['events', 'workstation']);
  assert.equal(argsOf('workstation_start').workstation, workstation);
  assert.ok(argsOf('workstation_start').events instanceof stub.Channel);
  assert.deepEqual(argsOf('workstation_command'), { command: { cmd: 'select', instrument: 1 } });
  assert.equal(argsOf('workstation_stop'), undefined, 'stop takes no arguments');

  // Tauri runs each command as its own task, so a call must wait for the one before it.
  let release;
  stub.gates.push(new Promise((resolve) => { release = resolve; }));
  stub.calls.length = 0;
  const slowStart = feed.start(workstation, () => {});
  const quickCommand = feed.command({ cmd: 'resync' });
  await settle();
  assert.deepEqual(stub.calls.map(([command]) => command), ['workstation_start'], 'the second call waits for the first to settle');
  release();
  await Promise.all([slowStart, quickCommand]);
  assert.deepEqual(stub.calls.map(([command]) => command), ['workstation_start', 'workstation_command']);

  // A line of 8 KiB or more can arrive after the feed was stopped or started again; it is dropped.
  stub.calls.length = 0;
  const firstRun = [];
  const secondRun = [];
  await feed.start(workstation, (line) => firstRun.push(line));
  const firstChannel = stub.calls[0][1].events;
  firstChannel.onmessage({ kind: 'tick', session: 1, seq: 1 });
  await feed.start(workstation, (line) => secondRun.push(line));
  const secondChannel = stub.calls[1][1].events;
  firstChannel.onmessage({ kind: 'tick', session: 1, seq: 2 });
  secondChannel.onmessage({ kind: 'tick', session: 1, seq: 3 });
  assert.deepEqual(firstRun.map((line) => line.seq), [1], 'a message on the replaced channel is dropped');
  assert.deepEqual(secondRun.map((line) => line.seq), [3]);
  await feed.stop();
  secondChannel.onmessage({ kind: 'tick', session: 1, seq: 4 });
  assert.deepEqual(secondRun.map((line) => line.seq), [3], 'nothing arrives after stop');

  stub.failures.set('workstation_command', 'the bridge is not running');
  await assert.rejects(feed.command({ cmd: 'resync' }), { kind: 'io', message: 'the bridge is not running' });
  stub.failures.set('workstation_command', new Error('the bridge fell over'));
  await assert.rejects(feed.command({ cmd: 'resync' }), { kind: 'io', message: 'the bridge fell over' });
  const rust = { kind: 'io', message: 'a workstation command is a JSON object' };
  stub.failures.set('workstation_command', rust);
  await assert.rejects(feed.command({ cmd: 'resync' }), (error) => error.kind === rust.kind && error.message === rust.message);
  stub.failures.delete('workstation_command');
  await feed.command({ cmd: 'resync' });

  delete globalThis.window;
  const pretend = connectWorkstation();
  await assert.rejects(pretend.command({ cmd: 'resync' }), { kind: 'io', message: 'the pretend feed is not running' });
});
