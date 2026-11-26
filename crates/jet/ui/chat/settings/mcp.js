// The MCP servers the signed-in user added, each with its state and tools, its sign-in or key, and the form that adds
// one from a known provider or by its address. A key or client secret goes only to Jet and is never shown again.

import { requestJson } from '../../bridge/browser-agent.js';
import { h } from '../../dom.js';
import { button, note, section } from './controls.js';

const PATH = '/api/mcp/servers';
const STATE = Object.freeze({ unchecked: 'unchecked', connected: 'connected', needsKey: 'needs_key', failed: 'failed' });
const SIGN_IN = 'signin';
const KEY_KINDS = Object.freeze([['bearer', 'Bearer token'], ['basic', 'Email and API token'], ['header', 'Custom header']]);
const ADD_KINDS = Object.freeze([[SIGN_IN, 'Sign in with my account'], ...KEY_KINDS]);
/** The name other Jet tabs hear on when a sign-in page finishes. */
const CHANNEL = 'jet-mcp';
/** How long a started sign-in waits for the user, as the server keeps it, in milliseconds. */
const SIGN_IN_WAITS = 10 * 60 * 1000;

const isText = (value) => typeof value === 'string';
const textOrNull = (value) => value === null || isText(value);

/** Reads one server from the server's answer, or throws on anything it does not expect. */
export function parseServer(raw) {
  const fine = raw !== null && typeof raw === 'object'
    && [raw.id, raw.provider, raw.name, raw.url].every(isText) && typeof raw.enabled === 'boolean' && typeof raw.signedIn === 'boolean'
    && textOrNull(raw.keyHeader) && textOrNull(raw.reason) && textOrNull(raw.pastedClientId) && Object.values(STATE).includes(raw.state)
    && Array.isArray(raw.tools) && raw.tools.every((tool) => isText(tool?.name) && typeof tool.readOnly === 'boolean');
  if (!fine) throw new Error('mcp: the server sent a server it cannot read: ' + JSON.stringify(raw));
  const tools = Object.freeze(raw.tools.map(({ name, readOnly }) => Object.freeze({ name, readOnly })));
  const { id, provider, name, url, enabled, keyHeader, signedIn, pastedClientId, state, reason } = raw;
  return Object.freeze({ id, provider, name, url, enabled, keyHeader, signedIn, pastedClientId, state, reason, tools });
}

/** Reads the list of servers, the known providers and the address providers send the user back to. */
export function parseList(raw) {
  if (!Array.isArray(raw?.servers) || !Array.isArray(raw?.providers) || !isText(raw?.redirectAddress)) {
    throw new Error('mcp: the list has no servers, providers or redirect address');
  }
  const providers = raw.providers.map((provider) => {
    const fine = [provider?.id, provider?.label, provider?.note].every(isText) && textOrNull(provider.address)
      && ['bearer', 'basic'].includes(provider.keyKind) && typeof provider.needsOwnClient === 'boolean';
    if (!fine) throw new Error('mcp: the server sent a provider it cannot read: ' + JSON.stringify(provider));
    const { id, label, address, note: help, keyKind, needsOwnClient } = provider;
    return Object.freeze({ id, label, address, note: help, keyKind, needsOwnClient });
  });
  return Object.freeze({ servers: Object.freeze(raw.servers.map(parseServer)), providers: Object.freeze(providers), redirectAddress: raw.redirectAddress });
}

/** What the state line of a server says. */
function stateWords(server) {
  if (!server.enabled) return 'Off';
  switch (server.state) {
    case STATE.connected: return 'Connected';
    case STATE.needsKey: return 'Needs sign-in';
    case STATE.failed: return 'Failed';
    case STATE.unchecked: return 'Not checked yet';
    default: throw new Error('mcp: unknown state ' + String(server.state));
  }
}

