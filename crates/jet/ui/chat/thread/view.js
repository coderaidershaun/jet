// Draws the thread's rows: bubbles with their grouping and tails, day and
// notice pills, the lane beside each Jet message, the cards of tool calls above
// a reply and the citation chips in its text, the waiting dots, the faded bubble
// of a spoken message still forming, the error and stopped bubbles, code blocks
// with Copy, links, and the emoji on a message with the chooser that puts them
// there. A row's node is kept for as long as the row lives, so the live Jet
// standing in a lane is never thrown away by a redraw.

import { h } from '../../dom.js';
import { clockTime, dayLabel } from '../clock.js';
import { typeset } from './math.js';
import { colleagueNode } from './cards/colleague.js';
import { callState } from './cards/model.js';
import { createCardList, linkCitations, openSource } from './cards/view.js';
import { fillAttachments } from './attachments.js';
import { createReactChooser, reactButton } from './react.js';

const LOGIN_HINT = /log ?in/i;
const doneCalls = (calls) => calls.filter((call) => callState(call) === 'done');
const dots = () => h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
const LONG_PRESS_MS = 450;
/** The user reacts to a saved Jet message, but not to an error. */
const canReact = (row) => row.type === 'jet' && Number.isInteger(row.entry.id) && (row.entry.status === 'complete' || row.entry.status === 'stopped');

/**
 * @param {{
 *   scroller: HTMLElement, rowsEl: HTMLElement, bannerEl: HTMLElement, jumpButton: HTMLElement,
 *   follow: ReturnType<typeof import('./scroll.js').createFollow>,
 *   handlers: {
 *     retry: () => void, openSettings: (section: string) => void, openLink: (url: string) => void,
 *     render: (text: string) => Promise<string>, readImage: (appId: string, path: string) => Promise<string>,
 *     react: (entryId: number, emoji: string | null) => void,
 *     watchJob: (call: import('./cards/model.js').ShownCall, onJob: (job: object) => void) => () => void,
 *   },
 * }} options
 */
