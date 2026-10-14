// The one list of every clip Jet can play. The lab and the director both read it, so a
// new clip is added here and nowhere else.

import { buildAbseil } from './abseil.js';
import { buildAnnoyed } from './annoyed.js';
import { buildBatBall, buildBatBallEnd, buildDoze, buildDozeEnd } from './antics.js';
import { buildDone } from './done.js';
import { buildDrop } from './drop.js';
import { buildError } from './error.js';
import { buildExcited } from './excited.js';
import { buildHello } from './hello.js';
import { buildInterrupted } from './interrupted.js';
import { buildCreep, buildLean, buildLeanBack, buildPeer } from './lean.js';
import { buildNeedsYou } from './needs-you.js';
import { buildThinking } from './thinking.js';
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
  thinking: { label: 'Thinking', build: buildThinking, hold: false },
  excited: { label: 'Excited', build: buildExcited, hold: false },
  annoyed: { label: 'Annoyed', build: buildAnnoyed, hold: false },
  done: { label: 'Done', build: buildDone, hold: false },
  needsYou: { label: 'Needs you', build: buildNeedsYou, hold: false },
  error: { label: 'Error', build: buildError, hold: false },
  lean: { label: 'Lean', build: buildLean, hold: true },
  leanBack: { label: 'Lean back', build: buildLeanBack, hold: false },
  interrupted: { label: 'Interrupted', build: buildInterrupted, hold: false },
  peer: { label: 'Peer', build: buildPeer, hold: true },
  creep: { label: 'Creep', build: buildCreep, hold: true },
  batBall: { label: 'Bat and ball', build: buildBatBall, hold: true },
  batBallEnd: { label: 'Bat and ball ends', build: buildBatBallEnd, hold: false },
  doze: { label: 'Doze', build: buildDoze, hold: true },
  dozeEnd: { label: 'Doze ends', build: buildDozeEnd, hold: false },
  drop: { label: 'Drop', build: buildDrop, hold: false },
  abseil: { label: 'Abseil', build: buildAbseil, hold: false },
};