/** The line under the state, when there is something to say. */
function stateDetail(server) {
  if (!server.enabled) return 'Jet cannot see or call this server until you turn it on.';
  if (server.state === STATE.failed) return capitalise(server.reason ?? '');
  if (server.state === STATE.needsKey) return capitalise(server.reason ?? 'the server asks you to sign in before Jet can call its tools');
  return '';
}

/** What the line beside the state says about how Jet proves who it is. */
function credentialWords(server) {
  if (server.signedIn) return server.state === STATE.needsKey ? '' : 'Signed in';
  if (server.keyHeader !== null) return 'Key saved, sent as ' + server.keyHeader;
  return server.state === STATE.needsKey ? '' : 'No key';
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

/** The redirect address with a button that copies it, for the user to give a provider's console. */
function redirectLine(address) {
  const text = h('code', { class: 'mcp-redirect-address', text: address });
  const copy = button('Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(address);
      copy.textContent = 'Copied';
    } catch {
      getSelection()?.selectAllChildren(text);
      copy.textContent = 'Selected, copy it now';
    }
  });
  return h('div', { class: 'mcp-redirect' }, h('span', { class: 'field-label', text: 'Redirect address' }), h('div', { class: 'mcp-redirect-row' }, text, copy));
}

/** The fields of a key: which kind, then the one or two values that kind needs. The add form offers signing in
 *  first; a saved key has its own Remove button. */
function keyEditor(kind, { label = 'Key', kinds = KEY_KINDS } = {}) {
  const choice = h('select', {}, ...kinds.map(([value, text]) => h('option', { value, text })));
  const token = secretInput(), user = textInput({ inputmode: 'email' }), password = secretInput(), header = textInput({ placeholder: 'X-Api-Key' }), value = secretInput();
  const inputs = { bearer: [token], basic: [user, password], header: [header, value], [SIGN_IN]: [] };
  const parts = {
    bearer: [field('Token', token)],
    basic: [field('Email', user), field('API token', password)],
    header: [field('Header name', header), field('Value', value)],
    [SIGN_IN]: [],
  };
  const holder = h('div', { class: 'mcp-key-fields' });
  const editor = {
    el: h('div', { class: 'mcp-key' }, field(label, choice), holder),
    onKind() {},
    get kind() { return choice.value; },
    set kind(next) { choice.value = next; paint(); },
    /** The key as the server takes it, or null for none: signing in, or fields left empty. */
    value() {
      if (inputs[choice.value].every((input) => input.value.trim() === '')) return null;
      switch (choice.value) {
        case 'bearer': return { kind: 'bearer', token: token.value };
        case 'basic': return { kind: 'basic', user: user.value, password: password.value };
        case 'header': return { kind: 'header', name: header.value, value: value.value };
        default: throw new Error('mcp: unknown key kind ' + String(choice.value));
      }
    },
    clear() { for (const input of [token, user, password, header, value]) input.value = ''; },
  };
  const paint = () => {
    holder.replaceChildren(...parts[choice.value]);
    editor.onKind(choice.value);
  };
  choice.addEventListener('change', paint);
  editor.kind = kind;
  return editor;
}

