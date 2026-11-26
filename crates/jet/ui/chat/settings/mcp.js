// The MCP servers the signed-in user added, each with its state and tools, and the form that adds one from a
// known provider or by its address. A key goes only to the server's own endpoint and is never shown again.

import { requestJson } from '../../bridge/browser-agent.js';
import { h } from '../../dom.js';
import { button, note, section } from './controls.js';

const PATH = '/api/mcp/servers';
const STATE = Object.freeze({ unchecked: 'unchecked', connected: 'connected', needsKey: 'needs_key', failed: 'failed' });
const KEY_KINDS = Object.freeze([['bearer', 'Bearer token'], ['basic', 'Email and API token'], ['header', 'Custom header'], ['none', 'No key']]);
export const OAUTH_NOTE = 'Signing in with OAuth is not built yet. Jet connects with a token or a header, so a server that offers only an OAuth sign-in cannot connect.';

const isText = (value) => typeof value === 'string';
const textOrNull = (value) => value === null || isText(value);

/** Reads one server from the server's answer, or throws on anything it does not expect. */
export function parseServer(raw) {
  const fine = raw !== null && typeof raw === 'object'
    && [raw.id, raw.provider, raw.name, raw.url].every(isText) && typeof raw.enabled === 'boolean'
    && textOrNull(raw.keyHeader) && textOrNull(raw.reason) && Object.values(STATE).includes(raw.state)
    && Array.isArray(raw.tools) && raw.tools.every((tool) => isText(tool?.name) && typeof tool.readOnly === 'boolean');
  if (!fine) throw new Error('mcp: the server sent a server it cannot read: ' + JSON.stringify(raw));
  const tools = Object.freeze(raw.tools.map(({ name, readOnly }) => Object.freeze({ name, readOnly })));
  const { id, provider, name, url, enabled, keyHeader, state, reason } = raw;
  return Object.freeze({ id, provider, name, url, enabled, keyHeader, state, reason, tools });
}

/** Reads the list of servers and the known providers. */
export function parseList(raw) {
  if (!Array.isArray(raw?.servers) || !Array.isArray(raw?.providers)) throw new Error('mcp: the list has no servers or providers');
  const providers = raw.providers.map((provider) => {
    const fine = [provider?.id, provider?.label, provider?.note].every(isText) && textOrNull(provider.address)
      && ['bearer', 'basic'].includes(provider.keyKind);
    if (!fine) throw new Error('mcp: the server sent a provider it cannot read: ' + JSON.stringify(provider));
    const { id, label, address, note: help, keyKind } = provider;
    return Object.freeze({ id, label, address, note: help, keyKind });
  });
  return Object.freeze({ servers: Object.freeze(raw.servers.map(parseServer)), providers: Object.freeze(providers) });
}

/** What the state line of a server says. */
function stateWords(server) {
  if (!server.enabled) return 'Off';
  switch (server.state) {
    case STATE.connected: return 'Connected';
    case STATE.needsKey: return 'Needs a sign-in or key';
    case STATE.failed: return 'Failed';
    case STATE.unchecked: return 'Not checked yet';
    default: throw new Error('mcp: unknown state ' + String(server.state));
  }
}

/** The line under the state, when there is something to say. */
function stateDetail(server) {
  if (!server.enabled) return 'Jet cannot see or call this server until you turn it on.';
  if (server.state === STATE.failed) return capitalise(server.reason ?? '');
  if (server.state === STATE.needsKey) return 'The server asks for credentials. Add a key it accepts. ' + OAUTH_NOTE.split('. ')[0] + '.';
  return '';
}

/** What names a control: its own label, or its words. */
const labelOf = (control) => control?.getAttribute?.('aria-label') ?? control?.textContent;
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith('.') ? '' : '.');
const message = (error) => error?.message ?? String(error);

function field(label, input) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input);
}
const textInput = (props = {}) => h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...props });
const secretInput = () => h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });

