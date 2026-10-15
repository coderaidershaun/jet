import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeWorkstation } from './fake-workstation.js';
import { FRAME_MS, START, assertKeys, assertSolidBucket, newMarket, seeded } from './fake-market-testing.mjs';
import { defaultSettings } from './settings.js';

/** Moves a market's clock a frame at a time and collects what it sends. */
function driveMarket(market, clock) {
  const frame = () => {
    clock.t += FRAME_MS;
    return market.tick();
  };
  const run = (ms) => {
    const lines = [];
    for (let n = 0; n < Math.ceil(ms / FRAME_MS); n += 1) lines.push(...frame());
    return lines;
  };
  const nextTick = () => {
    for (let n = 0; n < 50; n += 1) {
      const tick = frame().find((line) => line.kind === 'tick');
      if (tick) return tick;
    }
    return assert.fail('no tick line came');
  };
  /** Sends a command; returns the lines it answers at once and the next tick. */
  const send = (command) => ({ lines: market.apply(command), tick: nextTick() });
  return { frame, run, nextTick, send };
}

test('each command changes what the market sends next', () => {
  const { market, clock } = newMarket(5);
  const world = driveMarket(market, clock);
  market.open();
  world.run(2000);

  let { lines, tick } = world.send({ cmd: 'select', instrument: 1 });
  assert.deepEqual(lines, [], 'a view command answers in the next tick');
  assert.equal(tick.view.instrument, 1);
  assert.equal(tick.ladder.status, 'awaiting');
  assert.deepEqual(tick.ladder.pill, { text: 'AWAITING BOOK', tone: 'warning' });
  assert.equal(tick.ladder.muted, true);
  assert.ok(Math.abs(tick.ladder.midHalfTicks - 840001) < 10, 'a new book for ETH');
  assert.equal(tick.account.base.label, 'ETH');
  let generation = tick.chart.generation;
  assert.equal(generation, 2, 'a new instrument bumps the generation');
  assert.equal(tick.risk.generation, generation);
  assert.ok(tick.chart.buckets.length > 100 && tick.risk.buckets.length > 100, 'the whole window is sent after a bump');
  assert.ok(tick.channels.trades.rows.length >= 8, 'the channels are sent whole');
  assert.equal(tick.channels.system.rows[0].text, 'select instrument=1', 'every command adds a system row');
  assert.equal(world.run(700).filter((line) => line.kind === 'tick').at(-1).ladder.status, 'live', 'the book is back after half a second');

  ({ tick } = world.send({ cmd: 'chart_mode', mode: 'candles' }));
  assert.equal(tick.view.chartMode, 'candles');
  assert.equal(tick.channels.system.rows[0].text, 'chart_mode mode=candles');

  ({ tick } = world.send({ cmd: 'dom_unit', unit: 'ticks' }));
  assert.deepEqual(tick.view.domGrouping, { unit: 'ticks', perBucket: 1, label: 'x1' });
  assert.equal(tick.ladder.ticksPerBucket, 1);
  assert.deepEqual(tick.summary.captions, { bid: 'BID delta ticks', mid: 'MID', ask: 'ASK delta ticks' });
  assert.equal(tick.summary.hover, 'delta in ticks from mid, not a price');
  ({ tick } = world.send({ cmd: 'dom_unit', unit: 'bps' }));
  assert.deepEqual(tick.view.domGrouping, { unit: 'bps', numerator: 1, denominator: 20, label: '0.05 bp' });
  assert.equal(tick.ladder.ticksPerBucket, Math.floor(tick.ladder.midHalfTicks / 400000));
  assert.equal(tick.summary.captions.bid, 'BID delta bps');

  ({ tick } = world.send({ cmd: 'dom_grouping', unit: 'ticks', perBucket: 5 }));
  assert.equal(tick.view.domUnit, 'ticks', 'choosing a ticks grouping while the unit is bps switches the unit');
  assert.deepEqual(tick.view.domGrouping, { unit: 'ticks', perBucket: 5, label: 'x5' });
  assert.equal(tick.ladder.ticksPerBucket, 5);
  assert.deepEqual(world.send({ cmd: 'dom_unit', unit: 'bps' }).tick.view.domGrouping.label, '0.05 bp', 'each unit keeps its own grouping');
  assert.deepEqual(world.send({ cmd: 'dom_unit', unit: 'ticks' }).tick.view.domGrouping.label, 'x5');
  ({ tick } = world.send({ cmd: 'dom_grouping', unit: 'bps', numerator: 1, denominator: 10 }));
  assert.deepEqual([tick.view.domUnit, tick.view.domGrouping.label], ['bps', '0.1 bp']);
  assert.equal(tick.ladder.ticksPerBucket, Math.floor(tick.ladder.midHalfTicks / 200000));
  assert.equal(world.send({ cmd: 'dom_grouping', unit: 'ticks', perBucket: 7 }).tick.view, undefined, 'a grouping the bridge does not offer is ignored');

  for (const [asked, shown] of [[24, 24], [99, 30], [3, 12]]) {
    ({ tick } = world.send({ cmd: 'dom_levels', levels: asked }));
    assert.equal(tick.view.domLevels, shown, 'levels ' + asked + ' show ' + shown);
    assert.equal(tick.ladder.rows, shown);
    assert.equal(tick.ladder.asks.length, shown);
    assert.equal(tick.ladder.bids.length, shown);
  }
  world.send({ cmd: 'dom_levels', levels: 24 });
  assert.equal(world.send({ cmd: 'dom_fit', rows: 18 }).tick.ladder.rows, 18, 'the ladder shows what fits');
  assert.equal(world.send({ cmd: 'dom_levels', levels: 12 }).tick.ladder.rows, 12, 'and never more than the levels asked for');

  ({ tick } = world.send({ cmd: 'chart_ticks', mid: 9, risk: 5 }));
  assert.ok(tick.chart.axis.length >= 2 && tick.chart.axis.length <= 10, 'about nine price labels');
  for (const [n, mark] of tick.chart.axis.entries()) {
    assertKeys(mark, ['v', 'label']);
    assert.ok(mark.v >= tick.chart.low && mark.v <= tick.chart.high && mark.v % 2 === 0, 'a label sits on a whole tick inside the range');
    assert.equal(mark.label, (mark.v / 200).toFixed(2));
    if (n > 0) assert.ok(mark.v > tick.chart.axis[n - 1].v);
  }
  for (const marks of [tick.risk.axis.exposure, tick.risk.axis.pnl]) {
    assert.ok(marks.length >= 2 && marks.length <= 6, 'about five risk labels');
    marks.forEach((mark) => assert.match(mark.label, /^-?\d+\.\d\d$/));
  }

  ({ tick } = world.send({ cmd: 'risk_series', series: 'pnl' }));
  assert.equal(tick.view.riskSeries, 'pnl');
  assert.equal(tick.risk.series, 'pnl');
  assert.ok(tick.risk.buckets.length > 100, 'the risk chart is sent whole for the new series');
  assert.equal(tick.risk.generation, generation, 'a series change is not a generation change');

  ({ lines } = world.send({ cmd: 'assert', state: 'idle' }));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].chips[4], { text: 'asserting IDLE', tone: 'warning' });
  assert.deepEqual(lines[0].chips[3], { text: 'run RUNNING', tone: 'positive' }, 'the run chip follows only once applied');
  const applied = world.run(400).find((line) => line.kind === 'link');
  assert.deepEqual(applied.chips[4], { text: 'applied IDLE', tone: 'positive' });
  assert.deepEqual(applied.chips[3], { text: 'run IDLE', tone: 'text2' });
  assert.deepEqual(applied.button, { label: 'START', assert: 'running' });

  lines = market.apply({ cmd: 'next_peer' });
  assert.deepEqual(lines.map((line) => line.kind), ['link', 'lifecycle', 'catalog']);
  const [link, lifecycle, catalog] = lines;
  assert.deepEqual([link.peer, link.peerIndex, link.session, link.connection], ['127.0.0.1:9311', 1, 2, 'connecting']);
  assert.deepEqual(link.chips[4], { text: 'control none', tone: 'text2' }, 'a new session forgets the assertion');
  assert.deepEqual([lifecycle.session, lifecycle.screen], [2, 'starting']);
  assert.deepEqual([catalog.session, catalog.title], [2, 'Polysim - strat-micro-recorder @ 127.0.0.1:9311']);
  tick = world.nextTick();
  assert.equal(tick.session, 2);
  assert.equal(tick.chart.generation, generation + 1, 'a new session bumps the generation');
  generation += 1;
  const staleLines = world.run(2500);
  const staleLink = staleLines.find((line) => line.kind === 'link' && line.connection === 'stale');
  assert.deepEqual(staleLink.chips[1], { text: 'STALE', tone: 'stale' });
  assert.equal(staleLines.find((line) => line.kind === 'lifecycle').screen, 'live');
  const staleTicks = staleLines.filter((line) => line.kind === 'tick');
  const stale = staleTicks.at(-1).ladder;
  assert.equal(stale.status, 'stale');
  assert.match(stale.pill.text, /^STALE \d+ ms$/);
  assert.equal(stale.pill.tone, 'stale');
  assert.equal(stale.muted, true);
  const firstStale = staleTicks.findIndex((line) => line.ladder?.status === 'stale');
  assert.ok(firstStale >= 0 && firstStale < staleTicks.length - 100, 'the engine is stale for a good while');
  assert.ok(staleTicks.slice(firstStale).every((line) => !line.chart && !line.risk), 'a stale engine adds no bucket and the open one stops moving, so nothing is sent');
  staleTicks.flatMap((line) => line.chart?.buckets ?? []).forEach(assertSolidBucket);
  assert.ok(staleTicks.every((line) => !line.channels?.trades), 'a stale engine makes no trades');

  lines = market.apply({ cmd: 'next_peer' });
  assert.deepEqual([lines[0].peer, lines[0].peerIndex, lines[0].session], ['127.0.0.1:9310', 0, 3]);
  const liveLines = world.run(2000);
  assert.equal(liveLines.find((line) => line.kind === 'link' && line.connection === 'live').chips[1].text, 'LIVE');
  assert.equal(liveLines.filter((line) => line.kind === 'tick').at(-1).ladder.status, 'live', 'the next engine is live again');
  generation += 1;

  ({ lines, tick } = world.send({ cmd: 'resync' }));
  assert.deepEqual(lines.map((line) => line.kind), ['catalog']);
  assert.equal(tick.chart.generation, generation + 1);
  generation += 1;
  assert.ok(tick.chart.buckets.length > 100, 'a resync sends the whole chart');
  tick.chart.buckets.forEach(assertSolidBucket);
  assert.ok(tick.channels.system.rows.length > 3 && tick.view && tick.features && tick.latency, 'and every snapshot again');

  assert.deepEqual(market.apply({ cmd: 'pause' }), []);
  assert.deepEqual(world.run(500), [], 'nothing is sent while paused');
  lines = market.apply({ cmd: 'resume' });
  assert.deepEqual(lines.map((line) => line.kind), ['catalog'], 'resuming is a resync');
  tick = world.nextTick();
  assert.equal(tick.chart.generation, generation + 1);
  assert.ok(tick.chart.buckets.length > 100);
  tick.chart.buckets.forEach((bucket, n) => n > 0 && assert.equal(bucket.i, tick.chart.buckets[n - 1].i + 1, 'no hole after the pause'));

  assert.deepEqual(market.apply({ cmd: 'dance' }), [], 'a command the bridge does not know is ignored');
  assert.deepEqual(market.apply({}), []);
  assert.ok(!JSON.stringify(world.nextTick().channels ?? {}).includes('dance'), 'and leaves no system row');
});

