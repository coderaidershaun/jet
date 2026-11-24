// Draws the send card: the one place the user decides that a message goes to a colleague's Jet.
// Nothing is sent until the tap, and the card shows what became of it, also after the page reloads.

import { requestJson } from '../../../bridge/browser-agent.js';
import { h } from '../../../dom.js';
import { buttonWords, headingWords, itemTone, sendOf, sentWords, tapAnswer } from './send.js';

/** One read for all the cards drawn in the same moment, such as every card of a reloaded snapshot. */
const waiting = new Map();
function currentCard(id) {
  if (waiting.size === 0) {
    setTimeout(async () => {
      const batch = new Map(waiting);
      waiting.clear();
      try {
        const cards = await requestJson('/api/inbox/cards?ids=' + [...batch.keys()].join(','));
        for (const raw of Array.isArray(cards) ? cards : []) batch.get(raw?.id)?.forEach((done) => done(sendOf(raw)));
      } catch (error) {
        console.warn('the send cards could not be refreshed:', error?.message ?? error);
      }
      for (const done of [...batch.values()].flat()) done(null);
    }, 0);
  }
  return new Promise((resolve) => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));
}

/** @param {import('./model.js').Card} card */
export function sendCard(card) {
  const el = h('div', { class: 'card card-send', 'data-key': card.key, 'data-call': card.id });
  let view = card.body.view;
  let busy = false;
  const status = h('p', { class: 'send-status', role: 'status' });
  const button = h('button', { class: 'send-go', type: 'button', onClick: tap });

  function draw() {
    el.dataset.state = view.state;
    const title = h('p', { class: 'send-title', text: headingWords(view) });
    const about = view.objectiveTitle ? h('p', { class: 'send-about', text: 'About ' + view.objectiveTitle }) : null;
    const words = h('p', { class: 'send-text', text: view.text });
    if (view.state === 'proposed') {
      button.textContent = buttonWords(view);
      button.disabled = busy;
      el.replaceChildren(title, about, words, h('p', { class: 'send-hint', text: 'Nothing goes until you tap Send.' }), status, button);
    } else {
      el.replaceChildren(title, about, words, h('p', { class: 'send-done', 'data-tone': itemTone(view.itemState), text: sentWords(view) }));
    }
  }

  async function reread() {
    const fresh = await currentCard(view.id);
    if (fresh) { view = fresh; draw(); }
  }

  async function tap() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = 'Sending…';
    status.textContent = '';
    try {
      const next = sendOf(await requestJson('/api/inbox/cards/' + view.id + '/send', {}));
      if (next) view = next;
      busy = false;
      draw();
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
  reread();
  return el;
}
