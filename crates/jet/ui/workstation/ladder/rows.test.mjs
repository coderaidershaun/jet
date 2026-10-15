import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ROWS, chevronsOf, hoveredRow, readoutLines, readoutPosition, rowGeometry, rowsThatFit, strategyCell } from './rows.js';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} is not ${expected}`);

test('the ladder fits floor(side / 8.5) rows, at most 30, and its fonts shrink with the row down to the 7 px floor', () => {
  assert.equal(rowsThatFit(0), 0, 'a hidden page fits nothing');
  assert.equal(rowsThatFit(200), 10, 'a side is 92 px, which is 10 rows of 8.5 px');
  assert.equal(rowsThatFit(800), MAX_ROWS, 'a tall page never fits more than 30');

  const roomy = rowGeometry(800, 12);
  near(roomy.rowHeight, 30.67, 'row height');
  assert.equal(roomy.scale, 1, 'a row taller than 18 px does not grow the fonts');
  assert.equal(roomy.cellFont, 13);
  assert.equal(roomy.tagFont, 9);
  assert.equal(roomy.gridFade, 1);
  assert.equal(roomy.chevronHeight, 22, 'a chevron is never taller than 22 px');

  const tight = rowGeometry(720, 22);
  near(tight.scale, 0.836, 'scale');
  near(tight.cellFont, 10.87, 'cell font');
  near(tight.tagFont, 7.53, 'a tag that still reads is kept');

  const dense = rowGeometry(400, 30);
  assert.equal(dense.cellFont, 7, 'cell text stops shrinking at 7 px');
  assert.equal(dense.tagFont, null, 'a tag below 7 px is hidden');
  assert.equal(dense.gridFade, 0.35, 'the row rules fade but never vanish');
  assert.equal(dense.chevronHeight, 16, 'a chevron is never shorter than 16 px');
});

test('the strategy cell shows the real order before the wanted quote, which reads "want"', () => {
  const order = { qty: '0.05000', word: 'live', tone: 'selected' };
  assert.deepEqual(strategyCell({ order, want: '0.05000' }), { qty: '0.05000', word: 'live', tone: 'selected' }, 'a real order wins over the wanted quote');
  assert.deepEqual(strategyCell({ order: null, want: '0.05000' }), { qty: '0.05000', word: 'want', tone: 'want' });
  assert.equal(strategyCell({ order: null, want: null }), null, 'an empty row has no strategy cell');
});

test('the pointer finds the ask row above the separator and the bid row below it, and the readout spells that row out inside the ladder', () => {
  const at = (y) => hoveredRow({ y, height: 400, rows: 12 });
  assert.deepEqual(at(183), { side: 'ask', index: 0 }, 'the ask row nearest the separator');
  assert.deepEqual(at(1), { side: 'ask', index: 11 }, 'the ask row at the top');
  assert.equal(at(200), null, 'the separator is no row');
  assert.deepEqual(at(217), { side: 'bid', index: 0 }, 'the bid row nearest the separator');
  assert.deepEqual(at(399), { side: 'bid', index: 11 }, 'the bid row at the bottom');
  assert.equal(at(-1), null);
  assert.equal(at(400), null);
  assert.equal(hoveredRow({ y: 100, height: 400, rows: 0 }), null, 'no rows, no hover');

  const row = { price: '118000.05', public: '1.25000', order: { qty: '0.05000', word: 'sent', tone: 'warning' }, want: '0.05000' };
  assert.deepEqual(readoutLines(row), ['px    118000.05', 'pub   1.25000', 'order 0.05000  sent', 'want  0.05000']);
  assert.deepEqual(readoutLines({ price: '118000.06', public: null, order: null, want: null }), ['px    118000.06', 'pub   --', 'order --', 'want  --']);

  const bounds = { width: 300, height: 400 };
  const size = { width: 120, height: 60 };
  assert.deepEqual(readoutPosition({ x: 10, y: 20 }, size, bounds), { left: 18, top: 28 }, 'the box sits just below and right of the pointer');
  assert.deepEqual(readoutPosition({ x: 290, y: 390 }, size, bounds), { left: 180, top: 340 }, 'near the edges it is pulled back inside');
  assert.deepEqual(readoutPosition({ x: 5, y: 5 }, { width: 500, height: 500 }, bounds), { left: 0, top: 0 }, 'a box bigger than the ladder never goes negative');
});

test("a chevron shows for each quote off the rows, with the bridge's text", () => {
  assert.deepEqual(chevronsOf({ chevrons: { up: { text: '12.50' }, down: null } }), { up: '12.50', down: null }, 'a quote above the asks');
  assert.deepEqual(chevronsOf({ chevrons: { up: null, down: { text: '3.25' } } }), { up: null, down: '3.25' }, 'a quote below the bids');
  assert.deepEqual(chevronsOf({ chevrons: { up: { text: '1' }, down: { text: '2' } } }), { up: '1', down: '2' }, 'both at once');
  assert.deepEqual(chevronsOf(null), { up: null, down: null }, 'nothing received yet');
});
