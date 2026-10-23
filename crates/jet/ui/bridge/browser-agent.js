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

export function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createBrowserAgent({ fetch: fetcher = globalThis.fetch, EventSource: Source = globalThis.EventSource, storage = globalThis.sessionStorage, uuid = randomId, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let clientId = storage?.getItem('jet.browserClient');
  if (!clientId) { clientId = uuid(); storage?.setItem('jet.browserClient', clientId); }
  const call = (path, body, method, signal) => requestJson(path, body, method, fetcher, signal);
  const memoryListeners = new Set();
  let observer = null;
  let source = null;
  let epoch = null;
  let cursor = null;
  let stopped = false;
  let reconnectTimer = null;
  const callbacks = new Map();
  let pending = null;

  function connect() {
    if (stopped) return;
    const query = epoch === null ? '' : '?epoch=' + encodeURIComponent(epoch) + '&cursor=' + cursor;
    source = new Source('/api/events' + query);
    source.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.kind === 'resync') { epoch = null; cursor = null; reconnect(); return; }
      if (message.kind === 'snapshot') {
        epoch = message.data.epoch;
        cursor = message.data.cursor;
        observer?.snapshot(message.data);
        return;
      }
      if (message.kind !== 'event' || message.data.cursor <= cursor) return;
      cursor = message.data.cursor;
      const envelope = message.data;
      if (envelope.event.kind === 'memoryUpdated') for (const listener of memoryListeners) listener(envelope.event.notes);
      if (envelope.event.kind === 'shutdown') { reconnect(); return; }
      if (envelope.event.kind === 'historyChanged') { epoch = null; cursor = null; reconnect(); return; }
      if (observer) observer.event(envelope);
      else callbacks.get(envelope.turn?.requestId)?.(envelope.event);
      if (['finished', 'failed', 'stopped'].includes(envelope.event.kind)) callbacks.delete(envelope.turn?.requestId);
    };
    source.onerror = reconnect;
  }
  function reconnect() {
    source?.close();
    clearTimeout(reconnectTimer);
    if (!stopped) reconnectTimer = setTimeout(connect, 300);
  }

  return {
    serverEvents: true,
    clientId,
    status: () => call('/api/status'),
    history: async () => (await call('/api/snapshot')).history,
    snapshot: () => call('/api/snapshot'),
    feel: (text) => call('/api/feel', { text }),
    async stop(requestId = pending?.requestId) {
      if (!requestId) return;
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
    readLibraryImage: (path) => call('/api/image', { path }),
    async openLink(url) {
      if (!/^(https?:|mailto:)/i.test(url.trim())) throw { kind: 'badLink', message: 'Only web and mail links can be opened.' };
      globalThis.open(url, '_blank', 'noopener,noreferrer');
    },
    reloadLibraries: async () => {},
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
      return () => { stopped = true; source?.close(); clearTimeout(reconnectTimer); observer = null; };
    },
    onMemoryUpdated(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); },
  };
}
