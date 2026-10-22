import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restingFrame } from './paint.js';
import { mountJet } from './view.js';

// Just enough of the DOM for the view to build the kite and set attributes.
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
}
let created = 0;
globalThis.document = {
  createElementNS(_namespace, tagName) {
    created++;
    return new FakeElement(tagName);
  },
};

const descendants = (el) => el.children.flatMap((child) => [child, ...descendants(child)]);

test('the view mounts once and only sets attributes', () => {
  const svg = new FakeElement('svg');
  const draw = mountJet(svg);
  const byClass = (name) => descendants(svg).filter((el) => el.getAttribute('class') === name);
  assert.equal(svg.getAttribute('viewBox'), '0 0 200 240');
  assert.equal(svg.getAttribute('overflow'), 'visible');

  const mountedCount = created;
  const mountedElements = descendants(svg);
  assert.equal(byClass('jet-shape').length, 1);
  assert.ok(byClass('jet-shape')[0].getAttribute('d').startsWith('M'));

  draw({ ...restingFrame(), y: 0, string: [[100, 231.8], [90, 236], [70, 237.5]] }, { unitPx: 0.24 });
  draw({ ...restingFrame(), form: 0.5 }, { unitPx: 1 });
  assert.equal(created, mountedCount, 'a draw creates no element');
  assert.deepEqual(descendants(svg), mountedElements, 'the same elements stay in place');

  assert.equal(byClass('jet-eye-right')[0].getAttribute('transform'), 'translate(115.5 89.9)');
  assert.equal(byClass('jet-body')[0].getAttribute('transform'), 'translate(0 0) translate(100 88) rotate(0) scale(1 1) translate(-100 -88)');
  assert.equal(byClass('jet-string')[0].getAttribute('opacity'), '0', 'the last frame had no string');

  for (const el of [svg, ...descendants(svg)]) {
    assert.equal(el.getAttribute('style'), null, 'the page forbids inline styles');
    assert.deepEqual(el.style, {}, 'the page forbids inline styles');
  }

  const group = new FakeElement('g');
  mountJet(group);
  assert.equal(group.getAttribute('viewBox'), null, 'a group gets no viewBox');
});
