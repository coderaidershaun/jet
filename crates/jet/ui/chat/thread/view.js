// Draws the thread's rows: bubbles with their grouping and tails, day and
// notice pills, the lane beside each Jet message, the cards of tool calls above
// a reply and the citation chips in its text, the waiting dots, the error and
// stopped bubbles, code blocks with Copy, and links. A row's node is kept for as
// long as the row lives, so the live Jet standing in a lane is never thrown away
// by a redraw.

import { clockTime } from '../clock.js';
import { h } from '../dom.js';
import { typeset } from './math.js';
import { callState } from './cards/model.js';
import { createCardList, linkCitations, openSource } from './cards/view.js';

const LOGIN_HINT = /log ?in/i;
const doneCalls = (calls) => calls.filter((call) => callState(call) === 'done');

/**
 * @param {{
 *   scroller: HTMLElement, rowsEl: HTMLElement, bannerEl: HTMLElement, jumpButton: HTMLElement,
 *   follow: ReturnType<typeof import('./scroll.js').createFollow>,
 *   handlers: {
 *     retry: () => void, openSettings: (section: string) => void, openLink: (url: string) => void,
 *     render: (text: string) => Promise<string>, readImage: (path: string) => Promise<string>,
 *   },
 * }} options
 */
export function createThreadView({ scroller, rowsEl, bannerEl, jumpButton, follow, handlers }) {
  /** @type {Map<string, { el: HTMLElement, lane: HTMLElement | null, cards: ReturnType<typeof createCardList> | null, signature: string }>} */
  const nodes = new Map();
  let liveKey = null;

  function sealCode(body) {
    for (const pre of body.querySelectorAll('pre')) {
      const wrapper = h('div', { class: 'code' });
      pre.replaceWith(wrapper);
      wrapper.append(pre, h('button', { class: 'copy', type: 'button', 'aria-label': 'Copy code', text: 'Copy' }));
    }
  }

  // The time sits at the bubble's corner; a gap at the end of the last line keeps text from running under it.
  function leaveRoomForTime(bubble, body) {
    let last = body.lastElementChild;
    while (last && /^(UL|OL)$/.test(last.tagName)) last = last.lastElementChild;
    if (!last && body.textContent) body.append(h('span', { class: 'time-gap' }));
    else if (last && /^(P|LI|H[3-6])$/.test(last.tagName)) last.append(h('span', { class: 'time-gap' }));
    else bubble.classList.add('time-below');
  }

  function errorBody(row, isFinal) {
    const { entry, failure } = row;
    const box = h('div', { class: 'error', role: 'alert' }, h('p', { text: entry.error || 'Something went wrong.' }));
    if (LOGIN_HINT.test(entry.error || '')) box.append(h('p', { class: 'hint' }, 'Run ', h('code', { text: 'claude' }), ' in a terminal to log in.'));
    if (isFinal) {
      const actions = h('div', { class: 'actions' }, h('button', { class: 'action retry', type: 'button', text: 'Retry' }));
      if (failure && failure.kind === 'claudeMissing') actions.append(h('button', { class: 'action open-settings', type: 'button', text: 'Settings' }));
      box.append(actions);
    }
    return box;
  }

  const isWaiting = (entry) => entry.status === 'waiting' || (entry.status === 'streaming' && entry.html === '');

  // `known` holds the finished calls up to this row, so a chip can find its card.
  function fillBubble(bubble, row, isFinal, known) {
    const { entry } = row;
    bubble.replaceChildren();
    bubble.removeAttribute('aria-busy');
    bubble.classList.remove('time-below', 'is-waiting', 'is-error');
    // While a call runs and no text has come, its card's spinner is the only sign of work.
    bubble.hidden = row.type === 'jet' && isWaiting(entry) && (entry.tools ?? []).some((call) => callState(call) === 'running');
    const body = h('div', { class: 'body' });
    bubble.append(body);

    if (row.type === 'user') {
      body.textContent = entry.text;
    } else if (entry.status === 'failed') {
      bubble.classList.add('is-error');
      body.append(errorBody(row, isFinal));
    } else if (isWaiting(entry)) {
      bubble.classList.add('is-waiting');
      bubble.setAttribute('aria-busy', 'true');
      body.append(
        h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span', { class: 'still', text: 'still thinking…' }),
      );
      return;
    } else {
      body.innerHTML = entry.html;
      linkCitations(body, known);
      sealCode(body);
      typeset(body);
      if (entry.status === 'streaming') bubble.setAttribute('aria-busy', 'true');
      if (entry.status === 'stopped') body.append(h('p', { class: 'stopped', text: entry.text ? 'Stopped' : 'Stopped before replying' }));
    }
    if (entry.status === 'streaming') return;
    bubble.append(h('span', { class: 'time', text: clockTime(entry.at) }));
    leaveRoomForTime(bubble, body);
  }

  function fillRow(record, row, isFinal, earlier) {
    const { el } = record;
    el.className = 'row row-' + row.type + (row.first ? ' first' : '') + (row.last ? ' last' : '');
    if (row.type === 'lane') return;
    const calls = row.type === 'jet' ? row.entry.tools ?? [] : [];
    if (record.cards) record.cards.sync(calls, earlier);
    fillBubble(el.querySelector('.bubble'), row, isFinal, [...earlier, ...doneCalls(calls)]);
  }

  function create(row) {
    if (row.type === 'day') return { el: h('div', { class: 'pill pill-day', text: row.label }), lane: null, cards: null, signature: '' };
    if (row.type === 'notice') return { el: h('div', { class: 'pill pill-notice', role: 'status', text: row.message }), lane: null, cards: null, signature: '' };
    const lane = row.type === 'user' ? null : h('div', { class: 'lane' });
    if (row.type !== 'jet') {
      return { el: h('div', {}, lane, row.type === 'lane' ? null : h('div', { class: 'bubble' })), lane, cards: null, signature: '' };
    }
    const cardsEl = h('div', { class: 'cards' });
    const cards = createCardList(cardsEl, { render: handlers.render, readImage: handlers.readImage, seal: sealCode });
    return { el: h('div', {}, lane, h('div', { class: 'reply' }, cardsEl, h('div', { class: 'bubble' }))), lane, cards, signature: '' };
  }

  const signatureOf = (row, isFinal) => {
    const { entry, failure } = row;
    const calls = entry ? (entry.tools ?? []).map((call) => call.id + ':' + callState(call)).join(' ') : '';
    const shown = entry && [entry.status, row.type === 'user' ? entry.text : '', entry.html, entry.error, entry.at, calls];
    return JSON.stringify([row.type, row.label, row.message, row.first, row.last, isFinal, shown, failure && failure.kind]);
  };

  scroller.addEventListener('scroll', () => {
    follow.onScroll(scroller);
    jumpButton.hidden = !follow.jumpVisible;
  });
  // The visible part of the thread shrinks when the held chip or a tall field appears; stay at the bottom if the reader was there.
  new ResizeObserver(() => { if (follow.following) view.scrollToBottom(); }).observe(scroller);
  jumpButton.addEventListener('click', () => {
    follow.onSend();
    view.scrollToBottom();
  });

  rowsEl.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const link = target.closest('a[href]');
    if (link) {
      event.preventDefault();
      handlers.openLink(link.getAttribute('href'));
    } else if (target.closest('.cite')) {
      const chip = /** @type {HTMLElement} */ (target.closest('.cite'));
      if (openSource(rowsEl, chip.dataset.call, Number(chip.dataset.n))) {
        follow.onScroll(scroller);
        jumpButton.hidden = !follow.jumpVisible;
      }
    } else if (target.closest('.retry')) {
      handlers.retry();
    } else if (target.closest('.open-settings')) {
      handlers.openSettings('claude');
    } else if (target.closest('.copy')) {
      const button = /** @type {HTMLElement} */ (target.closest('.copy'));
      const code = button.parentElement.querySelector('pre').textContent;
      navigator.clipboard.writeText(code).then(
        () => {
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = 'Copy'; }, 1200);
        },
        (error) => console.warn('the code could not be copied:', error),
      );
    }
  });

  const view = {
    /** Brings the page up to date with the rows. @param {import('./store.js').Row[]} rows */
    render(rows) {
      const lastMessage = rows.findLastIndex((row) => row.type === 'user' || row.type === 'jet');
      const seen = new Set();
      // The finished calls of the Jet rows drawn so far. A reply's chips look here for their source, and a page's card for its document's title.
      const earlier = [];
      liveKey = null;
      rows.forEach((row, i) => {
        seen.add(row.key);
        let record = nodes.get(row.key);
        if (!record) {
          record = create(row);
          nodes.set(row.key, record);
        }
        if (row.live) liveKey = row.key;
        const signature = signatureOf(row, i === lastMessage);
        if (signature !== record.signature && (row.type === 'user' || row.type === 'jet' || row.type === 'lane')) {
          fillRow(record, row, i === lastMessage, earlier);
        }
        record.signature = signature;
        if (row.type === 'jet') earlier.push(...doneCalls(row.entry.tools ?? []));
        if (rowsEl.children[i] !== record.el) rowsEl.insertBefore(record.el, rowsEl.children[i] ?? null);
      });
      for (const [key, record] of nodes) {
        if (seen.has(key)) continue;
        record.el.remove();
        nodes.delete(key);
      }
      if (follow.following) view.scrollToBottom();
    },

    /** The lane where the live Jet stands, or null when there is no Jet row. */
    liveLane() {
      return liveKey ? nodes.get(liveKey).lane : null;
    },

    scrollToBottom() {
      scroller.scrollTop = scroller.scrollHeight;
    },

    /** One pill at the top of the thread, for a problem found at launch. */
    setBanner(message, action) {
      bannerEl.replaceChildren();
      if (!message) return;
      const pill = h('div', { class: 'pill pill-banner', role: 'status' }, h('span', { text: message }));
      if (action) pill.append(h('button', { class: 'action', type: 'button', text: action.label, onClick: action.run }));
      bannerEl.append(pill);
    },
  };
  return view;
}
