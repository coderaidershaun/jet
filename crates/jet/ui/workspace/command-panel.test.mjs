import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from './commands.js';
import { createCommandPanel } from './command-panel.js';

/** Just enough of the page for the panel: elements that hold children and listeners, and a document that sends events. */
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.textContent = ''; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'hidden') this.hidden = true; }
  addEventListener(kind, listener) { (this.listeners[kind] ??= []).push(listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  after(element) { this.next = element; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  emit(kind, event = {}) { for (const listener of this.listeners[kind] ?? []) listener({ preventDefault() { event.defaultPrevented = true; }, ...event }); return event; }
  find(tag) { return this.children.flatMap((child) => (child.tag === tag ? [child] : child.find?.(tag) ?? [])); }
}

function makePanel() {
  globalThis.document = Object.assign(new Element('document'), { createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag), querySelector: () => null });
  const rows = new Element('div'), field = new Element('textarea');
  const page = Object.assign(new Element('div'), { classList: { has: false, toggle(_, on) { this.has = on; } } });
  const show = createCommandPanel({ after: rows, page, field }).show;
  return { show, panel: rows.next, page, field };
}

test('help shows one row for each command, with its arguments apart from what it does', async () => {
  const { show, panel } = makePanel();
  const commands = createCommands({ workspace: {}, settings: {}, save: async () => {}, report: show });
  await commands.submit('/x', () => {});
  const terms = panel.find('dt');
  assert.equal(panel.hidden, false);
  assert.equal(terms.length, commands.suggestions('/').length);
  assert.equal(terms.length, panel.find('dd').length);
  assert.deepEqual([terms[0].find('code')[0].textContent, terms[0].find('span')[0].textContent, panel.find('dd')[0].textContent], ['/model', ' [model-id]', 'Choose the model for the next reply']);
});

test('the close button, Esc and opening another chat each clear the panel, and closing gives the focus back to the message box', () => {
  const { show, panel, page, field } = makePanel();
  const close = panel.find('button')[0];
  assert.equal(close.attributes['aria-label'], 'Close');

  show('Saved. Next reply: sonnet · high thinking.');
  assert.deepEqual([panel.hidden, page.classList.has], [false, true]);
  close.emit('click');
  assert.deepEqual([panel.hidden, page.classList.has, document.activeElement], [true, false, field]);

  show('Reloaded Notes.');
  document.activeElement = null;
  assert.equal(document.emit('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.deepEqual([panel.hidden, document.activeElement], [true, field]);
  assert.equal(document.emit('keydown', { key: 'Escape' }).defaultPrevented, undefined, 'Esc goes on to the page while nothing shows');

  show('Opened Notes.');
  document.emit('jet:chat-opened', { detail: { id: 2 } });
  assert.equal(panel.hidden, true);
});