export function createThreadView({ scroller, rowsEl, bannerEl, jumpButton, follow, handlers }) {
  /** @type {Map<string, { el: HTMLElement, lane: HTMLElement | null, cards: ReturnType<typeof createCardList> | null, files: HTMLElement | null, stamp: HTMLElement | null, reacts?: HTMLElement, signature: string }>} */
  const nodes = new Map();
  let liveKey = null;
  const chooser = createReactChooser({ onPick: handlers.react });

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

  // The raw words of a failure are for whoever fixes it, so they wait behind Details.
  function errorBody(row, isFinal) {
    const { entry, failure } = row;
    const box = h('div', { class: 'error', role: 'alert' }, h('p', { text: 'Jet could not finish this reply.' }));
    if (entry.error) box.append(h('details', { class: 'error-details' }, h('summary', { text: 'Details' }), h('p', { text: entry.error })));
    if (LOGIN_HINT.test(entry.error || '')) box.append(h('p', { class: 'hint' }, 'Run ', h('code', { text: 'claude' }), ' in a terminal to log in.'));
    if (isFinal) {
      const actions = h('div', { class: 'actions' }, h('button', { class: 'action retry', type: 'button', text: 'Retry' }));
      if (failure && failure.kind === 'claudeMissing') actions.append(h('button', { class: 'action open-settings', type: 'button', text: 'Settings' }));
      box.append(actions);
    }
    return box;
  }

  const isFilesAlone = (entry) => entry.text.trim() === '' && (entry.attachments ?? []).length > 0;
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
    bubble.append(h('span', { class: 'sr-only', text: row.type === 'user' ? 'You:' : 'Jet:' }), body);

    if (row.type === 'user') {
      bubble.classList.toggle('is-forming', entry.status === 'forming');
      body.textContent = entry.text;
      // A message of files alone has no bubble; its time sits under the files instead.
      bubble.hidden = isFilesAlone(entry);
    } else if (entry.status === 'failed') {
      bubble.classList.add('is-error');
      body.append(errorBody(row, isFinal));
    } else if (isWaiting(entry)) {
      bubble.classList.add('is-waiting');
      bubble.setAttribute('aria-busy', 'true');
      body.append(dots(), h('span', { class: 'still', text: 'still thinking…' }));
      return;
    } else if (entry.colleague?.outcome) {
      // The words are the other person's own, so only their name and words are shown, never the server's line about them.
      body.append(colleagueNode(entry.colleague) ?? '');
    } else {
      body.innerHTML = entry.html;
      const quote = entry.colleague ? colleagueNode(entry.colleague) : null;
      if (quote) body.append(quote);
      linkCitations(body, known);
      sealCode(body);
      typeset(body);
      if (entry.status === 'streaming') bubble.setAttribute('aria-busy', 'true');
      if (entry.status === 'stopped') body.append(h('p', { class: 'stopped', text: entry.text ? 'Stopped' : 'Stopped before replying' }));
    }
    if (entry.status === 'streaming' || entry.status === 'forming') return;
    bubble.append(h('span', { class: 'time', text: clockTime(entry.at) }));
    leaveRoomForTime(bubble, body);
  }

  // Each side has at most one emoji on a message. The user's own is a button that takes it off.
  function fillReactions(record, row) {
    record.reacts.replaceChildren(...row.reactions.map(({ by, emoji }) => (by === 'user'
      ? h('button', { class: 'react-chip mine', type: 'button', 'aria-label': 'Your reaction ' + emoji + ', press to remove', 'data-entry': row.entry.id, text: emoji })
      : h('span', { class: 'react-chip', role: 'img', 'aria-label': 'Reaction ' + emoji, text: emoji }))));
  }

  function fillRow(record, row, isFinal, earlier) {
    const { el } = record;
    el.className = 'row row-' + row.type + (row.first ? ' first' : '') + (row.last ? ' last' : '') + (row.reactions?.length ? ' has-reacts' : '') + (row.live ? ' is-live' : '');
    if (row.type === 'lane') return;
    fillReactions(record, row);
    const calls = row.type === 'jet' ? row.entry.tools ?? [] : [];
    if (record.cards) record.cards.sync(calls, earlier);
    if (record.files) {
      fillAttachments(record.files, row.entry.attachments ?? []);
      record.stamp.hidden = !isFilesAlone(row.entry);
      record.stamp.textContent = clockTime(row.entry.at);
    }
    const bubble = el.querySelector('.bubble');
    fillBubble(bubble, row, isFinal, [...earlier, ...doneCalls(calls)]);
    if (record.checkin) {
      record.checkin.hidden = !row.entry.check;
      record.checkin.textContent = row.entry.check ? 'Check-in · ' + dayLabel(row.entry.at, Date.now()) + ', ' + clockTime(row.entry.at) : '';
    }
    if (canReact(row)) {
      bubble.tabIndex = -1;
      bubble.append(reactButton(row.entry.id, row.reactions.find((reaction) => reaction.by === 'user')?.emoji));
    }
  }

  function create(row) {
    if (row.type === 'day') return { el: h('div', { class: 'pill pill-day', text: row.label }), lane: null, cards: null, files: null, stamp: null, signature: '' };
    if (row.type === 'notice') return { el: h('div', { class: row.warning ? 'pill pill-notice is-warning' : 'pill pill-notice', role: 'status', text: row.message }), lane: null, cards: null, files: null, stamp: null, signature: '' };
    if (row.type === 'user') {
      const files = h('div', { class: 'attachments' });
      const stamp = h('span', { class: 'sent-time', hidden: true });
      const reacts = h('div', { class: 'reacts' });
      return { el: h('div', {}, h('div', { class: 'sent' }, files, h('div', { class: 'bubble' }), reacts, stamp)), lane: null, cards: null, files, stamp, reacts, signature: '' };
    }
    const lane = h('div', { class: 'lane' });
    if (row.type !== 'jet') {
      return { el: h('div', {}, lane, row.type === 'lane' ? null : h('div', { class: 'bubble' })), lane, cards: null, files: null, stamp: null, signature: '' };
    }
    const cardsEl = h('div', { class: 'cards' });
    const cards = createCardList(cardsEl, { render: handlers.render, readImage: handlers.readImage, seal: sealCode, watchJob: handlers.watchJob });
    const reacts = h('div', { class: 'reacts' });
    // A message Jet wrote by itself on a check says so above it, with when.
    const checkin = h('p', { class: 'checkin-label', hidden: true });
    return { el: h('div', {}, lane, h('div', { class: 'reply' }, cardsEl, checkin, h('div', { class: 'bubble' }), reacts)), lane, cards, files: null, stamp: null, reacts, checkin, signature: '' };
  }

  const signatureOf = (row, isFinal) => {
    const { entry, failure } = row;
    const calls = entry ? (entry.tools ?? []).map((call) => call.id + ':' + callState(call) + (call.progress ? JSON.stringify(call.progress) : '')).join(' ') : '';
    const files = row.type === 'user' ? (entry.attachments ?? []).map((file) => file.id) : '';
    const reactions = (row.reactions ?? []).map((reaction) => reaction.by + reaction.emoji);
    const shown = entry && [entry.id, entry.status, row.type === 'user' ? entry.text : '', entry.html, entry.error, entry.at, calls, files, reactions, entry.colleague];
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
    // A link to a saved file is left to the browser, which opens it in a new tab or saves it.
    if (target.closest('a[data-file]')) return;
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
    } else if (target.closest('.react-open')) {
      openChooser(/** @type {HTMLElement} */ (target.closest('.react-open')));
    } else if (target.closest('.react-chip.mine')) {
      handlers.react(Number(/** @type {HTMLElement} */ (target.closest('.react-chip')).dataset.entry), null);
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

  function openChooser(button) {
    const bubble = button.closest('.bubble');
    const below = bubble.getBoundingClientRect().top - scroller.getBoundingClientRect().top < 64;
    chooser.open(bubble, { entryId: Number(button.dataset.entry), mine: button.dataset.mine || null, below, opener: button });
  }

  // The reaction controls stay out of the Tab order, so the message box is not dozens of stops away.
  // From the thread, the arrow keys move between Jet's messages, and the one that has the focus lets Tab reach its control.
  const reactables = () => [...rowsEl.querySelectorAll('.bubble:has(> .react-open)')];
  rowsEl.addEventListener('focusin', (event) => {
    for (const button of rowsEl.querySelectorAll('.react-open[tabindex="0"]')) button.tabIndex = -1;
    const open = /** @type {HTMLElement} */ (event.target).closest('.row')?.querySelector('.react-open');
    if (open) open.tabIndex = 0;
  });
  scroller.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (target !== scroller && !target.matches('.bubble')) return;
    const bubbles = reactables();
    if (bubbles.length === 0) return;
    const at = bubbles.indexOf(/** @type {HTMLElement} */ (target));
    const next = at === -1 ? (event.key === 'ArrowUp' ? bubbles.length - 1 : 0) : Math.min(bubbles.length - 1, Math.max(0, at + (event.key === 'ArrowUp' ? -1 : 1)));
    event.preventDefault();
    bubbles[next].focus();
  });

  // On a touch screen a long press on a Jet bubble opens the chooser, and a finger that moves is a scroll.
  let press = null;
  const endPress = () => {
    clearTimeout(press?.timer);
    press = null;
  };
  rowsEl.addEventListener('pointerdown', (event) => {
    const button = event.pointerType === 'touch' ? /** @type {HTMLElement} */ (event.target).closest('.bubble')?.querySelector(':scope > .react-open') : null;
    if (!button) return;
    endPress();
    press = { x: event.clientX, y: event.clientY, timer: setTimeout(() => openChooser(button), LONG_PRESS_MS) };
  });
  rowsEl.addEventListener('pointermove', (event) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) endPress();
  });
  rowsEl.addEventListener('pointerup', endPress);
  rowsEl.addEventListener('pointercancel', endPress);
  // A finger held on a bubble would also open the browser's own menu.
  rowsEl.addEventListener('contextmenu', (event) => { if (press) event.preventDefault(); });

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
        record.el.classList.toggle('is-live', Boolean(row.live));
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
        record.cards?.dispose();
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
