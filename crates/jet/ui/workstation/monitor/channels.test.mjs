import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, createChannelRings } from './channels.js';

const row = (n) => ({ time: String(n), text: 'row ' + n, textTone: 'text', detail: 'row ' + n });
/** The rows `from` down to `to`, newest first, as a channel delta carries them. */
const run = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => row(from - i));
const times = (rings, name) => rings.ring(name).rows.map((r) => Number(r.time));

/** A tick line of one session; `extra` adds the other sections. */
const tick = (channels, extra = {}, session = 1) => ({ kind: 'tick', session, seq: 1, channels, ...extra });

test('deltas go on top, newest first, and each ring keeps its newest 256', () => {
  const rings = createChannelRings();
  rings.fold(tick({ system: { appended: 2, rows: run(2, 1) } }));
  assert.deepEqual(times(rings, 'system'), [2, 1]);

  const incoming = run(3, 3);
  assert.equal(rings.fold(tick({ system: { appended: 3, rows: incoming } })), true);
  assert.deepEqual(times(rings, 'system'), [3, 2, 1], 'the new row goes on top');
  assert.equal(rings.ring('system').rows[0], incoming[0], 'the rows are the very objects that arrived');

  rings.fold(tick({ trades: { appended: 200, rows: run(200, 1) } }));
  rings.fold(tick({ trades: { appended: 300, rows: run(300, 201) } }));
  assert.equal(rings.ring('trades').rows.length, 256, 'a ring never grows past 256');
  assert.equal(rings.ring('trades').rows[0].time, '300');
  assert.equal(rings.ring('trades').rows[255].time, '45', 'it is the oldest rows that go');
  assert.equal(rings.ring('trades').appended, 300, 'the count is the bridge’s, not the length');
  assert.deepEqual(times(rings, 'system'), [3, 2, 1], 'another channel is not touched');
});

test('a full set, a new session, generation or instrument, and a new bridge start the rings over; a tick without those sections does not', () => {
  const epochs = (rings) => CHANNELS.map((name) => rings.ring(name).epoch);
  const rings = createChannelRings();
  const chart = (generation) => ({ chart: { generation }, view: { instrument: 0 } });

  rings.fold(tick({ system: { appended: 3, rows: run(3, 1) }, orders: { appended: 2, rows: run(2, 1) } }, chart(1)));
  const first = epochs(rings);
  rings.fold(tick({ system: { appended: 4, rows: run(4, 4) } }));
  assert.deepEqual(times(rings, 'system'), [4, 3, 2, 1], 'a delta tick with no chart, risk or view keeps the rows');
  assert.deepEqual(epochs(rings), first, 'and keeps the epoch');
  rings.fold(tick({ system: { appended: 5, rows: run(5, 5) } }, chart(1)));
  assert.deepEqual(times(rings, 'system'), [5, 4, 3, 2, 1], 'the same generation and instrument again start nothing');

  rings.fold(tick({ system: { appended: 6, rows: run(6, 6) } }, chart(2)));
  assert.deepEqual(times(rings, 'system'), [6], 'a new generation starts over, and the set that comes with it is all there is');
  assert.deepEqual(times(rings, 'orders'), [], 'including the channels the tick does not carry');
  assert.deepEqual(epochs(rings), first.map((n) => n + 1));

  rings.fold(tick({ system: { appended: 7, rows: run(7, 7) } }, { risk: { generation: 2 } }));
  assert.deepEqual(times(rings, 'system'), [7, 6], 'the risk section speaks for the generation when the chart is absent');
  rings.fold(tick({ system: { appended: 8, rows: run(8, 8) } }, { risk: { generation: 3 } }));
  assert.deepEqual(times(rings, 'system'), [8], 'and a new risk generation starts over');

  rings.fold(tick({ system: { appended: 9, rows: run(9, 9) } }, { view: { instrument: 1 } }));
  assert.deepEqual(times(rings, 'system'), [9], 'a new instrument starts over');

  rings.fold(tick({ system: { appended: 10, rows: run(10, 10) } }, {}, 2));
  assert.deepEqual(times(rings, 'system'), [10], 'a new session starts over');
  assert.equal(rings.fold(tick(undefined, {}, 3)), true, 'a start over with no rows to show still changes the rings');
  assert.deepEqual(times(rings, 'system'), [], 'and leaves them empty');
  assert.equal(rings.fold(tick(undefined, {}, 3)), false, 'the next tick of that session changes nothing');

  rings.fold(tick({ system: { appended: 11, rows: run(11, 11) }, fills: { appended: 4, rows: run(4, 1) } }, {}, 3));
  const systemEpoch = rings.ring('system').epoch;
  rings.fold(tick({ system: { appended: 19, rows: run(19, 12), full: true } }, {}, 3));
  assert.deepEqual(times(rings, 'system'), run(19, 12).map((r) => Number(r.time)), 'a set marked full replaces the ring');
  assert.equal(rings.ring('system').epoch, systemEpoch + 1, 'in a new epoch');
  assert.deepEqual(times(rings, 'fills'), [4, 3, 2, 1], 'and only the ring it is for');
  rings.fold(tick({ system: { appended: 20, rows: run(20, 20), full: false } }, {}, 3));
  assert.deepEqual(times(rings, 'system').slice(0, 2), [20, 19], 'a set not marked full is a delta');

  rings.restart();
  rings.fold(tick({ system: { appended: 1, rows: run(1, 1) } }, { risk: { generation: 3 }, view: { instrument: 1 } }, 3));
  assert.deepEqual(times(rings, 'system'), [1], 'after a new bridge says hello the next tick starts over, though the numbers look the same');
});
