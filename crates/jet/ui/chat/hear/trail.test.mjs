import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrailBars } from './trail.js';

const WIDTH = 96;

test('a bar is born for every two levels, from the louder, tall only for speech, and flows left 4 px each 64 ms until it leaves', () => {
  const cases = [
    { name: 'no levels', levels: [], at: 0, bars: [] },
    { name: 'half a bar waits for its partner', levels: [[0.5, true, 0]], at: 0, bars: [] },
    { name: 'the louder of the pair is born at the right edge', levels: [[0.25, true, 0], [0.5, true, 32]], at: 32, bars: [{ x: 96, height: 13 }] },
    {
      name: 'a later bar follows 4 px behind the one before',
      levels: [[0.25, true, 0], [0.5, true, 32], [0, true, 64], [0.25, true, 96]],
      at: 96,
      bars: [{ x: 92, height: 13 }, { x: 96, height: 7.5 }],
    },
    { name: 'a bar is still there one step before the left edge', levels: [[0.25, true, 0], [0.5, true, 32]], at: 32 + 1472, bars: [{ x: 4, height: 13 }] },
    { name: 'a bar that reaches the left edge is gone', levels: [[0.25, true, 0], [0.5, true, 32]], at: 32 + 1536, bars: [] },
    {
      name: 'speech stands up to 24 px, other sound to 6 px, silence is 2 px, and a pair is speech if either level was',
      levels: [[1, false, 0], [0.5, true, 32], [0, false, 64], [1, false, 96], [0.5, true, 128], [0, false, 160], [0, true, 192], [0, true, 224], [0, false, 256], [0, false, 288]],
      at: 288,
      bars: [{ x: 80, height: 24 }, { x: 84, height: 6 }, { x: 88, height: 13 }, { x: 92, height: 2 }, { x: 96, height: 2 }],
    },
  ];
  for (const { name, levels, at, bars } of cases) {
    const trail = createTrailBars();
    for (const [level, speech, now] of levels) trail.add(level, speech, now);
    assert.deepEqual(trail.at(at, WIDTH), bars, name);
  }
});
