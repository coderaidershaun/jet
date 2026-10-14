// A pretend Claude for the browser. It keeps its history, session and notes in
// storage, streams a reply as real stream-json lines with the typed events
// made from them, and fails on demand when the user's words ask for it. It
// stays the agent whenever the page runs outside Tauri.

import { QUANTY_SEARCH } from './fixtures/quanty-search.js';
import { renderMarkdown } from './markdown.js';
import { BASE_CONTEXT_TOKENS, MESSAGES, MODEL_IDS, bodyFor, chunksOf, costFor, lines, moodFor, tokensIn, usageFor, wants, wireModelUsage, wireUsage } from './fake-script.js';

const KEY = 'jet.fake.';
const HISTORY_LIMIT = 200;
const CACHE_TTL_MINUTES = 60;
const DELTAS_PER_MESSAGE_DELTA = 4;
const NOTE_LIMITS = { memory: 2200, user: 1375, recent: 1500 };
const NOT_FOUND_AT = ['~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bridgeError = (kind, message) => ({ kind, message });

/**
 * @param {{
 *   storage?: { getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void },
 *   now?: () => number,
 *   wait?: (ms: number) => Promise<void>,
 *   chunkMs?: number, chunkChars?: number, firstTokenMs?: number, slowMs?: number, toolMs?: number,
 *   claudeFound?: boolean,
 * }} [options]
 * @returns {import('./agent.js').Agent}
 */
export function createFakeAgent({
  storage = globalThis.localStorage,
  now = Date.now,
  wait = sleep,
  chunkMs = 40,
  chunkChars = 6,
  firstTokenMs = 2600,
  slowMs = 12000,
  toolMs = 800,
  claudeFound = true,
} = {}) {
  const read = (name, fallback) => {
    const raw = storage.getItem(KEY + name);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn('fake agent: ignoring unreadable ' + KEY + name + ':', error);
      return fallback;
    }
  };
  const write = (name, value) => storage.setItem(KEY + name, JSON.stringify(value));

  const listeners = new Set();
  /** @type {{ stopped: boolean, stop: () => void, stopSignal: Promise<void> } | null} */
  let running = null;

  const saveEntry = (entry) => {
    const id = read('nextId', 1);
    write('nextId', id + 1);
    const saved = { ...entry, id };
    write('history', [...read('history', []), saved].slice(-HISTORY_LIMIT));
    return saved;
  };

  const cacheStatus = () => ({ lastRequestAt: read('lastRequestAt', null), ttlMinutes: CACHE_TTL_MINUTES, contextTokens: read('contextTokens', 0) });

  // A reply that throws must still end, or the page waits forever and refuses every later send as busy.
  function crashed(control, error, onEvent) {
    console.error('fake agent: the reply crashed:', error);
    if (running !== control) return;
    running = null;
    const message = 'The pretend agent failed: ' + (error instanceof Error ? error.message : String(error));
    const entry = { id: null, role: 'jet', text: '', html: '', status: 'failed', error: message, at: now() };
    onEvent({ kind: 'failed', failure: { kind: 'io', message }, entry });
  }

  async function reply(request, onEvent) {
    const startedAt = now();
    const control = running;
    const text = request.text;
    const asks = wants(text);
    const emit = (event) => {
      try {
        onEvent(event);
      } catch (error) {
        console.error('fake agent: the listener for the "' + event.kind + '" event threw:', error);
      }
    };
    // Waits, but wakes at once when Stop is pressed.
    const pause = (ms) => Promise.race([wait(ms), control.stopSignal]);
    const end = (event) => {
      running = null;
      emit(event);
    };
    const failWith = (kind, message) => {
      const entry = saveEntry({ role: 'jet', text: '', html: '', status: 'failed', error: message, at: now() });
      end({ kind: 'failed', failure: { kind, message }, entry });
    };

    if (asks.missing || !claudeFound) return failWith('claudeMissing', MESSAGES.claudeMissing);

    const previous = read('session', null);
    const fresh = previous === null || asks.fresh;
    const sessionId = fresh ? crypto.randomUUID() : previous;
    const lastRequestAt = read('lastRequestAt', null);
    const warm = !fresh && lastRequestAt !== null && startedAt - lastRequestAt < CACHE_TTL_MINUTES * 60 * 1000;
    const contextBefore = fresh ? BASE_CONTEXT_TOKENS : read('contextTokens', BASE_CONTEXT_TOKENS);
    write('session', sessionId);
    write('lastRequestAt', startedAt);

    const model = MODEL_IDS[request.model] ?? MODEL_IDS.sonnet;
    const mcp = ['polysim', 'quanty'].filter((name) => request.mcp?.[name]?.enabled).map((name) => ({ name, status: 'connected' }));
    emit({ kind: 'rawLine', line: lines.init(sessionId, model, mcp) });
    emit({ kind: 'started', sessionId, model, fresh, mcp });
    if (asks.fresh) emit({ kind: 'notice', message: MESSAGES.fresh });

    if (asks.timeout) return failWith('timeout', MESSAGES.timeout);
    if (asks.error) {
      const noUsage = wireUsage({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0 }, 0);
      const result = { text: MESSAGES.claudeFailed, isError: true, durationMs: now() - startedAt, costUsd: 0, usage: noUsage };
      emit({ kind: 'rawLine', line: lines.result(sessionId, result) });
      return failWith('claudeFailed', MESSAGES.claudeFailed);
    }

    const replyNumber = read('history', []).filter((entry) => entry.role === 'jet' && entry.status === 'complete').length + 1;
    const mood = moodFor(text, replyNumber);
    const body = asks.quanty ? QUANTY_SEARCH.reply : bodyFor(text, replyNumber);
    let received = '';
    const calls = [];
    const withCalls = (entry) => (calls.length ? { ...entry, tools: calls } : entry);
    // Known before streaming, so the first line of the stream can already carry the input and cache counts.
    const { usage, outputTokens, contextAfter } = usageFor({ contextBefore, userText: text, replyText: body, warm });

    const stopped = () => {
      const entry = saveEntry(withCalls({ role: 'jet', text: received, html: renderMarkdown(received), status: 'stopped', at: now() }));
      end({ kind: 'stopped', entry });
    };

    async function searchLibrary() {
      const { use, result } = QUANTY_SEARCH;
      const [, server, tool] = use.name.split('__');
      emit({ kind: 'rawLine', line: lines.toolUse(sessionId, use) });
      emit({ kind: 'toolStarted', id: use.id, server, tool, input: use.input });
      const calledAt = now();
      await pause(toolMs);
      if (control.stopped) return false;
      const summary = server + ' · ' + tool + ' · ' + result.results.length + ' results';
      const durationMs = now() - calledAt;
      emit({ kind: 'rawLine', line: lines.toolResult(sessionId, { id: use.id, result }) });
      emit({ kind: 'toolFinished', id: use.id, server, tool, ok: true, result, summary, durationMs });
      calls.push({ id: use.id, server, tool, input: use.input, ok: true, result, summary, durationMs });
      return true;
    }

    await pause(asks.slow ? slowMs : firstTokenMs);
    if (control.stopped) return stopped();

    const ttftMs = now() - startedAt;
    if (asks.quanty && !(await searchLibrary())) return stopped();
    emit({ kind: 'rawLine', line: lines.messageStart(sessionId, { model, usage, ttftMs }) });
    if (mood) {
      emit({ kind: 'rawLine', line: lines.delta(sessionId, 'mood: ' + mood + '\n') });
      emit({ kind: 'mood', mood });
    }
    let deltaCount = 0;
    for (const chunk of chunksOf(body, chunkChars)) {
      if (control.stopped) return stopped();
      emit({ kind: 'rawLine', line: lines.delta(sessionId, chunk) });
      received += chunk;
      emit({ kind: 'text', delta: chunk });
      deltaCount += 1;
      if (deltaCount % DELTAS_PER_MESSAGE_DELTA === 0) {
        emit({ kind: 'rawLine', line: lines.messageDelta(sessionId, { usage, outputTokens: tokensIn(received), stopReason: null }) });
      }
      await pause(chunkMs);
    }
    if (control.stopped) return stopped();

    emit({ kind: 'rawLine', line: lines.messageDelta(sessionId, { usage, outputTokens, stopReason: 'end_turn' }) });
    const durationMs = now() - startedAt;
    const costUsd = costFor(usage, outputTokens);
    write('contextTokens', contextAfter);
    emit({ kind: 'rawLine', line: lines.assistant(sessionId, (mood ? 'mood: ' + mood + '\n' : '') + received) });
    const modelUsage = wireModelUsage({ model, usage, outputTokens, costUsd });
    const result = { text: received, isError: false, durationMs, ttftMs, costUsd, usage: wireUsage(usage, outputTokens), modelUsage };
    emit({ kind: 'rawLine', line: lines.result(sessionId, result) });
    const html = renderMarkdown(received);
    const entry = saveEntry(withCalls({ role: 'jet', text: received, html, ...(mood ? { mood } : {}), status: 'complete', at: now() }));
    end({ kind: 'finished', entry, durationMs, costUsd, usage: { ...usage, outputTokens, thinkingTokens: 0, model } });
  }

  return {
    async status() {
      return {
        claude: claudeFound ? { found: true, path: '~/.local/bin/claude', searched: [] } : { found: false, path: null, searched: NOT_FOUND_AT },
        dataDir: 'browser storage',
        busy: running !== null,
        cache: cacheStatus(),
      };
    },

    async history() {
      return read('history', []).slice(-HISTORY_LIMIT);
    },

    async send(request, onEvent) {
      if (running) throw bridgeError('busy', MESSAGES.busy);
      const user = saveEntry({ role: 'user', text: request.text, html: '', status: 'complete', at: now() });
      let wake;
      const control = {
        stopped: false,
        stopSignal: new Promise((resolve) => { wake = resolve; }),
        stop: () => {
          control.stopped = true;
          wake();
        },
      };
      running = control;
      // The reply starts after this call returns, as the real bridge's thread does.
      setTimeout(() => reply(request, onEvent).catch((error) => crashed(control, error, onEvent)), 0);
      return user;
    },

    async stop() {
      if (running) running.stop();
    },

    async forget() {
      if (running) throw bridgeError('busy', MESSAGES.busy);
      storage.removeItem(KEY + 'history');
      storage.removeItem(KEY + 'session');
      storage.removeItem(KEY + 'lastRequestAt');
      storage.removeItem(KEY + 'contextTokens');
    },

    async loadMemory() {
      return { ...read('notes', { memory: '', user: '', recent: '' }), limits: NOTE_LIMITS };
    },

    async saveMemory(notes) {
      const saved = { memory: notes.memory, user: notes.user, recent: notes.recent };
      write('notes', saved);
      return { ...saved, limits: NOTE_LIMITS };
    },

    async renderMarkdown(text) {
      return renderMarkdown(text);
    },

    async openLink(url) {
      if (!/^(https?:|mailto:)/i.test(url)) throw bridgeError('badLink', 'Only http, https and mailto links open: ' + url);
      window.open(url, '_blank', 'noopener');
    },

    onMemoryUpdated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