/** The fields of a key: which kind, then the one or two values that kind needs. "No key" is offered only where a
 *  key is optional; a saved key has its own Remove button. */
function keyEditor(kind, { offerNone }) {
  const kinds = KEY_KINDS.filter(([value]) => offerNone || value !== 'none');
  const choice = h('select', {}, ...kinds.map(([value, text]) => h('option', { value, text })));
  const token = secretInput(), user = textInput({ inputmode: 'email' }), password = secretInput(), header = textInput({ placeholder: 'X-Api-Key' }), value = secretInput();
  const inputs = { bearer: [token], basic: [user, password], header: [header, value], none: [] };
  const parts = {
    bearer: [field('Token', token)],
    basic: [field('Email', user), field('API token', password)],
    header: [field('Header name', header), field('Value', value)],
    none: [],
  };
  const holder = h('div', { class: 'mcp-key-fields' });
  const paint = () => holder.replaceChildren(...parts[choice.value]);
  choice.addEventListener('change', paint);
  const editor = {
    el: h('div', { class: 'mcp-key' }, field('Key', choice), holder),
    set kind(next) { choice.value = next; paint(); },
    /** The key as the server takes it, or null for no key, which is also what fields left empty mean. */
    value() {
      if (inputs[choice.value].every((input) => input.value.trim() === '')) return null;
      switch (choice.value) {
        case 'bearer': return { kind: 'bearer', token: token.value };
        case 'basic': return { kind: 'basic', user: user.value, password: password.value };
        case 'header': return { kind: 'header', name: header.value, value: value.value };
        case 'none': return null;
        default: throw new Error('mcp: unknown key kind ' + String(choice.value));
      }
    },
    clear() { for (const input of [token, user, password, header, value]) input.value = ''; },
  };
  editor.kind = kind;
  return editor;
}

/** @param {{ fetch?: typeof globalThis.fetch }} ctx   the window's context; only a test passes `fetch` */
export function buildMcp({ fetch: fetcher = globalThis.fetch } = {}) {
  const ask = (path, body, method) => requestJson(path, body, method, fetcher);
  let providers = [];
  let servers = [];
  let loaded = false;
  const list = h('ul', { class: 'mcp-list', 'aria-label': 'Your MCP servers' });
  const listStatus = h('p', { class: 'note', role: 'status', text: 'Loading your servers…' });
  const loadProblem = h('p', { class: 'problem', role: 'alert' });
  const retry = button('Try again', { hidden: true, onClick: () => load() });
  const announce = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

  // Each change draws the rows again, so the control that had the focus is found again in its new row.
  const focusIn = (id, label) => {
    const row = [...list.children].find((li) => li.getAttribute('data-id') === id);
    const controls = [...(row?.querySelectorAll?.('button, input') ?? [])].filter((control) => !control.hidden && !control.closest('[hidden]'));
    (controls.find((control) => labelOf(control) === label) ?? controls[0])?.focus();
  };
  const replace = (server, focused) => {
    servers = servers.map((old) => (old.id === server.id ? server : old));
    paint();
    focusIn(server.id, focused);
  };
  const paint = () => {
    const keyKind = (server) => providers.find((provider) => provider.id === server.provider)?.keyKind ?? 'bearer';
    list.replaceChildren(...servers.map((server) => serverRow(server, { ask, replace, forget, announce, keyKind: keyKind(server) })));
    listStatus.textContent = loaded && servers.length === 0 ? 'No servers yet. Add one below and Jet can call its tools.' : '';
    listStatus.hidden = listStatus.textContent === '';
    if (loaded && servers.length === 0) form.show();
  };
  const forget = (id) => {
    const at = servers.findIndex((server) => server.id === id);
    servers = servers.filter((server) => server.id !== id);
    paint();
    const next = servers[Math.min(at, servers.length - 1)];
    if (next) focusIn(next.id, next.name);
    else (addButton.hidden ? form.el.querySelector?.('select') : addButton)?.focus();
  };

  const form = addForm({
    providers: () => providers,
    add: async (input) => {
      const server = parseServer(await ask(PATH, input, 'POST'));
      servers = [...servers, server];
      paint();
      focusIn(server.id, server.name);
      announce.textContent = server.name + ' added: ' + stateWords(server) + '.';
    },
  });
  const addButton = button('Add a server', { onClick: () => form.show() });
  form.onShown = (shown) => { addButton.hidden = shown; };

  async function load() {
    listStatus.hidden = false;
    if (!loaded) listStatus.textContent = 'Loading your servers…';
    retry.hidden = true;
    try {
      ({ servers, providers } = parseList(await ask(PATH)));
      loaded = true;
      loadProblem.textContent = '';
      form.fill();
      paint();
    } catch (error) {
      listStatus.hidden = true;
      loadProblem.textContent = 'Your MCP servers could not load: ' + message(error);
      retry.hidden = false;
    }
  }

  return {
    el: section('mcp', 'MCP servers',
      note('Jet can call the tools of every server that is on, and is told which ones it has at the start of each reply.'),
      listStatus, loadProblem, retry, list, addButton, form.el, announce),
    refresh: load,
  };
}

