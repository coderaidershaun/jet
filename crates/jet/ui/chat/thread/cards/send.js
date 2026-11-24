// How the card for a message to a colleague's Jet reads from a tool result, and what its tap answers.
// Nothing is sent until the user taps, so this only reads and words. Pure, with no DOM.

import { isRecord, numberOrNull, orNull, recordOf } from './guard.js';

const STATES = ['proposed', 'sent'];
const TAP_FAILED = 'Could not reach Jet. Nothing was sent; try again.';
const TAP_ANSWERS = {
  noSuchCard: 'This card is not yours to tap.',
  sendLimit: 'You have sent this person a lot in the last day. Try again tomorrow.',
};
const KINDS = { question: 'Question for', task: 'Task for', note: 'Note for' };
const KIND_NOUNS = { question: 'question', task: 'task', note: 'note' };

/**
 * `itemState` is where the item is now, once the tap has stored it.
 * @typedef {{ id: number, to: { id: number, name: string }, kind: string, text: string, objectiveTitle: string | null, state: 'proposed' | 'sent', sentAt: number | null, itemState: string | null }} SendView
 */

/** The card as the server sends it, or null for a value that is not one. @returns {SendView | null} */
export function sendOf(raw) {
  if (!isRecord(raw) || !STATES.includes(raw.state) || numberOrNull(raw.id) === null || typeof raw.text !== 'string') return null;
  const to = recordOf(raw.to);
  return {
    id: raw.id, to: { id: numberOrNull(to.id) ?? 0, name: orNull(to.name) ?? 'Someone' }, kind: Object.hasOwn(KINDS, raw.kind) ? raw.kind : 'note',
    text: raw.text, objectiveTitle: orNull(raw.objectiveTitle), state: raw.state, sentAt: numberOrNull(raw.sentAt), itemState: orNull(raw.itemState),
  };
}

/** 'Question for Shaun'. */
export const headingWords = (view) => KINDS[view.kind] + ' ' + view.to.name;

/** What the button says. */
export const buttonWords = (view) => 'Send to ' + view.to.name;

/** Where a sent item stands, in the sender's words: 'Shaun answered', 'Not brought up yet'. */
export function itemWords(state, name) {
  switch (state) {
    case 'seen': return name + "'s Jet has brought it up";
    case 'answered': return name + ' answered';
    case 'declined': return name + ' declined';
    case 'done': return name + ' marked it done';
    case 'expired': return 'No answer, so it expired';
    default: return 'Delivered, not brought up yet';
  }
}

/** The tone a state is coloured by. */
export const itemTone = (state) => (state === 'answered' || state === 'done' ? 'good' : state === 'declined' ? 'warn' : 'quiet');

/** The line of the card once the tap has stored it. */
export const sentWords = (view) => 'Sent to ' + view.to.name + ' · ' + itemWords(view.itemState ?? 'sent', view.to.name);

/** What a refused or failed tap says; `reread` is true when the card may have changed under the page. */
export function tapAnswer(error) {
  const kind = recordOf(error).kind;
  if (kind === 'cardNotOpen') return { words: 'This card was already sent.', reread: true };
  if (kind === 'network') return { words: TAP_FAILED, reread: false };
  if (Object.hasOwn(TAP_ANSWERS, kind)) return { words: TAP_ANSWERS[kind], reread: false };
  return { words: orNull(recordOf(error).message) ?? TAP_FAILED, reread: false };
}

/** The one line a card shows folded in the thread: 'question to Shaun'. */
export const lineWords = (view) => KIND_NOUNS[view.kind] + ' to ' + view.to.name;
