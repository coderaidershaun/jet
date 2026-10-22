import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCatmullRom } from '../geometry.js';
import { HOVER_Y } from '../parts/forms.js';
import { STROKE_FLOOR_PX, paint, restingFrame } from './paint.js';

const everyNode = (node) => [node, ...(node.children ?? []).flatMap(everyNode)];
const withClass = (tree, name) => everyNode(tree).filter((node) => node.attrs.class === name);
const only = (tree, name) => {
  const found = withClass(tree, name);
  assert.equal(found.length, 1, `exactly one .${name}`);
  return found[0];
};
const shapeOf = (tree) => everyNode(tree).map((node) => `${node.tag}.${node.attrs.class}`);

const STRING = [[100, 173], [98, 190], [101, 205], [104, 220]];

test('paint draws the body, string, hands and eyes as attributes with no style', () => {
  const frame = { ...restingFrame(), string: STRING };
  const tree = paint(frame, { unitPx: 1 });

  assert.equal(tree.attrs.class, 'jet');
  assert.equal(only(tree, 'jet-shape').attrs.d.match(/C/g).length, 52);
  assert.equal(only(tree, 'jet-string').attrs.d, openCatmullRom(STRING));
  assert.equal(only(tree, 'jet-string').attrs.opacity, 1);
  for (const name of ['jet-eye-left', 'jet-eye-right']) {
    const eye = only(tree, name);
    assert.deepEqual(eye.children.map((child) => child.attrs.class), ['jet-eye-shape', 'jet-arch']);
  }
  assert.equal(only(tree, 'jet-eye-right').attrs.transform, 'translate(115.5 89.9)');
  for (const { attrs } of everyNode(tree)) assert.ok(!('style' in attrs), 'the page forbids inline styles');

  const noString = paint({ ...frame, string: null }, { unitPx: 1 });
  assert.deepEqual(only(noString, 'jet-string').attrs.d, '');
  assert.equal(only(noString, 'jet-string').attrs.opacity, 0);
  assert.deepEqual(shapeOf(noString), shapeOf(tree), 'the tree has the same shape without a string');

  const foldOpacity = (lift) => Number(only(paint({ ...frame, lift }, { unitPx: 1 }), 'jet-hand-right').children[0].attrs.opacity);
  assert.equal(foldOpacity([0, 0]), 0);
  assert.ok(foldOpacity([0, 30]) > 0.9);
  const lifted = paint({ ...frame, lift: [0, 30], liftSpeed: [0, 200] }, { unitPx: 1 });
  assert.equal(Number(only(lifted, 'jet-hand-left').children[0].attrs.opacity), 0, 'the other hand stays folded away');
  assert.deepEqual(shapeOf(lifted), shapeOf(tree), 'the tree has the same shape lifted');

  const standing = paint({ ...frame, y: 0, roll: 5, pivot: [100, 173] }, { unitPx: 1 });
  assert.equal(only(tree, 'jet-body').attrs.transform, 'translate(0 0) translate(100 88) rotate(0) scale(1 1) translate(-100 -88)');
  assert.equal(only(standing, 'jet-body').attrs.transform, `translate(0 ${HOVER_Y}) translate(100 173) rotate(5) scale(1 1) translate(-100 -173)`);

  const spinning = paint({ ...frame, form: 1, lift: [0, 30], eyes: { ...frame.eyes, lids: [0, 0] } }, { unitPx: 1 });
  assert.equal(Number(only(spinning, 'jet-hand-right').children[0].attrs.opacity), 0, 'the spinner has no hands');
  assert.equal(Number(only(spinning, 'jet-eye-left').children[0].attrs.opacity), 0, 'the spinner has no eyes');
  assert.equal(Number(only(paint({ ...frame, form: 0.1 }, { unitPx: 1 }), 'jet-eye-left').children[0].attrs.opacity), 1);
});

test('strokes never go under 0.8 px', () => {
  const frame = { ...restingFrame(), string: STRING, lift: [0, 30], liftSpeed: [0, 200] };
  const strokes = (unitPx) => everyNode(paint(frame, { unitPx })).filter((node) => 'stroke-width' in node.attrs);

  assert.equal(strokes(0.24).length, 9, 'the string, two creases, four speed lines and two arches');
  for (const { attrs } of strokes(0.24)) assert.ok(attrs['stroke-width'] * 0.24 >= STROKE_FLOOR_PX, `${attrs.class} is thinner than ${STROKE_FLOOR_PX} px`);
  assert.deepEqual(strokes(1).map((node) => node.attrs['stroke-width']), [1.6, 1.6, 1.7, 1.7, 1.6, 1.7, 1.7, 3.2, 3.2], 'big strokes keep their own width');
});
