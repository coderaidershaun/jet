// Draws the two cards that send words to a colleague: a message to their Jet and a reply to what they sent.
// Nothing is sent until the user's tap, and the card shows what became of it, after a reload and whenever
// the item changes while the page is open.

import { requestJson } from '../../../bridge/browser-agent.js';
import { h } from '../../../dom.js';
import { replyAbout, replyClosed, replyHeading, replyOf, replyReadPath, replySent, tapReply } from './reply.js';
import { buttonWords, headingWords, itemTone, sendOf, sentWords, tapAnswer } from './send.js';

/** What differs between the two cards: how each reads, where it is read again, and its tap. */
const KINDS = {
  send: {
    of: sendOf,
    heading: headingWords,
    about: (view) => (view.objectiveTitle ? 'About ' + view.objectiveTitle : null),
    sent: sentWords,
    tone: (view) => itemTone(view.itemState),
    readPath: (ids) => '/api/inbox/cards?ids=' + ids.join(','),
    tap: async (view) => sendOf(await requestJson('/api/inbox/cards/' + view.id + '/send', {})),
  },
  reply: {
    of: replyOf,
    heading: replyHeading,
    about: replyAbout,
    sent: replySent,
    tone: (view) => itemTone(view.itemState ?? view.outcome),
    readPath: replyReadPath,
    tap: (view) => tapReply(view),
    closed: replyClosed,
  },
};

/** One read for each kind of all the cards drawn in the same moment, such as every card of a reloaded snapshot. */
const waiting = { send: new Map(), reply: new Map() };
function currentCard(kind, id) {
  const queue = waiting[kind];
  if (queue.size === 0) {
    setTimeout(async () => {
      const batch = new Map(queue);
      queue.clear();
      try {
        const cards = await requestJson(KINDS[kind].readPath([...batch.keys()]));
        for (const raw of Array.isArray(cards) ? cards : []) batch.get(raw?.id)?.forEach((done) => done(KINDS[kind].of(raw)));
      } catch (error) {
        console.warn('the cards could not be refreshed:', error?.message ?? error);
      }
      for (const done of [...batch.values()].flat()) done(null);
    }, 0);
  }
  return new Promise((resolve) => queue.set(id, [...(queue.get(id) ?? []), resolve]));
}

/** Each card on the page reads itself again when the server says the plan or an item changed; a card that left the page is let go. */
const rereads = new Map();
let listening = false;
function follow(el, reread) {
  if (!listening) {
    listening = true;
    document.addEventListener('jet:pane-changed', () => {
      for (const [card, again] of rereads) if (card.isConnected) again(); else rereads.delete(card);
    });
  }
  rereads.set(el, reread);
}

/** @param {import('./model.js').Card} card @param {'send' | 'reply'} kind */
function outgoingCard(card, kind) {
  const spec = KINDS[kind];
  const el = h('div', { class: 'card card-send card-' + kind, 'data-key': card.key, 'data-call': card.id });
  let view = card.body.view;
  let busy = false;
  const status = h('p', { class: 'send-status', role: 'status' });
  const button = h('button', { class: 'send-go', type: 'button', onClick: tap });

  function draw() {
    el.dataset.state = view.state;
    const about = spec.about(view);
    const parts = [
      h('p', { class: 'send-title', text: spec.heading(view) }),
      about ? h('p', { class: 'send-about', text: about }) : null,
      view.text.trim() ? h('p', { class: 'send-text', text: view.text }) : null,
    ];
    const closed = spec.closed?.(view) ?? null;
    if (closed) {
      parts.push(h('p', { class: 'send-done', 'data-tone': 'quiet', text: closed }));
    } else if (view.state === 'proposed') {
      button.textContent = buttonWords(view);
      button.disabled = busy;
      parts.push(h('p', { class: 'send-hint', text: 'Nothing goes until you tap Send.' }), status, button);
    } else {
      parts.push(h('p', { class: 'send-done', 'data-tone': spec.tone(view), text: spec.sent(view) }));
    }
    el.replaceChildren(...parts.filter(Boolean));
  }

  async function reread() {
    const fresh = await currentCard(kind, view.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(view)) { view = fresh; draw(); }
  }

  async function tap() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = 'Sending…';
    status.textContent = '';
    try {
      const next = await spec.tap(view);
      if (next) view = next;
      busy = false;
      draw();
      el.querySelector('.send-done')?.setAttribute('role', 'status');
    } catch (error) {
      const answer = tapAnswer(error);
      busy = false;
      draw();
      status.textContent = answer.words;
      status.dataset.tone = 'invalid';
      if (answer.reread) await reread();
    }
  }

  draw();
  follow(el, reread);
  reread();
  return el;
}

/** @param {import('./model.js').Card} card */
export const sendCard = (card) => outgoingCard(card, 'send');

/** @param {import('./model.js').Card} card */
export const replyCard = (card) => outgoingCard(card, 'reply');
