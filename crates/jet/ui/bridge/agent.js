// The page's connection to the Jet server.

import { createBrowserAgent } from './browser-agent.js';

/** @typedef {{ found: boolean, path: string | null, searched: string[] }} ClaudeStatus */
/** One finished call of an MCP tool. @typedef {{ id: string, server: string, tool: string, input: any, ok: boolean, result: any, summary: string, durationMs: number }} ToolCall */
/** @typedef {{ model: string | null, usedTokens: number | null, limitTokens: number | null, estimated: boolean }} ContextStatus */
/**
 * `id` is null only for an entry that was never saved, such as a send that failed before a reply began.
 * @typedef {{
 *   id: number | null, role: 'user' | 'jet', text: string, html: string, mood?: string,
 *   status: 'complete' | 'stopped' | 'failed', error?: string, tools?: ToolCall[], attachments?: import('../chat/thread/store.js').Attachment[],
 *   reactions?: import('../chat/thread/store.js').Reaction[], at: number,
 * }} ShownEntry
 */
/** @typedef {{ id: number, kind: 'main' | 'objective' | 'topic', title: string, unread: number, activeAt: number }} ChatSummary */
/** @typedef {{ memory: string, user: string, recent: string, limits?: { memory: number, user: number, recent: number } }} Notes */
/** @typedef {{ kind: 'busy' | 'claudeMissing' | 'providerFailed' | 'timeout' | 'io' | 'badLink', message: string }} Failure */

/**
 * @typedef { { kind: 'started', fresh: boolean }
 *   | { kind: 'notice', message: string }
 *   | { kind: 'mood', mood: string }
 *   | { kind: 'text', delta: string }
 *   | { kind: 'toolStarted', id: string, server: string, tool: string, input: any }
 *   | { kind: 'toolProgress', id: string, progress: number, total: number | null, message: string | null }
 *   | { kind: 'toolFinished', id: string, server: string, tool: string, input: any, ok: boolean, result: any, summary: string, durationMs: number }
 *   | { kind: 'finished', entry: ShownEntry }
 *   | { kind: 'failed', failure: Failure, entry: ShownEntry }
 *   | { kind: 'stopped', entry: ShownEntry }
 *   | { kind: 'noReply' }
 *   | { kind: 'reactions', entryId: number, reactions: import('../chat/thread/store.js').Reaction[] }} AgentEvent
 */

/**
 * @typedef {object} SendRequest
 * @property {string | null} [feeling]
 * @property {string} text
 * @property {string[]} [attachments]   the ids of uploaded files
 * @property {string} model
 * @property {string} effort
 * @property {number} budgetUsd
 * @property {{ name: string, jobTitle: string, notes: string }} persona
 * @property {string} localTime
 */

/**
 * @typedef {object} Agent
 * @property {() => Promise<{ program: ClaudeStatus, context: ContextStatus }>} status
 * @property {(text: string) => Promise<{ mood: string, scores: object }>} feel
 * @property {() => Promise<{ chatId: number, history: ShownEntry[], active: any, unread: number, cursor: number }>} snapshot   the open chat's history and running reply
 * @property {(id: number, show: (snapshot: any) => void) => Promise<void>} openChat   makes `id` the open chat: every call below then carries it
 * @property {() => Promise<ChatSummary[]>} chats
 * @property {() => Promise<ChatSummary>} addChat
 * @property {(id: number, title: string) => Promise<object>} renameChat
 * @property {(id: number) => Promise<object>} removeChat
 * @property {(id: number, through?: number) => Promise<{ unread: number }>} markRead
 * @property {(listener: (envelope: { chatId: number | null, cursor: number, event: any }) => void) => () => void} onChatEvent   `unread`, `entryAdded` and `chatsChanged`, for every chat
 * @property {(request: SendRequest, onEvent: (event: AgentEvent) => void) => Promise<ShownEntry>} send
 *   resolves with the saved user entry; the reply streams to `onEvent`
 * @property {() => Promise<void>} stop
 * @property {(request: Omit<SendRequest, 'text' | 'attachments' | 'feeling'> & { entryId: number, emoji: string | null }) => Promise<{ entry: ShownEntry }>} react
 *   puts the user's emoji on a Jet message, or takes it off with null; the new list arrives as a `reactions` event
 * @property {() => Promise<void>} forget   rejects with kind "busy" while a reply runs
 * @property {(confirm: string) => Promise<object>} factoryReset   an admin's wipe of the whole server back to a fresh install; `confirm` is the word the admin typed, which the server checks
 * @property {() => Promise<Notes>} loadMemory
 * @property {(notes: { memory: string, user: string, recent: string }) => Promise<Notes>} saveMemory
 * @property {(text: string) => Promise<string>} renderMarkdown
 * @property {() => Promise<{ speak: { gemini: { available: boolean, reason: string | null, warning: string | null }, phonon: { available: boolean, reason: string | null, warning: null } }, hear: { gemini: { available: boolean, reason: string | null, warning: string | null }, phonon2: { available: boolean, reason: string | null, warning: null } }, cues: { tag: string, weight: number }[] }>} voiceStatus
 *   whether each of the server's engines can speak and hear, and why not; `warning` is what Google last refused on that route, kept for ten minutes and cleared by an answer; `cues` lists the vocal tags the voice performs, each with the letters of time it takes
 * @property {(markdown: string, signal?: AbortSignal, mood?: string, engine?: 'gemini' | 'phonon') => Promise<ArrayBuffer>} speech
 *   the spoken words of a piece of Markdown as raw 24 kHz 16-bit mono sound, said by the server's `engine` (Gemini when missing) in the manner of the reply's `mood`, which only Gemini follows; empty when there is nothing to say; rejects with `{ kind, message }`
 * @property {(pcm: Int16Array, vocabulary: string[], signal?: AbortSignal, choice?: { engine: 'gemini' | 'phonon2', mode?: 'fast' | 'exact' | 'cpu' }) => Promise<{ text: string }>} hear
 *   the words in a clip of raw 16 kHz 16-bit mono sound, empty when nobody spoke; `vocabulary` lists names to spell right; `choice` names the server's engine, Gemini when missing; rejects with `{ kind, message }`
 * @property {(appId: string, path: string) => Promise<string>} readAppImage   rejects when no registered image route is available
 * @property {(file: File, onProgress?: (fraction: number) => void) => Promise<import('../chat/thread/store.js').Attachment>} uploadFile
 *   saves a file the user chose, hidden from Jet until a message carries it; rejects with a reason fit to show
 * @property {(id: string) => Promise<void>} removeFile   deletes an upload that was never sent
 * @property {(url: string) => Promise<void>} openLink
 * @property {(listener: (notes: Notes) => void) => () => void} onMemoryUpdated   returns the way to stop listening
 * @property {(listener: (connected: boolean) => void) => () => void} onConnectionChanged   fires only when the server is lost or found again
 */

/**
 * @param {{ beforeReconnect?: () => Promise<unknown> }} [options]   runs before the event stream opens again
 * @returns {Agent}
 */
export function connectAgent(options) {
  return createBrowserAgent(options);
}
