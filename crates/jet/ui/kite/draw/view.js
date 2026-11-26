// Puts the kite on the page. It builds the elements once and from then on only
// changes their attributes. This is the only module that touches the DOM.

import { paint, restingFrame } from './paint.js';

const SVG = 'http://www.w3.org/2000/svg';
const UNIT_BOX = '0 0 200 240';

/** Creates an element for every node and returns the element with a mirror of its children. */
function build(node) {
  const el = document.createElementNS(SVG, node.tag);
  const children = (node.children ?? []).map(build);
  if (children.length > 0) el.append(...children.map((child) => child.el));
  return { el, children };
}

function apply(node, mounted) {
  for (const [name, value] of Object.entries(node.attrs)) mounted.el.setAttribute(name, String(value));
  (node.children ?? []).forEach((child, i) => apply(child, mounted.children[i]));
}

/**
 * Builds the kite inside `parent` (an <svg> or a <g>) and returns a function that
 * draws a frame. An <svg> with no viewBox gets the character's unit box.
 * @param {SVGElement} parent
 * @returns {(frame: import('./paint.js').Frame, view: { unitPx: number }) => void}
 */
export function mountJet(parent) {
  if (parent.tagName === 'svg' && !parent.hasAttribute('viewBox')) parent.setAttribute('viewBox', UNIT_BOX);
  parent.setAttribute('overflow', 'visible');

  const first = paint(restingFrame(), { unitPx: 1 });
  const mounted = build(first);
  apply(first, mounted);
  parent.append(mounted.el);

  return function draw(frame, view) {
    apply(paint(frame, view), mounted);
  };
}
