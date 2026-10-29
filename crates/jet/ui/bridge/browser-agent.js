import { readAppImage } from './images.js';
import { uploadFile } from './uploads.js';

// Browser connections observe server-owned turns; reconnecting never starts another reply.

export async function requestJson(path, body, method = body === undefined ? 'GET' : 'POST', fetcher = globalThis.fetch, signal) {
  let response;
  try {
    response = await fetcher(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (error) {
    throw { kind: 'network', message: error.message ?? String(error) };
  }
  let value;
  try { value = await response.json(); }
  catch (error) { throw { kind: 'network', message: error.message ?? String(error) }; }
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

/** The words in a clip of 16 kHz 16-bit mono sound. Only the bytes the view covers are sent, not the whole buffer behind it. */
function requestWords(pcm, vocabulary, fetcher, signal) {
  const query = vocabulary.map((term) => 'vocabulary=' + encodeURIComponent(term)).join('&');
  const body = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  return postVoice('/api/voice/hear' + (query ? '?' + query : ''), { contentType: 'audio/L16;rate=16000;channels=1', body, read: (response) => response.json() }, fetcher, signal);
}

export function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createBrowserAgent({ fetch: fetcher = globalThis.fetch, EventSource: Source = globalThis.EventSource, storage = globalThis.sessionStorage, uuid = randomId, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let clientId = storage?.getItem('jet.browserClient');
  if (!clientId) { clientId = uuid(); storage?.setItem('jet.browserClient', clientId); }
  const call = (path, body, method, signal) => requestJson(path, body, method, fetcher, signal);
  const memoryListeners = new Set();
  const registryListeners = new Set();
  const appListeners = new Set();
  const connectionListeners = new Set();
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
  let stopped = false;
  let reconnectTimer = null;
  const callbacks = new Map();
  let pending = null;

  function sameTurn(left, right) {
    return left && right && ['clientId', 'requestId', 'turnId'].every(key => typeof left[key] === 'string' && left[key] && left[key] === right[key]);
  }
  async function openApp(envelope) {
    const action = envelope.event;
    if (action.clientId !== clientId || !sameTurn(action, activeIdentity) || cancelledActions.has(action.requestId)) return;
    const generation = actionGeneration, eventEpoch = epoch;
    const current = () => generation === actionGeneration && eventEpoch === epoch && sameTurn(action, activeIdentity) && !cancelledActions.has(action.requestId);
    try {
      const snapshot = await call('/api/snapshot');
      if (!current() || snapshot.epoch !== eventEpoch || snapshot.cursor < envelope.cursor || !sameTurn(action, snapshot.active?.identity)) return;
      for (const listener of appListeners) listener(action, current);
    } catch (error) { console.warn('App opening could not be verified:', error.message ?? error); }
  }
  function connect() {
    if (stopped) return;
    const query = epoch === null ? '' : '?epoch=' + encodeURIComponent(epoch) + '&cursor=' + cursor;
    source = new Source('/api/events' + query);
    source.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.kind === 'resync') { epoch = null; cursor = null; reconnect(); return; }
      if (message.kind === 'snapshot') {
        actionGeneration++;
        activeIdentity = message.data.active?.identity ?? null;
        epoch = message.data.epoch;
        cursor = message.data.cursor;
        observer?.snapshot(message.data);
        return;
      }
      if (message.kind !== 'event' || message.data.cursor <= cursor) return;
      cursor = message.data.cursor;
      const envelope = message.data;
      if (envelope.event.kind === 'accepted') { actionGeneration++; activeIdentity = envelope.turn; }
      if (['finished', 'failed', 'stopped'].includes(envelope.event.kind) && sameTurn(envelope.turn, activeIdentity)) { actionGeneration++; activeIdentity = null; }
      if (envelope.event.kind === 'appOpened') void openApp(envelope);
      if (envelope.event.kind === 'memoryUpdated') for (const listener of memoryListeners) listener(envelope.event.notes);
      if (envelope.event.kind === 'registryChanged') for (const listener of registryListeners) listener(envelope.event);
      if (envelope.event.kind === 'shutdown') { reconnect(); return; }
      if (envelope.event.kind === 'historyChanged') { epoch = null; cursor = null; reconnect(); return; }
      if (observer) observer.event(envelope);
      else callbacks.get(envelope.turn?.requestId)?.(envelope.event);
      if (['finished', 'failed', 'stopped'].includes(envelope.event.kind)) callbacks.delete(envelope.turn?.requestId);
    };
    source.onopen = () => setConnected(true);
    source.onerror = () => { setConnected(false); reconnect(); };
  }
  function reconnect() {
    actionGeneration++;
    source?.close();
    clearTimeout(reconnectTimer);
    if (!stopped) reconnectTimer = setTimeout(connect, 300);
  }

  return {
    serverEvents: true,
    clientId,
    status: () => call('/api/status'),
    history: async () => (await call('/api/snapshot')).history,
    feel: (text) => call('/api/feel', { text }),
    async stop(requestId = pending?.requestId) {
      if (!requestId) return;
      actionGeneration++;
      cancelledActions.add(requestId);
      if (cancelledActions.size > 512) cancelledActions.delete(cancelledActions.values().next().value);
      if (pending?.requestId === requestId) {
        pending.cancelled = true;
        pending.controller.abort();
      }
      for (;;) {
        try { return await call('/api/chat/stop', { requestId }); }
        catch (error) {
          if (error.kind !== 'network') throw error;
          await delay(300);
        }
      }
    },
    forget: () => call('/api/chat/forget', {}),
    loadMemory: () => call('/api/memory'),
    saveMemory: (notes) => call('/api/memory', notes, 'PUT'),
    renderMarkdown: (text) => call('/api/markdown', { text }),
    voiceStatus: () => call('/api/voice'),
    hear: (pcm, vocabulary, signal) => requestWords(pcm, vocabulary, fetcher, signal),
    speech: (text, signal, mood) => requestAudio('/api/voice/speech', mood ? { text, mood } : { text }, fetcher, signal),
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
      const payload = { ...request, requestId: request.requestId ?? uuid(), clientId };
      callbacks.set(payload.requestId, onEvent);
      const sending = { requestId: payload.requestId, cancelled: false, controller: new AbortController() };
      pending = sending;
      if (!source) connect();
      try {
        for (;;) {
          if (sending.cancelled) throw { kind: 'cancelled', message: 'The request was stopped.' };
          try { return (await call('/api/chat/send', payload, 'POST', sending.controller.signal)).user; }
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
