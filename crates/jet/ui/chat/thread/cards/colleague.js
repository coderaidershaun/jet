// Draws a colleague's words in the thread, under their name, as text and never as markup.
// The server keeps those words in `entry.colleague`, apart from Jet's own line.

import { h } from '../../../dom.js';
import { isRecord, numberOrNull, orNull } from './guard.js';

const OUTCOMES = { answered: 'answered', declined: 'declined', done: 'marked it done' };
const ASKED = { question: 'asked', task: 'sent a task', note: 'left a note' };

/** The mark of an entry, or null when it has none. @returns {{ name: string, text: string, label: string, outcome: string | null } | null} */
export function colleagueOf(raw) {
  if (!isRecord(raw) || numberOrNull(raw.user) === null) return null;
  const name = orNull(raw.name) ?? 'A colleague';
  const outcome = orNull(raw.outcome);
  const byJet = outcome === 'jetAnswered';
  const label = byJet ? 'answered from shared objectives' : OUTCOMES[outcome] ?? ASKED[raw.kind] ?? 'wrote';
  return { name: byJet ? name + "'s Jet" : name, text: typeof raw.text === 'string' ? raw.text : '', label, outcome };
}

/** The quote block: their name and a quiet label, then their words. @returns {HTMLElement | null} */
export function colleagueNode(raw) {
  const mark = colleagueOf(raw);
  if (!mark) return null;
  return h('blockquote', { class: 'colleague', 'data-outcome': mark.outcome ?? 'asked' },
    h('p', { class: 'colleague-head' }, h('span', { class: 'colleague-name', text: mark.name }), h('span', { class: 'colleague-label', text: mark.label })),
    mark.text.trim() === '' ? null : h('p', { class: 'colleague-text', text: mark.text }));
}
