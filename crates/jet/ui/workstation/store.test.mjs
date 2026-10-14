import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandMemory, createFrameStore } from './store.js';

/** Runs `body` with console.error recorded instead of printed. */
function quietly(body) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    body();
  } finally {
    console.error = original;
  }
  return logged;
}

test('lines land in the store by name, in order, and every painter runs on every frame', () => {
  const store = createFrameStore();
  const hello = { kind: 'hello', protocol: 1 };
  const link = { kind: 'link', peer: 'a' };
  const status = { kind: 'bridge', status: 'starting', detail: 'x' };
  const odd = { kind: 'something-new', value: 3 };
  for (const line of [hello, link, status, odd, { kind: 'lifecycle', screen: 'live' }, { kind: 'catalog', session: 1 }, { kind: 'bye', reason: 'x' }]) assert.equal(store.accept(line), false);
  assert.equal(store.latest('hello'), hello, 'a line is stored whole under its kind');
  assert.equal(store.latest('link'), link);
  assert.equal(store.latest('bridge'), status);
  assert.equal(store.latest('something-new'), odd, 'an unknown kind is stored too');
  assert.equal(store.latest('ladder'), undefined);

  const heard = [];
  for (const name of ['tick', 'view', 'ladder', 'chart', 'risk', 'extra']) store.onFrame(name, (value, line) => heard.push([name, value, line]));
  const stopHearing = store.onFrame('ladder', () => heard.push(['ladder again']));
  const tick = { kind: 'tick', session: 1, seq: 1, risk: { generation: 1 }, extra: { n: 1 }, chart: { generation: 1 }, ladder: { rows: 12 }, view: { instrument: 0 } };
  assert.equal(store.accept(tick), false);
  assert.deepEqual(heard.map(([name]) => name), ['tick', 'view', 'ladder', 'ladder again', 'chart', 'risk', 'extra'], 'sections reach listeners in the bridge order, whatever the line’s own order');
  assert.deepEqual(heard[0][1], { session: 1, seq: 1 }, 'the tick itself is its session and sequence number');
  assert.equal(heard[2][1], tick.ladder);
  assert.equal(heard[2][2], tick, 'a listener also gets the line');
  assert.equal(store.latest('chart'), tick.chart);
  assert.deepEqual(store.latest('tick'), { session: 1, seq: 1 });

  stopHearing();
  heard.length = 0;
  store.accept({ kind: 'tick', session: 1, seq: 2, ladder: { rows: 13 } });
  assert.deepEqual(heard.map(([name]) => name), ['tick', 'ladder'], 'only the sections a tick carries are heard');
  assert.equal(store.latest('chart'), tick.chart, 'a section that was not sent keeps its last value');
  assert.equal(store.latest('ladder').rows, 13);

  const ran = [];
  const stopRunning = store.register('first', (now) => ran.push(['first', now]));
  store.onFrame('summary', () => { throw new Error('a listener bug'); });
  store.onFrame('summary', (value) => ran.push(['summary', value]));
  const logged = quietly(() => store.accept({ kind: 'tick', session: 1, seq: 3, summary: { mid: 1 } }));
  assert.deepEqual(ran, [['summary', { mid: 1 }]], 'a throwing listener does not stop the next one');
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /summary/, 'the log names the section');

  ran.length = 0;
  store.register('second', (now) => ran.push(['second', now]));
  const failures = quietly(() => {
    store.register('broken', () => { throw new Error('a painter bug'); });
    store.register('third', (now) => ran.push(['third', now]));
    store.paint(1000);
    store.paint(1016);
  });
  assert.deepEqual(ran, [['first', 1000], ['second', 1000], ['third', 1000], ['first', 1016], ['second', 1016], ['third', 1016]], 'every painter runs on every frame, in registration order');
  assert.equal(failures.length, 1, 'a painter that throws is logged once');
  assert.match(String(failures[0][0]), /broken/, 'and named');
  stopRunning();
  ran.length = 0;
  store.paint(1032);
  assert.deepEqual(ran.map(([name]) => name), ['second', 'third'], 'an unregistered painter stops, the broken one is gone');

  const counted = createFrameStore();
  const next = (session, seq) => counted.accept({ kind: 'tick', session, seq });
  assert.equal(next(1, 5), false, 'the first tick has nothing before it');
  assert.equal(next(1, 6), false);
  assert.equal(next(1, 8), true, 'a jump inside one session is a gap');
  assert.equal(next(1, 9), false, 'the count goes on from the tick that showed the gap');
  assert.equal(next(1, 3), true, 'going back is a gap too');
  assert.equal(next(2, 40), false, 'a new session has its own count');
  assert.equal(next(2, 41), false);
  counted.accept({ kind: 'hello', protocol: 1 });
  assert.equal(next(2, 100), false, 'a hello means a fresh bridge');
});

test('view commands and the latest pause or resume are remembered for the replay after hello; the others are not', () => {
  const memory = createCommandMemory();
  assert.deepEqual(memory.replay(), []);

  const select = { cmd: 'select', instrument: 1 };
  const mode = { cmd: 'chart_mode', mode: 'candles' };
  const levels = { cmd: 'dom_levels', levels: 20 };
  const fit = { cmd: 'dom_fit', rows: 18 };
  const ticks = { cmd: 'chart_ticks', mid: 9, risk: 5 };
  const series = { cmd: 'risk_series', series: 'pnl' };
  for (const command of [select, mode, levels, fit, ticks, series]) memory.note(command);
  memory.note({ cmd: 'chart_mode', mode: 'line' });
  assert.deepEqual(memory.replay(), [select, levels, fit, ticks, series, { cmd: 'chart_mode', mode: 'line' }], 'the last of each kind, in the order each was last sent');

  memory.note({ cmd: 'assert', state: 'idle' });
  memory.note({ cmd: 'next_peer' });
  memory.note({ cmd: 'resync' });
  memory.note({ cmd: 'dance' });
  memory.note({ cmd: 'dom_unit', unit: 'ticks' });
  memory.note({ cmd: 'dom_grouping', unit: 'ticks', perBucket: 5 });
  memory.note({ cmd: 'dom_unit', unit: 'bps' });
  const replayed = memory.replay();
  assert.deepEqual(replayed.map((command) => command.cmd), ['select', 'dom_levels', 'dom_fit', 'chart_ticks', 'risk_series', 'chart_mode', 'dom_grouping', 'dom_unit'], 'an assertion, a peer step, a resync and an unknown command are never replayed');
  assert.deepEqual(replayed.at(-1), { cmd: 'dom_unit', unit: 'bps' }, 'the unit the user ended on is the one replayed last');

  memory.note({ cmd: 'dom_grouping', unit: 'bps', numerator: 1, denominator: 10 });
  memory.note({ cmd: 'dom_grouping', unit: 'ticks', perBucket: 10 });
  const groupings = memory.replay().filter((command) => command.cmd === 'dom_grouping');
  assert.deepEqual(groupings.map((command) => command.unit), ['bps', 'ticks'], 'each unit keeps its own grouping, and the later choice replays last');

  memory.note({ cmd: 'pause' });
  memory.note({ cmd: 'dom_levels', levels: 14 });
  assert.deepEqual(memory.replay().at(-1), { cmd: 'pause' }, 'a bridge restarted while the page is hidden starts paused');
  memory.note({ cmd: 'resume' });
  const last = memory.replay();
  assert.deepEqual(last.at(-1), { cmd: 'resume' });
  assert.equal(last.filter((command) => command.cmd === 'pause' || command.cmd === 'resume').length, 1, 'pause and resume share one place');
});
