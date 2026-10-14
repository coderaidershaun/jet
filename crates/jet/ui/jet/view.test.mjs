import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROP, PROP_HIDDEN, PROP_KINDS, PROP_STRIDE, RING_HIDDEN } from './state.js';
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
  eyes: [...rig.eyes.circle, 0, 0, 1],
  colour: rig.palette.rest,
  scale: 1,
  ring: RING_HIDDEN,
  speed: 0,
  ...fields,
});

const opacityOf = (el) => Number(el.getAttribute('opacity'));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-3, message + ': ' + actual + ' is not ' + expected);
const channelsOf = (fill) => fill.match(/\d+/g).map(Number);

test('an eye blends from the ground colour to a light tint of the body, and six numbers draw as before', () => {
  const { draw, byClass } = mount();
  const ground = byClass('jet-eye');
  const tinted = byClass('jet-eye-tint');
  assert.equal(ground.length, 2);
  assert.equal(tinted.length, 2);

  draw(restingJet({ eyes: [...rig.eyes.circle, 2, 2, 1] }));
  for (const el of ground) near(opacityOf(el), 0, 'a faint eye hides the ground colour');
  for (const el of tinted) near(opacityOf(el), 1, 'a faint eye shows the tint');
  const body = rig.palette.rest;
  const light = channelsOf(tinted[0].getAttribute('fill'));
  const shares = body.map((v, i) => (v < 255 ? (light[i] - v) / (255 - v) : null)).filter((share) => share !== null);
  assert.ok(shares.every((share) => share > 0 && share < 1), 'the tint is lighter than the body but not white: ' + light);
  assert.ok(Math.max(...shares) - Math.min(...shares) < 0.01, 'the tint is the body colour mixed toward white: ' + light);
  for (const [i, el] of tinted.entries()) {
    for (const name of ['cx', 'cy', 'rx', 'ry']) assert.equal(el.getAttribute(name), ground[i].getAttribute(name), 'both layers of an eye share its ' + name);
  }

  draw(restingJet({ eyes: [...rig.eyes.soft, 4, 4, 0.25] }));
  for (const el of ground) near(opacityOf(el), 0.75, 'a quarter tint keeps most of the ground colour');
  for (const el of tinted) near(opacityOf(el), 0.25, 'a quarter tint shows a quarter of the tint');

  draw(restingJet({ eyes: [...rig.eyes.soft, 4, 4] }));
  for (const el of ground) near(opacityOf(el), 1, 'six numbers draw the eyes in the ground colour');
  for (const el of tinted) near(opacityOf(el), 0, 'six numbers show no tint');
  assert.equal(ground[0].getAttribute('rx'), '4');

  for (const el of [...ground, ...tinted]) {
    assert.equal(el.getAttribute('style'), null, 'the page forbids inline styles');
    assert.deepEqual(el.style, {}, 'the page forbids inline styles');
  }
});

/** The hidden props with one slot set to x, y, rotate, scale and opacity. */
function propWith(slot, [x, y, rotate, scale, opacity]) {
  const prop = PROP_HIDDEN.slice();
  const at = slot * PROP_STRIDE;
  prop[at + PROP.X] = x;
  prop[at + PROP.Y] = y;
  prop[at + PROP.ROTATE] = rotate;
  prop[at + PROP.SCALE] = scale;
  prop[at + PROP.OPACITY] = opacity;
  return prop;
}

test('a prop slot draws its kind where the track puts it and hides at opacity 0', () => {
  const { draw, byClass } = mount();
  const slots = byClass('jet-prop');
  assert.equal(slots.length, 2);

  draw(restingJet());
  for (const slot of slots) assert.equal(slot.getAttribute('opacity'), '0', 'a state with no props, like the drawer\'s, hides both slots');

  for (const kind of PROP_KINDS) {
    draw(restingJet({ prop: propWith(1, [30, 70, -15, 1.5, 0.5]), propKinds: [null, kind] }));
    assert.ok(slots[1].children.length > 0, kind + ' draws a shape');
    near(opacityOf(slots[1]), 0.32 * 0.5, kind + ' is drawn as faint as the spin grooves');
    const placed = slots[1].getAttribute('transform').match(/^translate\((\S+) (\S+)\) rotate\((\S+)\) scale\((\S+)\)$/);
    assert.ok(placed, kind + ' is moved, turned and sized');
    assert.deepEqual(placed.slice(1).map(Number), [30, 70, -15, 1.5]);
    assert.equal(slots[0].getAttribute('opacity'), '0', 'the other slot stays hidden');
  }

  draw(restingJet({ prop: propWith(1, [30, 70, -15, 1.5, 0.2]), propKinds: [null, null] }));
  assert.ok(slots[1].children.length > 0, 'a prop keeps its shape while it fades out after its clip');
  draw(restingJet({ prop: propWith(1, [30, 70, -15, 1.5, 0]), propKinds: [null, null] }));
  assert.equal(slots[1].getAttribute('opacity'), '0');
  for (const slot of slots) assert.deepEqual(slot.style, {}, 'the page forbids inline styles');
});
