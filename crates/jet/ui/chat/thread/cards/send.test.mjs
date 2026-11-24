import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';
import { buttonWords, headingWords, sendOf, sentWords, tapAnswer } from './send.js';
import { colleagueOf } from './colleague.js';
import { readPane } from '../../../plan/model.js';
import { sentRow } from '../../../plan/sent.js';

const proposed = { id: 3, to: { id: 1, name: 'Shaun' }, kind: 'question', text: 'When does the budget draft land?', objectiveId: 4, objectiveTitle: 'Budget', state: 'proposed', sentAt: null, itemId: null, itemState: null };
const call = (result) => ({ id: 'c1', server: 'jet', tool: 'tasks_update', input: { command: { action: 'send' } }, ok: true, result, durationMs: 300 });

test('a proposed send card shows the name, the kind, the exact words and one button, and a sent one shows where it stands', () => {
  const card = cardOf(call({ send: proposed }));
  assert.equal(card.body.kind, 'send');
  const view = card.body.view;
  assert.equal(headingWords(view), 'Question for Shaun');
  assert.equal(buttonWords(view), 'Send to Shaun');
  assert.equal(view.text, 'When does the budget draft land?');
  assert.equal(view.objectiveTitle, 'Budget');
  assert.equal(sentWords(sendOf({ ...proposed, state: 'sent', sentAt: 5, itemState: 'answered' })), 'Sent to Shaun · Shaun answered');
  assert.equal(sendOf({ ...proposed, state: 'nonsense' }), null);
  assert.notEqual(cardOf(call({ other: 1 })).body?.kind, 'send', 'a tasks_update with no card is drawn as plain fields');
});

test('a refused tap says why in plain words, and a used card is read again', () => {
  assert.equal(tapAnswer({ kind: 'cardNotOpen' }).reread, true);
  assert.match(tapAnswer({ kind: 'sendLimit' }).words, /Try again tomorrow/);
  assert.match(tapAnswer({ kind: 'network' }).words, /Nothing was sent/);
  assert.equal(tapAnswer({ kind: 'weird', message: 'because' }).words, 'because');
});

test('the sent list reads each item to whom, when and where it stands, and a pane without it still reads', () => {
  const row = sentRow({ id: 1, to: { id: 2, name: 'Admin 123' }, kind: 'question', text: 'q?', objectiveTitle: null, state: 'answered', sentAt: 1767225600, reply: 'Friday', answeredByJet: true, chatId: 7 }, 'Europe/London');
  assert.equal(row.heading, 'Question to Admin 123');
  assert.equal(row.state, 'Admin 123 answered');
  assert.equal(row.tone, 'good');
  assert.equal(row.replyFrom, "Admin 123's Jet, from what they share with you");
  assert.equal(row.chatId, 7);
  assert.deepEqual(readPane({}).sent, []);
});

test('an entry mark reads as the colleague, with a quiet label for each outcome', () => {
  const mark = { user: 2, name: 'Admin 123', item: 1, kind: 'note', text: 'Friday', at: 1 };
  assert.equal(colleagueOf({ ...mark, kind: 'question' }).label, 'asked');
  assert.equal(colleagueOf({ ...mark, outcome: 'answered' }).label, 'answered');
  assert.deepEqual(colleagueOf({ ...mark, outcome: 'jetAnswered' }), { name: "Admin 123's Jet", text: 'Friday', label: 'answered from shared objectives', outcome: 'jetAnswered' });
  assert.equal(colleagueOf({ text: 'x' }), null);
});

// A colleague's words must reach the page as text. A tiny stand-in for the document records every element made.
test('a colleague\'s words are drawn as text and never become elements', async () => {
  const made = [];
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; made.push(this); }
    append(...kids) { this.children.push(...kids); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener() {}
    set textContent(value) { this.children = [String(value)]; }
    get textContent() { return this.children.map((kid) => (typeof kid === 'string' ? kid : kid.textContent)).join(''); }
  }
  globalThis.document = { createElement: (tag) => new Node(tag) };
  const { colleagueNode } = await import('./colleague.js');
  const hostile = '<img src=x onerror=alert(1)> **bold** <script>x()</script>';
  const node = colleagueNode({ user: 2, name: '<b>Admin</b>', kind: 'note', text: hostile, at: 1 });
  assert.equal(node.textContent, '<b>Admin</b>left a note' + hostile);
  assert.deepEqual(made.map((item) => item.tag).sort(), ['blockquote', 'p', 'p', 'span', 'span']);
  assert.equal(Object.hasOwn(node, 'innerHTML'), false);
});
