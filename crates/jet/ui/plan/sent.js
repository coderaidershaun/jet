// The sent list of the plan pane: what the user sent to colleagues' Jets, to whom, when, and where each item stands.
// `sentRow` is the pure reading, tested; `sentSection` draws it, with the colleague's reply as text only.

import { h } from '../dom.js';
import { itemTone, itemWords } from '../chat/thread/cards/send.js';
import { isRecord, listOf, numberOrNull, orNull, recordOf, stringOf } from '../chat/thread/cards/guard.js';
import { clockWords } from './model.js';

const KIND_WORDS = { question: 'Question', task: 'Task', note: 'Note' };
const SHOWN = 5;

/** One sent item as the pane shows it, from a record of `GET /api/pane`. */
export function sentRow(item, timeZone) {
  const to = recordOf(item.to);
  const name = orNull(to.name) ?? 'Someone';
  const reply = orNull(item.reply);
  return {
    id: item.id,
    heading: (KIND_WORDS[item.kind] ?? 'Note') + ' to ' + name,
    about: orNull(item.objectiveTitle),
    text: stringOf(item.text),
    when: clockWords(numberOrNull(item.sentAt), timeZone),
    state: itemWords(item.state, name),
    tone: itemTone(item.state),
    reply,
    replyFrom: reply ? (item.answeredByJet === true ? name + "'s Jet, from what they share with you" : name) : null,
    chatId: numberOrNull(item.chatId),
  };
}

function rowCard(row, ctx) {
  return h('li', { class: 'plan-card sent-item', 'data-id': row.id, 'data-tone': row.tone },
    h('div', { class: 'sent-top' }, h('span', { class: 'sent-heading', text: row.heading }), h('span', { class: 'sent-when', text: row.when })),
    row.about ? h('p', { class: 'sent-about', text: 'About ' + row.about }) : null,
    h('p', { class: 'sent-text', text: row.text }),
    h('p', { class: 'sent-state', text: row.state }),
    row.reply ? h('blockquote', { class: 'sent-reply' }, h('span', { class: 'sent-from', text: row.replyFrom }), h('p', { text: row.reply })) : null,
    row.chatId === null ? null : h('button', { type: 'button', class: 'pane-button sent-chat', 'data-key': 'sent-chat-' + row.id, onClick: () => ctx.act.openChat({ chatId: row.chatId }) }, h('span', { text: 'Open chat' })));
}

/** The section, or null when nothing was sent. The rows after the first few wait in a fold. */
export function sentSection(sent, ctx) {
  const items = listOf(sent).filter(isRecord).map((item) => sentRow(item, ctx.timeZone));
  if (items.length === 0) return null;
  const rest = items.slice(SHOWN);
  return h('section', { class: 'pane-section' },
    h('h3', { class: 'pane-heading' }, h('span', { text: 'Sent to colleagues' })),
    h('ul', { class: 'stack' }, ...items.slice(0, SHOWN).map((row) => rowCard(row, ctx))),
    rest.length === 0 ? null : h('details', { class: 'closed' }, h('summary', { 'data-key': 'sent-more' }, h('span', { text: `Earlier (${rest.length})` })), h('ul', { class: 'closed-list' }, ...rest.map((row) => rowCard(row, ctx)))));
}
