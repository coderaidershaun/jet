// Checks how the plan pane draws a goal a colleague shares once its owner has closed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Just enough of the DOM for `h` and the icons: tags, attributes, text and children. */
function fakeNode(tag) {
  const node = {
    tagName: tag, attributes: {}, children: [], dataset: {}, style: {}, _text: '', className: '',
    setAttribute(key, value) { node.attributes[key] = String(value); },
    getAttribute(key) { return node.attributes[key] ?? null; },
    append(...kids) { for (const kid of kids) node.children.push(typeof kid === 'string' ? { text: kid, children: [] } : kid); },
    appendChild(kid) { node.children.push(kid); return kid; },
    addEventListener() {},
    get textContent() { return node._text + node.children.map((kid) => kid.textContent ?? kid.text ?? '').join(''); },
    set textContent(value) { node._text = String(value); node.children = []; },
  };
  return node;
}
globalThis.document = { createElement: fakeNode, createElementNS: (_, tag) => fakeNode(tag), addEventListener() {} };

const all = (node, found = []) => { if (node && node.tagName) { found.push(node); node.children.forEach((kid) => all(kid, found)); } return found; };

test('a shared goal its owner closed shows its status word and no days-left fact', async () => {
  const { planNodes } = await import('./view.js');
  const { readPane } = await import('./model.js');
  const pane = readPane({ sharedWithMe: [{ id: 1, owner: 'Ada', title: 'G', status: 'done', due: '2099-06-01', daysLeft: -3, steps: [{ id: 1, title: 'S', due: '2099-06-02', doneAt: null }] }] });
  const ctx = { isOpen: (key) => key === 'shared', act: {}, today: '2099-06-04', year: 2099, now: 0, timeZone: 'UTC', files: [], scope: null, overview: true };
  const row = planNodes(pane, ctx).flatMap((node) => all(node)).find((node) => node.className === 'plan-row shared');
  const facts = all(row).find((node) => node.className === 'row-facts');
  assert.equal(facts.textContent.includes('overdue'), false);
  assert.match(facts.textContent, /Done/);
  assert.equal(row.textContent.includes('late'), false);
});
