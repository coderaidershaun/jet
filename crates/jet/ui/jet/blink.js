// The lid curve every blink shares: shut fast, held, opened slower a little past
// open, then settled. The idle blinks and the clips that blink all read it from here.

import { easeInOut, easeOut } from './easing.js';

/** How far past open a lid swings; the lid closure goes slightly below 0. */
export const LID_OVERSHOOT = -0.07;

/** One blink as rows of [ms, closure, easing], from the moment it starts. */
export const BLINK = Object.freeze([
  Object.freeze([60, 1, easeInOut]),
  Object.freeze([100, 1]),
  Object.freeze([200, LID_OVERSHOOT, easeOut]),
  Object.freeze([340, 0, easeInOut]),
]);