test('the pretend feed runs on its clock, takes commands and is silent after stop', async () => {
  const clock = { t: START };
  const waits = [];
  const wait = (ms) => new Promise((resolve) => waits.push({ ms, resolve }));
  const feed = createFakeWorkstation({ now: () => clock.t, wait, random: seeded(2) });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Lets the feed's loop run for `ms` of clock, a frame at a time. */
  const frames = async (ms) => {
    for (let n = 0; n < Math.ceil(ms / FRAME_MS); n += 1) {
      clock.t += FRAME_MS;
      for (const pending of waits.splice(0)) pending.resolve();
      await settle();
    }
  };

  await assert.rejects(feed.command({ cmd: 'resync' }), { kind: 'io', message: 'the pretend feed is not running' });
  await feed.stop();

  const lines = [];
  let acceptedEarly = null;
  let accepted = null;
  let threw = 0;
  const consoleError = console.error;
  console.error = () => { threw += 1; };
  try {
    await feed.start(defaultSettings().workstation, (line) => {
      lines.push(line);
      if (line.kind === 'bridge') acceptedEarly = feed.command({ cmd: 'dom_levels', levels: 20 });
      if (line.kind === 'hello') accepted = feed.command({ cmd: 'chart_mode', mode: 'candles' });
      if (line.kind === 'catalog' && threw === 0) throw new Error('a listener bug');
    });
    assert.deepEqual(lines.map((line) => line.kind), ['bridge', 'hello', 'link', 'lifecycle', 'catalog'], 'Jet’s starting line, then the opening lines');
    assert.deepEqual(lines[0], { kind: 'bridge', status: 'starting', detail: 'the pretend feed' });
    await acceptedEarly;
    await accepted;
    assert.equal(waits.length, 1, 'the loop waits for one frame at a time');
    assert.equal(waits[0].ms, FRAME_MS);

    await frames(1600);
    assert.equal(threw, 1, 'a throwing listener is logged once');
  } finally {
    console.error = consoleError;
  }
  const ticks = lines.filter((line) => line.kind === 'tick');
  assert.ok(ticks.length > 20, 'ticks keep coming after a listener threw');
  assert.equal(ticks[0].view.chartMode, 'candles', 'a command sent from inside the hello was taken');
  assert.equal(ticks[0].view.domLevels, 20, 'and one sent from inside Jet’s starting line too');
  assert.ok(lines.some((line) => line.kind === 'link' && line.connection === 'live'), 'the engine goes live');
  assert.ok(lines.some((line) => line.kind === 'lifecycle' && line.screen === 'live'), 'the starting screen gives way');

  const before = lines.length;
  const done = feed.command({ cmd: 'resync' });
  assert.equal(lines.length, before, 'the answer to a command never comes inside the call');
  await done;
  assert.equal(lines.at(-1).kind, 'catalog');

  const restarted = [];
  const oldCount = lines.length;
  const abandoned = feed.command({ cmd: 'resync' });
  await feed.start(defaultSettings().workstation, (line) => restarted.push(line));
  await abandoned;
  await frames(100);
  assert.equal(lines.length, oldCount, 'a replaced run says nothing more, not even the answer to a command it had just taken');
  assert.deepEqual(restarted.slice(0, 5).map((line) => line.kind), ['bridge', 'hello', 'link', 'lifecycle', 'catalog']);
  assert.ok(restarted.length > 5, 'the new run ticks');

  await feed.stop();
  const stoppedAt = restarted.length;
  await frames(200);
  assert.equal(restarted.length, stoppedAt, 'nothing arrives after stop');
  await assert.rejects(feed.command({ cmd: 'resync' }), { kind: 'io' });
});
