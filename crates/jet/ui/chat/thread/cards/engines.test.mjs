import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLYSIM_ENGINES } from '../../../bridge/fixtures/polysim-engines.js';
import { clockTime } from '../../clock.js';
import { actionFor, actionLine, confirmText, createFleet, createPreface, detailLine, engineRows, modeBadge, stateBadge } from './engines.js';

const fixtureRows = () => engineRows(POLYSIM_ENGINES.result);

test("rows from a listing carry each engine's state, mode and details", () => {
  const rows = fixtureRows();
  assert.deepEqual(rows.map((row) => row.name), [
    'strat-micro-recorder · te-binance-spot-btcusdt',
    'strat-micro-recorder · te-polymarket-btc-updown-5m',
    'strat-maker · te-binance-spot-ethusdt',
    'strat-maker · te-polymarket-eth-updown-5m',
  ]);
  assert.equal(rows[0].key, 'strat-micro-recorder te-binance-spot-btcusdt');
  assert.deepEqual([rows[0].strategyId, rows[0].teId, rows[0].linkBind, rows[0].pid], ['strat-micro-recorder', 'te-binance-spot-btcusdt', '127.0.0.1:9310', 48213]);
  assert.equal(rows[0].startedAt, Date.parse('2026-10-14T21:30:12.123456Z'));
  assert.equal(rows[1].startedAt, null);
  assert.equal(rows[3].linkBind, null);

  const badges = rows.map((row) => [stateBadge(row), modeBadge(row)]);
  assert.deepEqual(badges.map(([state, mode]) => [state.text, state.tone, mode.text, mode.tone]), [
    ['RUNNING', 'positive', 'SIM', 'warning'],
    ['STOPPED', 'muted', 'OFF', 'muted'],
    ['STOPPED', 'muted', 'LIVE', 'negative'],
    ['EXITED', 'warning', 'UNREADABLE', 'invalid'],
  ]);
  assert.deepEqual(badges.map(([, mode]) => mode.title), [null, null, null, rows[3].configError]);
  assert.match(rows[3].configError, /unknown variant `paper`/);
  assert.deepEqual([modeBadge({ mode: 'absent' }).text, modeBadge({ mode: 'paper' }).tone, stateBadge({ state: 'starting' }).text], ['ABSENT', 'invalid', 'STARTING']);

  const since = clockTime(Date.parse('2026-10-14T21:30:12.123456Z'));
  assert.deepEqual(rows.map(detailLine), ['pid 48213 · since ' + since, '', '', 'exit code 101']);
  assert.equal(detailLine({ state: 'running', pid: 7, startedAt: null }), 'pid 7');

  for (const nothing of [undefined, null, 'text', {}, { engines: 'no' }]) assert.deepEqual(engineRows(nothing), []);
});

test('the button follows the state, and Start asks unless the fresh mode is off or sim', () => {
  const [sim, off, live, unreadable] = fixtureRows();
  assert.deepEqual([sim, off, live, unreadable].map(actionFor), ['stop', 'start', 'start', 'start']);

  const start = (row) => confirmText({ kind: 'start', row });
  assert.equal(start(off), null);
  assert.equal(start(sim), null);
  assert.equal(start(live), 'This engine trades real money. Start it?');
  assert.equal(start(unreadable), "This engine's mode is unreadable. Start it?");
  assert.equal(start({ ...off, mode: 'absent' }), "This engine's mode is absent. Start it?");
  assert.equal(start({ ...off, mode: 'paper' }), "This engine's mode is paper. Start it?");
  assert.equal(start({ ...off, mode: null }), "This engine's mode is unknown. Start it?");

  assert.equal(confirmText({ kind: 'stop', row: live }), null);
  assert.equal(confirmText({ kind: 'mode', row: off, mode: 'live' }), 'This engine trades real money once it starts. Set it to live?');
  assert.equal(confirmText({ kind: 'mode', row: live, mode: 'sim' }), null);
  assert.equal(confirmText({ kind: 'mode', row: live, mode: 'off' }), null);
});

