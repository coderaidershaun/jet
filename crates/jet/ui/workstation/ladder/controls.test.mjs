import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LEVELS, groupingChoices, levelAt, levelFill, levelReadout, stepLevel } from './controls.js';

test('the level stepper steps and drags within 12..30 and reads "(N)" when fewer rows fit', () => {
  const range = DEFAULT_LEVELS;
  assert.deepEqual(range, { min: 12, max: 30, default: 12 }, 'the range used until hello says otherwise');

  assert.equal(stepLevel(12, -1, range), 12, 'it stops at the least');
  assert.equal(stepLevel(29, +1, range), 30);
  assert.equal(stepLevel(30, +1, range), 30, 'it stops at the most');

  assert.equal(levelAt(0, range), 12, 'the left end of the track');
  assert.equal(levelAt(1, range), 30, 'the right end of the track');
  assert.equal(levelAt(0.5, range), 21);
  assert.equal(levelAt(-1, range), 12, 'a drag past the left end');
  assert.equal(levelAt(2, range), 30, 'a drag past the right end');

  assert.equal(levelFill(21, range), 0.5);
  assert.equal(levelFill(12, range), 0);
  assert.equal(levelFill(40, range), 1);

  assert.deepEqual(levelReadout(24, 18), { value: '24', capped: '(18)' }, 'fewer rows fit than were asked for');
  assert.equal(levelReadout(12, 18).capped, null, 'everything asked for fits');
  assert.equal(levelReadout(24, null).capped, null, 'the body was never measured');
});

test('the grouping list comes from hello for the current unit, and each choice sends its own command', () => {
  const groupings = {
    ticks: [1, 2, 5, 10, 25, 50, 100].map((perBucket) => ({ perBucket, label: 'x' + perBucket })),
    bps: [[1, 100, '0.01 bp'], [1, 20, '0.05 bp'], [1, 10, '0.1 bp'], [1, 4, '0.25 bp'], [1, 2, '0.5 bp'], [1, 1, '1 bp'], [2, 1, '2 bp'], [5, 1, '5 bp']]
      .map(([numerator, denominator, label]) => ({ numerator, denominator, label })),
  };

  const bps = groupingChoices(groupings, { domUnit: 'bps', domGrouping: { unit: 'bps', numerator: 1, denominator: 20, label: '0.05 bp' } });
  assert.equal(bps.options.length, 8, 'only the basis point choices while the unit is bps');
  assert.equal(bps.selected, 1);
  assert.equal(bps.options[1].label, '0.05 bp');
  assert.deepEqual(bps.options[1].command, { cmd: 'dom_grouping', unit: 'bps', numerator: 1, denominator: 20 });

  const ticks = groupingChoices(groupings, { domUnit: 'ticks', domGrouping: { unit: 'ticks', perBucket: 5, label: 'x5' } });
  assert.equal(ticks.options.length, 7, 'only the tick choices while the unit is ticks');
  assert.equal(ticks.selected, 2);
  assert.deepEqual(ticks.options[2].command, { cmd: 'dom_grouping', unit: 'ticks', perBucket: 5 });

  const unknown = groupingChoices(groupings, { domUnit: 'ticks', domGrouping: { unit: 'ticks', perBucket: 3, label: 'x3' } });
  assert.equal(unknown.selected, -1, 'a grouping that is not in the list selects nothing');

  const early = groupingChoices(groupings, undefined);
  assert.equal(early.options.length, 8, 'before the first view the bps list shows');
  assert.equal(early.selected, -1);
  assert.deepEqual(groupingChoices(undefined, undefined), { options: [], selected: -1 }, 'before hello there is nothing to choose');
});
