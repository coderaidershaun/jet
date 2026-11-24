// The plan pane on the right of the window: reads GET /api/pane, redraws on each paneChanged event,
// and turns each tap into one call. It owns whether the pane is open and what the user has seen of it.

import { requestJson } from '../bridge/browser-agent.js';
import { h, icon } from '../dom.js';
import { shareOf } from '../chat/thread/cards/share.js';
import { shareCard } from '../chat/thread/cards/share-view.js';
import { svgIcon } from './icons.js';
import { keysOf, newCount, readPane } from './model.js';
import { planNodes } from './view.js';

const OPEN_KEY = 'jet.pane';
const SEEN_KEY = 'jet.pane.seen';

/** Per-browser storage that never throws: a blocked or full store reads as empty and loses the write. */
const stored = {
  read(key) {
    try { return localStorage.getItem(key); } catch (error) { console.warn('the browser store could not be read:', error); return null; }
  },
  write(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { console.warn('the browser store could not be written:', error); }
  },
};

function seenKeys() {
  try { return new Set(JSON.parse(stored.read(SEEN_KEY) ?? '[]')); } catch (error) { console.warn('the seen marks could not be read:', error); return new Set(); }
}

const idsOf = (list) => (Array.isArray(list) ? list.map((item) => item.id) : []);

/**
 * @param {{ shell: HTMLElement, host: HTMLElement, agent: any, openChat: (chatId: number) => void }} parts
 *   `shell` carries `data-pane`; `host` is the pane itself; `openChat` shows a chat by its id
 * @returns {{ button: HTMLElement, refresh: () => Promise<void> }}
 */
export function createPlanPane({ shell, host, agent, openChat }) {
  const overlay = matchMedia('(max-width: 1023px)');
  let desktopOpen = stored.read(OPEN_KEY) !== 'closed';
  let overlayOpen = false;
  let pane = null, problem = null, refreshNumber = 0;
  let seen = seenKeys();
  const view = { showClosed: false, showAllRuns: false };
  const shares = new Map();

  const count = h('span', { class: 'pane-count', 'aria-hidden': 'true', hidden: true });
  const button = h('button', { type: 'button', class: 'pane-toggle', 'aria-controls': host.id, onClick: () => setOpen(!isOpen(), true) }, svgIcon('plan'), count);
  const notice = h('p', { class: 'pane-notice', role: 'status' });
  const body = h('div', { class: 'pane-body' });
  const close = h('button', { type: 'button', class: 'icon-button pane-close', 'aria-label': 'Close the plan', title: 'Close the plan', onClick: () => setOpen(false, true) }, icon('close'));
  host.setAttribute('aria-label', 'Plan');
  host.append(h('header', { class: 'pane-head' }, h('div', { class: 'pane-bar' }, h('h2', { class: 'pane-title', text: 'Plan' }), close), notice), body);

  const isOpen = () => (overlay.matches ? overlayOpen : desktopOpen);

  function setOpen(on, byUser) {
    if (overlay.matches) overlayOpen = on;
    else { desktopOpen = on; stored.write(OPEN_KEY, on ? 'open' : 'closed'); }
    paint();
    if (byUser && overlay.matches) (on ? close : button).focus();
  }

  /** Opening the pane is what marks everything in it as seen. */
  function paint() {
    const open = isOpen();
    host.hidden = !open;
    shell.dataset.pane = open ? 'open' : 'closed';
    if (open && pane) {
      seen = new Set(keysOf(pane));
      stored.write(SEEN_KEY, JSON.stringify([...seen]));
    }
    const fresh = !open && pane ? newCount(pane, seen) : 0;
    count.hidden = fresh === 0;
    count.textContent = String(fresh);
    const label = (open ? 'Close the plan' : 'Open the plan') + (fresh ? `, ${fresh} new` : '');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-expanded', String(open));
  }

  function draw() {
    const focus = host.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const scroll = host.scrollTop;
    notice.textContent = problem ?? '';
    const ctx = {
      year: new Date().getFullYear(), now: Date.now() / 1000, timeZone: pane?.timeZone ?? undefined, shares, act,
      showClosed: view.showClosed, showAllRuns: view.showAllRuns,
      set: { closed: (on) => { view.showClosed = on; }, allRuns: (on) => { view.showAllRuns = on; draw(); } },
    };
    body.replaceChildren(...(pane ? planNodes(pane, ctx) : [h('p', { class: 'pane-hint', text: 'Loading the plan…' })]));
    host.scrollTop = scroll;
    if (focus) body.querySelector(`[data-key="${CSS.escape(focus)}"]`)?.focus();
    paint();
  }

  async function refresh() {
    const current = ++refreshNumber;
    try {
      const next = readPane(await requestJson('/api/pane'));
      if (current !== refreshNumber) return;
      pane = next;
      problem = null;
    } catch (error) {
      if (current !== refreshNumber) return;
      problem = 'The plan could not be loaded: ' + (error.message ?? 'check the connection');
    }
    draw();
  }

  /** One tap: the button is off until the answer, then the whole pane is read again. */
  async function tap(failure, call, el) {
    if (el) el.disabled = true;
    try {
      await call();
      problem = null;
    } catch (error) {
      problem = `${failure}: ${error?.message ?? 'try again'}`;
    }
    await refresh();
  }

  async function toggleShare(objective, el) {
    if (shares.has(objective.id)) { shares.delete(objective.id); draw(); return; }
    el.disabled = true;
    try {
      const sharedWith = objective.sharedWith ?? {};
      const card = shareOf(await requestJson(`/api/objectives/${objective.id}/share-proposals`, { people: idsOf(sharedWith.people), teams: idsOf(sharedWith.teams) }));
      if (!card) throw new Error('Jet sent a card that this page cannot read');
      const key = `pane-share-${objective.id}`;
      shares.set(objective.id, h('div', { class: 'pane-share' }, shareCard({ key, id: key, body: { view: card } })));
      problem = null;
    } catch (error) {
      problem = `The share card could not be made: ${error?.message ?? 'try again'}`;
    }
    draw();
  }

  const act = {
    tick: (objective, step, done, el) => tap('The step could not be changed', () => requestJson(`/api/objectives/${objective.id}/steps/${step.id}`, { done }, 'PUT'), el),
    flip: (objective, note, el) => tap('The note could not be changed', () => requestJson(`/api/objectives/${objective.id}/notes/${note.id}`, { private: !note.isPrivate }, 'PUT'), el),
    snooze: (task, el) => tap('The check could not be snoozed', () => requestJson(`/api/tasks/${task.id}/snooze`, {}, 'POST'), el),
    cancel: (task, el) => tap('The check could not be cancelled', () => requestJson(`/api/tasks/${task.id}/cancel`, {}, 'POST'), el),
    share: toggleShare,
    openChat(objective) {
      if (overlay.matches) setOpen(false);
      openChat(objective.chatId);
    },
  };

  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !overlay.matches || !overlayOpen || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    setOpen(false, true);
    event.preventDefault();
    event.stopPropagation();
  });
  overlay.addEventListener('change', paint);
  agent.onChatEvent?.((envelope) => { if (envelope.event.kind === 'paneChanged') refresh(); });
  agent.onConnectionChanged?.((connected) => { if (connected) refresh(); });
  // Times such as "in 2 h" age while the page sits still.
  setInterval(() => { if (isOpen() && pane) draw(); }, 60000);
  draw();
  refresh();
  return { button, refresh };
}
