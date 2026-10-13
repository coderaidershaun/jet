// Draws a JetState: one path for the body, a stroked ring for the loop or the
// spin grooves, two ellipses for the eyes, a scale about the foot. This is the
// only module that touches the DOM on Jet's behalf.

import { RING, cssColour, pathFrom } from './rig.js';

const SVG = 'http://www.w3.org/2000/svg';

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
  const eyeLeft = document.createElementNS(SVG, 'ellipse');
  const eyeRight = document.createElementNS(SVG, 'ellipse');
  eyeLeft.setAttribute('class', 'jet-eye');
  eyeRight.setAttribute('class', 'jet-eye');
  group.append(body, ring, eyeLeft, eyeRight);
  parent.append(group);

  const [footX, footY] = rig.foot;

  /** @param {import('./player.js').JetState} state */
  return function draw(state) {
    body.setAttribute('d', pathFrom(state.body));
    const colour = cssColour(state.colour);
    body.setAttribute('fill', colour);
    body.setAttribute('stroke', colour);

    const r = state.ring;
    const visible = r[RING.OPACITY] > 0.005 && r[RING.RX] > 0.1;
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

    const [lx, ly, rx, ry, radiusX, radiusY] = state.eyes;
    eyeLeft.setAttribute('cx', String(lx));
    eyeLeft.setAttribute('cy', String(ly));
    eyeRight.setAttribute('cx', String(rx));
    eyeRight.setAttribute('cy', String(ry));
    for (const eye of [eyeLeft, eyeRight]) {
      eye.setAttribute('rx', String(Math.max(0, radiusX)));
      eye.setAttribute('ry', String(Math.max(0, radiusY)));
    }
    group.setAttribute('transform', 'translate(' + footX + ' ' + footY + ') scale(' + state.scale.toFixed(4) + ') translate(' + -footX + ' ' + -footY + ')');
  };
}
