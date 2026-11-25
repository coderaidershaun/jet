// Draws the share card: the one place the user decides who sees an objective. Nothing is shared until the
// tap, and the card shows what the tap did, also after the page reloads.

import { requestJson } from '../../../bridge/browser-agent.js';
import { h } from '../../../dom.js';
import { shareButton, shareOf, sharedWords, tapAnswer, tapBody } from './share.js';

/** One read for all the cards that were drawn in the same moment, such as every card of a reloaded snapshot. */
const waiting = new Map();
function currentCard(id) {
  if (waiting.size === 0) {
    setTimeout(async () => {
      const batch = new Map(waiting);
      waiting.clear();
      try {
        const cards = await requestJson('/api/shares/proposals?ids=' + [...batch.keys()].join(','));
        for (const raw of Array.isArray(cards) ? cards : []) batch.get(raw?.id)?.forEach((done) => done(shareOf(raw)));
      } catch (error) {
        console.warn('the share cards could not be refreshed:', error?.message ?? error);
      }
      for (const done of [...batch.values()].flat()) done(null);
    }, 0);
  }
  return new Promise((resolve) => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));
}

function entryRow(entry, ticked, onToggle) {
  const box = h('input', { type: 'checkbox', class: 'share-box', ...(ticked.has(entry.key) ? { checked: true } : {}), onChange: () => onToggle(entry.key, box.checked) });
  const removal = entry.shared ? (entry.ticked ? 'Shared now' : 'Shared now, will be removed unless you tick it') : null;
  return h(
    'label',
    { class: 'share-row', 'data-kind': entry.kind },
    box,
    h(
      'span',
      { class: 'share-what' },
      h('span', { class: 'share-name', text: entry.kind === 'team' ? entry.name + ' team' : entry.name }),
      entry.members.length > 0 ? h('span', { class: 'share-members', text: entry.members.join(', ') }) : null,
      removal ? h('span', { class: 'share-removal', 'data-ticked': String(entry.ticked), text: removal }) : null,
    ),
  );
}

/**
 * @param {import('./model.js').Card & { apply?: (body: { people: number[], teams: number[] }) => Promise<unknown> }} card
 *   `apply` replaces the tap's route for a card that has no proposal yet, such as the plan pane's card from the directory
 */
export function shareCard(card) {
  const el = h('div', { class: 'card card-share', 'data-key': card.key, 'data-call': card.id });
  let view = card.body.view;
  let ticked = new Set(view.entries.filter((entry) => entry.ticked).map((entry) => entry.key));
  let busy = false;

  const status = h('p', { class: 'share-status', role: 'status' });
  const button = h('button', { class: 'share-go', type: 'button', onClick: tap });

  function draw() {
    el.dataset.state = view.state;
    const title = h('p', { class: 'share-title' }, view.state === 'applied' ? 'Shared · ' : 'Share · ', h('span', { class: 'share-objective', text: view.title }));
    if (view.state === 'proposed') {
      const label = () => { const next = shareButton(view, ticked); button.textContent = next.words; button.disabled = busy || !next.enabled; };
      const toggle = (key, on) => { if (on) ticked.add(key); else ticked.delete(key); label(); };
      label();
      el.replaceChildren(title, h('p', { class: 'share-hint', text: 'Tick who should see it, then tap Share. Nothing is shared until you do.' }), h('div', { class: 'share-rows' }, ...view.entries.map((entry) => entryRow(entry, ticked, toggle))), status, button);
    } else if (view.state === 'applied') {
      el.replaceChildren(title, h('p', { class: 'share-done', text: sharedWords(view) }));
    } else {
      el.replaceChildren(title, h('p', { class: 'share-done', text: 'Replaced by a newer card.' }));
    }
  }

  async function reread() {
    const fresh = await currentCard(view.id);
    if (fresh) { view = fresh; ticked = new Set(view.entries.filter((entry) => entry.ticked).map((entry) => entry.key)); draw(); }
  }

  async function tap() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = 'Sharing…';
    status.textContent = '';
    try {
      const body = tapBody(view, ticked);
      const next = shareOf(await (card.apply ? card.apply(body) : requestJson('/api/shares/proposals/' + view.id + '/apply', body)));
      if (next) view = next;
      busy = false;
      draw();
    } catch (error) {
      const answer = tapAnswer(error);
      busy = false;
      draw();
      status.textContent = answer.words;
      status.dataset.tone = 'invalid';
      if (answer.reread && view.id !== null) await reread();
    }
  }

  // A tap in another window, or a newer card from the pane, changes this card without a tap here.
  const onPaneChanged = () => {
    if (!el.isConnected) document.removeEventListener('jet:pane-changed', onPaneChanged);
    else if (view.state === 'proposed' && !busy && view.id !== null) reread();
  };
  document.addEventListener('jet:pane-changed', onPaneChanged);

  draw();
  if (view.id !== null) reread();
  return el;
}
