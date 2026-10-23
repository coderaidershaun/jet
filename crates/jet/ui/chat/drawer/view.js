// Usage and diagnostics inside the chat dock.

import { h } from '../../dom.js';
import { createPlayer } from '../../jet/player.js';
import { mountJet } from '../../jet/draw/view.js';
import { captionFor } from './caption.js';
import { NOTHING, compactCount, count, dollars, modelAndThinking, seconds, spendText, turnsText } from './format.js';
import { RATES_DATE } from './rates.js';
import { tokenCount } from './usage.js';

const FOLLOW_SLACK_PX = 24;
const COPIED_SHOWN_MS = 1200;
const SESSION_ID_CHARS = 8;

/**
 * @param {{
 *   jetSvg: SVGSVGElement, nameEl: HTMLElement, titleEl: HTMLElement, chipEl: HTMLElement, modelEl: HTMLElement,
 *   usageEl: HTMLElement, logToggle: HTMLElement, logList: HTMLElement, copyButton: HTMLElement, clearButton: HTMLElement, gearButton: HTMLElement,
 *   log: ReturnType<typeof import('./log.js').createLog>,
 *   handlers: { openSettings: () => void },
 * }} options
 */
export function createDrawerView({
  jetSvg, nameEl, titleEl, chipEl, modelEl, usageEl, logToggle, logList, copyButton, clearButton, gearButton, log, handlers,
}) {
  jetSvg.setAttribute('viewBox', '0 70 200 170');
  const draw = mountJet(jetSvg);
  const staticJet = createPlayer({ standing: true, reducedMotion: true });
  staticJet.tick(0);
  const drawStatic = () => draw(staticJet.frame, { unitPx: Math.max(jetSvg.getBoundingClientRect().width / 200, 0.001) });
  const logEl = logToggle.closest('.log');
  const usagePart = (id) => usageEl.querySelector('#usage-' + id);
  const sessionCopyButton = usagePart('copy');
  const setValue = (id, text) => {
    const element = usagePart(id);
    element.textContent = text;
    element.toggleAttribute('data-empty', text === NOTHING);
  };
  let pending = [];
  let flushQueued = false;
  let latestUsage = null;
  let usageQueued = false;

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
    showLogCount();
  }

  function showLogCount() {
    logToggle.textContent = 'Raw stream (' + log.lines().length + ')';
  }

  function setLogOpen(open) {
    logToggle.setAttribute('aria-expanded', String(open));
    logEl.dataset.open = String(open);
    logList.hidden = !open;
    if (open) logList.scrollTop = logList.scrollHeight;
  }

  function drawUsage() {
    usageQueued = false;
    const { current, total, byModelEffort } = latestUsage;

    usagePart('dot').dataset.status = current.status;
    usagePart('status').textContent = current.status;
    setValue('in', count(current.inputTokens));
    setValue('cache-read', count(current.cacheReadTokens));
    // The zero-width space lets a long pair wrap after the slash, never inside a number.
    setValue('cache-write', count(current.cacheWrite5mTokens) + '/\u200B' + count(current.cacheWrite1hTokens));
    setValue('out', count(current.outputTokens));
    setValue('thinking', count(current.thinkingTokens));
    setValue('spend', spendText(current));
    setValue('first-token', seconds(current.ttftMs));
    setValue('api', seconds(current.apiMs));
    setValue('duration', seconds(current.durationMs));
    setValue('turns', turnsText(current.numTurns));
    setValue('stop', current.stopReason ?? NOTHING);

    setValue('all-replies', count(total.replies));
    setValue('all-tokens', compactCount(tokenCount(total)));
    setValue('all-spend', dollars(total.usd));
    usagePart('table').hidden = byModelEffort.length === 0;
    usagePart('table-body').replaceChildren(...byModelEffort.map((row) => h('tr', {},
      h('td', { text: modelAndThinking(row) }),
      h('td', { class: 'usage-number', text: count(row.replies) }),
      h('td', { class: 'usage-number', text: count(tokenCount(row)) }),
      h('td', { class: 'usage-number', text: row.usd === null ? NOTHING : row.usd.toFixed(4) }),
    )));

    setValue('model', modelAndThinking(current));
    setValue('session', current.sessionId === null ? NOTHING : current.sessionId.slice(0, SESSION_ID_CHARS));
    sessionCopyButton.disabled = current.sessionId === null;
  }

  function copyText(button, text, what) {
    navigator.clipboard.writeText(text).then(
      () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, COPIED_SHOWN_MS); },
      (error) => console.warn(what + ' could not be copied:', error),
    );
  }

  copyButton.addEventListener('click', () => copyText(copyButton, log.text(), 'the stream log'));
  sessionCopyButton.addEventListener('click', () => copyText(sessionCopyButton, latestUsage.current.sessionId, 'the session id'));
  clearButton.addEventListener('click', () => {
    log.clear();
    pending = [];
    logList.replaceChildren();
    showLogCount();
  });
  logToggle.addEventListener('click', () => setLogOpen(logToggle.getAttribute('aria-expanded') !== 'true'));
  usagePart('note').textContent = 'List prices of ' + RATES_DATE;
  gearButton.addEventListener('click', handlers.openSettings);
  const view = {
    init: drawStatic,

    setPersona({ name, jobTitle }) {
      nameEl.textContent = name;
      titleEl.textContent = jobTitle;
    },

    setCache({ warm, text }) {
      chipEl.textContent = text;
      chipEl.dataset.warm = String(warm);
    },

    /** The words under the gear: what the next reply will use. */
    setModel({ model, effort }) {
      modelEl.textContent = captionFor(model, effort);
    },

    /** Keeps the latest usage; the panel is drawn once per frame. */
    setUsage(snapshot) {
      latestUsage = snapshot;
      if (!usageQueued) {
        usageQueued = true;
        requestAnimationFrame(drawUsage);
      }
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
