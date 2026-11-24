// The plan pane on the right of the window: reads GET /api/pane, redraws on each paneChanged event,
// and turns each tap into one call. It owns whether the pane is open and what the user has seen of it.
// Below 1024 px the open pane is a dialog over the page, which stays inert behind a scrim until it closes.

import { requestJson } from '../bridge/browser-agent.js';
import { h, icon } from '../dom.js';
import { numberOrNull } from '../chat/thread/cards/guard.js';
import { directoryView, shareOf } from '../chat/thread/cards/share.js';
import { shareCard } from '../chat/thread/cards/share-view.js';
import { svgIcon } from './icons.js';
import { dueWords, firstOpen, groupObjectives, isoDay, keysOf, newCount, readPane } from './model.js';
import { CONFIRM_MS, disarm, idleTaps, pressCancel, tapEnded } from './taps.js';
import { planNodes } from './view.js';

const OPEN_KEY = 'jet.pane';
const SEEN_KEY = 'jet.pane.seen';
const TAB_STOPS = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** Per-browser storage that never throws: a blocked or full store reads as empty and loses the write. */
const stored = {
  read(key) {
    try { return localStorage.getItem(key); } catch (error) { console.warn('the browser store could not be read:', error); return null; }
  },
  write(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { console.warn('the browser store could not be written:', error); }
  },
};

/** What the user saw when they last looked, or null on their first visit. */
function seenKeys() {
  try {
    const raw = stored.read(SEEN_KEY);
    return raw === null ? null : new Set(JSON.parse(raw));
  } catch (error) {
    console.warn('the seen marks could not be read:', error);
    return null;
  }
}

/**
 * @param {{ shell: HTMLElement, host: HTMLElement, agent: any, openChat: (chatId: number, entryId?: number | null) => void }} parts
 *   `shell` carries `data-pane`; `host` is the pane itself; `openChat` shows a chat by its id, at an entry when given
 * @returns {{ button: HTMLElement, refresh: () => Promise<void> }}
 */