test('an action is pending until it settles, and a failure stays on its row', () => {
  const fleet = createFleet();
  const { result } = POLYSIM_ENGINES;
  assert.equal(fleet.adopt('call-1', result), true);
  assert.equal(fleet.rows.length, 4);
  assert.equal(fleet.adopt('call-1', { engines: [] }), false, 'a call that was taken once is not taken again');
  assert.equal(fleet.rows.length, 4);
  assert.equal(fleet.stale, false);

  // A listing restored from an earlier session is old until the card lists again.
  const restored = createFleet();
  restored.know('call-0');
  assert.equal(restored.adopt('call-0', result), false, 'a known call never replaces what the card shows');
  assert.equal(restored.rows.length, 0);
  assert.equal(restored.adopt('call-9', result, { stale: true }), true);
  assert.equal(restored.stale, true);
  restored.list({ engines: [] });
  assert.deepEqual([restored.stale, restored.rows.length], [false, 0]);

  const [sim, off] = fleet.rows;
  assert.deepEqual(fleet.rowView(off.key), { pending: null, error: null, busy: false, modeLocked: false });
  fleet.begin(off.key, 'start');
  assert.deepEqual(fleet.rowView(off.key), { pending: 'start', error: null, busy: true, modeLocked: true });
  fleet.settle(off.key, 'Jet is not running polysim itself');
  assert.deepEqual(fleet.rowView(off.key), { pending: null, error: 'Jet is not running polysim itself', busy: false, modeLocked: false });
  fleet.begin(off.key, 'start');
  assert.equal(fleet.rowView(off.key).error, null, 'a new action clears the old error');
  fleet.settle(off.key);
  assert.equal(fleet.rowView(off.key).error, null);

  assert.deepEqual(fleet.rowView(sim.key), { pending: null, error: null, busy: false, modeLocked: true }, 'a running engine keeps its mode');
  assert.equal(fleet.row(off.key).name, off.name);
  assert.equal(fleet.row('nobody gone'), null);

  fleet.failList('polysim did not answer');
  assert.equal(fleet.error, 'polysim did not answer');
  fleet.list(result);
  assert.equal(fleet.error, null);
});

test('each action makes a line for the thread and a preface for the next message', () => {
  const [sim, off] = fixtureRows();
  const at = new Date(2026, 9, 14, 22, 41).getTime();
  const later = at + 60 * 1000;
  assert.equal(actionLine({ kind: 'start', row: off, at }), 'You started strat-micro-recorder · te-polymarket-btc-updown-5m · 22:41');
  assert.equal(actionLine({ kind: 'stop', row: sim, at }), 'You stopped strat-micro-recorder · te-binance-spot-btcusdt · 22:41');
  assert.equal(actionLine({ kind: 'mode', row: off, mode: 'sim', at }), 'You set strat-micro-recorder · te-polymarket-btc-updown-5m to sim · 22:41');

  const preface = createPreface();
  assert.equal(preface.take(), null, 'nothing to say yet');
  preface.add({ kind: 'start', row: off, at });
  preface.add({ kind: 'mode', row: sim, mode: 'sim', at: later });
  const taken = preface.take();
  assert.equal(taken, '[Jet: the user started strat-micro-recorder · te-polymarket-btc-updown-5m at 22:41; the user set strat-micro-recorder · te-binance-spot-btcusdt to sim at 22:42]');
  assert.equal(preface.take(), null, 'it is told once');

  // The send was refused before Claude read it: what was taken goes back in front of newer actions.
  preface.add({ kind: 'stop', row: sim, at: later });
  preface.giveBack(taken);
  assert.equal(preface.take(), '[Jet: the user started strat-micro-recorder · te-polymarket-btc-updown-5m at 22:41; the user set strat-micro-recorder · te-binance-spot-btcusdt to sim at 22:42; the user stopped strat-micro-recorder · te-binance-spot-btcusdt at 22:42]');
});
