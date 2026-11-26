// Picking a provider fills in its published address and offers signing in first, a key sent to add a server is never
// shown back, and a server that needs a sign-in opens the provider's page or asks for a client of the user's own.

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
const buttonOf = (root, words) => walk(root).find((node) => node.tag === 'button' && node.textContent === words && !node.hidden);
const shown = (root) => walk(root).filter((node) => !node.hidden).map((node) => node.textContent + node.value).join('\n');

const PROVIDERS = [
  { id: 'slack', label: 'Slack', address: 'https://mcp.slack.com/mcp', note: 'Make an internal Slack app.', keyKind: 'bearer', needsOwnClient: true },
  { id: 'notion', label: 'Notion', address: 'https://mcp.notion.com/mcp', note: 'Signs in with your Notion account.', keyKind: 'bearer', needsOwnClient: false },
  { id: 'custom', label: 'Custom server', address: null, note: 'The address of the endpoint.', keyKind: 'bearer', needsOwnClient: false },
];
const REDIRECT = 'https://jet.example/mcp-signin/return';
const SERVER = { id: 's1', provider: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', enabled: true, keyHeader: null, signedIn: false, pastedClientId: null, state: 'connected', reason: null, tools: [{ name: 'search', readOnly: true }] };

/** A Jet that answers each request from `answers`, by method and path, and keeps what it was sent. */
function host(answers) {
  const sent = [];
  const fetch = async (path, init) => {
    sent.push({ path, method: init.method, body: init.body && JSON.parse(init.body) });
    const answer = answers(init.method, path) ?? { servers: [], providers: PROVIDERS, redirectAddress: REDIRECT };
    const ok = answer.kind === undefined;
    return { ok, status: ok ? 200 : 409, json: async () => answer };
  };
  return { sent, fetch };
}

async function withPage(run) {
  const previous = { document: globalThis.document, open: globalThis.open };
  globalThis.document = { createElement: fakeElement };
  try {
    await run();
  } finally {
    globalThis.document = previous.document;
    globalThis.open = previous.open;
  }
}

test('a known provider fills in its address and offers signing in first, and a key sent to add a server is not shown back', () => withPage(async () => {
  const jet = host((method) => (method === 'POST' ? { ...SERVER, keyHeader: 'Authorization' } : null));
  const { el, refresh } = buildMcp({ fetch: jet.fetch });
  await refresh();
  const form = walk(el).find((node) => node.tag === 'form');
  assert.equal(form.hidden, false, 'with no servers the add form is open');
  const [provider, name, address] = ['Provider', 'Name', 'Address'].map((label) => fieldOf(form, label));
  assert.deepEqual([provider.value, name.value, address.value], ['slack', 'Slack', 'https://mcp.slack.com/mcp']);
  assert.equal(fieldOf(form, 'How Jet signs in').value, 'signin', 'signing in is offered first');
  assert.ok(shown(form).includes(REDIRECT), 'the redirect address shows for a provider whose console needs it');
  assert.ok(buttonOf(form, 'Add'), 'a server that signs in is added, then signed in');
  provider.value = 'notion';
  provider.fire('change');
  assert.deepEqual([name.value, address.value], ['Notion', 'https://mcp.notion.com/mcp']);
  assert.ok(!shown(form).includes(REDIRECT), 'a provider that registers Jet itself needs no redirect address');

  provider.value = 'custom';
  provider.fire('change');
  assert.deepEqual([name.value, address.value], ['', ''], 'a custom server leaves its name and address to the user');
  assert.equal(address.getAttribute('placeholder'), 'https://example.com/mcp');
  name.value = 'Wiki';
  address.value = 'https://wiki.example/mcp';
  await form.fire('submit');
  assert.equal(jet.sent.at(-1).body.key, null, 'signing in sends no key');

  form.hidden = false;
  provider.value = 'notion';
  provider.fire('change');
  const kind = fieldOf(form, 'How Jet signs in');
  kind.value = 'bearer';
  kind.fire('change');
  assert.ok(!shown(form).includes(REDIRECT) && buttonOf(form, 'Add and test'), 'a key needs no redirect address');
  fieldOf(form, 'Token').value = 'ntn_secret';
  await form.fire('submit');
  assert.deepEqual(jet.sent.at(-1), {
    path: '/api/mcp/servers', method: 'POST',
    body: { provider: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', key: { kind: 'bearer', token: 'ntn_secret' } },
  });
  const page = walk(el).map((node) => node.textContent + node.value).join('\n');
  assert.ok(!page.includes('ntn_secret'), 'the key is not left on the page');
  assert.ok(page.includes('Connected') && page.includes('1 tool'), 'the new server shows its state and tools');
}));

test('a server that needs a sign-in opens the provider page, or asks for a client when the provider will not register Jet', () => withPage(async () => {
  const waiting = { ...SERVER, state: 'needs_key', tools: [] };
  let registers = false;
  const jet = host((method, path) => {
    if (method === 'GET') return { servers: [waiting], providers: PROVIDERS, redirectAddress: REDIRECT };
    if (path.endsWith('/signin') && !registers) {
      registers = true;
      return { kind: 'noRegistration', message: 'mcp.notion.com does not let Jet register itself; paste its client id' };
    }
    return { address: 'https://auth.example/authorize?state=abc' };
  });
  const tab = { opener: 'jet', location: { href: '' }, close() { this.closed = true; } };
  globalThis.open = () => tab;
  const { el, refresh } = buildMcp({ fetch: jet.fetch });
  await refresh();
  const row = walk(el).find((node) => node.tag === 'li');
  assert.ok(shown(row).includes('Needs sign-in'), 'the state line says what the server needs');
  assert.equal(buttonOf(row, 'Sign in').className, 'action mcp-primary', 'Sign in is the one filled button');

  await buttonOf(row, 'Sign in').fire('click');
  assert.deepEqual(jet.sent.at(-1), { path: '/api/mcp/servers/s1/signin', method: 'POST', body: { client: null } });
  assert.ok(tab.closed, 'the tab opened for the sign-in closes when there is no page to show');
  const clientBox = walk(row).find((node) => node.getAttribute('aria-label') === 'Client for Notion');
  assert.equal(clientBox.hidden, false, 'the client fields show only once the provider refused to register Jet');
  assert.equal(buttonOf(row, 'Sign in'), buttonOf(clientBox, 'Sign in'), 'one Sign in shows at a time');
  assert.ok(shown(clientBox).includes(REDIRECT) && shown(clientBox).includes('paste its client id.'));

  fieldOf(clientBox, 'Client id').value = 'console-client';
  fieldOf(clientBox, 'Client secret, if it has one').value = 'console-secret';
  await buttonOf(clientBox, 'Sign in').fire('click');
  assert.deepEqual(jet.sent.at(-1).body, { client: { clientId: 'console-client', clientSecret: 'console-secret' } });
  assert.equal(tab.location.href, 'https://auth.example/authorize?state=abc', 'the provider page opens in the new tab');
  assert.equal(tab.opener, null, 'the provider page cannot reach back into Jet');
  assert.ok(shown(row).includes('Waiting for you to sign in…'));
  assert.ok(!walk(el).map((node) => node.textContent + node.value).join('\n').includes('console-secret'), 'the secret is not left on the page');
}));

test('a provider that needs a client of its own asks for it on the first tap, and a pasted client can be changed', () => withPage(async () => {
  const slack = { ...SERVER, id: 's2', provider: 'slack', name: 'Slack', url: 'https://mcp.slack.com/mcp', state: 'needs_key', tools: [] };
  const pasted = { ...SERVER, id: 's3', name: 'Mail', state: 'needs_key', tools: [], pastedClientId: 'console-client' };
  const jet = host((method) => (method === 'GET' ? { servers: [slack, pasted], providers: PROVIDERS, redirectAddress: REDIRECT } : { address: 'https://auth.example/authorize' }));
  let opened = 0;
  globalThis.open = () => { opened += 1; return null; };
  const { el, refresh } = buildMcp({ fetch: jet.fetch });
  await refresh();
  const [slackRow, mailRow] = walk(el).filter((node) => node.tag === 'li');
  const before = jet.sent.length;
  await buttonOf(slackRow, 'Sign in').fire('click');
  assert.equal(jet.sent.length, before, 'nothing is asked of the server yet');
  assert.equal(opened, 0, 'no tab opens for nothing');
  const slackClient = walk(slackRow).find((node) => node.getAttribute('aria-label') === 'Client for Slack');
  assert.equal(slackClient.hidden, false);
  assert.ok(shown(slackClient).includes('Slack needs an OAuth client of your own') && shown(slackClient).includes(REDIRECT));

  assert.equal(buttonOf(slackRow, 'Change client'), undefined, 'a server with no pasted client has nothing to change');
  await buttonOf(mailRow, 'Change client').fire('click');
  const mailClient = walk(mailRow).find((node) => node.getAttribute('aria-label') === 'Client for Mail');
  assert.equal(mailClient.hidden, false);
  assert.equal(fieldOf(mailClient, 'Client id').value, 'console-client', 'the client id to correct is filled in');
  assert.ok(shown(mailRow).includes('Needs sign-in') && !shown(mailRow).includes('Signed in'));
}));

test('a server in a state the page does not know is refused', () => {
  assert.equal(parseServer(SERVER).state, 'connected');
  assert.throws(() => parseServer({ ...SERVER, state: 'sleeping' }), /cannot read/);
  assert.throws(() => parseServer({ ...SERVER, signedIn: undefined }), /cannot read/);
});
