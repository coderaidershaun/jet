// The one list of every clip Jet can play. The lab and the director both read it, so a
// new clip is added here and nowhere else.

import { buildHello } from './hello.js';
import { buildWorking, buildWorkingEnd } from './working.js';
import { buildZoom } from './zoom.js';

/**
 * @typedef {object} CatalogueEntry
 * @property {string} label
 * @property {(rig: import('../rig.js').Rig, p: import('../clip.js').Params, options?: object) => import('../clip.js').Clip} build
 * @property {boolean} hold   true for a clip that ends away from the circle on purpose
 */

/** @type {Record<string, CatalogueEntry>} */
export const CLIPS = {
  hello: { label: 'Hello', build: buildHello, hold: false },
  zoom: { label: 'Zoom', build: buildZoom, hold: false },
  working: { label: 'Working', build: buildWorking, hold: true },
  workingEnd: { label: 'Working ends', build: buildWorkingEnd, hold: false },
};
