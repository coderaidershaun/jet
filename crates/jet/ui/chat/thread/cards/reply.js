// How the card of an answer to a colleague reads from a tool result, and the one request its tap makes.
// The words go out in the user's name only when the user taps Send. Pure, with no DOM.

import { requestJson } from '../../../bridge/browser-agent.js';
import { isRecord, numberOrNull, orNull, recordOf } from './guard.js';
import { itemWords } from './send.js';

const STATES = ['proposed', 'sent'];
const OUTCOMES = ['answered', 'declined', 'done'];
const KIND_NOUNS = { question: 'question', task: 'task', note: 'note' };

/**
 * `to` is the colleague who sent the item, whom the reply goes to; `itemState` is where the item is now.
 * @typedef {{ id: number, itemId: number, to: { id: number, name: string }, kind: string, outcome: 'answered' | 'declined' | 'done',
 *   text: string, state: 'proposed' | 'sent', sentAt: number | null, itemState: string | null }} ReplyView
 */

/** The card as the server sends it, or null for a value that is not one. @returns {ReplyView | null} */
export function replyOf(raw) {
  if (!isRecord(raw) || !STATES.includes(raw.state) || !OUTCOMES.includes(raw.outcome) || numberOrNull(raw.id) === null) return null;
  const to = recordOf(raw.to);
  return {
    id: raw.id, itemId: numberOrNull(raw.itemId) ?? 0, to: { id: numberOrNull(to.id) ?? 0, name: orNull(to.name) ?? 'Someone' },
    kind: Object.hasOwn(KIND_NOUNS, raw.kind) ? raw.kind : 'note', outcome: raw.outcome, text: typeof raw.text === 'string' ? raw.text : '',
    state: raw.state, sentAt: numberOrNull(raw.sentAt), itemState: orNull(raw.itemState),
  };
}

/** 'Reply to Admin 123'. */
export const replyHeading = (view) => 'Reply to ' + view.to.name;

/** What the reply does to their message: 'Answers their question', 'Declines their task'. */
export function replyAbout(view) {
  const noun = KIND_NOUNS[view.kind];
  if (view.outcome === 'declined') return 'Declines their ' + noun;
  if (view.outcome === 'done') return 'Marks their ' + noun + ' done';
  return 'Answers their ' + noun;
}

/** The line of the card once the tap has stored it: 'Sent to Admin 123 · Admin 123 answered' reads wrong, so it says what the user did. */
export function replySent(view) {
  const state = view.itemState ?? view.outcome;
  const did = { answered: 'answered', declined: 'declined', done: 'marked done' }[state];
  return 'Sent to ' + view.to.name + ' · ' + (did ? 'you ' + did + ' it' : itemWords(state, view.to.name));
}

/**
 * Why a reply that was never sent can no longer go, because its item ended another way, or null while it can.
 * 'Not sent: their question was already answered'.
 */
export function replyClosed(view) {
  if (view.state !== 'proposed') return null;
  const noun = KIND_NOUNS[view.kind];
  const ended = { answered: 'was already answered', declined: 'was already declined', done: 'was already marked done', expired: 'expired' }[view.itemState];
  return ended ? 'Not sent: their ' + noun + ' ' + ended : null;
}

/** The one line a card shows folded in the thread: 'reply to Admin 123'. */
export const replyLine = (view) => 'reply to ' + view.to.name;

/** The read of the cards as they are now, for the ids given. */
export const replyReadPath = (ids) => '/api/inbox/replies?ids=' + ids.join(',');

/**
 * The user's tap: the one request that sends the words, as the signed-in user. Answers the card as it is after the tap.
 * @param {ReplyView} view
 * @returns {Promise<ReplyView | null>}
 */
export async function tapReply(view, fetcher = globalThis.fetch) {
  return replyOf(await requestJson('/api/inbox/replies/' + view.id + '/send', {}, 'POST', fetcher));
}
