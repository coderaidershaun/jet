import { readAppImage } from './images.js';
import { uploadFile } from './uploads.js';

// Browser connections observe server-owned turns; reconnecting never starts another reply.

const TERMINAL = new Set(['finished', 'failed', 'stopped', 'noReply']);
/** Events about the chat list rather than a turn: the page's chat list reads them for every chat, not only the open one. */
const CHAT_LEVEL = new Set(['unread', 'entryAdded', 'chatsChanged', 'paneChanged']);

export async function requestJson(path, body, method = body === undefined ? 'GET' : 'POST', fetcher = globalThis.fetch, signal) {
  let response;
  try {
    response = await fetcher(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (error) {
    throw { kind: 'network', message: error.message ?? String(error) };
  }
  let value;
  try { value = await response.json(); }
  catch (error) {
    // A refusal with a text or HTML body is an answer, not a lost connection; only a gateway that is down is worth another try.
    if (!response.ok && ![502, 503, 504].includes(response.status)) throw { kind: 'http', status: response.status, message: `Jet refused the request (${response.status}).` };
    throw { kind: 'network', message: error.message ?? String(error) };
  }
  if (!response.ok) throw value;
  return value;
}

/** Posts a body to a voice route and reads the answer. A refusal is thrown as `{ kind, message }`, like any other call. */
async function postVoice(path, { contentType, body, read }, fetcher, signal) {
  let response;
  try {
    response = await fetcher(path, { method: 'POST', headers: { 'Content-Type': contentType }, body, signal });
  } catch (error) {
    throw { kind: 'network', message: error.message ?? String(error) };
  }
  if (!response.ok) {
    const refusal = await response.json().catch(() => ({}));
    throw { kind: refusal.kind ?? 'http', message: refusal.message ?? 'The voice request failed.' };
  }
  try { return await read(response); }
  catch (error) { throw { kind: 'network', message: error.message ?? String(error) }; }
}

const requestAudio = (path, body, fetcher, signal) => postVoice(path, { contentType: 'application/json', body: JSON.stringify(body), read: (response) => response.arrayBuffer() }, fetcher, signal);

/**
 * The words in a clip of 16 kHz 16-bit mono sound, heard by the server's `engine` ('gemini' when missing) in Phonon-2's
 * `mode`. Only the bytes the view covers are sent, not the whole buffer behind it.
 */
function requestWords(pcm, vocabulary, { engine, mode } = {}, fetcher, signal) {
  const terms = vocabulary.map((term) => 'vocabulary=' + encodeURIComponent(term));
  const choice = engine === 'phonon2' ? ['engine=phonon2', 'mode=' + encodeURIComponent(mode ?? 'fast')] : [];
  const query = [...terms, ...choice].join('&');
  const body = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  return postVoice('/api/voice/hear' + (query ? '?' + query : ''), { contentType: 'audio/L16;rate=16000;channels=1', body, read: (response) => response.json() }, fetcher, signal);
}

export function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createBrowserAgent({ fetch: fetcher = globalThis.fetch, EventSource: Source = globalThis.EventSource, storage = globalThis.sessionStorage, uuid = randomId, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), beforeReconnect = async () => {} } = {}) {
  let clientId = storage?.getItem('jet.browserClient');
  if (!clientId) { clientId = uuid(); storage?.setItem('jet.browserClient', clientId); }
  const call = (path, body, method, signal) => requestJson(path, body, method, fetcher, signal);
  const memoryListeners = new Set();
  const registryListeners = new Set();
  const appListeners = new Set();
  const connectionListeners = new Set();
  const chatListeners = new Set();
  let connected = true;
  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    for (const listener of connectionListeners) listener(value);
  }
  const cancelledActions = new Set();
  let actionGeneration = 0;
  let activeIdentity = null;
  let observer = null;
  let source = null;
  let epoch = null;
  let cursor = null;
  /** The chat on screen. Null means the main chat until a snapshot names it. Every call of a chat carries it. */
  let chat = null;
  /** Per chat, the feed and the position in it that its snapshot already holds, so a later event at or before it is not shown twice. */
  const floors = new Map();
  /** While a chat is being opened, the events of that chat wait here until its snapshot is on screen. */
  let loading = null;
  let openToken = 0;
  let stopped = false;
  let reconnectTimer = null;
  const callbacks = new Map();
  let pending = null;

  const inChat = (path) => (chat === null ? path : path + '?chat=' + chat);
  // A position counts only in its own feed: a server that started again counts from nothing.
  const seenBefore = (chatId, at) => floors.get(chatId)?.epoch === epoch && at <= floors.get(chatId).cursor;
  function sameTurn(left, right) {
    return left && right && ['clientId', 'requestId', 'turnId'].every(key => typeof left[key] === 'string' && left[key] && left[key] === right[key]);
  }
  async function openApp(envelope) {
    const action = envelope.event;
    if (action.clientId !== clientId || !sameTurn(action, activeIdentity) || cancelledActions.has(action.requestId)) return;
    const generation = actionGeneration, eventEpoch = epoch;
    const current = () => generation === actionGeneration && eventEpoch === epoch && sameTurn(action, activeIdentity) && !cancelledActions.has(action.requestId);
    try {
      const snapshot = await call(inChat('/api/snapshot'));
      if (!current() || snapshot.epoch !== eventEpoch || snapshot.cursor < envelope.cursor || !sameTurn(action, snapshot.active?.identity)) return;
      for (const listener of appListeners) listener(action, current);
    } catch (error) { console.warn('App opening could not be verified:', error.message ?? error); }
  }
  function route(envelope) {
    const chatId = envelope.chatId ?? null;
    const { kind } = envelope.event;
    if (kind === 'shutdown') { reconnect(); return; }
    if (kind === 'memoryUpdated') for (const listener of memoryListeners) listener(envelope.event.notes);
    if (kind === 'registryChanged') for (const listener of registryListeners) listener(envelope.event);
    if (CHAT_LEVEL.has(kind)) {
      if (chatId === null || !seenBefore(chatId, envelope.cursor)) for (const listener of chatListeners) listener(envelope);
      return;
    }
    // A turn of another chat shows nowhere on this page; its unread event is what reaches the list.
    if (chatId !== null && chatId !== chat) return;
    if (seenBefore(chatId, envelope.cursor)) return;
    if (kind === 'accepted') { actionGeneration++; activeIdentity = envelope.turn; }
    if (TERMINAL.has(kind) && sameTurn(envelope.turn, activeIdentity)) { actionGeneration++; activeIdentity = null; }
    if (kind === 'appOpened') void openApp(envelope);
    if (kind === 'historyChanged') { epoch = null; cursor = null; reconnect(); return; }
    if (observer) observer.event(envelope);
    else callbacks.get(envelope.turn?.requestId)?.(envelope.event);
    if (TERMINAL.has(kind)) callbacks.delete(envelope.turn?.requestId);
  }
  function connect() {
    if (stopped) return;
    const query = [];
    if (chat !== null) query.push('chat=' + chat);
    if (epoch !== null) query.push('epoch=' + encodeURIComponent(epoch), 'cursor=' + cursor);
    source = new Source('/api/events' + (query.length ? '?' + query.join('&') : ''));
    source.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.kind === 'resync') { epoch = null; cursor = null; reconnect(); return; }
      if (message.kind === 'snapshot') {
        epoch = message.data.epoch;
        cursor = message.data.cursor;
        const shown = message.data.chatId ?? null;
        chat ??= shown;
        if (shown !== chat) return;
        floors.set(shown, { epoch, cursor });
        actionGeneration++;
        activeIdentity = message.data.active?.identity ?? null;
        observer?.snapshot(message.data);
        return;
      }
      if (message.kind !== 'event' || message.data.cursor <= cursor) return;
      cursor = message.data.cursor;
      if (loading && message.data.chatId === chat) loading.push(message.data);
      else route(message.data);
    };
    source.onopen = () => setConnected(true);
    source.onerror = () => { setConnected(false); reconnect(); };
  }
  function reconnect() {
    actionGeneration++;
    source?.close();
    clearTimeout(reconnectTimer);
    if (!stopped) reconnectTimer = setTimeout(connectAgain, 300);
  }
  // A stream that failed because the access token ran out would fail again, so the sign-in is renewed first.
  function connectAgain() {
    beforeReconnect().then(dropDeadChat).then(connect, (error) => {
      if (error?.kind === 'signedOut') return;
      console.warn('the sign-in could not be checked before reconnecting:', error?.message ?? error);
      connect();
    });
  }
  // A chat deleted while the stream was down would answer 404 to every new stream, so the page starts again from the main chat.
  async function dropDeadChat() {
    if (chat === null) return;
    try { await call(inChat('/api/status')); }
    catch (error) {
      if (error.kind !== 'notFound') return;
      chat = null; epoch = null; cursor = null;
    }
  }

  return {
    serverEvents: true,
    clientId,
    status: () => call(inChat('/api/status')),
    /** The open chat's snapshot. The first one names the main chat, so its events can be told from the others. */
    async snapshot() {
      const snapshot = await call(inChat('/api/snapshot'));
      chat ??= snapshot.chatId ?? null;
      return snapshot;
    },
    /**
     * Opens another chat: reads its snapshot, hands it to `show`, and only then lets that chat's events through,
     * those the snapshot does not already hold.
     */
    async openChat(id, show) {
      const token = ++openToken, before = chat;
      chat = id;
      loading = [];
      try {
        const snapshot = await call(inChat('/api/snapshot'));
        if (token !== openToken) return;
        floors.set(id, { epoch: snapshot.epoch, cursor: snapshot.cursor });
        actionGeneration++;
        activeIdentity = snapshot.active?.identity ?? null;
        const late = loading;
        loading = null;
        show(snapshot);
        for (const envelope of late) route(envelope);
      } catch (error) {
        if (token === openToken) { chat = before; loading = null; }
        throw error;
      }
    },
    /** The id of the chat on screen, or null for the main chat before the first snapshot. */
    chatId: () => chat,
    chats: () => call('/api/chats'),
    addChat: () => call('/api/chats', {}),
    renameChat: (id, title) => call('/api/chats/' + id, { title }, 'PATCH'),
    removeChat: (id) => call('/api/chats/' + id, undefined, 'DELETE'),
    /** Moves the chat's read mark to the newest entry, or to `through` when given. */
    markRead: (id, through) => call('/api/chats/' + id + '/read', through === undefined ? {} : { through }),
    onChatEvent(listener) { chatListeners.add(listener); return () => chatListeners.delete(listener); },
    feel: (text) => call('/api/feel', { text }),
    async stop(requestId = pending?.requestId) {
      if (!requestId) return;
      const target = inChat('/api/chat/stop');
      actionGeneration++;
      cancelledActions.add(requestId);
      if (cancelledActions.size > 512) cancelledActions.delete(cancelledActions.values().next().value);
      if (pending?.requestId === requestId) {
        pending.cancelled = true;
        pending.controller.abort();
      }
      for (;;) {
        try { return await call(target, { requestId }); }
        catch (error) {
          if (error.kind !== 'network') throw error;
          await delay(300);
        }
      }
    },
    react: (request) => call(inChat('/api/chat/react'), { ...request, requestId: uuid(), clientId }),
    forget: () => call(inChat('/api/chat/forget'), {}),
    loadMemory: () => call('/api/memory'),
    saveMemory: (notes) => call('/api/memory', notes, 'PUT'),
    renderMarkdown: (text) => call('/api/markdown', { text }),
    voiceStatus: () => call('/api/voice'),
    hear: (pcm, vocabulary, signal, choice) => requestWords(pcm, vocabulary, choice, fetcher, signal),
    /** The engine is Gemini unless it is 'phonon'; the browser's own voice never reaches the server. */
    speech: (text, signal, mood, engine) => requestAudio('/api/voice/speech' + (engine === 'phonon' ? '?engine=phonon' : ''), mood ? { text, mood } : { text }, fetcher, signal),
    readAppImage: (appId, path) => readAppImage(call, appId, path),
    uploadFile,
    async removeFile(id) {
      // The server answers 204 with no body, which `call` could not read.
      const response = await fetcher('/api/files/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw { kind: 'io', message: 'The file could not be removed.' };
    },
    async openLink(url) {
      if (!/^(https?:|mailto:)/i.test(url.trim())) throw { kind: 'badLink', message: 'Only web and mail links can be opened.' };
      globalThis.open(url, '_blank', 'noopener,noreferrer');
    },
    async send(request, onEvent) {
      const { chatId = chat, ...rest } = request;
      const payload = { ...rest, requestId: request.requestId ?? uuid(), clientId };
      // A message belongs to the chat it was typed in, even when the page opened another before it went out.
      const target = chatId === null ? '/api/chat/send' : '/api/chat/send?chat=' + chatId;
      callbacks.set(payload.requestId, onEvent);
      const sending = { requestId: payload.requestId, cancelled: false, controller: new AbortController() };
      pending = sending;
      if (!source) connect();
      try {
        for (;;) {
          if (sending.cancelled) throw { kind: 'cancelled', message: 'The request was stopped.' };
          try { return (await call(target, payload, 'POST', sending.controller.signal)).user; }
          catch (error) {
            if (sending.cancelled) throw { kind: 'cancelled', message: 'The request was stopped.' };
            if (error.kind !== 'network') throw error;
            await delay(300);
          }
        }
      } catch (error) {
        callbacks.delete(payload.requestId);
        throw error;
      } finally {
        if (pending === sending) pending = null;
      }
    },
    watch(snapshot, event) {
      observer = { snapshot, event };
      stopped = false;
      connect();
      return () => { actionGeneration++; activeIdentity = null; stopped = true; source?.close(); clearTimeout(reconnectTimer); observer = null; };
    },
    onAppOpened(listener) { appListeners.add(listener); return () => appListeners.delete(listener); },
    onRegistryChanged(listener) { registryListeners.add(listener); return () => registryListeners.delete(listener); },
    onConnectionChanged(listener) { connectionListeners.add(listener); return () => connectionListeners.delete(listener); },
    onMemoryUpdated(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); },
  };
}
