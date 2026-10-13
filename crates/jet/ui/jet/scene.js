// Scenery that rushes past when Jet zooms: mountains, hills, houses and trees
// on separate layers, each scrolling at its own rate, plus speed streaks behind
// Jet. The scenery is not part of the character: it reads the speed track and
// nothing else, draws in the ink colour at low opacity, and fades away at rest.

import { clamp } from './maths.js';
import { cssColour } from './state.js';

const SVG = 'http://www.w3.org/2000/svg';
const TILE = 320; // one repeat of each layer, in rig units
const GROUND_Y = 88;
const FADE_MS = 220;

const LAYERS = [
  { name: 'mountains', factor: 0.12, opacity: 0.07, shapes: () => mountains() },
  { name: 'hills', factor: 0.3, opacity: 0.1, shapes: () => hills() },
  { name: 'village', factor: 0.75, opacity: 0.22, shapes: () => village() },
  { name: 'tufts', factor: 1, opacity: 0.35, shapes: () => tufts() },
];

function el(name, attrs) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function mountains() {
  return [el('path', { d: 'M0 88 L0 66 L28 46 L52 60 L84 38 L112 58 L140 48 L172 64 L204 42 L232 56 L262 40 L292 60 L320 50 L320 88 Z' })];
}

function hills() {
  return [el('path', { d: 'M0 88 L0 74 Q40 60 80 72 T160 70 T240 74 T320 68 L320 88 Z' })];
}

function village() {
  const shapes = [];
  for (const x of [24, 176, 272]) {
    shapes.push(el('path', { d: 'M' + x + ' 88 V76 h14 V88 Z' }));
    shapes.push(el('path', { d: 'M' + (x - 2) + ' 76 L' + (x + 7) + ' 66 L' + (x + 16) + ' 76 Z' }));
  }
  for (const x of [72, 118, 222, 300]) {
    shapes.push(el('circle', { cx: x, cy: 77, r: 5.5 }));
    shapes.push(el('rect', { x: x - 0.9, y: 81, width: 1.8, height: 7 }));
  }
  return shapes;
}

function tufts() {
  const shapes = [];
  for (let x = 6; x < TILE; x += 26) {
    shapes.push(el('path', { d: 'M' + x + ' 88 l1.6 -3.2 l1.6 3.2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linecap': 'round' }));
  }
  return shapes;
}

/**
 * Builds the scenery inside `parent`, behind whatever is appended after it.
 * @param {SVGElement} parent
 */
export function mountScene(parent) {
  const root = el('g', { class: 'scene', opacity: 0 });
  const layers = LAYERS.map((layer) => {
    const group = el('g', { fill: 'currentColor', opacity: layer.opacity });
    for (const shift of [0, TILE]) {
      const tile = el('g', { transform: 'translate(' + shift + ' 0)' });
      for (const shape of layer.shapes()) tile.append(shape);
      group.append(tile);
    }
    root.append(group);
    return { group, factor: layer.factor };
  });
  root.append(el('line', { x1: -400, y1: GROUND_Y, x2: 400, y2: GROUND_Y, stroke: 'currentColor', 'stroke-width': 0.8, opacity: 0.25 }));
  const streaks = [el('line', { x1: 24, y1: 52, x2: 24, y2: 52 }), el('line', { x1: 18, y1: 59, x2: 18, y2: 59 }), el('line', { x1: 24, y1: 66, x2: 24, y2: 66 })];
  const streakGroup = el('g', { fill: 'none', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-dasharray': '9 7' });
  for (const s of streaks) streakGroup.append(s);
  root.append(streakGroup);
  parent.append(root);

  let distance = 0;
  let visible = 0;

  /**
   * @param {number} dt   ms since the last frame
   * @param {import('./state.js').JetState} state
   */
  return function update(dt, state) {
    const speed = state.speed;
    distance += (speed * dt) / 1000;
    for (const { group, factor } of layers) {
      const shift = -((distance * factor) % TILE);
      group.setAttribute('transform', 'translate(' + shift.toFixed(2) + ' 0)');
    }
    const target = speed > 4 ? 1 : 0;
    visible += (target - visible) * (1 - Math.exp(-dt / FADE_MS));
    root.setAttribute('opacity', visible.toFixed(3));

    const length = clamp(speed * 0.09, 0, 34);
    const strength = clamp(speed / 220, 0, 1) * 0.45;
    streakGroup.setAttribute('stroke', cssColour(state.colour));
    streakGroup.setAttribute('opacity', strength.toFixed(3));
    streakGroup.setAttribute('stroke-dashoffset', (-(distance % 1000)).toFixed(1));
    const scales = [1, 1.3, 0.8];
    streaks.forEach((s, i) => s.setAttribute('x2', (Number(s.getAttribute('x1')) - length * scales[i]).toFixed(1)));
  };
}
