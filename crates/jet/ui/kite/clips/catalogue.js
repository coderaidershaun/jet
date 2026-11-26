// The one list of every clip Jet can play. The director reads it, so a new
// clip is added here and nowhere else.

import { buildDrift } from './drift.js';
import { buildFly } from './fly.js';
import { buildInsulted } from './insulted.js';
import { buildHello } from './hello.js';
import { buildSettle } from './settle.js';
import { buildWorking, buildWorkingEnd } from './working.js';

/**
 * @typedef {object} CatalogueEntry
 * @property {(start: import('../clip.js').Start, options?: object) => import('../clip.js').Clip} build
 * @property {boolean} hold   true for a clip that ends away from rest on purpose, as the spinner and the drift do
 */

/** @type {Record<string, CatalogueEntry>} */
export const CLIPS = {
  insulted: { build: buildInsulted, hold: false },
  hello: { build: buildHello, hold: false },
  fly: { build: buildFly, hold: false },
  settle: { build: buildSettle, hold: false },
  working: { build: buildWorking, hold: true },
  drift: { build: buildDrift, hold: true },
  workingEnd: { build: buildWorkingEnd, hold: false },
};
