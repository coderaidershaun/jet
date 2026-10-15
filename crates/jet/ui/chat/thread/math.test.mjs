import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTypesetter } from './math.js';

const drawing = (label) => ({ label, cloneNode: () => drawing(label) });

/** A stand-in for a `.math` element that has only what `typeset` touches. */
function formula(tex, display = false) {
  const element = {
    attributes: new Map([['data-tex', tex]]),
    classes: new Set(display ? ['math', 'math-display'] : ['math']),
    children: [],
    text: null,
    getAttribute: (name) => element.attributes.get(name) ?? null,
    setAttribute: (name, value) => element.attributes.set(name, String(value)),
    classList: { contains: (name) => element.classes.has(name), add: (name) => element.classes.add(name) },
    replaceChildren: (...nodes) => { element.children = nodes; },
    get firstChild() { return element.children[0] ?? null; },
    set textContent(text) { element.text = text; element.children = []; },
  };
  return element;
}

const page = (...elements) => ({ querySelectorAll: () => elements });

test('each formula goes through KaTeX once per mode, the newest are kept, and each is labelled', () => {
  const drawn = [];
  const draw = (tex, element, display) => {
    drawn.push((display ? 'display ' : 'inline ') + tex);
    element.replaceChildren(drawing(tex));
  };
  const typeset = createTypesetter({ draw, limit: 2 });
  const painted = [];
  const paint = (...elements) => {
    painted.push(...elements);
    typeset(page(...elements));
  };

  const [first, second] = [formula('a'), formula('a')];
  paint(first, second, formula('a', true));
  assert.deepEqual(drawn, ['inline a', 'display a'], 'one drawing for each mode');
  assert.notEqual(first.firstChild, second.firstChild, 'each element holds its own copy');

  paint(formula('a'), formula('a', true));
  assert.equal(drawn.length, 2, 'refilling the same bubble draws nothing again');

  paint(formula('a'), formula('b'), formula('a'), formula('a', true));
  assert.deepEqual(drawn.slice(2), ['inline b', 'display a'], 'the formula used last survives, the oldest is drawn again');

  for (const element of painted) {
    assert.equal(element.getAttribute('role'), 'img');
    assert.equal(element.getAttribute('aria-label'), element.getAttribute('data-tex'));
  }
});

test('a formula KaTeX cannot read keeps its TeX, is marked, and is tried again', () => {
  let attempts = 0;
  const draw = () => {
    attempts += 1;
    throw new Error('KaTeX parse error: Expected group after ^');
  };
  const typeset = createTypesetter({ draw });

  const bad = formula('x^');
  typeset(page(bad));
  assert.equal(bad.text, 'x^');
  assert.ok(bad.classes.has('math-error'));
  assert.equal(bad.getAttribute('title'), 'KaTeX parse error: Expected group after ^');
  assert.equal(bad.getAttribute('aria-label'), 'x^');

  typeset(page(formula('x^')));
  assert.equal(attempts, 2, 'a broken formula is not remembered as drawn');
});

// A tiny document with the calls KaTeX makes to build its tree. It records every attribute written.
function installFakeDocument() {
  const attributeCalls = [];
  const node = (tag) => ({
    tag,
    className: '',
    style: { cssText: '' },
    children: [],
    setAttribute: (name, value) => attributeCalls.push({ tag, name, value }),
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    cloneNode(deep) {
      const copy = node(tag);
      copy.className = this.className;
      copy.style = { ...this.style };
      if (deep) copy.children = this.children.map((child) => (child.cloneNode ? child.cloneNode(true) : child));
      return copy;
    },
  });
  globalThis.document = {
    createElement: node,
    createElementNS: (namespace, tag) => node(tag),
    createDocumentFragment: () => node('#fragment'),
    createTextNode: (text) => ({ text, cloneNode: () => ({ text }) }),
  };
  return {
    attributeCalls,
    remove: () => { delete globalThis.document; },
  };
}

const nodesTagged = (root, tag) => [root, ...(root.children || []).flatMap((child) => nodesTagged(child, tag))].filter((node) => node.tag === tag);

test('KaTeX drawings reach the page with no style attribute', () => {
  const fake = installFakeDocument();
  try {
    const typeset = createTypesetter();
    const vector = formula('\\vec{w} \\cdot \\vec{C}');
    const cases = formula('f(x)=\\begin{cases}a & x<0\\\\ b & x=0\\\\ c & x>0\\end{cases}', true);
    typeset(page(vector, cases));

    assert.equal(vector.classes.has('math-error'), false, vector.getAttribute('title'));
    assert.equal(cases.classes.has('math-error'), false, cases.getAttribute('title'));
    assert.deepEqual(fake.attributeCalls.filter((call) => call.name === 'style'), []);

    const arrows = nodesTagged(vector.firstChild, 'svg');
    assert.ok(arrows.length > 0, 'the arrows over the vectors are drawn');
    for (const arrow of arrows) assert.match(arrow.style.cssText, /width:/, 'the arrow keeps its width');
    const braces = nodesTagged(cases.firstChild, 'svg');
    assert.ok(braces.length > 0, 'the tall brace is drawn');
    for (const brace of braces) assert.notEqual(brace.style.cssText, '', 'the brace keeps its style');
  } finally {
    fake.remove();
  }
});