/** @param {{ fetch?: typeof globalThis.fetch }} ctx   the window's context; only a test passes `fetch` */
export function buildMcp({ fetch: fetcher = globalThis.fetch } = {}) {
  const ask = (path, body, method) => requestJson(path, body, method, fetcher);
  let providers = [];
  let servers = [];
  let redirectAddress = '';
  let loaded = false;
  /** The servers whose sign-in page is open in another tab, each with that page's address and when it opened. */
  const waiting = new Map();
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
    const providerOf = (server) => providers.find((provider) => provider.id === server.provider) ?? null;
    const shared = { ask, replace, forget, announce, waiting, redirect: () => redirectAddress };
    list.replaceChildren(...servers.map((server) => serverRow(server, { ...shared, provider: providerOf(server) })));
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
    redirect: () => redirectAddress,
    add: async (input) => {
      const server = parseServer(await ask(PATH, input, 'POST'));
      servers = [...servers, server];
      paint();
      const needsSignIn = server.enabled && server.state === STATE.needsKey;
      focusIn(server.id, needsSignIn ? 'Sign in' : server.name);
      announce.textContent = server.name + ' added: ' + (needsSignIn ? 'sign in to connect it.' : stateWords(server) + '.');
    },
  });
  const addButton = button('Add a server', { onClick: () => form.show() });
  form.onShown = (shown) => { addButton.hidden = shown; };

  async function load() {
    listStatus.hidden = false;
    if (!loaded) listStatus.textContent = 'Loading your servers…';
    retry.hidden = true;
    try {
      ({ servers, providers, redirectAddress } = parseList(await ask(PATH)));
      const now = Date.now();
      for (const [id, { since }] of [...waiting]) {
        const settled = servers.find((server) => server.id === id)?.signedIn !== false;
        if (settled || now - since > SIGN_IN_WAITS) waiting.delete(id);
      }
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

  // The sign-in page tells every Jet tab when it finishes; coming back to this tab checks too, for a page that could not.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  channel?.unref?.();
  const reload = () => load().catch((error) => { loadProblem.textContent = 'Your MCP servers could not load: ' + message(error); });
  // A sign-in page that finished, well or not, ends the wait; the reload shows where each server stands.
  channel?.addEventListener('message', () => {
    waiting.clear();
    reload();
  });
  globalThis.addEventListener?.('focus', () => { if (waiting.size > 0) reload(); });

  return {
    el: section('mcp', 'MCP servers',
      note('Jet can call the tools of every server that is on, and is told which ones it has at the start of each reply.'),
      listStatus, loadProblem, retry, list, addButton, form.el, announce),
    refresh: load,
  };
}

/** One server: its name and switch, its address, its state and tools, and what can be done with it. */
function serverRow(server, { ask, replace, forget, announce, waiting, redirect, provider }) {
  const base = PATH + '/' + encodeURIComponent(server.id);
  const problem = h('p', { class: 'problem', role: 'alert' });
  const state = h('span', { class: 'mcp-state', 'data-state': server.enabled ? server.state : 'off', text: stateWords(server) });
  const toggle = h('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': server.name });
  toggle.checked = server.enabled;
  const controls = () => [toggle, test, signIn, signOut, changeKey, changeClient, remove];
  const busy = (working, words) => {
    for (const control of controls()) control.disabled = working;
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

  // Signing in: Jet gives the provider's page, which opens in a new tab and sends the user back to Jet when done. The
  // tab is opened before the request, while the tap still counts, so the browser does not block it.
  const needsSignIn = server.enabled && server.state === STATE.needsKey;
  const signIn = button(server.signedIn ? 'Sign in again' : 'Sign in', { class: needsSignIn ? 'action mcp-primary' : 'action' });
  const reopen = h('a', { class: 'mcp-reopen', target: '_blank', rel: 'noopener', text: 'Open the sign-in page again', hidden: true });
  const startSignIn = async (client) => {
    const tab = globalThis.open?.('', '_blank') ?? null;
    busy(true, 'Opening the sign-in page…');
    try {
      const { address } = await ask(base + '/signin', { client }, 'POST');
      if (!isText(address)) throw new Error('mcp: the sign-in answer has no address');
      waiting.set(server.id, { address, since: Date.now() });
      if (tab) {
        tab.opener = null;
        tab.location.href = address;
      }
      showClient(false);
      showWaiting(address, tab === null);
    } catch (error) {
      tab?.close();
      busy(false);
      state.textContent = stateWords(server);
      if (error?.kind === 'noRegistration') {
        askForClient(capitalise(message(error)));
      } else {
        problem.textContent = message(error);
      }
    }
  };
  const showWaiting = (address, blocked) => {
    busy(false);
    state.textContent = 'Waiting for you to sign in…';
    state.setAttribute('data-state', 'waiting');
    reopen.setAttribute('href', address);
    reopen.textContent = blocked ? 'Open the sign-in page' : 'Open the sign-in page again';
    reopen.hidden = false;
  };
  // A provider known to need a client of the user's own asks for it on the first tap, with no tab opened for nothing.
  const asksForClient = provider?.needsOwnClient === true && server.pastedClientId === null && !server.signedIn;
  signIn.addEventListener('click', () => {
    if (!asksForClient) return startSignIn(null);
    askForClient(`${provider.label} needs an OAuth client of your own: make one in its console with the redirect address below, then paste its client id and secret.`);
  });
  const signOut = button('Sign out', { onClick: () => act('Signing out…', () => ask(base + '/signin', undefined, 'DELETE')) });

  // A provider that does not let Jet register itself needs a client the user makes in its console.
  const clientWords = h('p', { class: 'mcp-client-words' });
  const clientId = textInput();
  const clientSecret = secretInput();
  const useClient = button('Sign in', { class: 'action mcp-primary' });
  useClient.addEventListener('click', () => {
    if (clientId.value.trim() === '') {
      problem.textContent = 'Paste the client id first.';
      return;
    }
    problem.textContent = '';
    const client = { clientId: clientId.value, clientSecret: clientSecret.value.trim() === '' ? null : clientSecret.value };
    clientSecret.value = '';
    return startSignIn(client);
  });
  const clientBox = h('div', { class: 'mcp-panel mcp-client', role: 'group', 'aria-label': 'Client for ' + server.name, hidden: true },
    clientWords, redirectLine(redirect()),
    h('div', { class: 'mcp-pair' }, field('Client id', clientId), field('Client secret, if it has one', clientSecret)),
    h('div', { class: 'row-actions' }, useClient, button('Cancel', { onClick: () => { showClient(false); signIn.focus(); } })));
  // While the client fields are open, their own Sign in is the one to press.
  const showClient = (visible) => {
    clientBox.hidden = !visible;
    signIn.hidden = visible;
    changeClient.hidden = visible;
  };
  const askForClient = (words) => {
    clientWords.textContent = words;
    showClient(true);
    clientId.focus();
  };
  // A client id with a typo, or one the provider has since deleted, can be replaced here.
  const changeClient = button('Change client', {
    onClick: () => {
      clientId.value = server.pastedClientId ?? '';
      askForClient('Paste the client id and secret from the provider\'s console. Jet signs in with them from now on.');
    },
  });

  const key = keyEditor(provider?.keyKind ?? 'bearer');
  const saveKey = button('Save key');
  const removeKey = button('Remove key', { hidden: server.keyHeader === null });
  const keyBox = h('div', { class: 'mcp-panel', hidden: true }, key.el, h('div', { class: 'row-actions' }, saveKey, removeKey, button('Cancel', { onClick: () => { keyBox.hidden = true; } })));
  const keyLabel = server.keyHeader !== null ? 'Change key' : needsSignIn ? 'Use a key instead' : 'Add a key';
  const changeKey = button(keyLabel, { onClick: () => { keyBox.hidden = false; confirmBox.hidden = true; showClient(false); } });
  saveKey.addEventListener('click', () => {
    const value = key.value();
    if (value === null) problem.textContent = 'Paste the key first.';
    else act('Connecting…', () => ask(base + '/key', value, 'PUT'));
  });
  removeKey.addEventListener('click', () => act('Connecting…', () => ask(base + '/key', undefined, 'DELETE')));

  const confirmRemove = button('Remove', { class: 'action danger' });
  const confirmBox = h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm removing ' + server.name, hidden: true },
    h('p', { text: 'Remove ' + server.name + '? Jet forgets its key or sign-in and can no longer call its tools.' }),
    h('div', { class: 'row-actions' }, button('Cancel', { onClick: () => { confirmBox.hidden = true; } }), confirmRemove));
  const remove = button('Remove', { onClick: () => { confirmBox.hidden = false; keyBox.hidden = true; showClient(false); confirmRemove.focus(); } });
  confirmRemove.addEventListener('click', async () => {
    confirmRemove.disabled = true;
    try {
      await ask(base, undefined, 'DELETE');
      waiting.delete(server.id);
      forget(server.id);
      announce.textContent = server.name + ' removed.';
    } catch (error) {
      confirmRemove.disabled = false;
      problem.textContent = message(error);
    }
  });

  const detail = stateDetail(server);
  const tools = server.enabled && server.state === STATE.connected
    ? h('details', { class: 'mcp-tools' },
      h('summary', { text: server.tools.length === 1 ? '1 tool' : server.tools.length + ' tools' }),
      h('p', { text: server.tools.map((tool) => tool.name).join(', ') || 'The server lists no tools.' }))
    : null;
  const actions = actionsOf(server, { test, signIn, signOut, changeKey, changeClient, remove });
  const row = h('li', { class: 'mcp-server', 'data-id': server.id },
    h('div', { class: 'mcp-head' }, h('span', { class: 'mcp-name', text: server.name }), toggle),
    h('p', { class: 'mcp-url', text: server.url }),
    h('p', { class: 'mcp-line' }, state, h('span', { class: 'mcp-key-words', text: credentialWords(server) })),
    detail ? h('p', { class: 'mcp-detail', 'data-state': server.enabled ? server.state : 'off', text: detail }) : null,
    tools,
    h('div', { class: 'row-actions' }, ...actions),
    reopen, clientBox, keyBox, confirmBox, problem);
  const pending = waiting.get(server.id);
  if (pending !== undefined && needsSignIn) showWaiting(pending.address, false);
  return row;
}

