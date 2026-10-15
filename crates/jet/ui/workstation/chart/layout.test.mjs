import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisEntries, fractionAt, legibleTickCeiling, pillRect, stackLayout } from './layout.js';

test('the stack splits 70 / 30 under a 30 px strip, each plot is inset 10 with a 72 px gutter, and a pill stays inside the stack', () => {
  const layout = stackLayout(400, 500);
  assert.equal(layout.split, 350, 'the mid chart takes 70% of the height');
  assert.equal(layout.riskTop, 380, 'the risk chart starts under the 30 px strip');
  assert.deepEqual(layout.mid, { left: 10, top: 10, right: 318, bottom: 340 });
  assert.deepEqual(layout.risk, { left: 10, top: 390, right: 318, bottom: 490 });

  assert.equal(stackLayout(400, 100).risk, null, 'a risk chart too short for its padding has no plot');
  assert.notEqual(stackLayout(400, 100).mid, null);
  assert.deepEqual([stackLayout(82, 500).mid, stackLayout(82, 500).risk], [null, null], 'the gutter leaves no width');

  assert.equal(fractionAt(10, layout), 0);
  assert.equal(fractionAt(164, layout), 0.5);
  assert.equal(fractionAt(318, layout), 1);
  assert.ok(fractionAt(340, layout) > 1, 'a pointer in the gutter is not clamped');
  assert.equal(fractionAt(100, stackLayout(82, 500)), null, 'no plot, no fraction');

  const pill = (anchorX, anchorY) => pillRect({ anchorX, anchorY, textWidth: 40, textHeight: 13, layout });
  assert.deepEqual(pill(100, 50), { x: 108, y: 43.5, width: 52, height: 19 }, 'beside the hairline, centred on the anchor');
  assert.equal(pill(380, 50).x, 348, 'pushed back in from the right edge');
  assert.equal(pill(100, 495).y, 481, 'pushed back in from the bottom edge');
  assert.equal(pill(100, 2).y, 0, 'pushed back in from the top edge');
});

test('the tick ceiling is floor(h / 22) in single precision, and zero when h / 13.2 is under 5', () => {
  assert.equal(legibleTickCeiling(65), 0);
  assert.equal(legibleTickCeiling(66), 0, 'single precision puts 66 / 13.2 just under 5');
  assert.equal(legibleTickCeiling(67), 3);
  assert.equal(legibleTickCeiling(220), 10);
  assert.equal(legibleTickCeiling(400), 18);
  assert.equal(legibleTickCeiling(-5), 0);

  const axis = [{ v: 100, label: '1.00' }, { v: 200, label: '2.00' }];
  assert.deepEqual(axisEntries(axis, 220), axis, 'a tall plot shows the entries the frame sent');
  assert.deepEqual(axisEntries(axis, 65), [], 'a short plot shows none');
  assert.deepEqual(axisEntries(undefined, 220), []);
  assert.deepEqual(axisEntries(null, 220), []);
});
