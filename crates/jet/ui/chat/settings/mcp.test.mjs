// Picking a provider fills in its published address, a custom server leaves the address to the user, and a key
// sent to add a server is never shown back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcp, parseServer } from './mcp.js';

/** Just enough of an element for the section: attributes, text, children and listeners. */
function fakeElement(tag) {
  const listeners = {};
  const attributes = {};
  const el = {
    tag, children: [], textContent: '', value: '', hidden: false, disabled: false, checked: false, placeholder: '', className: '',
    setAttribute(name, value) { attributes[name] = String(value); if (name === 'hidden') el.hidden = true; },
    getAttribute: (name) => attributes[name] ?? null,
    append(...nodes) { el.children.push(...nodes); },
    replaceChildren(...nodes) { el.children = nodes; },
    addEventListener(type, listener) { listeners[type] = listener; },
    fire(type) { return listeners[type]?.({ preventDefault() {} }); },
    focus() {},
  };
  return el;
}
const walk = (el) => [el, ...el.children.filter((child) => typeof child === 'object').flatMap(walk)];
/** The control inside the field whose label says `label`. */
const fieldOf = (root, label) => walk(root).find((node) => node.tag === 'label' && node.children[0]?.textContent === label).children[1];

const PROVIDERS = [
  { id: 'notion', label: 'Notion', address: 'https://mcp.notion.com/mcp', note: 'Paste an MCP token.', keyKind: 'bearer' },
  { id: 'jira', label: 'Jira', address: 'https://mcp.atlassian.com/v2/mcp', note: 'Email and API token.', keyKind: 'basic' },
  { id: 'custom', label: 'Custom server', address: null, note: 'The address of the endpoint.', keyKind: 'bearer' },
];

/** A Jet with no servers yet that adds whatever it is sent, keeping the key to itself. */
function host() {
  const sent = [];
  const fetch = async (path, init) => {
    sent.push({ path, method: init.method, body: init.body && JSON.parse(init.body) });
    const body = init.method === 'POST'
      ? { id: 's1', provider: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', enabled: true, keyHeader: 'Authorization', state: 'connected', reason: null, tools: [{ name: 'search', readOnly: true }] }
      : { servers: [], providers: PROVIDERS };
    return { ok: true, status: 200, json: async () => body };
  };
  return { sent, fetch };
}

test('a known provider fills in its published address, a custom server leaves an empty address, and the key is not shown back', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: fakeElement };
  try {
    const jet = host();
    const { el, refresh } = buildMcp({ fetch: jet.fetch });
    await refresh();
    const form = walk(el).find((node) => node.tag === 'form');
    assert.equal(form.hidden, false, 'with no servers the add form is open');
    const [provider, name, address] = ['Provider', 'Name', 'Address'].map((label) => fieldOf(form, label));
    assert.deepEqual([provider.value, name.value, address.value], ['notion', 'Notion', 'https://mcp.notion.com/mcp']);

    provider.value = 'custom';
    provider.fire('change');
    assert.deepEqual([name.value, address.value], ['', ''], 'a custom server leaves its name and address to the user');
    assert.equal(address.getAttribute('placeholder'), 'https://example.com/mcp');

    provider.value = 'jira';
    provider.fire('change');
    assert.deepEqual([name.value, address.value], ['Jira', 'https://mcp.atlassian.com/v2/mcp']);
    assert.equal(fieldOf(form, 'Key').value, 'basic', 'Jira asks for an email and an API token');
    assert.ok(walk(form).some((node) => node.textContent.startsWith('Signing in with OAuth is not built yet')));

    provider.value = 'custom';
    provider.fire('change');
    name.value = 'Wiki';
    address.value = 'https://wiki.example/mcp';
    await form.fire('submit');
    assert.equal(jet.sent.at(-1).body.key, null, 'a key left empty is sent as no key');

    form.hidden = false;
    provider.value = 'notion';
    provider.fire('change');
    fieldOf(form, 'Key').value = 'bearer';
    fieldOf(form, 'Key').fire('change');
    fieldOf(form, 'Token').value = 'ntn_secret';
    await form.fire('submit');
    assert.deepEqual(jet.sent.at(-1), {
      path: '/api/mcp/servers', method: 'POST',
      body: { provider: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', key: { kind: 'bearer', token: 'ntn_secret' } },
    });
    const shown = walk(el).map((node) => node.textContent + node.value).join('\n');
    assert.ok(!shown.includes('ntn_secret'), 'the key is not left on the page');
    assert.ok(shown.includes('Connected') && shown.includes('1 tool'), 'the new server shows its state and tools');
  } finally {
    globalThis.document = previous;
  }
});

test('a server in a state the page does not know is refused', () => {
  const server = { id: 's', provider: 'custom', name: 'S', url: 'https://s/mcp', enabled: true, keyHeader: null, state: 'connected', reason: null, tools: [] };
  assert.equal(parseServer(server).state, 'connected');
  assert.throws(() => parseServer({ ...server, state: 'sleeping' }), /cannot read/);
});
