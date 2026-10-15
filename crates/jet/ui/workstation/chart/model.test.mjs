import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketAtFraction, candleColour, createChartModel, domainFromRange, lerp, segmentPoints, timeOfDay, xFraction, yFraction,
} from './model.js';

const bucket = (i, c = 150) => ({ i, o: c - 1, h: c + 2, l: c - 3, c, cl: String(c), t: '', gap: false });
const riskBucket = (i, e = 10, p = 1) => ({ i, e, p, el: String(e), pl: String(p) });
const riskFrame = (changes = {}) => ({
  generation: 1, series: 'exposure', latest: null, note: null, buckets: [],
  bounds: { exposure: { low: -50, high: 50 }, pnl: { low: -5, high: 5 } }, axis: { exposure: [{ v: 0, label: '0' }], pnl: [{ v: 1, label: '1' }] }, ...changes,
});
const chartFrame = (changes = {}) => ({
  generation: 1, capacity: 10, first: 0, last: 9, low: 100, high: 200, axis: [], buckets: [], fills: [],
  note: null, fillsCaption: false, ...changes,
});

test('the window spans capacity slots and the x and y fractions lerp inside it', () => {
  assert.deepEqual(domainFromRange(10, 12, 5), { first: 10, last: 14 }, 'not full yet: starts at the oldest bucket');
  assert.deepEqual(domainFromRange(0, 9, 5), { first: 5, last: 9 }, 'full: the newest bucket is the last slot');
  assert.deepEqual(domainFromRange(5, 9, 5), { first: 5, last: 9 }, 'a window given back to it stays put');
  assert.deepEqual(domainFromRange(3, 7, 0), { first: 7, last: 7 }, 'no capacity still leaves one slot');

  const domain = { first: 100, last: 110 };
  assert.equal(xFraction(100, domain), 0);
  assert.equal(xFraction(105, domain), 0.5);
  assert.equal(xFraction(110, domain), 1);
  assert.equal(xFraction(120, domain), 1, 'past the window clamps to the right edge');
  assert.equal(xFraction(90, domain), 0, 'before the window clamps to the left edge');
  assert.equal(xFraction(5, { first: 5, last: 5 }), 0, 'a one slot window has no span');

  const bounds = { low: 0, high: 10 };
  assert.equal(yFraction(0, bounds), 0);
  assert.equal(yFraction(5, bounds), 0.5);
  assert.equal(yFraction(99, bounds), 1);
  assert.equal(yFraction(-3, bounds), 0);
  assert.equal(yFraction(5, { low: 3, high: 3 }), 0.5, 'no span puts the value in the middle');

  assert.equal(bucketAtFraction(0, domain), 100);
  assert.equal(bucketAtFraction(0.44, domain), 104);
  assert.equal(bucketAtFraction(0.46, domain), 105, 'rounds to the nearest slot');
  assert.equal(bucketAtFraction(-1, domain), 100);
  assert.equal(bucketAtFraction(2, domain), 110);

  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.equal(lerp(20, 10, 0.25), 17.5, 'runs backwards too, which is how a y axis that grows downward is made');
});

test('a gap flag or a missing index starts a new run, and a candle takes its colour from close against open', () => {
  const runStarts = (items) => segmentPoints(items).map((point) => point.isRunStart);
  assert.deepEqual(runStarts([{ i: 1 }, { i: 2 }, { i: 3 }]), [true, false, false], 'only the first point starts a run');
  assert.deepEqual(runStarts([{ i: 1 }, { i: 2 }, { i: 5 }, { i: 6 }]), [true, false, true, false], 'a missing index breaks the line');
  assert.deepEqual(runStarts([{ i: 1 }, { i: 2, gap: true }, { i: 3 }]), [true, true, false], 'a gap flag breaks it before that bucket');
  assert.deepEqual(runStarts([{ i: 1 }, { i: 2, gap: false }]), [true, false]);
  assert.deepEqual(runStarts([]), []);
  const items = [{ i: 7, v: 1 }];
  assert.equal(segmentPoints(items)[0].item, items[0], 'each point carries its item');

  assert.equal(candleColour({ o: 10, c: 11 }), 'bid');
  assert.equal(candleColour({ o: 10, c: 9 }), 'ask');
  assert.equal(candleColour({ o: 10, c: 10 }), 'text2');
});

