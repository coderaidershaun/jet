// The sent items of the plan pane: what the user sent to colleagues' Jets, to whom, when, and where each item stands.
// `sentRow` is the pure reading, tested; `sentList` draws it, with the colleague's reply as text only.

import { h } from '../dom.js';
import { itemTone, itemWords } from '../chat/thread/cards/send.js';
import { isRecord, listOf, numberOrNull, orNull, recordOf, stringOf } from '../chat/thread/cards/guard.js';
import { clockWords } from './model.js';

const KIND_WORDS = { question: 'Question', task: 'Task', note: 'Note' };

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

/** One sent item as a line that unfolds to its words, the answer and its chat. `foldRow` is the view's own. */
function sentLine(row, ctx, foldRow) {
  // The kind is `item`, the pane's word for it: `sent` is the thread's class for a sent message.
  return foldRow('item', row.id, ctx,
    [h('span', { class: 'row-stack' }, h('span', { class: 'row-title sent-heading', text: row.heading }), h('span', { class: 'fact', 'data-tone': row.tone === 'warn' ? 'warn' : 'quiet', text: row.state })),
      h('span', { class: 'fact sent-when', text: row.when })],
    [row.about ? h('p', { class: 'sent-about', text: 'About ' + row.about }) : null,
      h('p', { class: 'sent-text', text: row.text }),
      row.reply ? h('blockquote', { class: 'sent-reply' }, h('span', { class: 'sent-from', text: row.replyFrom }), h('p', { text: row.reply })) : null,
      row.chatId === null ? null : h('button', { type: 'button', class: 'text-button', 'data-key': 'sent-chat-' + row.id, onClick: () => ctx.act.openChat({ chatId: row.chatId }), text: 'Open chat' })]);
}

/** The list of items that wait for a colleague's answer. */
export function sentList(items, ctx, foldRow) {
  return h('ul', { class: 'plan-rows' }, ...listOf(items).filter(isRecord).map((item) => sentLine(sentRow(item, ctx.timeZone), ctx, foldRow)));
}
