// The library: every file of the user across their chats, newest change first, with one search field, and a way
// to choose several files to download as one zip or delete. It owns only the search words and the choice.

import { h } from '../../dom.js';
import { files } from './store.js';
import { bulkDeleteAsk, matches, usageWords } from './words.js';
import { fileRow } from './row.js';

const CONFIRM_MS = 4000;
const SKELETON_ROWS = 5;

/**
 * @param {{ titleOf: (chatId: number) => string, announce: (message: string) => void }} parts
 */
export function createLibrary({ titleOf, announce }) {
  let shown = false, choosing = false, armed = false, deleting = false, zipping = null, armTimer = 0;
  const chosen = new Set();

  const title = h('h1', { class: 'library-title', id: 'library-title', tabindex: '-1', text: 'Files' });
  const search = h('input', { type: 'search', class: 'library-search', placeholder: 'Search files', 'aria-label': 'Search files', enterkeyhint: 'search', autocomplete: 'off', onInput: paintList });
  const select = h('button', { type: 'button', class: 'text-button', onClick: startChoosing }, 'Select');
  const downloadAll = h('button', { type: 'button', class: 'text-button', 'aria-label': 'Download all files as one zip', onClick: (event) => zip(null, event.currentTarget) }, 'Download all');
  const count = h('span', { class: 'library-count', role: 'status' });
  const zipChosen = h('button', { type: 'button', class: 'library-zip', onClick: (event) => zip([...chosen], event.currentTarget) }, 'Download as zip');
  const remove = h('button', { type: 'button', class: 'text-button library-delete', onClick: askDelete, onBlur: () => { if (armed) disarm(); } }, 'Delete');
  const cancel = h('button', { type: 'button', class: 'text-button', onClick: () => stopChoosing() }, 'Cancel');
  const finding = h('div', { class: 'library-bar' }, search, select, downloadAll);
  const choosingBar = h('div', { class: 'library-bar', hidden: true }, count, zipChosen, remove, cancel);
  const usage = h('p', { class: 'library-usage' });
  const list = h('ul', { class: 'library-list', 'aria-labelledby': 'library-title' });
  const state = h('div', { class: 'library-state' });
  const loading = h('p', { class: 'sr-only', role: 'status' });
  const el = h('section', { class: 'library', id: 'files-content', 'aria-labelledby': 'library-title', hidden: true },
    h('header', { class: 'library-head' }, title),
    h('div', { class: 'library-column' }, h('div', { class: 'library-tools' }, finding, choosingBar), usage, list, state, loading));

  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (choosing) stopChoosing();
    else if (event.target === search && search.value !== '') { search.value = ''; paintList(); }
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  function startChoosing() {
    choosing = true;
    // Back leaves the choice before it leaves the library.
    history.pushState({ files: 'choose' }, '', '#files');
    paint();
    zipChosen.focus();
  }

  /** Ends the choice. `byBack` is true when the browser's back already took its history step away. */
  function stopChoosing(byBack = false) {
    if (!choosing) return;
    choosing = false;
    chosen.clear();
    disarm();
    if (!byBack && history.state?.files === 'choose') history.back();
    paint();
    select.focus();
  }

  function disarm() {
    clearTimeout(armTimer);
    if (!armed) return;
    armed = false;
    paintBar();
  }

  async function askDelete() {
    if (!armed) {
      armed = true;
      armTimer = setTimeout(disarm, CONFIRM_MS);
      paintBar();
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    const doomed = files.state.files.filter((file) => chosen.has(file.id));
    // Each delete makes the list repaint, so the button stays off by this flag until every delete has answered.
    deleting = true;
    paintBar();
    for (const file of doomed) {
      try { await files.remove(file.id); } catch (error) { announce(`${file.name} could not be deleted: ${error?.message ?? 'Jet did not answer.'}`); }
    }
    deleting = false;
    stopChoosing();
  }

  async function zip(ids, button) {
    zipping = button;
    paintBar();
    try {
      await files.saveZip(ids);
    } catch (error) {
      announce(`The zip could not be made: ${error?.message ?? 'Jet did not answer.'}`);
    }
    zipping = null;
    paintBar();
  }

  function paintBar() {
    const { status, files: everything } = files.state;
    const none = status !== 'ready' || everything.length === 0;
    finding.hidden = choosing;
    choosingBar.hidden = !choosing;
    select.disabled = none;
    downloadAll.disabled = none || zipping !== null;
    downloadAll.textContent = zipping === downloadAll ? 'Preparing zip…' : 'Download all';
    downloadAll.setAttribute('aria-label', zipping === downloadAll ? 'Preparing zip…' : 'Download all files as one zip');
    count.textContent = `${chosen.size} selected`;
    zipChosen.disabled = chosen.size === 0 || zipping !== null;
    zipChosen.textContent = zipping === zipChosen ? 'Preparing zip…' : 'Download as zip';
    remove.disabled = chosen.size === 0 || deleting;
    remove.textContent = armed ? bulkDeleteAsk(chosen.size) : 'Delete';
    remove.classList.toggle('is-armed', armed);
  }

  function paintUsage() {
    const { status, usedBytes, limitBytes, refreshFailed } = files.state;
    usage.hidden = status !== 'ready';
    if (refreshFailed) {
      usage.dataset.tone = 'quiet';
      usage.replaceChildren('Files could not be refreshed. ', h('button', { type: 'button', class: 'text-button', onClick: () => files.retry() }, 'Try again'));
      return;
    }
    const { words, tone } = usageWords(usedBytes, limitBytes);
    usage.dataset.tone = tone;
    usage.replaceChildren(words);
  }

  function stateBlock(heading, words, action = null) {
    return [h('p', { class: 'library-state-head', text: heading }), words ? h('p', { class: 'library-state-words', text: words }) : null, action].filter(Boolean);
  }

  function paintList() {
    const { status, files: everything } = files.state;
    const query = search.value;
    for (const id of chosen) if (!everything.some((file) => file.id === id)) chosen.delete(id);
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    const now = Date.now();
    const found = everything.filter((file) => matches(file, query, titleOf));
    list.setAttribute('aria-busy', String(status === 'loading'));
    loading.textContent = status === 'loading' ? 'Loading files' : '';
    if (status === 'loading') {
      list.replaceChildren(...Array.from({ length: SKELETON_ROWS }, () => h('li', { class: 'file-row is-skeleton', 'aria-hidden': 'true' }, h('span', { class: 'skeleton-sheet' }), h('span', { class: 'skeleton-lines' }, h('span'), h('span')))));
    } else {
      list.replaceChildren(...found.map((file) => fileRow(file, {
        now, titleOf: titleOf,
        choosing: choosing ? { chosen: chosen.has(file.id), toggle: () => { if (chosen.has(file.id)) chosen.delete(file.id); else chosen.add(file.id); disarm(); paintList(); } } : undefined,
      })));
    }
    const nothing = status === 'ready' && everything.length === 0;
    const noMatch = status === 'ready' && everything.length > 0 && found.length === 0;
    state.hidden = !(status === 'failed' || nothing || noMatch);
    if (status === 'failed') state.replaceChildren(...stateBlock('Files could not be loaded.', '', h('button', { type: 'button', class: 'text-button', 'data-key': 'retry', onClick: () => files.retry() }, 'Try again')));
    else if (nothing) state.replaceChildren(...stateBlock('No files yet', 'Files you send in a chat, and files Jet writes for you, are kept here.'));
    else if (noMatch) state.replaceChildren(...stateBlock(`No file matches “${query.trim()}”.`, '', h('button', { type: 'button', class: 'text-button', 'data-key': 'clear', onClick: () => { search.value = ''; paintList(); search.focus(); } }, 'Clear search')));
    paintBar();
    if (focused) el.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  function paint() {
    if (!shown) return;
    paintUsage();
    paintList();
  }

  files.subscribe(paint);

  return {
    el,
    get choosing() { return choosing; },
    stopChoosing,
    paint,
    /** Shows the library. A phone gets the focus on the title, so its keyboard does not cover the list. */
    show({ narrow }) {
      shown = true;
      el.hidden = false;
      paint();
      (narrow ? title : search).focus({ preventScroll: true });
    },
    hide() {
      if (choosing) stopChoosing(true);
      shown = false;
      el.hidden = true;
    },
  };
}
