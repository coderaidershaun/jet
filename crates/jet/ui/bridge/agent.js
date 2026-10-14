// The page's one way to talk to Claude. Every other module is handed an Agent
// and never asks which one it is. Inside Tauri it is the real agent, which calls
// the Rust side; in a plain browser it is the pretend agent, which keeps
// everything in the browser.

import { createFakeAgent } from './fake-agent.js';
import { createTauriAgent } from './tauri-agent.js';

/** @typedef {{ found: boolean, path: string | null, searched: string[] }} ClaudeStatus */
/** @typedef {{ lastRequestAt: number | null, ttlMinutes: number, contextTokens: number }} CacheStatus */
/**
 * `id` is null only for an entry that was never saved, such as a send that failed before a reply began.
 * @typedef {{
 *   id: number | null, role: 'user' | 'jet', text: string, html: string, mood?: string,
 *   status: 'complete' | 'stopped' | 'failed', error?: string, at: number,
 * }} ShownEntry
 */
/** @typedef {{ memory: string, user: string, recent: string, limits?: { memory: number, user: number, recent: number } }} Notes */
/** @typedef {{ kind: 'busy' | 'claudeMissing' | 'claudeFailed' | 'timeout' | 'io' | 'badLink', message: string }} Failure */
/** @typedef {{ inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, cacheCreation1hTokens: number, outputTokens: number, thinkingTokens: number, model: string }} Usage */

/**
 * @typedef {{ kind: 'rawLine', line: string }
 *   | { kind: 'started', sessionId: string, model: string, fresh: boolean }
 *   | { kind: 'notice', message: string }
 *   | { kind: 'mood', mood: string }
 *   | { kind: 'text', delta: string }
 *   | { kind: 'finished', entry: ShownEntry, durationMs: number, costUsd: number, usage: Usage }
 *   | { kind: 'failed', failure: Failure, entry: ShownEntry }
 *   | { kind: 'stopped', entry: ShownEntry }} AgentEvent
 */

/**
 * @typedef {object} SendRequest
 * @property {string} text
 * @property {string} model
 * @property {string} effort
 * @property {number} budgetUsd
 * @property {{ name: string, jobTitle: string, notes: string }} persona
 * @property {{ candid: number, playful: number }} behaviour
 * @property {string} localTime
 * @property {string | null} claudePath
 */

/**
 * @typedef {object} Agent
 * @property {() => Promise<{ claude: ClaudeStatus, dataDir: string, busy: boolean, cache: CacheStatus }>} status
 * @property {() => Promise<ShownEntry[]>} history
 * @property {(request: SendRequest, onEvent: (event: AgentEvent) => void) => Promise<ShownEntry>} send
 *   resolves with the saved user entry; the reply streams to `onEvent`
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} forget   rejects with kind "busy" while a reply runs
 * @property {() => Promise<Notes>} loadMemory
 * @property {(notes: { memory: string, user: string, recent: string }) => Promise<Notes>} saveMemory
 * @property {(text: string) => Promise<string>} renderMarkdown
 * @property {(url: string) => Promise<void>} openLink
 * @property {(listener: (notes: Notes) => void) => () => void} onMemoryUpdated   returns the way to stop listening
 */

/** @returns {Agent} */
export function connectAgent() {
  const tauri = globalThis.window?.__TAURI__;
  return tauri ? createTauriAgent(tauri) : createFakeAgent();
}