test('buckets append by index, the open bucket is replaced, and a new generation or a new bridge starts over', () => {
  const model = createChartModel();
  const chartIndexes = () => model.mid.points.map((point) => point.item.i);
  const riskIndexes = () => model.risk.points.map((point) => point.item.i);

  model.apply('chart', chartFrame({ buckets: [bucket(0), bucket(1), bucket(2)] }));
  assert.deepEqual(chartIndexes(), [0, 1, 2]);

  model.apply('chart', { buckets: [bucket(2, 155), bucket(3)] });
  assert.deepEqual(chartIndexes(), [0, 1, 2, 3], 'the open bucket is replaced and the new one appended');
  assert.equal(model.mid.points[2].item.c, 155);

  model.apply('chart', { fills: [{ i: 1, ht: 150, side: 'buy' }] });
  model.apply('chart', { fills: [{ i: 3, ht: 151, side: 'sell' }] });
  assert.deepEqual(model.mid.fills.map((fill) => fill.i), [1, 3], 'fills are appended');

  model.apply('chart', { first: 2, last: 11, buckets: [bucket(4)] });
  assert.deepEqual(chartIndexes(), [2, 3, 4], 'buckets before the window are dropped');
  assert.deepEqual(model.mid.fills.map((fill) => fill.i), [3], 'and so are the fills');

  model.apply('risk', riskFrame({ buckets: [riskBucket(2), riskBucket(3), riskBucket(4)] }));
  model.apply('risk', { buckets: [riskBucket(4, 99), riskBucket(5)] });
  assert.deepEqual(riskIndexes(), [2, 3, 4, 5]);
  assert.equal(model.risk.points[2].item.v, 99, 'the open risk bucket is replaced too');
  model.apply('chart', { first: 3, last: 12 });
  assert.deepEqual(riskIndexes(), [3, 4, 5], 'the risk chart follows the chart window');

  model.apply('chart', chartFrame({ generation: 2, buckets: [bucket(5)] }));
  assert.deepEqual(chartIndexes(), [5], 'a new chart generation clears the chart and loads its full window');
  assert.deepEqual(model.mid.fills, []);
  assert.deepEqual(riskIndexes(), [], 'it clears the risk chart as well, which the bridge sends again right after');
  model.apply('risk', riskFrame({ generation: 2, buckets: [riskBucket(5)] }));
  assert.deepEqual(riskIndexes(), [5]);

  model.apply('risk', riskFrame({ generation: 3, buckets: [riskBucket(6)] }));
  assert.deepEqual(riskIndexes(), [6], 'a new risk generation clears the risk chart only');
  assert.deepEqual(chartIndexes(), [5]);

  const riskValues = () => model.risk.points.map((point) => point.item.v);
  model.apply('risk', { buckets: [riskBucket(7, 20, 2)] });
  assert.deepEqual(riskValues(), [10, 20], 'exposure shows first');
  assert.deepEqual(model.risk.bounds, { low: -50, high: 50 });
  assert.deepEqual(model.risk.axis, [{ v: 0, label: '0' }]);
  model.apply('risk', { latest: { text: '20', tone: 'positive' } });
  assert.deepEqual(model.risk.latest, { text: '20', tone: 'positive' });
  model.apply('view', { riskSeries: 'pnl' });
  assert.deepEqual(riskIndexes(), [6, 7], 'switching series keeps the history');
  assert.deepEqual(riskValues(), [1, 2], 'and shows the other values');
  assert.deepEqual(model.risk.bounds, { low: -5, high: 5 }, 'inside that series own bounds');
  assert.deepEqual(model.risk.axis, [{ v: 1, label: '1' }], 'and its own axis');

  model.apply('hello', { kind: 'hello' });
  assert.deepEqual([chartIndexes(), riskIndexes()], [[], []], 'a new bridge clears both charts');
  assert.equal(model.riskSeries, 'pnl', 'the view settings stay, because the bridge sends them again');
  assert.equal(model.risk.latest, null);
  const restarted = chartFrame({ generation: 2, buckets: [bucket(1)], axis: [{ v: 150, label: '150' }] });
  delete restarted.fillsCaption;
  model.apply('chart', restarted);
  assert.deepEqual(chartIndexes(), [1], 'a restarted bridge counts generations from the start again');
  assert.deepEqual(model.mid.axis, [{ v: 150, label: '150' }]);

  model.apply('chart', { buckets: [{ ...bucket(2), c: null }, { ...bucket(3), h: null }, bucket(4)] });
  assert.deepEqual(chartIndexes(), [1, 4], 'a bucket with no price is not stored');
  assert.deepEqual(model.mid.points.map((point) => point.isRunStart), [true, true], 'so the hole it leaves breaks the line');

  assert.deepEqual(model.mid.bounds, { low: 100, high: 200 }, 'a section that leaves out a field keeps its value');
  assert.equal(model.mid.isPlottable, true);
  model.apply('chart', { note: 'no mid samples yet' });
  assert.equal(model.mid.note, 'no mid samples yet');
  assert.equal(model.mid.isPlottable, false, 'a note replaces the chart');
  model.apply('chart', { note: null });
  assert.equal(model.mid.isPlottable, true, 'null clears the note, unlike a field that is left out');

  assert.equal(model.mid.hasCaption, false, 'with no word from the bridge, no fill means no caption');
  model.apply('chart', { fills: [{ i: 1, ht: 150, side: 'sell' }] });
  assert.equal(model.mid.hasCaption, true, 'and a fill in the window brings it');
  model.apply('chart', { fillsCaption: false });
  assert.equal(model.mid.hasCaption, false, 'the bridge word wins');

  model.apply('chart', null);
  model.apply('risk', undefined);
  assert.equal(model.mid.isPlottable, true, 'a section with no content changes nothing');

  assert.equal(model.mid.mode, 'line');
  model.apply('view', { chartMode: 'candles' });
  assert.equal(model.mid.mode, 'candles');
});