/** One server: its name and switch, its address, its state and tools, and what can be done with it. */
function serverRow(server, { ask, replace, forget, announce, keyKind }) {
  const base = PATH + '/' + encodeURIComponent(server.id);
  const problem = h('p', { class: 'problem', role: 'alert' });
  const state = h('span', { class: 'mcp-state', 'data-state': server.enabled ? server.state : 'off', text: stateWords(server) });
  const toggle = h('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': server.name });
  toggle.checked = server.enabled;
  const busy = (working, words) => {
    for (const control of [toggle, test, changeKey, remove]) control.disabled = working;
    if (working) state.textContent = words;
  };
  const act = async (words, call) => {
    const focused = labelOf(document.activeElement);
    busy(true, words);
    try {
      const next = parseServer(await call());
      replace(next, focused);
      announce.textContent = next.name + ': ' + stateWords(next) + '.';
    } catch (error) {
      busy(false);
      state.textContent = stateWords(server);
      toggle.checked = server.enabled;
      problem.textContent = message(error);
    }
  };
  toggle.addEventListener('change', () => act(toggle.checked ? 'Connecting…' : 'Turning off…', () => ask(base + '/enabled', { enabled: toggle.checked }, 'PUT')));
  const test = button('Test connection', { onClick: () => act('Testing…', () => ask(base + '/test', {}, 'POST')) });
  test.hidden = !server.enabled;

  const key = keyEditor(keyKind, { offerNone: false });
  const saveKey = button('Save key');
  const removeKey = button('Remove key', { hidden: server.keyHeader === null });
  const keyBox = h('div', { class: 'mcp-panel', hidden: true }, key.el, h('div', { class: 'row-actions' }, saveKey, removeKey, button('Cancel', { onClick: () => { keyBox.hidden = true; } })));
  const changeKey = button(server.keyHeader === null ? 'Add a key' : 'Change key', { onClick: () => { keyBox.hidden = false; confirmBox.hidden = true; } });
  saveKey.addEventListener('click', () => {
    const value = key.value();
    if (value === null) problem.textContent = 'Paste the key first.';
    else act('Connecting…', () => ask(base + '/key', value, 'PUT'));
  });
  removeKey.addEventListener('click', () => act('Connecting…', () => ask(base + '/key', undefined, 'DELETE')));

  const confirmRemove = button('Remove', { class: 'action danger' });
  const confirmBox = h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm removing ' + server.name, hidden: true },
    h('p', { text: 'Remove ' + server.name + '? Jet forgets its key and can no longer call its tools.' }),
    h('div', { class: 'row-actions' }, button('Cancel', { onClick: () => { confirmBox.hidden = true; } }), confirmRemove));
  const remove = button('Remove', { onClick: () => { confirmBox.hidden = false; keyBox.hidden = true; confirmRemove.focus(); } });
  confirmRemove.addEventListener('click', async () => {
    confirmRemove.disabled = true;
    try {
      await ask(base, undefined, 'DELETE');
      forget(server.id);
      announce.textContent = server.name + ' removed.';
    } catch (error) {
      confirmRemove.disabled = false;
      problem.textContent = message(error);
    }
  });

  const detail = stateDetail(server);
  const keyWords = server.keyHeader === null ? 'No key' : 'Key saved, sent as ' + server.keyHeader;
  const tools = server.enabled && server.state === STATE.connected
    ? h('details', { class: 'mcp-tools' },
      h('summary', { text: server.tools.length === 1 ? '1 tool' : server.tools.length + ' tools' }),
      h('p', { text: server.tools.map((tool) => tool.name).join(', ') || 'The server lists no tools.' }))
    : null;
  return h('li', { class: 'mcp-server', 'data-id': server.id },
    h('div', { class: 'mcp-head' }, h('span', { class: 'mcp-name', text: server.name }), toggle),
    h('p', { class: 'mcp-url', text: server.url }),
    h('p', { class: 'mcp-line' }, state, h('span', { class: 'mcp-key-words', text: keyWords })),
    detail ? h('p', { class: 'mcp-detail', 'data-state': server.enabled ? server.state : 'off', text: detail }) : null,
    tools,
    h('div', { class: 'row-actions' }, ...(server.state === STATE.needsKey ? [changeKey, test] : [test, changeKey]), remove),
    keyBox, confirmBox, problem);
}

