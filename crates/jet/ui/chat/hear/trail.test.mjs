import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrailBars } from './trail.js';

const WIDTH = 96;

test('a bar is born for every two levels, from the louder, and flows left 4 px each 64 ms until it leaves', () => {
  const cases = [
    { name: 'no levels', levels: [], at: 0, bars: [] },
    { name: 'half a bar waits for its partner', levels: [[0.5, 0]], at: 0, bars: [] },
    { name: 'the louder of the pair is born at the right edge', levels: [[0.2, 0], [0.7, 32]], at: 32, bars: [{ x: 96, level: 0.7 }] },
    {
      name: 'a later bar follows 4 px behind the one before',
      levels: [[0.2, 0], [0.7, 32], [0, 64], [0.1, 96]],
      at: 96,
      bars: [{ x: 92, level: 0.7 }, { x: 96, level: 0.1 }],
    },
    { name: 'a bar is still there one step before the left edge', levels: [[0.2, 0], [0.7, 32]], at: 32 + 1472, bars: [{ x: 4, level: 0.7 }] },
    { name: 'a bar that reaches the left edge is gone', levels: [[0.2, 0], [0.7, 32]], at: 32 + 1536, bars: [] },
  ];
  for (const { name, levels, at, bars } of cases) {
    const trail = createTrailBars();
    for (const [level, now] of levels) trail.add(level, now);
    assert.deepEqual(trail.at(at, WIDTH), bars, name);
  }
});
