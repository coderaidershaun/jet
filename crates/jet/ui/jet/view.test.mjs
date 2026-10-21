import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RING_HIDDEN } from './state.js';
import { mountJet } from './view.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../rig/jet.json', import.meta.url)), 'utf8'));

// Just enough of the DOM for the view to build Jet and set attributes.
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
globalThis.document = { createElementNS: (_namespace, tagName) => new FakeElement(tagName) };

const descendants = (el) => el.children.flatMap((child) => [child, ...descendants(child)]);

function mount() {
  const svg = new FakeElement('svg');
  const draw = mountJet(svg, rig);
  const byClass = (name) => descendants(svg).filter((el) => el.getAttribute('class') === name);
  return { draw, byClass };
}

const restingJet = (fields) => ({
  body: rig.poses.circle,
  eyes: [...rig.eyes.circle, 0, 0],
  colour: rig.palette.rest,
  scale: 1,
  ring: RING_HIDDEN,
  speed: 0,
  ...fields,
});

test('the eyes draw in one layer that the stylesheet fills with the ground colour', () => {
  const { draw, byClass } = mount();
  const eyes = byClass('jet-eye');
  assert.equal(eyes.length, 2);

  draw(restingJet({ eyes: [42, 54, 58, 51, 2.8, 1.4] }));
  assert.deepEqual(['cx', 'cy', 'rx', 'ry'].map((name) => eyes[0].getAttribute(name)), ['42', '54', '2.8', '1.4']);
  assert.deepEqual(['cx', 'cy', 'rx', 'ry'].map((name) => eyes[1].getAttribute(name)), ['58', '51', '2.8', '1.4']);

  draw(restingJet({ eyes: [...rig.eyes.circle, -1, 0] }));
  assert.equal(eyes[0].getAttribute('rx'), '0', 'a size below zero draws no eye');

  for (const el of eyes) {
    assert.equal(el.getAttribute('fill'), null, 'the stylesheet sets the fill, so a fill attribute would be ignored');
    assert.equal(el.getAttribute('style'), null, 'the page forbids inline styles');
    assert.deepEqual(el.style, {}, 'the page forbids inline styles');
  }
});
