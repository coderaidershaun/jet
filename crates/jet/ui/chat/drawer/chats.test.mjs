import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatIcon, createChats } from './chats.js';
import { KITES } from '../../dom.js';

const summary = (id, kind, title, activeAt, unread = 0) => ({ id, kind, title, activeAt, unread });
const LIST = [summary(2, 'topic', 'Boats', 300), summary(1, 'main', 'Main chat', 100), summary(3, 'objective', 'Ship it', 500, 1), summary(4, 'topic', 'Old', 50)];

function setup({ attending = () => true } = {}) {
  const marked = [];
  const agent = {
    chats: async () => structuredClone(LIST),
    markRead: async (id, through) => { marked.push([id, through]); return { unread: 0 }; },
  };
  const chats = createChats({ agent, attending });
  return { chats, marked };
}

test('the main chat is first, then the others by their last activity', async () => {
  const { chats } = setup();
  await chats.refresh();
  assert.deepEqual(chats.items.map((chat) => chat.id), [1, 3, 2, 4]);
});

test('a reply in a chat that is not open raises its badge and lifts it, and opening it clears the badge and marks it read', async () => {
  const { chats, marked } = setup();
  await chats.refresh();
  chats.opened(1);
  chats.handle({ chatId: 4, event: { kind: 'unread', unread: 2 } });
  assert.equal(chats.items.find((chat) => chat.id === 4).unread, 2);
  assert.equal(chats.items[1].id, 4, 'the chat with the newest activity comes first among the others');
  assert.deepEqual(marked, [[1, undefined]]);
  chats.opened(4);
  assert.equal(chats.items.find((chat) => chat.id === 4).unread, 0);
  assert.deepEqual(marked.at(-1), [4, undefined]);
});

test('an entry for the open chat moves its read mark and raises no badge', async () => {
  const { chats, marked } = setup();
  await chats.refresh();
  chats.opened(2);
  chats.handle({ chatId: 2, event: { kind: 'entryAdded', entry: { id: 9 } } });
  chats.handle({ chatId: 2, event: { kind: 'unread', unread: 1 } });
  assert.equal(chats.items.find((chat) => chat.id === 2).unread, 0);
  assert.deepEqual(marked, [[2, undefined], [2, undefined]]);
});

test('while the page cannot be seen the open chat keeps its badge, and showing the page clears it', async () => {
  let seen = false;
  const { chats, marked } = setup({ attending: () => seen });
  await chats.refresh();
  chats.opened(2);
  marked.length = 0;
  chats.handle({ chatId: 2, event: { kind: 'unread', unread: 3 } });
  assert.equal(chats.items.find((chat) => chat.id === 2).unread, 3);
  assert.deepEqual(marked, []);
  seen = true;
  chats.attend();
  assert.equal(chats.items.find((chat) => chat.id === 2).unread, 0);
  assert.deepEqual(marked, [[2, undefined]]);
});

test('a chat wears one of the twenty marks, the same on every draw, and the main chat keeps its own', () => {
  const marks = Object.keys(KITES);
  assert.equal(marks.length, 20);
  assert.equal(chatIcon({ id: 1, kind: 'main' }), 'chat');
  const worn = Array.from({ length: 20 }, (_, n) => chatIcon({ id: 41 + n, kind: 'topic' }));
  assert.deepEqual(worn.toSorted(), marks.toSorted(), 'twenty chats made one after another wear all twenty');
  assert.deepEqual(worn.map((_, n) => chatIcon({ id: 41 + n, kind: 'objective' })), worn);
});
