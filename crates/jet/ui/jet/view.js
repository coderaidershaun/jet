// Draws a JetState: two prop slots behind the body, one path for the body, a
// stroked ring for the loop or the spin grooves, eyes in two layers (the ground
// colour and a light tint of the body), and a scale about the foot. This is the
// only module that touches the DOM on Jet's behalf.

import { clamp, lerp } from './maths.js';
import { pathFrom } from './rig.js';
import { PROP, PROP_HIDDEN, PROP_SLOTS, PROP_STRIDE, RING, cssColour } from './state.js';

const SVG = 'http://www.w3.org/2000/svg';
const WHITE = [255, 255, 255];
const EYE_TINT_TOWARD_WHITE = 0.6;
// Props are as faint as the spin grooves, so Jet stays the only saturated thing on the stage.
const PROP_OPACITY = 0.32;
const MAX_HIDDEN_OPACITY = 0.005;

function svgElement(name, attributes) {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  return el;
}

const STROKED = { stroke: 'currentColor', 'stroke-linecap': 'round' };

// Each kind of prop in rig units, drawn around the point Jet holds it by.
const PROP_SHAPES = {
  umbrella: () => [
    svgElement('path', { d: 'M-24 -36 A24 18 0 0 1 24 -36 Z', fill: 'currentColor' }),
    svgElement('line', { x1: 0, y1: 0, x2: 0, y2: -36, 'stroke-width': 2.4, ...STROKED }),
  ],
  bat: () => [svgElement('path', { d: 'M-1.4 0 L-3 -30 A3 3 0 0 1 3 -30 L1.4 0 A1.4 1.4 0 0 1 -1.4 0 Z', fill: 'currentColor' })],
  ball: () => [svgElement('circle', { r: 4, fill: 'currentColor' })],
  // The rope reaches far above Jet's box. It shows only because the drawing may spill outside the box.
  rope: () => [svgElement('line', { x1: 0, y1: -600, x2: 0, y2: 0, 'stroke-width': 1.6, ...STROKED })],
};

/**
 * Builds Jet inside `parent` (an <svg> or a <g>) and returns a draw function.
 * An <svg> with no viewBox gets the rig's unit box.
 * @param {SVGElement} parent
 * @param {import('./rig.js').Rig} rig
 */
