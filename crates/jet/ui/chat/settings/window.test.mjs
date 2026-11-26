// The settings window builds its menu and its sections from the registry, so one more entry is one more section.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings } from '../../bridge/settings.js';
import { h } from '../../dom.js';
import { SECTIONS } from './sections.js';
import { createSettingsWindow } from './window.js';

const walk = (el) => [el, ...(el.children ?? []).filter((child) => typeof child === 'object').flatMap(walk)];

/** Matches the one-part selectors the sections use: `.class`, `[attribute]` or a tag. */
function matches(el, selector) {
  if (selector.startsWith('.')) return (el.className ?? '').split(' ').includes(selector.slice(1));
  if (selector.startsWith('[')) return el.getAttribute?.(selector.slice(1, -1)) !== null;
  return el.tag === selector;
}

/** Just enough of an element for the window and its sections: attributes, text, children, listeners and focus. */
function fakeElement(tag) {
  const attributes = new Map();
  const listeners = new Map();
  const el = {
    tag, children: [], textContent: '', value: '', className: '', dataset: {}, hidden: false, disabled: false, offsetParent: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { attributes.set(name, String(value)); if (name === 'hidden') el.hidden = true; if (name === 'value') el.value = String(value); },
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    append(...nodes) { el.children.push(...nodes); },
    replaceChildren(...nodes) { el.children = nodes; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    fire(type, event = {}) { return listeners.get(type)?.({ target: el, preventDefault() {}, ...event }); },
    focus() { globalThis.document.activeElement = el; },
    querySelector: (selector) => walk(el).slice(1).find((node) => matches(node, selector)) ?? null,
    querySelectorAll: (selector) => walk(el).slice(1).filter((node) => matches(node, selector)),
  };
  return el;
}

test('a section added to the registry gets a menu entry, and choosing it shows that section alone', async () => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.document = { createElement: fakeElement, createElementNS: (_, tag) => fakeElement(tag), createDocumentFragment: () => fakeElement('#fragment'), activeElement: null };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ saved: false }) });
  globalThis.requestAnimationFrame = () => 0;
  try {
    const settings = await loadSettings({ isAdmin: true });
    const agent = {
      status: async () => ({ program: { provider: 'Claude Code', found: true } }),
      voiceStatus: async () => undefined,
      loadMemory: async () => ({ memory: '', user: '', recent: '' }),
      onMemoryUpdated() {},
    };
    const context = { settings, agent, isAdmin: true, systemMotion: { matches: false, addEventListener() {} }, onClaudeChecked() {}, onForget: async () => {} };
    const standInEl = h('p', { text: 'The stand-in section' });
    const standIn = { id: 'stand-in', label: 'Stand-in', build: () => ({ el: standInEl }) };
    const dialog = fakeElement('dialog');
    dialog.showModal = () => { dialog.open = true; };
    const settingsWindow = createSettingsWindow({ dialog, context, onChange() {}, save: async () => {}, sections: [...SECTIONS, standIn] });

    const entries = walk(dialog).filter((node) => node.className === 'settings-entry');
    const panels = walk(dialog).filter((node) => node.className === 'settings-panel');
    const shown = () => panels.filter((panel) => !panel.hidden).map((panel) => panel.getAttribute('id'));
    const current = () => entries.filter((entry) => entry.getAttribute('aria-current') === 'true').map((entry) => entry.textContent);
    assert.deepEqual(entries.map((entry) => entry.textContent), [...SECTIONS.map((section) => section.label), 'Stand-in']);

    entries.at(-1).fire('click');
    assert.deepEqual([shown(), current()], [['settings-stand-in'], ['Stand-in']]);
    assert.ok(walk(panels.at(-1)).includes(standInEl), 'the stand-in panel holds the element its build made');

    walk(dialog).find((node) => node.className === 'settings-menu').fire('keydown', { key: 'ArrowDown', target: entries.at(-1) });
    assert.deepEqual([shown(), current(), document.activeElement], [['settings-persona'], ['Persona'], entries[0]], 'the arrow wraps to the first entry');

    settingsWindow.open('claude');
    assert.deepEqual([shown(), current(), dialog.dataset.view], [['settings-claude'], ['Agent programs'], 'section']);
    assert.throws(() => settingsWindow.open('nowhere'), /no section "nowhere"/);
  } finally {
    Object.assign(globalThis, previous);
  }
});
