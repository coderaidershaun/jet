// Choose the real server bridge unless development explicitly requests the local fixture.

import { createFakeAgent } from './fake-agent.js';
import { createBrowserAgent } from './browser-agent.js';

/** @typedef {{ found: boolean, path: string | null, searched: string[] }} ClaudeStatus */
/** The state of one MCP server when a reply started. Only `failed` means offline; `pending` is still starting. @typedef {{ name: string, status: string }} McpStatus */
/** One finished call of an MCP tool. @typedef {{ id: string, server: string, tool: string, input: any, ok: boolean, result: any, summary: string, durationMs: number }} ToolCall */
/** @typedef {{ lastRequestAt: number | null, ttlMinutes: number, contextTokens: number }} CacheStatus */
/**
 * `id` is null only for an entry that was never saved, such as a send that failed before a reply began.
 * @typedef {{
 *   id: number | null, role: 'user' | 'jet', text: string, html: string, mood?: string,
 *   status: 'complete' | 'stopped' | 'failed', error?: string, tools?: ToolCall[], at: number,
 * }} ShownEntry
 */
/** @typedef {{ memory: string, user: string, recent: string, limits?: { memory: number, user: number, recent: number } }} Notes */
/** @typedef {{ kind: 'busy' | 'claudeMissing' | 'claudeFailed' | 'timeout' | 'io' | 'badLink', message: string }} Failure */
/** @typedef {{ inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, cacheCreation1hTokens: number, outputTokens: number, thinkingTokens: number, model: string }} Usage */

/**
 * @typedef {{ kind: 'rawLine', line: string }
 *   | { kind: 'started', sessionId: string, model: string, fresh: boolean, mcp: McpStatus[] }
 *   | { kind: 'notice', message: string }
 *   | { kind: 'mood', mood: string }
 *   | { kind: 'text', delta: string }
 *   | { kind: 'toolStarted', id: string, server: string, tool: string, input: any }
 *   | { kind: 'toolFinished', id: string, server: string, tool: string, ok: boolean, result: any, summary: string, durationMs: number }
 *   | { kind: 'finished', entry: ShownEntry, durationMs: number, costUsd: number, usage: Usage }
 *   | { kind: 'failed', failure: Failure, entry: ShownEntry }
 *   | { kind: 'stopped', entry: ShownEntry }} AgentEvent
 */

/**
 * @typedef {object} SendRequest
 * @property {string | null} [feeling]
 * @property {string} text
 * @property {string} model
 * @property {string} effort
 * @property {number} budgetUsd
 * @property {{ name: string, jobTitle: string, notes: string }} persona
 * @property {string} localTime
 * @property {string | null} claudePath
 * @property {string | null} codexPath
 * @property {import('./settings.js').Settings['mcp']} mcp
 */

/**
 * @typedef {object} Agent
 * @property {() => Promise<{ claude: ClaudeStatus, dataDir: string, busy: boolean, cache: CacheStatus }>} status
 * @property {(text: string) => Promise<{ mood: string, scores: object }>} feel
 * @property {() => Promise<ShownEntry[]>} history
 * @property {(request: SendRequest, onEvent: (event: AgentEvent) => void) => Promise<ShownEntry>} send
 *   resolves with the saved user entry; the reply streams to `onEvent`
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} forget   rejects with kind "busy" while a reply runs
 * @property {() => Promise<Notes>} loadMemory
 * @property {(notes: { memory: string, user: string, recent: string }) => Promise<Notes>} saveMemory
 * @property {(text: string) => Promise<string>} renderMarkdown
 * @property {(path: string) => Promise<string>} readLibraryImage   rejects when no registered image route is available
 * @property {(url: string) => Promise<void>} openLink
 * @property {() => Promise<void>} reloadLibraries   compatibility hook for the existing settings panel
 * @property {(listener: (notes: Notes) => void) => () => void} onMemoryUpdated   returns the way to stop listening
 */

/** @returns {Agent} */
export function connectAgent() {
  return globalThis.__JET_FAKE__ === true ? createFakeAgent() : createBrowserAgent();
}
