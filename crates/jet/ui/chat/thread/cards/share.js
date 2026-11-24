// How an objective's share card reads from a tool result, and what a tap sends and answers.
// The card is the one place the user decides who sees an objective, so nothing here shares by itself.
// Pure, with no DOM.

import { isRecord, listOf, numberOrNull, orNull, recordOf, stringsOf } from './guard.js';

const STATES = ['proposed', 'applied', 'refused'];
const TAP_FAILED = 'Could not reach Jet. Nothing was shared; try again.';
const TAP_ANSWERS = {
  noSuchProposal: 'This card is not yours to tap.',
  notOnCard: 'That choice is not on this card. Ask Jet for a fresh one.',
};

/**
 * One person or team on the card. `key` tells them apart in one list of ticks.
 * @typedef {{ key: string, kind: 'person' | 'team', id: number, name: string, members: string[], ticked: boolean }} Entry
 * @typedef {{ id: number, objectiveId: number, title: string, state: 'proposed' | 'applied' | 'refused', entries: Entry[] }} ShareView
 */

/** The card of a proposal as the server sends it, or null for a value that is not one. @returns {ShareView | null} */
export function shareOf(raw) {
  if (!isRecord(raw) || !STATES.includes(raw.state) || numberOrNull(raw.id) === null) return null;
  const entry = (kind) => (item) => {
    const record = recordOf(item);
    return { key: kind[0] + record.id, kind, id: numberOrNull(record.id), name: orNull(record.name) ?? 'Someone', members: stringsOf(record.members), ticked: record.ticked === true };
  };
  const entries = [...listOf(raw.teams).map(entry('team')), ...listOf(raw.people).map(entry('person'))].filter((item) => item.id !== null);
  return { id: raw.id, objectiveId: numberOrNull(raw.objectiveId) ?? 0, title: orNull(raw.title) ?? 'this objective', state: raw.state, entries };
}

/** 'the Commercial team (Cat, Dan)' or 'Bob'. */
export const entryWords = (entry) => (entry.kind === 'team' ? 'the ' + entry.name + ' team' + (entry.members.length > 0 ? ' (' + entry.members.join(', ') + ')' : '') : entry.name);

/** 'Shared with Bob and the Commercial team (Cat)', or the words for nobody. */
export function sharedWords(view) {
  const names = view.entries.filter((entry) => entry.ticked).map(entryWords);
  if (names.length === 0) return 'Not shared with anyone';
  return 'Shared with ' + (names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0]);
}

/** The body of the tap: exactly the ticked entries. `ticked` holds their keys. */
export function tapBody(view, ticked) {
  const chosen = (kind) => view.entries.filter((entry) => entry.kind === kind && ticked.has(entry.key)).map((entry) => entry.id);
  return { people: chosen('person'), teams: chosen('team') };
}

/** What the button says for the ticks now. */
export const buttonWords = (ticked) => (ticked.size === 0 ? 'Stop sharing' : 'Share');

/**
 * What a refused or failed tap says. `reread` is true when the card may have changed under the page, so it asks the
 * server for the card again and draws what it finds. A network failure puts the button back.
 */
export function tapAnswer(error) {
  const kind = recordOf(error).kind;
  if (kind === 'proposalNotOpen') return { words: 'This card was already used or replaced.', reread: true };
  if (kind === 'network') return { words: TAP_FAILED, reread: false };
  if (Object.hasOwn(TAP_ANSWERS, kind)) return { words: TAP_ANSWERS[kind], reread: false };
  return { words: orNull(recordOf(error).message) ?? TAP_FAILED, reread: false };
}