export function createPlanPane({ shell, host, agent, openChat }) {
  const overlay = matchMedia('(max-width: 1023px)');
  let desktopOpen = stored.read(OPEN_KEY) !== 'closed';
  let overlayOpen = false, wasModal = false;
  let pane = null, problem = null, refreshNumber = 0, busy = false, armTimer = 0;
  let taps = idleTaps;
  let seen = seenKeys();
  const view = { showClosed: false, showAllRuns: false, open: null };
  const shares = new Map();

  const count = h('span', { class: 'pane-count', 'aria-hidden': 'true', hidden: true });
  const button = h('button', { type: 'button', class: 'pane-toggle', 'aria-controls': host.id, onClick: () => setOpen(!isOpen(), true) }, svgIcon('plan'), h('span', { class: 'pane-toggle-label', text: 'Plan' }), count);
  const notice = h('p', { class: 'pane-notice', role: 'status' });
  const alert = h('p', { class: 'pane-notice pane-alert', role: 'alert' });
  const said = h('p', { class: 'sr-only', role: 'status' });
  const body = h('div', { class: 'pane-body' });
  const close = h('button', { type: 'button', class: 'icon-button pane-close', 'aria-label': 'Close the plan', title: 'Close the plan', onClick: () => setOpen(false, true) }, icon('close'));
  const scrim = h('div', { class: 'pane-scrim', hidden: true, onClick: () => setOpen(false, true) });
  host.setAttribute('aria-label', 'Plan');
  host.append(h('header', { class: 'pane-head' }, h('div', { class: 'pane-bar' }, h('h2', { class: 'pane-title', text: 'Plan' }), close), notice, alert), said, body);
  shell.append(scrim);

  const isOpen = () => (overlay.matches ? overlayOpen : desktopOpen);

  function setOpen(on, byUser) {
    if (overlay.matches) overlayOpen = on;
    else { desktopOpen = on; stored.write(OPEN_KEY, on ? 'open' : 'closed'); }
    paint();
    if (byUser && overlay.matches) (on ? close : button).focus();
  }

  /** Everything of the page but the pane: the chat's own parts rather than the chat, whose inert the shell owns. */
  const behind = () => [...shell.children].flatMap((el) => (el === host || el === scrim ? [] : el.contains(button) ? [...el.children] : [el]));

  function markSeen() {
    if (!pane) return;
    seen = new Set(keysOf(pane));
    stored.write(SEEN_KEY, JSON.stringify([...seen]));
  }

  /** Opening the pane is what marks everything in it as seen. */
  function paint() {
    const open = isOpen();
    const modal = open && overlay.matches;
    host.hidden = !open;
    shell.dataset.pane = open ? 'open' : 'closed';
    scrim.hidden = !modal;
    if (modal !== wasModal) {
      wasModal = modal;
      if (modal) { host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); } else { host.removeAttribute('role'); host.removeAttribute('aria-modal'); }
      for (const el of behind()) el.inert = modal;
    }
    if (open || (pane && seen === null)) markSeen();
    const fresh = !open && pane ? newCount(pane, seen) : 0;
    count.hidden = fresh === 0;
    count.textContent = String(fresh);
    const label = (open ? 'Close the plan' : 'Open the plan') + (fresh ? `, ${fresh} new` : '');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-expanded', String(open));
  }

  function focusKey(key) {
    const target = key ? body.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
    target?.focus({ preventScroll: true });
    return target;
  }

  function draw() {
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const focus = focused?.dataset.key ?? null;
    const scroll = host.scrollTop;
    // Writing the same words again would make a screen reader say them again on every redraw.
    if (notice.textContent !== (problem ?? '')) notice.textContent = problem ?? '';
    if (alert.textContent !== taps.notice) alert.textContent = taps.notice;
    const zone = pane?.timeZone ?? undefined;
    const now = Date.now() / 1000;
    const ctx = {
      year: new Date().getFullYear(), now, today: isoDay(now, zone), timeZone: zone, shares, act, taps, open: view.open ?? new Set(),
      showClosed: view.showClosed, showAllRuns: view.showAllRuns,
      set: { closed: (on) => { view.showClosed = on; }, allRuns: (on) => { view.showAllRuns = on; draw(); } },
    };
    body.replaceChildren(...(pane ? planNodes(pane, ctx) : [h('p', { class: 'pane-hint', text: 'Loading the plan…' })]));
    host.scrollTop = scroll;
    // The share card is kept across redraws and has no keys, so its own element takes the focus back.
    if (!focusKey(focus) && focused?.isConnected) focused.focus({ preventScroll: true });
    paint();
  }

  async function refresh() {
    const current = ++refreshNumber;
    try {
      const next = readPane(await requestJson('/api/pane'));
      if (current !== refreshNumber) return;
      pane = next;
      problem = null;
      if (view.open === null) view.open = new Set([firstOpen(groupObjectives(pane.objectives).active)]);
    } catch (error) {
      if (current !== refreshNumber) return;
      problem = 'The plan could not be loaded: ' + (error?.message ?? 'check the connection');
    }
    draw();
  }

  /**
   * One tap: the control stays where it is and keeps the focus while the call runs, then the whole pane is read
   * again. A failure stays on screen until a later tap works; a success is said aloud.
   */
  async function tap(failure, call, el, done, focusAfter = el?.dataset.key) {
    if (busy) return;
    busy = true;
    el?.setAttribute('aria-disabled', 'true');
    let error = null;
    try { await call(); } catch (caught) { error = caught ?? {}; }
    taps = tapEnded(failure, error);
    said.textContent = error === null ? done : '';
    // Emptied first, so a second failure with the same words is announced again by the redraw.
    if (error !== null) alert.textContent = '';
    busy = false;
    await refresh();
    if (!focusKey(error === null ? focusAfter : el?.dataset.key)) focusKey('heading-plan');
  }

  function armCancel() {
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { taps = disarm(taps); draw(); }, CONFIRM_MS);
    said.textContent = 'Tap Cancel again to stop this check.';
    draw();
  }

  /** The control to take the focus once a check is cancelled and its row is gone: the next check, else the one before. */
  function afterCancel(task) {
    const left = (pane?.tasks ?? []).filter((t) => t.state !== 'running');
    const at = left.findIndex((t) => t.id === task.id);
    const next = left[at + 1] ?? left[at - 1];
    return next ? `snooze-${next.id}` : 'heading-plan';
  }

  async function toggleShare(objective, el) {
    if (shares.has(objective.id)) { shares.delete(objective.id); draw(); return; }
    el.setAttribute('aria-disabled', 'true');
    try {
      const card = directoryView(objective, await requestJson(`/api/objectives/${objective.id}/directory`));
      if (!card) throw new Error('Jet sent a list of people that this page cannot read');
      const key = `pane-share-${objective.id}`;
      // The owner's tap makes the proposal and applies it in one go: the card is drawn from the directory, so it has none yet.
      const apply = async (picked) => {
        const proposal = shareOf(await requestJson(`/api/objectives/${objective.id}/share-proposals`, picked));
        if (!proposal) throw { kind: 'network', message: 'Jet sent a card that this page cannot read' };
        return requestJson(`/api/shares/proposals/${proposal.id}/apply`, picked);
      };
      shares.set(objective.id, h('div', { class: 'pane-share' }, shareCard({ key, id: key, body: { view: card }, apply })));
      taps = idleTaps;
    } catch (error) {
      taps = tapEnded('The list of people could not be read', error);
    }
    draw();
    focusKey(`share-${objective.id}`);
  }

  function jump(target) {
    const heading = focusKey(`heading-${target}`);
    heading?.scrollIntoView({ block: 'start' });
  }

  function leaveFor(show) {
    if (overlay.matches) setOpen(false);
    show();
  }

  const act = {
    tick: (objective, step, done, el) => tap('The step could not be changed', () => requestJson(`/api/objectives/${objective.id}/steps/${step.id}`, { done }, 'PUT'), el, `${done ? 'Ticked' : 'Unticked'} ${step.title}`),
    flip: (objective, note, el) => tap('The note could not be changed', () => requestJson(`/api/objectives/${objective.id}/notes/${note.id}`, { private: !note.isPrivate }, 'PUT'), el, note.isPrivate ? 'The note is shared now' : 'The note is private now'),
    snooze: (task, el) => tap('The check could not be snoozed', () => requestJson(`/api/tasks/${task.id}/snooze`, {}, 'POST'), el, numberOrNull(task.snoozeAt) === null ? 'Snoozed' : `Snoozed to ${dueWords(task.snoozeAt, pane?.timeZone ?? task.timeZone, new Date().getFullYear())}`),
    cancel(task, el) {
      const pressed = pressCancel(taps, task.id);
      taps = pressed.taps;
      if (!pressed.send) { armCancel(); return; }
      clearTimeout(armTimer);
      tap('The check could not be cancelled', () => requestJson(`/api/tasks/${task.id}/cancel`, {}, 'POST'), el, 'Cancelled the check', afterCancel(task));
    },
    share: toggleShare,
    fold(objective) {
      if (view.open.has(objective.id)) view.open.delete(objective.id); else view.open.add(objective.id);
      draw();
    },
    jump,
    openChat: (objective) => leaveFor(() => openChat(objective.chatId)),
    openRun: (run) => leaveFor(() => openChat(run.chatId, run.entryId)),
    draft: (text) => leaveFor(() => host.dispatchEvent(new CustomEvent('jet:draft', { bubbles: true, detail: { text } }))),
  };

  host.addEventListener('keydown', (event) => {
    if (!overlay.matches || !overlayOpen || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      setOpen(false, true);
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === 'Tab') {
      const stops = [...host.querySelectorAll(TAB_STOPS)].filter((el) => !el.disabled && el.tabIndex >= 0 && el.checkVisibility());
      const edge = event.shiftKey ? stops[0] : stops.at(-1);
      if (stops.length && document.activeElement === edge) {
        (event.shiftKey ? stops.at(-1) : stops[0]).focus();
        event.preventDefault();
      }
    }
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