/** The buttons a server shows, the one it most needs first. An off server can only be turned on or removed. */
function actionsOf(server, { test, signIn, signOut, changeKey, changeClient, remove }) {
  const second = server.signedIn ? signOut : changeKey;
  if (!server.enabled) return [second, remove];
  if (server.state === STATE.needsKey) return [signIn, ...(server.pastedClientId === null ? [] : [changeClient]), second, remove];
  return [test, second, remove];
}

/** The form that adds a server: a provider, which fills in its name and published address, then how Jet signs in. */
function addForm({ providers, redirect, add }) {
  const provider = h('select', {});
  const name = textInput({ maxlength: '60' });
  const address = textInput({ inputmode: 'url', placeholder: 'https://example.com/mcp' });
  const providerNote = h('p', { class: 'note' });
  const key = keyEditor(SIGN_IN, { label: 'How Jet signs in', kinds: ADD_KINDS });
  const redirectHolder = h('div', { class: 'mcp-redirect-holder' });
  const submitWords = () => (key.kind === SIGN_IN ? 'Add' : 'Add and test');
  const submit = h('button', { type: 'submit', class: 'action', text: submitWords() });
  const problem = h('p', { class: 'problem', role: 'alert' });
  let picked = null;
  // A provider that asks for a client of the user's own needs this address in its console.
  key.onKind = (kind) => {
    const shows = kind === SIGN_IN && picked?.needsOwnClient === true && redirect() !== '';
    redirectHolder.replaceChildren(...(shows ? [redirectLine(redirect())] : []));
    submit.textContent = submitWords();
  };

  const pick = () => {
    const next = providers().find((candidate) => candidate.id === provider.value) ?? null;
    if (name.value.trim() === '' || name.value === picked?.label) name.value = next && next.id !== 'custom' ? next.label : '';
    address.value = next?.address ?? '';
    providerNote.textContent = next?.note ?? '';
    picked = next;
    key.kind = SIGN_IN;
  };
  provider.addEventListener('change', pick);

  const el = h('form', { class: 'mcp-add mcp-panel', hidden: true, 'aria-label': 'Add an MCP server' },
    field('Provider', provider), h('div', { class: 'mcp-pair' }, field('Name', name), field('Address', address)), providerNote,
    key.el, redirectHolder,
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
      submit.textContent = submitWords();
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
