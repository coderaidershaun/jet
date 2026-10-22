import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLive } from './live.js';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.offsetWidth = 200;
    this.scale = 0.24;
    this.left = 0;
    this.top = 0;
  }
  append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
  setAttribute(name, value) { this.attrs[name] = value; }
  hasAttribute(name) { return name in this.attrs; }
  getBoundingClientRect() {
    const scale = this.parent?.scale ?? this.scale;
    return { left: this.parent?.left ?? this.left, top: this.parent?.top ?? this.top, width: 200 * scale, height: 240 * scale };
  }
  animate() { return { finished: Promise.resolve() }; }
  getAnimations() { return []; }
}

function surface(t) {
  t.mock.method(globalThis, 'setTimeout', () => 1);
  t.mock.method(performance, 'now', () => 0);
  const frames = [];
  globalThis.document = { createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  t.after(() => { delete globalThis.document; delete globalThis.requestAnimationFrame; });
  const hero = new Element(); hero.scale = 0.6;
  const lane = new Element(); lane.top = 500; lane.left = 500;
  const live = createLive({ reducedMotion: false, heroSlot: hero, scrollToBottom() {} });
  live.start();
  const tick = (now) => frames.shift()(now);
  return { live, hero, lane, tick };
}

const snapshot = (el) => JSON.stringify(el, (key, value) => key === 'parent' ? undefined : value);

test('the host grounds lane/reduced Jet, hovers in the hero, and draws idle at thirty fps or more', (t) => {
  const { live, hero, lane, tick } = surface(t);
  live.showHero();
  tick(0);
  const node = hero.children[0];
  const group = node.children[0].children[0];
  const body = group.children.find((el) => el.attrs.class === 'jet-body');
  assert.ok(body.attrs.transform.startsWith('translate(0 0)'), 'hero starts hovering');
  const hover = snapshot(group);
  live.showInLane(lane);
  tick(33);
  assert.notEqual(snapshot(group), hover);
  assert.ok(body.attrs.transform.startsWith('translate(0 58.8)'), 'lane starts standing');
  const before = snapshot(node.children);
  tick(66);
  assert.notEqual(snapshot(node.children), before, 'idle wind and sway are drawn every 33ms');
  live.showHero();
  live.setReducedMotion(true);
  tick(100);
  assert.ok(body.attrs.transform.startsWith('translate(0 58.8)'), 'reduced motion grounds the hovering hero');
  assert.equal(node.attrs['aria-label'], 'Jet, idle');
  assert.ok(node.children[0].attrs.viewBox === '0 0 200 240');
});

test('the host uses measured scale for strokes and carries flight until its own end despite settling', (t) => {
  const { live, hero, lane, tick } = surface(t);
  live.showHero(); tick(0);
  const node = hero.children[0];
  const first = live.measure();
  assert.equal(first.fromScale, 0.6);
  assert.equal(first.first.y, 144);
  live.send(lane, 0, first);
  live.done(10);
  for (let now = 16; now <= 800; now += 16) tick(now);
  const body = node.children[0].children[0].children.find((el) => el.attrs.class === 'jet-body');
  const roll = Number(/rotate\(([^)]+)\)/.exec(body.attrs.transform)[1]);
  assert.ok(roll > 5, 'page movement in character units makes the body lean into flight');
  for (let now = 816; now <= 2500; now += 16) tick(now);
  assert.equal(node.style.transform, '', 'settle status cannot prolong the host flight');
  const all = [];
  const walk = (el) => { all.push(el); el.children.forEach(walk); }; walk(node);
  const strokes = all.filter((el) => el.attrs['stroke-width']);
  assert.ok(strokes.length > 0);
  assert.ok(strokes.every((el) => Number(el.attrs['stroke-width']) * 0.24 >= 0.8 - 1e-6));
});

const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('an old reduced-motion fade never reparents or cancels a new send after rapid stop and retry', async (t) => {
  const animations = [];
  t.mock.method(Element.prototype, 'animate', function () {
    let finish;
    const animation = { finished: new Promise((resolve) => { finish = resolve; }), cancel() { this.cancelled = true; }, finish: () => finish() };
    animations.push(animation);
    return animation;
  });
  t.mock.method(Element.prototype, 'getAnimations', () => animations.filter((animation) => !animation.cancelled));
  const { live, hero } = surface(t);
  live.setReducedMotion(true);
  live.showHero();
  const oldLane = new Element();
  const newLane = new Element();
  const node = hero.children[0];
  live.send(oldLane, 0, live.measure());
  const oldFade = animations.at(-1);
  oldFade.finish();
  await settle();
  assert.equal(node.parent, oldLane);
  const oldFadeIn = animations.at(-1);
  live.stopped(10);
  live.send(newLane, 20, live.measure());
  const newFade = animations.at(-1);
  oldFadeIn.finish();
  await settle();
  assert.ok(!newFade.cancelled, 'old cleanup must not cancel the new fade');
  newFade.finish();
  await settle();
  assert.equal(node.parent, newLane);
  const newFadeIn = animations.at(-1);
  newFadeIn.finish();
  await settle();

  live.send(oldLane, 40, live.measure());
  const delayedOldFade = animations.at(-1);
  live.stopped(50);
  assert.equal(node.parent, oldLane, 'a stop before fade-out completes still moves to its reply lane');
  live.send(newLane, 60, live.measure());
  const latestFade = animations.at(-1);
  latestFade.finish();
  await settle();
  const latestFadeIn = animations.at(-1);
  assert.equal(node.parent, newLane);
  delayedOldFade.finish();
  await settle();
  assert.equal(node.parent, newLane, 'an old fade finishing cannot move Jet back');
  assert.ok(!latestFadeIn.cancelled);
  latestFadeIn.finish();
  await settle();
});
