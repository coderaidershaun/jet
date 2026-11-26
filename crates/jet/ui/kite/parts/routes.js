// Routes the end of the string can write. A route is one dense polyline in
// the hand's own space (x right, y up, origin at the wrist) that the string
// follows as a single unbroken stroke. The one route here is a fist with its
// middle finger raised.

import { arc, line, place, polylineLength, smooth } from '../geometry.js';

/** How much bigger than route units the written hand is drawn. */
export const HAND_SCALE = 1.2;

const HALF_WIDTH = 20;
const HEIGHT = 22;
const CORNER_RADIUS = 5;
const COLUMN_LEFT = -11.5;
const COLUMN_MIDDLE = 0;
const COLUMN_RIGHT = 11.5;

// Loops are drawn travelling along +x. The curled fingers are fuller ovals;
// the middle finger is the same stroke drawn tall, with parallel sides and a round tip.
const OVAL_CONTROLS = [[-2.0, 0], [0.8, 1.5], [2.8, 4.0], [3.3, 7.5], [2.2, 10.5], [0, 11.5], [-2.2, 10.5], [-3.3, 7.5], [-2.8, 4.0], [-0.8, 1.5], [2.0, 0]];
const FINGER_CONTROLS = [[-1.8, 0], [0.3, 2.5], [2.2, 6], [2.6, 12], [2.6, 24], [2.4, 30], [1.2, 33.5], [-1.0, 34], [-2.6, 31.5], [-2.9, 26], [-2.8, 14], [-2.4, 6], [-1.0, 2.0], [1.8, 0]];
const KNUCKLE = { sx: 1.6, sy: 1.35, controls: OVAL_CONTROLS };
const FINGER = { sx: 1.35, sy: 1.05, controls: FINGER_CONTROLS };

const loop = ({ sx, sy, controls }, count) => smooth(controls.map(([x, y]) => [x * sx, y * sy]), count);

/**
 * The fist route: along the bottom of the palm, up its side, a big loop for
 * each curled finger along the top, down the far side and back to the wrist;
 * then up through the fist and over the middle finger, crossing itself on the way down.
 * @returns {{ points: number[][], palmLength: number, totalLength: number }}
 *   `palmLength` is the length written before the pause at the wrist.
 */
export function fistRoute() {
  const knuckleHalf = 2.0 * KNUCKLE.sx;
  const palm = [
    smooth([[0, 0], [-1.2, 1.4], [-3.5, 0.6], [-7, 0.1], [-(HALF_WIDTH - CORNER_RADIUS), 0]], 24),
    arc(-(HALF_WIDTH - CORNER_RADIUS), CORNER_RADIUS, CORNER_RADIUS, CORNER_RADIUS, -90, -180),
    line([-HALF_WIDTH, CORNER_RADIUS], [-HALF_WIDTH, HEIGHT - CORNER_RADIUS]),
    arc(-(HALF_WIDTH - CORNER_RADIUS), HEIGHT - CORNER_RADIUS, CORNER_RADIUS, CORNER_RADIUS, 180, 90),
    line([-(HALF_WIDTH - CORNER_RADIUS), HEIGHT], [COLUMN_LEFT - knuckleHalf, HEIGHT]),
    place(loop(KNUCKLE, 70), [COLUMN_LEFT, HEIGHT], 0),
    line([COLUMN_LEFT + knuckleHalf, HEIGHT], [COLUMN_RIGHT - knuckleHalf, HEIGHT]),
    place(loop(KNUCKLE, 70), [COLUMN_RIGHT, HEIGHT], 0),
    line([COLUMN_RIGHT + knuckleHalf, HEIGHT], [HALF_WIDTH - CORNER_RADIUS, HEIGHT]),
    arc(HALF_WIDTH - CORNER_RADIUS, HEIGHT - CORNER_RADIUS, CORNER_RADIUS, CORNER_RADIUS, 90, 0),
    line([HALF_WIDTH, HEIGHT - CORNER_RADIUS], [HALF_WIDTH, CORNER_RADIUS]),
    arc(HALF_WIDTH - CORNER_RADIUS, CORNER_RADIUS, CORNER_RADIUS, CORNER_RADIUS, 0, -90),
    line([HALF_WIDTH - CORNER_RADIUS, 0], [3, 0]),
  ].flat();

  const fingerStart = [COLUMN_MIDDLE - 1.8 * FINGER.sx, HEIGHT];
  const fingerEnd = [COLUMN_MIDDLE + 1.8 * FINGER.sx, HEIGHT];
  const finger = [
    smooth([[3, 0], [0.5, 0.3], [-1.2, 1.8], [-2.0, 5], [-2.4, 10], [-2.7, 15], [-2.6, 19], fingerStart], 40),
    place(loop(FINGER, 110), [COLUMN_MIDDLE, HEIGHT], 0),
    smooth([fingerEnd, [3.6, 20.2], [5.0, 19.4], [6.0, 19.8]], 12),
  ].flat();

  const points = [...palm, ...finger];
  return { points, palmLength: polylineLength(palm), totalLength: polylineLength(points) };
}
