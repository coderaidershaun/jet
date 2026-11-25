// The one copy of the user's files on the page. The library, the plan pane, the file dialog and the thread's
// file cards all read it, so they cannot disagree. It reads the list again whenever the page hears that it changed.
// A change is asked of the server here and shows only when that news arrives, so nothing edits the list by hand.

import { requestJson } from '../../bridge/browser-agent.js';
import { isRecord, listOf, numberOrNull, recordOf, stringOf } from '../thread/cards/guard.js';
import { fileLinks } from '../files.js';
import { attachmentName } from './words.js';

/**
 * @typedef {{ id: string, name: string, kind: string, bytes: number, details: string, by: string, context: string,
 *   changedAt: number, version: number, earlier: number[], chats: number[] }} File
 * @typedef {{ status: 'loading' | 'ready' | 'failed', files: File[], usedBytes: number, limitBytes: number, refreshFailed: boolean }} State
 */

const numbers = (value) => listOf(value).filter((item) => numberOrNull(item) !== null);

/** One file as the server sends it, or null when it lacks what the page needs to show it and link to it. */
function readFile(raw) {
  const file = recordOf(raw);
  if (!fileLinks(file.id) || stringOf(file.name) === '') return null;
  return Object.freeze({
    id: file.id.toLowerCase(), name: file.name, kind: stringOf(file.kind), bytes: numberOrNull(file.bytes) ?? 0,
    details: stringOf(file.details), by: stringOf(file.by), context: stringOf(file.context), changedAt: numberOrNull(file.changedAt) ?? 0,
    version: numberOrNull(file.version) ?? 1, earlier: numbers(file.earlier), chats: numbers(file.chats),
  });
}

/** The answer of GET /api/files, with every file the page cannot use left out. */
export function readLibrary(raw) {
  const library = recordOf(raw);
  return {
    files: listOf(library.files).filter(isRecord).map(readFile).filter(Boolean),
    usedBytes: numberOrNull(library.usedBytes) ?? 0,
    limitBytes: numberOrNull(library.limitBytes) ?? 0,
  };
}

/** A call whose answer may have no body (a delete answers 204). A refusal is thrown as the server's `{ kind, message }`. */
async function send(method, path, body) {
  let response;
  try {
    response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    throw { kind: 'network', message: error.message ?? String(error) };
  }
  if (response.ok) return response;
  const refusal = await response.json().catch(() => ({}));
  throw { kind: stringOf(refusal.kind) || 'http', message: stringOf(refusal.message) || `the server answered ${response.status}` };
}

/** @type {State} */
let state = { status: 'loading', files: [], usedBytes: 0, limitBytes: 0, refreshFailed: false };
let readNumber = 0;
const listeners = new Set();
// A file is new to the list until a read brings it in, so absence alone never means deleted. A file is gone once a
// list that held it no longer does, or once the server answers that no file of the user has its id. That answer is
// asked for an id no list has held, such as a card drawn after a reload, and it covers unsent uploads too.
const seen = new Set();
const deleted = new Set();
const there = new Set();
const asking = new Set();
const tell = () => { for (const listener of listeners) listener(state); };
const path = (id) => '/api/files/' + encodeURIComponent(id);

/** Asks the server once whether the user still has a file. Only a 404 counts as deleted; any other answer leaves it alone. */
async function confirm(id) {
  if (asking.has(id)) return;
  asking.add(id);
  try {
    const response = await fetch(path(id), { method: 'HEAD' });
    if (response.status === 404) deleted.add(id);
    else if (response.ok) there.add(id);
    else asking.delete(id);
  } catch (error) {
    asking.delete(id);
    console.warn('whether a file is still there could not be asked:', error);
    return;
  }
  tell();
}

async function refresh() {
  const current = ++readNumber;
  try {
    const read = readLibrary(await requestJson('/api/files'));
    if (current !== readNumber) return;
    state = { status: 'ready', ...read, refreshFailed: false };
    for (const file of read.files) seen.add(file.id);
  } catch (error) {
    if (current !== readNumber) return;
    console.warn('the files could not be read:', error);
    state = state.status === 'ready' ? { ...state, refreshFailed: true } : { ...state, status: 'failed' };
  }
  tell();
}

export const files = {
  get state() { return state; },
  /** @returns {File | null} */
  byId: (id) => state.files.find((file) => file.id === id?.toLowerCase()) ?? null,
  /**
   * 'present', 'gone', or 'unknown' while the list loads or the server is being asked about an id no list has held.
   * A file that exists is never 'gone'. Asking about an unknown id starts the question; the answer tells the listeners.
   */
  statusOf(id) {
    const key = String(id ?? '').toLowerCase();
    if (files.byId(key)) return 'present';
    if (state.status !== 'ready') return 'unknown';
    if (seen.has(key) || deleted.has(key)) return 'gone';
    if (there.has(key)) return 'present';
    if (fileLinks(key)) confirm(key);
    return 'unknown';
  },
  isGone: (id) => files.statusOf(id) === 'gone',
  inChat: (chatId) => state.files.filter((file) => file.chats.includes(chatId)),
  /** @param {(state: State) => void} listener */
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  refresh,
  /** Reads the list now and again on every change the page hears of. */
  start() {
    document.addEventListener('jet:pane-changed', refresh);
    refresh();
  },
  /** A first read that failed is tried again with the loading rows back. */
  retry() {
    if (state.status === 'failed') { state = { ...state, status: 'loading' }; tell(); }
    return refresh();
  },

  rename: (id, name) => send('PATCH', path(id), { name }),
  remove: (id) => send('DELETE', path(id)),
  addTo: (id, chat) => send('POST', path(id) + '/chats', { chat }),
  takeFrom: (id, chat) => send('DELETE', `${path(id)}/chats/${encodeURIComponent(chat)}`),
  restore: (id, version) => send('POST', path(id) + '/restore', { version }),
  versions: async (id) => listOf(await (await send('GET', path(id) + '/versions')).json()).filter(isRecord),

  /** Saves the chosen files, or every file when `ids` is null, as one zip. */
  async saveZip(ids) {
    const response = await (ids === null ? send('GET', '/api/files/archive') : send('POST', '/api/files/archive', { ids }));
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = attachmentName(response.headers.get('content-disposition'), 'Jet files.zip');
    document.body.append(link);
    link.click();
    link.remove();
    // The browser has taken the file once the click is handled; the address is no longer needed after that.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
