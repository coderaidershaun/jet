import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_MS, SECTIONS, START, assertKeys, assertSolidBucket, newMarket } from './fake-market-testing.mjs';

const TONES = new Set(['text', 'text2', 'bid', 'ask', 'sellFill', 'positive', 'negative', 'warning', 'invalid', 'stale', 'selected', 'focus', 'canvas']);
const assertTextTone = (value, what) => {
  assertKeys(value, ['text', 'tone'], what);
  assert.equal(typeof value.text, 'string', what);
  assert.ok(TONES.has(value.tone), what + ' has a tone word: ' + value.tone);
};
const assertRoundTrips = (line) => assert.deepEqual(JSON.parse(JSON.stringify(line)), line, 'a ' + line.kind + ' line survives JSON unchanged');

test('the market opens with hello, link, lifecycle and catalog, and its first tick carries every section in the bridge shape', () => {
  const { market } = newMarket();
  const opening = market.open();
  assert.deepEqual(opening.map((line) => line.kind), ['hello', 'link', 'lifecycle', 'catalog']);
  const [hello, link, lifecycle, catalog] = opening;

  assertKeys(hello, ['kind', 'protocol', 'bridge', 'polysim', 'tickMs', 'groupings', 'levels', 'channels']);
  assert.equal(hello.protocol, 1);
  assert.equal(hello.bridge, 'fake-workstation');
  assert.equal(hello.polysim, 'fake');
  assert.equal(hello.tickMs, 16);
  assert.deepEqual(hello.groupings.ticks.map((g) => [g.perBucket, g.label]), [[1, 'x1'], [2, 'x2'], [5, 'x5'], [10, 'x10'], [25, 'x25'], [50, 'x50'], [100, 'x100']]);
  assert.deepEqual(hello.groupings.bps.map((g) => [g.numerator, g.denominator, g.label]), [
    [1, 100, '0.01 bp'], [1, 20, '0.05 bp'], [1, 10, '0.1 bp'], [1, 4, '0.25 bp'], [1, 2, '0.5 bp'], [1, 1, '1 bp'], [2, 1, '2 bp'], [5, 1, '5 bp'],
  ]);
  assert.deepEqual(hello.levels, { min: 12, max: 30, default: 12 });
  assert.deepEqual(hello.channels, {
    system: { label: 'System', emptyNote: 'no system events' },
    orders: { label: 'Orders', emptyNote: 'no orders' },
    trades: { label: 'Pub trades', emptyNote: 'no public trades' },
    fills: { label: 'Trade fills', emptyNote: 'no fills' },
  }, 'the bridge words each channel for the tabs');

  assertKeys(link, ['kind', 'peer', 'peerIndex', 'peerCount', 'session', 'chips', 'peerClickable', 'button', 'connection']);
  assert.equal(link.peer, '127.0.0.1:9310');
  assert.equal(link.peerCount, 2, 'the settings link plus the pretend stale engine');
  assert.equal(link.peerClickable, true);
  assert.equal(link.session, 1);
  assert.equal(link.chips.length, 5);
  link.chips.forEach((chip) => assertTextTone(chip, 'a link chip'));
  assert.deepEqual(link.chips[0], { text: 'engine 127.0.0.1:9310 [1/2]', tone: 'text' });
  assert.deepEqual(link.chips[1], { text: 'CONNECTING', tone: 'text2' });
  assert.deepEqual(link.button, { label: 'STOP', assert: 'idle' });
  assert.equal(link.connection, 'connecting');

  assertKeys(lifecycle, ['kind', 'session', 'screen', 'title', 'titleTone', 'detail', 'detailTone']);
  assert.deepEqual([lifecycle.screen, lifecycle.title, lifecycle.titleTone, lifecycle.detail, lifecycle.detailTone], ['starting', 'STARTING', 'text', 'waiting for engine', 'text2']);

  assertKeys(catalog, ['kind', 'session', 'strategyId', 'title', 'badge', 'spinIntervalUs', 'instruments', 'featureNames']);
  assert.equal(catalog.strategyId, 'strat-micro-recorder');
  assert.equal(catalog.title, 'Polysim - strat-micro-recorder @ 127.0.0.1:9310');
  assert.deepEqual(catalog.badge, { text: 'SIM', tone: 'warning' });
  assert.equal(catalog.spinIntervalUs, 1_000_000);
  assert.deepEqual(catalog.instruments, [
    { id: 0, display: 'BTCUSDT', base: 'BTC', quote: 'USDT', tick: '0.01' },
    { id: 1, display: 'ETHUSDT', base: 'ETH', quote: 'USDT', tick: '0.01' },
  ]);
  assert.equal(catalog.featureNames.length, 20);
  assert.equal(new Set(catalog.featureNames).size, 20);

  const lines = market.tick();
  assert.deepEqual(lines.map((line) => line.kind), ['tick'], 'at the instant of the open nothing but the first tick is new');
  const [tick] = lines;
  assert.deepEqual(Object.keys(tick), ['kind', 'session', 'seq', ...SECTIONS], 'kind first, then the sections in the bridge order');
  assert.equal(tick.seq, 1);
  assert.equal(tick.session, 1);

  assert.deepEqual(tick.view, { instrument: 0, chartMode: 'line', domUnit: 'bps', domGrouping: { unit: 'bps', numerator: 1, denominator: 20, label: '0.05 bp' }, domLevels: 12, riskSeries: 'exposure' });

  const { ladder } = tick;
  assertKeys(ladder, ['status', 'pill', 'muted', 'mid', 'midHalfTicks', 'ticksPerBucket', 'rows', 'asks', 'bids', 'chevrons']);
  assert.equal(ladder.status, 'disconnected', 'the engine is still connecting');
  assert.deepEqual(ladder.pill, { text: 'DISCONNECTED', tone: 'invalid' });
  assert.equal(ladder.muted, true);
  assert.deepEqual(ladder.mid, { text: '118000.005', tone: 'text' });
  assert.equal(ladder.midHalfTicks, 23600001);
  assert.equal(ladder.ticksPerBucket, 59, '0.05 bp of 118000 is 59 ticks of 0.01');
  assert.equal(ladder.rows, 12);
  assert.equal(ladder.asks.length, 12);
  assert.equal(ladder.bids.length, 12);
  for (const row of [...ladder.asks, ...ladder.bids]) {
    assertKeys(row, ['tick', 'price', 'public', 'order', 'want', 'ring']);
    assert.equal(typeof row.tick, 'number');
    assert.match(row.price, /^\d+\.\d\d$/);
    assert.ok(row.public === null || /^\d+\.\d{5}$/.test(row.public));
    if (row.order) {
      assertKeys(row.order, ['qty', 'word', 'tone']);
      assert.ok(['live', 'sent', 'lost'].includes(row.order.word));
      assert.ok(TONES.has(row.order.tone));
    }
    assert.ok(row.want === null || typeof row.want === 'string');
    assert.ok([null, 'confirmed', 'inflight', 'lost', 'desired'].includes(row.ring));
  }
  assert.deepEqual([ladder.asks[0].tick, ladder.asks[0].price, ladder.bids[0].tick, ladder.bids[0].price], [11800001, '118000.01', 11800000, '118000.00']);
  assert.deepEqual(ladder.chevrons, { up: null, down: null });

  const { summary } = tick;
  assertKeys(summary, ['captions', 'bid', 'mid', 'ask', 'hover']);
  assert.deepEqual(summary.captions, { bid: 'BID delta bps', mid: 'MID', ask: 'ASK delta bps' });
  assert.deepEqual(summary.mid, { text: '118000.005', tone: 'text' });
  assert.deepEqual(summary.bid, { text: '--', tone: 'text2' }, 'no quote is shown while the book is not live');
  assert.equal(summary.hover, 'delta in basis points from mid, not a price');

  const { account } = tick;
  assertKeys(account, ['notes', 'captions', 'base', 'quote', 'sides', 'gate', 'haltReason', 'reject']);
  assert.deepEqual(account.notes, []);
  assert.deepEqual(account.captions, { free: 'free', locked: 'locked', value: 'value USDT' });
  for (const [balance, label] of [[account.base, 'BTC'], [account.quote, 'USDT']]) {
    assertKeys(balance, ['label', 'free', 'locked', 'value']);
    assert.equal(balance.label, label);
    for (const field of ['free', 'locked', 'value']) assert.match(balance[field], /^-?\d+\.\d+$/);
  }
  for (const side of [account.sides.bid, account.sides.ask]) {
    assertKeys(side, ['open', 'inflight', 'lost', 'leaked']);
    for (const count of Object.values(side)) assert.ok(Number.isInteger(count) && count >= 0);
  }
  assert.equal(account.gate, 'armed');
  assert.equal(account.haltReason, null);
  assert.deepEqual(account.reject, { text: '--', tone: 'text2' });

  assert.equal(tick.features.length, 20);
  assert.deepEqual(tick.features.map((feature) => feature.name), catalog.featureNames);
  for (const feature of tick.features) {
    assertKeys(feature, ['name', 'value', 'changed', 'stale', 'hover']);
    assert.match(feature.value, /^-?\d+\.\d{4}$/);
    assert.equal(feature.hover, feature.name + '  =  ' + feature.value);
    assert.equal(feature.changed, false);
    assert.equal(feature.stale, false);
  }

  const { channels } = tick;
  assertKeys(channels, ['system', 'orders', 'trades', 'fills']);
  const rowKeys = {
    system: ['time', 'text', 'textTone', 'detail'],
    orders: ['time', 'tag', 'text', 'textTone', 'detail'],
    trades: ['time', 'tag', 'price', 'qty', 'detail'],
    fills: ['time', 'tag', 'price', 'qty', 'detail'],
  };
  for (const [name, expected] of Object.entries(rowKeys)) {
    const channel = channels[name];
    assertKeys(channel, ['appended', 'full', 'rows'], name);
    assert.equal(channel.full, true, name + ' is sent whole the first time');
    assert.ok(channel.rows.length >= 8 && channel.rows.length <= 12, name + ' opens with about ten backfilled rows');
    assert.equal(channel.appended, channel.rows.length, name + ' counts every row it has made');
    let newer = '99:99:99.999';
    for (const row of channel.rows) {
      assertKeys(row, expected, name + ' row');
      assert.match(row.time, /^\d\d:\d\d:\d\d\.\d{3}$/);
      assert.ok(row.time <= newer, name + ' rows are newest first');
      newer = row.time;
      assert.equal(typeof row.detail, 'string');
      if (row.tag) {
        assert.deepEqual(row.tag.tone, row.tag.side === 'BUY' ? 'bid' : 'ask');
        assertKeys(row.tag, name === 'fills' ? ['liq', 'side', 'tone'] : ['side', 'tone']);
      }
      if (row.textTone) assert.ok(TONES.has(row.textTone));
      if (row.price) assert.match(row.price, /^\d+\.\d\d$/);
      if (row.qty) assert.match(row.qty, /^\d+\.\d{5}$/);
    }
  }
  assert.deepEqual([channels.system.rows[0].text, channels.system.rows[0].textTone], ['engine ready', 'positive']);
  assert.equal(channels.fills.rows[0].tag.liq, 'mkr');

  const { latency } = tick;
  assertKeys(latency, ['header', 'columns', 'rows']);
  assert.equal(latency.header, 'LATENCY  us');
  assert.deepEqual(latency.columns, ['EXCH>RECV', 'RECV>QUEUE', 'QUEUE WAIT', 'PROCESS', 'END-TO-END', 'RND TRIP', 'SLOTS']);
  assert.deepEqual(latency.rows.map((row) => row.label), ['MARKET DATA', 'ORDER TRIP', 'HOT PATH']);
  for (const row of latency.rows) {
    assertKeys(row, ['label', 'cells']);
    assert.equal(row.cells.length, 7);
    row.cells.forEach((cell) => assertTextTone(cell, 'a latency cell'));
  }

  const { chart, risk } = tick;
  assertKeys(chart, ['generation', 'capacity', 'first', 'last', 'low', 'high', 'axis', 'buckets', 'fills', 'note', 'fillsCaption']);
  const openBucket = Math.floor(START / 1000);
  assert.equal(chart.generation, 1);
  assert.equal(chart.capacity, 300);
  assert.equal(chart.buckets.length, 121, '120 closed buckets and the open one');
  assert.equal(chart.first, openBucket - 120);
  assert.equal(chart.last, chart.first + 299, 'the window is as wide as the capacity');
  assert.deepEqual(chart.buckets.map((bucket) => bucket.i), Array.from({ length: 121 }, (_, n) => openBucket - 120 + n));
  for (const bucket of chart.buckets) {
    assertKeys(bucket, ['i', 'o', 'h', 'l', 'c', 'cl', 't', 'gap']);
    assertSolidBucket(bucket);
    assert.equal(bucket.gap, false);
    assert.ok(bucket.l <= Math.min(bucket.o, bucket.c) && bucket.h >= Math.max(bucket.o, bucket.c), 'high and low enclose open and close');
    assert.match(bucket.cl, /^\d+\.\d{3}$/, 'a close is a mid, so it has the extra decimal');
    assert.match(bucket.t, /^\d\d:\d\d:\d\d\.\d{3}$/);
    assert.ok(chart.low <= bucket.l && chart.high >= bucket.h, 'the range holds every bucket');
  }
  assert.equal(chart.buckets.at(-1).t, '12:34:56.000', 'a bucket is named by its open time');
  assert.deepEqual(chart.axis, [], 'the page picks its ticks until it sends chart_ticks');
  assert.equal(chart.note, null);
  assert.equal(chart.fillsCaption, chart.fills.length > 0);
  for (const fill of chart.fills) {
    assertKeys(fill, ['i', 'ht', 'side']);
    assert.ok(['buy', 'sell'].includes(fill.side));
    assert.ok(fill.i >= chart.first && fill.i <= chart.last);
  }

  assertKeys(risk, ['generation', 'series', 'latest', 'bounds', 'axis', 'buckets', 'note']);
  assert.equal(risk.generation, chart.generation, 'risk and chart share the generation');
  assert.equal(risk.series, 'exposure');
  assertTextTone(risk.latest, 'the latest risk value');
  assert.match(risk.latest.text, /^-?\d+\.\d\d$/);
  for (const bounds of [risk.bounds.exposure, risk.bounds.pnl]) {
    assertKeys(bounds, ['low', 'high']);
    assert.ok(bounds.low <= 0 && bounds.high >= 0 && bounds.high - bounds.low >= 1e8, 'bounds include zero and span at least one unit');
  }
  assert.deepEqual(risk.axis, { exposure: [], pnl: [] });
  assert.deepEqual(risk.buckets.map((bucket) => bucket.i), chart.buckets.map((bucket) => bucket.i));
  for (const bucket of risk.buckets) {
    assertKeys(bucket, ['i', 'e', 'p', 'el', 'pl']);
    assert.ok(Number.isInteger(bucket.e) && Number.isInteger(bucket.p));
    assert.match(bucket.el, /^-?\d+\.\d\d$/);
    assert.match(bucket.pl, /^-?\d+\.\d\d$/);
  }
  assert.equal(risk.note, null);
  assert.deepEqual(tick.gaps, { books: 0, events: 0 });

  for (const line of [...opening, tick]) {
    assert.equal(Object.keys(line)[0], 'kind');
    assertRoundTrips(line);
  }

  market.open();
  const [again] = market.tick();
  assert.equal(again.seq, 1, 'opening again starts over');
});