export function mountJet(parent, rig) {
  if (parent.tagName === 'svg' && !parent.hasAttribute('viewBox')) {
    parent.setAttribute('viewBox', '0 0 ' + rig.unit + ' ' + rig.unit);
  }
  parent.setAttribute('overflow', 'visible');

  const group = document.createElementNS(SVG, 'g');
  group.setAttribute('class', 'jet');
  const body = document.createElementNS(SVG, 'path');
  body.setAttribute('stroke-width', String(rig.stroke));
  body.setAttribute('stroke-linejoin', 'round');
  const ring = document.createElementNS(SVG, 'ellipse');
  ring.setAttribute('class', 'jet-ring');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke-linecap', 'round');
  // Each eye has two layers. The stylesheet fills the first with the ground
  // colour, and a stylesheet rule beats a fill attribute, so the light tint
  // needs a second layer of its own. The tint fades one in and the other out.
  const groundEyes = [svgElement('ellipse', { class: 'jet-eye' }), svgElement('ellipse', { class: 'jet-eye' })];
  const tintEyes = [svgElement('ellipse', { class: 'jet-eye-tint' }), svgElement('ellipse', { class: 'jet-eye-tint' })];
  const propSlots = Array.from({ length: PROP_SLOTS }, () => svgElement('g', { class: 'jet-prop', opacity: 0 }));
  /** @type {(string | null)[]} the kind each slot last drew */
  const propsDrawn = propSlots.map(() => null);
  group.append(...propSlots, body, ring, ...groundEyes, ...tintEyes);
  parent.append(group);

  const [footX, footY] = rig.foot;

  /**
   * @param {number[]} eyes
   * @param {number[]} colour
   */
  function drawEyes(eyes, colour) {
    const [lx, ly, rx, ry, radiusX, radiusY, tint = 0] = eyes;
    const faint = clamp(tint, 0, 1);
    const tintColour = cssColour(lerp(colour, WHITE, EYE_TINT_TOWARD_WHITE));
    for (const [left, right] of [groundEyes, tintEyes]) {
      left.setAttribute('cx', String(lx));
      left.setAttribute('cy', String(ly));
      right.setAttribute('cx', String(rx));
      right.setAttribute('cy', String(ry));
      for (const el of [left, right]) {
        el.setAttribute('rx', String(Math.max(0, radiusX)));
        el.setAttribute('ry', String(Math.max(0, radiusY)));
      }
    }
    for (const el of groundEyes) el.setAttribute('opacity', (1 - faint).toFixed(3));
    for (const el of tintEyes) {
      el.setAttribute('opacity', faint.toFixed(3));
      el.setAttribute('fill', tintColour);
    }
  }

  /**
   * @param {number[]} prop
   * @param {(string | null)[]} kinds
   */
  function drawProps(prop, kinds) {
    for (const [i, slot] of propSlots.entries()) {
      // A slot with no kind keeps the shape it last drew, so a prop can fade out after its clip has ended.
      const kind = kinds[i] ?? null;
      if (kind !== null && kind !== propsDrawn[i]) {
        if (!Object.hasOwn(PROP_SHAPES, kind)) throw new RangeError('there is no prop called ' + kind);
        // SMELL: a slot that gets a new kind while its old prop still shows swaps the shape at once, which
        // cuts. A clip should use the other slot, or let the old prop fade out first.
        slot.replaceChildren(...PROP_SHAPES[kind]());
        propsDrawn[i] = kind;
      }
      const at = i * PROP_STRIDE;
      const opacity = clamp(prop[at + PROP.OPACITY], 0, 1) * PROP_OPACITY;
      const shown = opacity > MAX_HIDDEN_OPACITY;
      slot.setAttribute('opacity', shown ? opacity.toFixed(3) : '0');
      if (!shown) continue;
      const place = 'translate(' + prop[at + PROP.X].toFixed(2) + ' ' + prop[at + PROP.Y].toFixed(2) + ')';
      slot.setAttribute('transform', place + ' rotate(' + prop[at + PROP.ROTATE].toFixed(2) + ') scale(' + prop[at + PROP.SCALE].toFixed(4) + ')');
    }
  }

  /** @param {import('./state.js').JetState} state */
  return function draw(state) {
    body.setAttribute('d', pathFrom(state.body));
    const colour = cssColour(state.colour);
    body.setAttribute('fill', colour);
    body.setAttribute('stroke', colour);

    const r = state.ring;
    const visible = r[RING.OPACITY] > MAX_HIDDEN_OPACITY && r[RING.RX] > 0.1;
    ring.setAttribute('opacity', visible ? r[RING.OPACITY].toFixed(3) : '0');
    if (visible) {
      ring.setAttribute('cx', r[RING.CX].toFixed(2));
      ring.setAttribute('cy', r[RING.CY].toFixed(2));
      ring.setAttribute('rx', r[RING.RX].toFixed(2));
      ring.setAttribute('ry', r[RING.RY].toFixed(2));
      ring.setAttribute('stroke-width', r[RING.WIDTH].toFixed(2));
      ring.setAttribute('stroke-dasharray', r[RING.DASH_ON].toFixed(2) + ' ' + r[RING.DASH_OFF].toFixed(2));
      ring.setAttribute('stroke-dashoffset', r[RING.OFFSET].toFixed(2));
      ring.setAttribute('transform', 'rotate(' + r[RING.ROTATE].toFixed(2) + ' ' + r[RING.CX].toFixed(2) + ' ' + r[RING.CY].toFixed(2) + ')');
      // ground colour comes from the stylesheet; the body colour is set here when the mix asks for it
      ring.style.stroke = r[RING.MIX] >= 0.5 ? colour : '';
    }

    drawEyes(state.eyes, state.colour);
    drawProps(state.prop ?? PROP_HIDDEN, state.propKinds ?? []);

    group.setAttribute('transform', 'translate(' + footX + ' ' + footY + ') scale(' + state.scale.toFixed(4) + ') translate(' + -footX + ' ' + -footY + ')');
  };
}