test('the crosshair picks the bucket under the pointer and shows the frame\'s own labels', () => {
  const model = createChartModel();
  const closedBuckets = [0, 1, 2, 3, 4, 6, 7, 8, 9].map((i) => ({ ...bucket(i, 100 + i), cl: `price ${100 + i}` }));
  const labelled = (i) => ({ ...riskBucket(i, 10 * i, i), el: `exposure ${i}`, pl: `pnl ${i}` });
  model.apply('chart', chartFrame({ buckets: closedBuckets }));
  model.apply('risk', riskFrame({ buckets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(labelled) }));
  assert.equal(model.crosshair(0.34).timeText, null, 'no time label before the bridge has said the spin interval');
  model.apply('catalog', { spinIntervalUs: 1_000_000 });

  assert.deepEqual(model.crosshair(0.34), {
    index: 3, midClose: 103, midText: 'price 103', riskValue: 30, riskText: 'exposure 3', timeText: '00:00:03.000',
  }, 'a third of the way across is the fourth slot');
  assert.equal(model.crosshair(0).index, 0);
  assert.equal(model.crosshair(1.7).index, 9, 'a pointer past the plot reads the last slot');

  const overHole = model.crosshair(5 / 9);
  assert.deepEqual([overHole.index, overHole.midText, overHole.riskText], [5, null, 'exposure 5'], 'a slot with no bucket has no mid label');
  assert.equal(overHole.timeText, '00:00:05.000', 'the time still follows the slot');

  model.apply('view', { riskSeries: 'pnl' });
  assert.deepEqual([model.crosshair(0.34).riskValue, model.crosshair(0.34).riskText], [3, 'pnl 3']);

  model.apply('risk', { note: 'no position samples yet' });
  const midOnly = model.crosshair(0.34);
  assert.deepEqual([midOnly.midText, midOnly.riskValue, midOnly.riskText], ['price 103', null, null], 'a chart showing a note has no label');
  model.apply('chart', { note: 'no mid samples yet' });
  assert.equal(model.crosshair(0.34), null, 'with neither chart drawn there is no crosshair');
  assert.equal(model.crosshair(null), null, 'and none without a pointer');

  assert.equal(timeOfDay(3_723_004_000), '01:02:03.004');
  assert.equal(timeOfDay(86_400_000_000 + 5_000), '00:00:00.005', 'the day wraps at midnight UTC');
  assert.equal(timeOfDay(-1_000), '23:59:59.999', 'a time before the epoch counts back from midnight');
});
