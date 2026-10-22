import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARCH, KINDS, eyeOrigin, eyePath, lidState } from './eyes.js';

// The corner points of the eyes in jet-eyes-A.svg, -B.svg and -C.svg, left eye
// then right eye, and where each still draws the eye's lower lid line.
const STILLS = {
  A: {
    kind: 'lid',
    left: { origin: [70.5, 80.9], corners: [[79, 63.9], [79, 80.9], [62, 80.9]] },
    right: { origin: [101.5, 80.9], corners: [[110, 80.9], [93, 80.9], [93, 63.9]] },
  },
  B: {
    kind: 'B',
    left: { origin: [70.5, 80.9], corners: [[79, 63.9], [62, 63.9], [79, 80.9]] },
    right: { origin: [101.5, 80.9], corners: [[93, 80.9], [110, 63.9], [93, 63.9]] },
  },
  // This still draws the eye 1.28 lower; the character puts every kind's lowest point on the lid line.
  C: {
    kind: 'C',
    left: { origin: [70.5, 82.18], corners: [[75.39, 62.63], [75.39, 82.18], [65.61, 72.4]] },
    right: { origin: [101.5, 82.18], corners: [[106.39, 72.4], [96.61, 82.18], [96.61, 62.63]] },
  },
};

const corners = (d) => [...d.matchAll(/Q(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05;
function coordinates(d) {
  const values = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const pairs = [];
  for (let i = 0; i < values.length; i += 2) pairs.push([values[i], values[i + 1]]);
  return pairs;
}

test("eyes A, B and C are the stills' triangles on the lid line", () => {
  for (const [name, still] of Object.entries(STILLS)) {
    for (const [side, key] of [[-1, 'left'], [1, 'right']]) {
      const { origin, corners: inStill } = still[key];
      const want = inStill.map(([x, y]) => [x - origin[0], y - origin[1]]);
      const got = corners(eyePath(side, { kind: still.kind }));
      for (const corner of want) assert.ok(got.some((g) => near(g, corner)), `eye ${name} ${key} has the corner ${corner}`);

      const extra = got.filter((g) => !want.some((w) => near(g, w)));
      if (name !== 'A') {
        assert.equal(extra.length, 0, `eye ${name} ${key} has only the still's corners`);
        continue;
      }
      // Eye A is the lid-shaped eye at rest: its fourth corner sits on the slanted edge.
      assert.equal(extra.length, 1);
      const [from, to] = [[-side * 8.5, -17], [side * 8.5, 0]];
      const cross = (to[0] - from[0]) * (extra[0][1] - from[1]) - (to[1] - from[1]) * (extra[0][0] - from[0]);
      assert.ok(Math.abs(cross) / Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.05, 'the fourth corner lies on the slanted edge');
    }
  }
  assert.deepEqual(eyeOrigin(-1), [84.5, 89.9]);
  assert.deepEqual(eyeOrigin(1), [115.5, 89.9]);
});

test('a shut lid hides the shape and shows the arch', () => {
  assert.deepEqual(lidState(0), { scaleY: 1, shapeOpacity: 1, archOpacity: 0 });
  assert.deepEqual(lidState(1), { scaleY: 0.04, shapeOpacity: 0, archOpacity: 1 });
  assert.deepEqual(lidState(0.5), { scaleY: 0.5, shapeOpacity: 1, archOpacity: 0 });
  assert.equal(ARCH, 'M-8.5 0 Q0 -3.2 8.5 0');
});

test("every kind's lowest point is on the lid line", () => {
  assert.deepEqual(KINDS, ['round', 'lid', 'B', 'C']);
  for (const kind of KINDS) {
    for (const side of [-1, 1]) {
      for (const [anger, squint] of [[0, 0], [1, 0], [0.5, 1]]) {
        const lowest = Math.max(...coordinates(eyePath(side, { kind, anger, squint })).map((p) => p[1]));
        assert.equal(lowest, 0, `${kind} ${side} anger ${anger} squint ${squint}`);
      }
    }
  }
  assert.throws(() => eyePath(1, { kind: 'square' }), /unknown eye kind "square"/);
});
