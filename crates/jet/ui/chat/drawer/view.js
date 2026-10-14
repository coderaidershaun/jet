// The drawer: the static Jet and name, the cache chip, the raw stream log, and
// the gear that opens settings. It also opens and closes itself, docked beside
// the thread on wide screens and over it on narrow ones.

import { RING_HIDDEN } from '../../jet/state.js';
import { mountJet } from '../../jet/view.js';
import { h } from '../dom.js';

const NARROW = '(max-width: 759.98px)';
const FOLLOW_SLACK_PX = 24;

/**
 * @param {{
 *   page: HTMLElement, toggle: HTMLElement, scrim: HTMLElement,
 *   jetSvg: SVGSVGElement, nameEl: HTMLElement, titleEl: HTMLElement, chipEl: HTMLElement, modelEl: HTMLElement,
 *   logList: HTMLElement, copyButton: HTMLElement, clearButton: HTMLElement, gearButton: HTMLElement,
 *   rig: import('../../jet/rig.js').Rig,
 *   log: ReturnType<typeof import('./log.js').createLog>,
 *   handlers: { openSettings: () => void, dockedChanged: (open: boolean) => void },
 * }} options
 */
export function createDrawerView({
  page, toggle, scrim, jetSvg, nameEl, titleEl, chipEl, modelEl, logList, copyButton, clearButton, gearButton, rig, log, handlers,
}) {
  const narrow = window.matchMedia(NARROW);
  const draw = mountJet(jetSvg, rig);
  let pending = [];
  let flushQueued = false;

  const staticJet = () => ({
    body: rig.poses.soft,
    eyes: [...rig.eyes.soft, 4, 4],
    colour: rig.palette.rest,
    scale: 1,
    ring: RING_HIDDEN,
    speed: 0,
  });

  // SMELL: each row is its own Tab stop, so up to 500 rows stand between Clear and the gear. One Tab stop for
  // the whole list, with the arrow keys moving between rows, would fix it.
  function logRow(line) {
    const row = h('div', {
      class: 'log-row',
      'data-type': line.type,
      'data-tone': line.tone ?? '',
      role: 'button',
      tabindex: '0',
      'aria-expanded': 'false',
    }, h('span', { class: 'log-line', text: line.raw }));
    const toggleRow = () => {
      const open = row.getAttribute('aria-expanded') === 'true';
      row.setAttribute('aria-expanded', String(!open));
      if (open) row.querySelector('pre').remove();
      else row.append(h('pre', { class: 'log-pretty', text: line.pretty }));
    };
    row.addEventListener('click', (event) => { if (!(/** @type {HTMLElement} */ (event.target)).closest('pre')) toggleRow(); });
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      toggleRow();
    });
    return row;
  }

  function flush() {
    flushQueued = false;
    const following = logList.scrollHeight - logList.scrollTop - logList.clientHeight <= FOLLOW_SLACK_PX;
    logList.append(...pending.map(logRow));
    pending = [];
    while (logList.children.length > log.lines().length) logList.firstElementChild.remove();
    if (following) logList.scrollTop = logList.scrollHeight;
  }

  function applyOpen(open) {
    page.dataset.drawer = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', String(open));
    scrim.hidden = !(open && narrow.matches);
  }

  copyButton.addEventListener('click', () => {
    navigator.clipboard.writeText(log.text()).then(
      () => { copyButton.textContent = 'Copied'; setTimeout(() => { copyButton.textContent = 'Copy'; }, 1200); },
      (error) => console.warn('the stream log could not be copied:', error),
    );
  });
  clearButton.addEventListener('click', () => {
    log.clear();
    pending = [];
    logList.replaceChildren();
  });
  gearButton.addEventListener('click', handlers.openSettings);
  toggle.addEventListener('click', () => view.setOpen(page.dataset.drawer !== 'open'));
  scrim.addEventListener('click', () => view.setOpen(false));
  narrow.addEventListener('change', () => view.setOpen(!narrow.matches && view.dockedPreference));

  const view = {
    /** What the user last chose for the docked drawer. */
    dockedPreference: true,

    get isOpen() {
      return page.dataset.drawer === 'open';
    },

    /** True only for the narrow-screen drawer that covers the thread. */
    get overlayOpen() {
      return view.isOpen && narrow.matches;
    },

    setOpen(open) {
      applyOpen(open);
      if (narrow.matches) return;
      view.dockedPreference = open;
      handlers.dockedChanged(open);
    },

    /** The first state of the drawer: the saved choice when docked, closed when it would cover the thread. */
    init(openWhenDocked) {
      view.dockedPreference = openWhenDocked;
      applyOpen(openWhenDocked && !narrow.matches);
      draw(staticJet());
    },

    recolour() {
      draw(staticJet());
    },

    setPersona({ name, jobTitle }) {
      nameEl.textContent = name;
      titleEl.textContent = jobTitle;
    },

    setCache({ warm, text }) {
      chipEl.textContent = text;
      chipEl.dataset.warm = String(warm);
    },

    setModel(model) {
      modelEl.textContent = model;
    },

    /** Adds a raw line; rows are drawn once per frame. */
    addLine(raw) {
      pending.push(log.add(raw));
      if (!flushQueued) {
        flushQueued = true;
        requestAnimationFrame(flush);
      }
    },
  };
  return view;
}
