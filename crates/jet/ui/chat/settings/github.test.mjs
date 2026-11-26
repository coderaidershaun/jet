// The GitHub token goes only to its own endpoint and is never shown again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGithub } from './github.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Just enough of an element for the section: attributes, text, children and listeners. */
function fakeElement(tag) {
  const listeners = {};
  const attributes = {};
  return {
    tag, children: [], textContent: '', value: '', hidden: false, disabled: false, placeholder: '', className: '',
    setAttribute(name, value) { attributes[name] = value; if (name === 'hidden') this.hidden = true; },
    getAttribute: (name) => attributes[name] ?? null,
    append(...nodes) { this.children.push(...nodes); },
    addEventListener(type, listener) { listeners[type] = listener; },
    fire(type) { return listeners[type]?.({}); },
  };
}
const walk = (el) => [el, ...el.children.filter((child) => typeof child === 'object').flatMap(walk)];

/** A Jet that keeps one token and answers only whether it is saved. */
function host() {
  const server = { token: null, calls: [] };
  const fetch = async (path, init) => {
    server.calls.push({ path, method: init.method, body: init.body });
    if (init.method === 'PUT') server.token = JSON.parse(init.body).token;
    if (init.method === 'DELETE') server.token = null;
    return { ok: true, status: 200, json: async () => ({ saved: server.token !== null }) };
  };
  return { server, fetch };
}

test('a pasted token goes only to its own endpoint, the field empties, the section says only saved or not saved, and remove deletes it', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: fakeElement };
  try {
    const jet = host();
    const settings = { claudePath: null, model: 'claude-sonnet' };
    const before = structuredClone(settings);
    const changes = [];
    const el = buildGithub({ settings, changed: (kind) => changes.push(kind), fetch: jet.fetch });
    const all = walk(el);
    const input = all.find((node) => node.tag === 'input');
    const [save, remove] = all.filter((node) => node.tag === 'button');
    const status = all.find((node) => node.getAttribute('role') === 'status');
    const shown = () => all.map((node) => node.textContent).join('\n');
    await flush();
    assert.deepEqual([status.textContent, remove.hidden], ['Not saved', true]);

    input.value = 'ghp_fake0000';
    input.fire('input');
    await save.fire('click');
    await flush();
    assert.deepEqual(jet.server.calls.map(({ path, method }) => [path, method]), [['/api/github/token', 'GET'], ['/api/github/token', 'PUT']]);
    assert.equal(jet.server.token, 'ghp_fake0000');
    assert.equal(input.value, '', 'the field keeps nothing after the save');
    assert.deepEqual([status.textContent, remove.hidden], ['Saved', false]);
    assert.ok(!shown().includes('ghp_fake0000'), 'the token is never shown');
    assert.deepEqual([settings, changes], [before, []], 'the shared settings never see the token and are not saved');

    await remove.fire('click');
    assert.deepEqual(jet.server.calls.at(-1), { path: '/api/github/token', method: 'DELETE', body: undefined });
    assert.deepEqual([status.textContent, remove.hidden, jet.server.token], ['Not saved', true, null]);
  } finally {
    globalThis.document = previous;
  }
});