/** The form that adds a server: a provider, which fills in its name and published address, then the key. */
function addForm({ providers, add }) {
  const provider = h('select', {});
  const name = textInput({ maxlength: '60' });
  const address = textInput({ inputmode: 'url', placeholder: 'https://example.com/mcp' });
  const providerNote = h('p', { class: 'note' });
  const key = keyEditor('bearer', { offerNone: true });
  const submit = h('button', { type: 'submit', class: 'action', text: 'Add and test' });
  const problem = h('p', { class: 'problem', role: 'alert' });
  let picked = null;

  const pick = () => {
    const next = providers().find((candidate) => candidate.id === provider.value) ?? null;
    if (name.value.trim() === '' || name.value === picked?.label) name.value = next && next.id !== 'custom' ? next.label : '';
    address.value = next?.address ?? '';
    providerNote.textContent = next?.note ?? '';
    key.kind = next?.keyKind ?? 'bearer';
    picked = next;
  };
  provider.addEventListener('change', pick);

  const el = h('form', { class: 'mcp-add mcp-panel', hidden: true, 'aria-label': 'Add an MCP server' },
    field('Provider', provider), h('div', { class: 'mcp-pair' }, field('Name', name), field('Address', address)), providerNote,
    key.el, note(OAUTH_NOTE),
    h('div', { class: 'row-actions' }, submit, button('Cancel', { onClick: () => shown(false) })), problem);
  const shown = (visible) => {
    el.hidden = !visible;
    form.onShown(visible);
  };
  el.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Connecting…';
    try {
      await add({ provider: provider.value, name: name.value, url: address.value, key: key.value() });
      problem.textContent = '';
      key.clear();
      name.value = '';
      pick();
      shown(false);
    } catch (error) {
      problem.textContent = message(error);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Add and test';
    }
  });

  const form = {
    el,
    onShown() {},
    show() {
      shown(true);
    },
    /** Lists the providers, once they are known, and picks the first. */
    fill() {
      if (provider.children.length > 0) return;
      provider.append(...providers().map(({ id, label }) => h('option', { value: id, text: label })));
      provider.value = providers()[0]?.id ?? '';
      pick();
    },
  };
  return form;
}
