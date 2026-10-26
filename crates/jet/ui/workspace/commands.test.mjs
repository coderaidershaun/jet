import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from './commands.js';
import { createCommandMenu } from './completion.js';
import { createComposer } from '../chat/composer/state.js';
import { createComposerView } from '../chat/composer/view.js';

test('commands_route_before_chat_and_preserve_composer_keys', async () => {
  const requests = [], reports = [], opened = [], scopes = [];
  const apps = [{ id: 'a', label: 'Same name' }, { id: 'b', label: 'Same name' }];
  let sent = 0, selected = 'a', failSave = false, saveGate = null;
  const settings = { model: 'gpt-6.1-sol', effort: 'ultra' };
  const saved = [];
  const workspace = { activeAppId: () => selected, refresh: async () => {}, openApp: id => opened.push(id), reloadApp: async id => opened.push("reload:" + id), showTools: id => scopes.push(id) };
  const commands = createCommands({ workspace, settings, save: async candidate => { if (failSave) throw new Error('Disk unavailable'); await saveGate; saved.push({ ...candidate }); }, report: text => reports.push(text), request: async (path, body) => {
    requests.push({ path, body });
    if (!body) return apps;
    return { app: { id: 'new', label: body.overrides?.label ?? 'Saved' }, apps, discovery: { status: 'unavailable', message: 'offline' } };
  } });
  await commands.submit('/app add 8080 "Research notes"', () => sent++);
  assert.deepEqual(requests[0], { path: '/api/apps', body: { action: 'add', address: '8080', overrides: { label: 'Research notes' } } });
  assert.equal(sent, 0);
  assert.match(reports.at(-1), /saved.*offline/i);
  await commands.submit('/app open "Same name"', () => sent++);
  assert.match(reports.at(-1), /ambiguous/i);
  assert.deepEqual(opened, []);
  await commands.submit('/app open a', () => sent++);
  assert.deepEqual(opened, ['a']);
  await commands.submit('/tools b', () => sent++);
  assert.deepEqual(scopes, ['b']);
  assert.deepEqual(opened, ['a']);
  for (const action of ['enable', 'disable', 'remove']) {
    await commands.submit('/app ' + action + ' b', () => sent++);
    assert.deepEqual(requests.at(-1).body, { action, id: 'b' });
  }
  await commands.submit('/app add', () => sent++);
  assert.match(reports.at(-1), /app add <address>/);
  assert.doesNotMatch(reports.at(-1), /form/i);
  await commands.submit('/app edit', () => sent++);
  assert.match(reports.at(-1), /Same name.*a[\s\S]*ask Jet/i);
  await commands.submit('/app reload b', () => sent++);
  await commands.submit('/app reload', () => sent++);
  assert.deepEqual(opened, ['a', 'reload:b', 'reload:a']);
  selected = null;
  await commands.submit('/app reload', () => sent++);
  assert.match(reports.at(-1), /Choose an app/);
  selected = 'a';
  await commands.submit('/app list', () => sent++);
  assert.match(reports.at(-1), /Same name — a/);
  for (const text of ['/unknown', '/app add "unterminated', '/app open', '/app open missing', '/app list extra']) {
    await commands.submit(text, () => sent++);
    assert.ok(reports.at(-1).length);
  }
  assert.equal(sent, 0);
  await commands.submit('/model', () => sent++);
  assert.match(reports.at(-1), /gpt-6.1-sol/);
  assert.ok(commands.suggestions('/model so').some(item => item.value === '/model sonnet'));
  await commands.submit('/model sonnet', () => sent++);
  assert.equal(settings.model, 'sonnet');
  assert.equal(settings.effort, 'high');
  assert.equal(saved.at(-1).model, 'sonnet');
  assert.deepEqual(commands.suggestions('/thinking u'), []);
  await commands.submit('/thinking ultra', () => sent++);
  assert.match(reports.at(-1), /valid|choose/i);
  assert.equal(settings.effort, 'high');
  await commands.submit('/thinking low', () => sent++);
  assert.equal(settings.effort, 'low');
  failSave = true;
  await commands.submit('/model gpt-6.1-sol', () => sent++);
  assert.match(reports.at(-1), /Disk unavailable/);
  assert.equal(settings.model, 'sonnet');
  assert.equal(settings.effort, 'low');
  await commands.submit('/model missing', () => sent++);
  assert.match(reports.at(-1), /valid|choose/i);
  assert.equal(sent, 0);
  await commands.submit('ordinary chat', () => sent++);
  assert.equal(sent, 1);
  failSave = false;
  let releaseSave;
  saveGate = new Promise(resolve => { releaseSave = resolve; });
  const chosen = commands.submit('/model opus', () => sent++);
  const dispatched = [];
  const first = commands.submit('first', text => { dispatched.push([text, settings.model]); return new Promise(() => {}); });
  const second = commands.submit('second', text => dispatched.push([text, settings.model]));
  await new Promise(setImmediate);
  assert.deepEqual(dispatched, [], 'Messages wait for preceding settings to be saved');
  releaseSave();
  await Promise.all([chosen, first, second]);
  assert.deepEqual(dispatched, [['first', 'opus'], ['second', 'opus']], 'Dispatch order does not wait for a provider reply');
  saveGate = null;

  class Element {
    constructor() { this.value = ''; this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.attributes = {}; this.scrollHeight = this.offsetHeight = this.clientHeight = 0; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(kind, listener) { (this.listeners[kind] ??= []).push(listener); }
    focus() { globalThis.document.activeElement = this; }
    contains(node) { return this === node || this.children.includes(node); }
    emit(kind, props = {}) { const event = { key: '', shiftKey: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props }; for (const listener of this.listeners[kind] ?? []) listener(event); return event; }
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new Element(), createElementNS: () => new Element() };
  try {
    const field = new Element(), container = new Element(), state = createComposer({ empty: false });
    let menu, held = 0;
    const view = createComposerView({ page: new Element(), composer: container, field, button: new Element(), heldChip: new Element(), heldCancel: new Element(), state, reducedMotion: () => true, handlers: {
      input: text => menu?.input(text), keydown: event => menu?.keydown(event),
      send: text => commands.submit(text, () => sent++), hold: text => commands.submit(text, () => held++), cancelHold() {}, stop() {},
    } });
    menu = createCommandMenu({ field, container, commands, setText: view.setText });
    view.setText('/app li');
    assert.equal(field.emit('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, undefined);
    assert.equal(field.value, '/app li');
    assert.equal(field.emit('keydown', { key: 'Enter', shiftKey: true }).defaultPrevented, undefined);
    assert.equal(field.emit('keydown', { key: 'Tab' }).defaultPrevented, true);
    assert.equal(field.value, '/app list ');
    state.replying = true;
    field.emit('keydown', { key: 'Enter' });
    await new Promise(setImmediate);
    assert.equal(held, 0, 'slash during reply never enters the held model queue');
    assert.equal(sent, 1);
    view.setText('/app');
    assert.equal(field.emit('keydown', { key: 'Escape' }).defaultPrevented, true);
    assert.equal(field.attributes['aria-expanded'], 'false');
    view.setText('queued ordinary message');
    field.emit('keydown', { key: 'Enter' });
    await new Promise(setImmediate);
    assert.equal(held, 1);
  } finally { globalThis.document = previous; }
});