/** Opens a market and ticks it once per frame for `frames` frames; returns every line it sent. */
function runFrames(seed, frames) {
  const { market, clock } = newMarket(seed);
  const lines = [...market.open()];
  for (let frame = 0; frame < frames; frame += 1) {
    lines.push(...market.tick());
    clock.t += FRAME_MS;
  }
  return lines;
}

test('ticks walk the mid, keep the ladder full, send only new channel rows and only append chart and risk buckets', () => {
  const frames = Math.ceil(14_000 / FRAME_MS);
  const lines = runFrames(11, frames);
  const ticks = lines.filter((line) => line.kind === 'tick');
  assert.ok(ticks.length > 100);

  ticks.forEach((tick, n) => {
    if (n > 0) assert.equal(tick.seq, ticks[n - 1].seq + 1, 'seq rises by one per tick line');
    assert.equal(tick.session, 1);
  });

  const ladders = ticks.filter((tick) => tick.ladder).map((tick) => tick.ladder);
  let moves = 0;
  ladders.forEach((ladder, n) => {
    assert.equal(ladder.asks.length, ladder.rows);
    assert.equal(ladder.bids.length, ladder.rows);
    assert.ok(ladder.asks[0].tick > ladder.bids[0].tick);
    for (let row = 1; row < ladder.rows; row += 1) {
      assert.equal(ladder.asks[row].tick - ladder.asks[row - 1].tick, ladder.ticksPerBucket, 'ask ticks rise by the bucket size');
      assert.equal(ladder.bids[row - 1].tick - ladder.bids[row].tick, ladder.ticksPerBucket, 'bid ticks fall by the bucket size');
    }
    if (n === 0) return;
    const step = Math.abs(ladder.midHalfTicks - ladders[n - 1].midHalfTicks);
    assert.ok(step <= 2, 'the mid moves by at most one tick a frame, not ' + step + ' half-ticks');
    if (step > 0) moves += 1;
  });
  assert.ok(moves >= 5, 'the mid wanders: ' + moves + ' moves');
  assert.ok(ladders.some((ladder) => ladder.status === 'live' && ladder.pill === null && ladder.muted === false), 'the book goes live');
  assert.ok(ladders.some((ladder) => ladder.asks.concat(ladder.bids).some((row) => row.order?.word === 'live' && row.ring === 'confirmed')), 'a quote reaches the book');
  assert.ok(ladders.some((ladder) => ladder.chevrons.up || ladder.chevrons.down), 'now and then a quote is too far from the mid to show');
  for (const ladder of ladders) for (const chevron of [ladder.chevrons.up, ladder.chevrons.down]) if (chevron) assertKeys(chevron, ['text']);

  const appended = {};
  for (const tick of ticks) {
    for (const [name, channel] of Object.entries(tick.channels ?? {})) {
      const before = appended[name];
      if (before !== undefined) {
        assert.ok(channel.rows.length > 0, name + ' is sent only when it has new rows');
        assert.equal(channel.rows.length, channel.appended - before, name + ' sends exactly the rows added since the last tick');
        assert.equal(channel.full, false, name + ' sends only a delta after the first tick');
      }
      for (let n = 1; n < channel.rows.length; n += 1) assert.ok(channel.rows[n].time <= channel.rows[n - 1].time, name + ' rows are newest first');
      appended[name] = channel.appended;
    }
  }
  const firstChannels = ticks[0].channels;
  assert.ok(appended.trades > firstChannels.trades.appended + 20, 'about five trades a second');
  assert.ok(appended.orders > firstChannels.orders.appended, 'the quotes make order rows');

  const charts = ticks.filter((tick) => tick.chart).map((tick) => tick.chart);
  const risks = ticks.filter((tick) => tick.risk).map((tick) => tick.risk);
  charts.forEach((chart, n) => {
    assert.equal(chart.generation, 1, 'nothing bumps the generation here');
    assert.equal(chart.last - chart.first + 1, chart.capacity);
    assert.ok(chart.buckets.length > 0 && (n === 0 || chart.buckets.length <= 2), 'after the first tick only the open bucket and a just-closed one are sent');
    if (n > 0) assert.ok(chart.buckets[0].i >= charts[n - 1].buckets.at(-1).i, 'buckets are only appended');
    chart.buckets.forEach((bucket, k) => k > 0 && assert.equal(bucket.i, chart.buckets[k - 1].i + 1));
    chart.buckets.forEach(assertSolidBucket);
  });
  risks.forEach((risk, n) => {
    assert.equal(risk.generation, 1);
    if (n > 0) assert.ok(risk.buckets[0].i >= risks[n - 1].buckets.at(-1).i && risk.buckets.length <= 2);
  });
  const lastBucket = Math.floor((START + (frames - 1) * FRAME_MS) / 1000);
  assert.equal(charts.at(-1).buckets.at(-1).i, lastBucket, 'the open bucket follows the clock');
  assert.equal(risks.at(-1).buckets.at(-1).i, lastBucket);
  assert.equal(charts.at(-1).first, charts[0].first, 'the window holds still while it fills');

  const tables = ticks.filter((tick) => tick.features).map((tick) => tick.features);
  const everChanged = new Set();
  const everStale = new Set();
  let changedFlipped = false;
  tables.forEach((table, n) => {
    table.forEach((feature, k) => {
      if (feature.changed) everChanged.add(feature.name);
      if (feature.stale) everStale.add(feature.name);
      if (n > 0 && tables[n - 1][k].changed && !feature.changed) changedFlipped = true;
    });
  });
  assert.ok(everChanged.size >= 3 && changedFlipped, 'a feature shows changed and then stops showing it');
  assert.ok(everStale.size >= 3, 'features that do not change go stale after five seconds');
  const frozen = tables.map((table) => table.slice(-3).map((feature) => feature.value).join());
  assert.equal(new Set(frozen).size, 1, 'the last three features never change');

  const { market: slow, clock: slowClock } = newMarket(3);
  slow.open();
  let window = null;
  const gapBuckets = new Map();
  for (let second = 0; second < 200; second += 1) {
    slowClock.t += 1000;
    const chart = slow.tick().find((line) => line.kind === 'tick')?.chart;
    if (!chart) continue;
    assert.equal(chart.last - chart.first + 1, chart.capacity);
    if (window) assert.ok(chart.first >= window.first && chart.buckets.length <= 2, 'the window only moves forward');
    window = chart;
    chart.buckets.forEach(assertSolidBucket);
    for (const bucket of chart.buckets) if (bucket.gap) gapBuckets.set(bucket.i, second);
  }
  assert.equal(window.first, Math.floor((START + 200_000) / 1000) - 299, 'once 300 buckets are held the oldest one drops');
  const gapSeconds = [...gapBuckets.values()];
  assert.ok(gapSeconds[0] <= 60, 'the book loses a snapshot now and then, within a minute: ' + gapSeconds);
  assert.ok(gapSeconds.length >= 3 && gapSeconds.length <= 5, 'about once every 45 seconds: ' + gapSeconds);

  assert.deepEqual(runFrames(11, 200), runFrames(11, 200), 'the same inputs make the same lines');
  assert.notDeepEqual(runFrames(11, 200), runFrames(12, 200));
});
