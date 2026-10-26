// The page's connection to the Jet server.

import { createBrowserAgent } from './browser-agent.js';

/** @typedef {{ found: boolean, path: string | null, searched: string[] }} ClaudeStatus */
/** One finished call of an MCP tool. @typedef {{ id: string, server: string, tool: string, input: any, ok: boolean, result: any, summary: string, durationMs: number }} ToolCall */
/** @typedef {{ model: string | null, usedTokens: number | null, limitTokens: number | null, estimated: boolean }} ContextStatus */
/**
 * `id` is null only for an entry that was never saved, such as a send that failed before a reply began.
 * @typedef {{
 *   id: number | null, role: 'user' | 'jet', text: string, html: string, mood?: string,
 *   status: 'complete' | 'stopped' | 'failed', error?: string, tools?: ToolCall[], at: number,
 * }} ShownEntry
 */
/** @typedef {{ memory: string, user: string, recent: string, limits?: { memory: number, user: number, recent: number } }} Notes */
/** @typedef {{ kind: 'busy' | 'claudeMissing' | 'claudeFailed' | 'timeout' | 'io' | 'badLink', message: string }} Failure */

/**
 * @typedef { { kind: 'started', fresh: boolean }
 *   | { kind: 'notice', message: string }
 *   | { kind: 'mood', mood: string }
 *   | { kind: 'text', delta: string }
 *   | { kind: 'toolStarted', id: string, server: string, tool: string, input: any }
 *   | { kind: 'toolFinished', id: string, server: string, tool: string, ok: boolean, result: any, summary: string, durationMs: number }
 *   | { kind: 'finished', entry: ShownEntry }
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
 */

/**
 * @typedef {object} Agent
 * @property {() => Promise<{ claude: ClaudeStatus, context: ContextStatus }>} status
 * @property {(text: string) => Promise<{ mood: string, scores: object }>} feel
 * @property {() => Promise<ShownEntry[]>} history
 * @property {(request: SendRequest, onEvent: (event: AgentEvent) => void) => Promise<ShownEntry>} send
 *   resolves with the saved user entry; the reply streams to `onEvent`
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} forget   rejects with kind "busy" while a reply runs
 * @property {() => Promise<Notes>} loadMemory
 * @property {(notes: { memory: string, user: string, recent: string }) => Promise<Notes>} saveMemory
 * @property {(text: string) => Promise<string>} renderMarkdown
 * @property {(appId: string, path: string) => Promise<string>} readAppImage   rejects when no registered image route is available
 * @property {(url: string) => Promise<void>} openLink
 * @property {(listener: (notes: Notes) => void) => () => void} onMemoryUpdated   returns the way to stop listening
 */

/** @returns {Agent} */
export function connectAgent() {
  return createBrowserAgent();
}
