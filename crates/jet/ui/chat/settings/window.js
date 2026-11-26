// The settings window: a modal over the page with a menu of sections on its left and the chosen section on its
// right. Every change saves itself a moment after editing pauses.

import { displayName } from '../../bridge/settings.js';
import { h, icon } from '../../dom.js';
import { paintNames } from './names.js';
import { SECTIONS } from './sections.js';

const SAVE_AFTER_EDIT_MS = 600;
const PROGRAM_SECTION = 'claude';
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * @typedef {object} SettingsContext
 * @property {import('../../bridge/settings.js').Settings} settings   edited in place
 * @property {*} agent   what the page talks to the agent through
 * @property {boolean} isAdmin   only an admin sees and sets the program paths
 * @property {(kind: string) => void} changed   tell the page what changed; saving follows
 * @property {{ matches: boolean, addEventListener: (type: 'change', listener: () => void) => void }} systemMotion   the system's reduced-motion query
 * @property {(claude: import('../../bridge/agent.js').ClaudeStatus) => void} onClaudeChecked   the page's banner follows each check
 * @property {() => Promise<void>} onForget
 * @property {() => string} [chatTitle]   the title of the open chat, which Forget clears
 */

/** A hidden element, or one inside a hidden one, has no offset parent. */
const isShown = (el) => el.offsetParent !== null;

/**
 * @param {{
 *   dialog: HTMLDialogElement, context: Omit<SettingsContext, 'changed'>, onChange: (kind: string) => void,
 *   save: () => Promise<void>, sections?: readonly import('./sections.js').SettingsSection[],
 * }} options
 */
export function createSettingsWindow({ dialog, context, onChange, save, sections = SECTIONS }) {
  const ids = sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) throw new Error('settings: two sections share an id in ' + ids.join(', '));

  let saveTimer = 0;
  let needsProgramCheck = false;
  let opener = null;
  let current = ids[0];
  const saveError = h('p', { class: 'settings-save-error', role: 'alert' });
  // There is no Save button: every change saves itself a moment after the user stops typing, and this line says so.
  const saved = h('p', { class: 'settings-saved', role: 'status', text: 'Changes save as you type' });

  // The Rust side reads the saved model and program paths, so changes are checked only after saving.
  const saveEdits = async () => {
    const checkProgram = needsProgramCheck;
    needsProgramCheck = false;
    try {
      await save();
      saveError.textContent = '';
      saved.textContent = 'Saved';
      if (checkProgram) refresh(entryOf(PROGRAM_SECTION));
    } catch (error) {
      needsProgramCheck ||= checkProgram;
      saved.textContent = 'Not saved';
      saveError.textContent = 'Settings could not be saved: ' + (error.message ?? String(error));
    }
  };
  const changed = (kind) => {
    onChange(kind);
    if (kind === 'persona') paintNames(pane, displayName(ctx.settings));
    if (kind === 'claude' || kind === 'model') needsProgramCheck = true;
    clearTimeout(saveTimer);
    saved.textContent = 'Saving…';
    saveTimer = setTimeout(saveEdits, SAVE_AFTER_EDIT_MS);
  };
  const ctx = { ...context, changed };

  const entries = sections.map(({ id, label, build, savesWithButtons = false }) => {
    const { el, refresh: refreshSection = () => {} } = build(ctx);
    const panelId = 'settings-' + id;
    const panel = h('div', { class: 'settings-panel', id: panelId, tabindex: '-1', hidden: true }, el);
    const button = h('button', { class: 'settings-entry', type: 'button', 'aria-controls': panelId, text: label });
    button.addEventListener('click', () => {
      choose(id);
      showSection();
    });
    return { id, label, panel, button, refreshSection, savesWithButtons };
  });
  const entryOf = (id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error('settings: no section "' + id + '"; the sections are ' + ids.join(', '));
    return entry;
  };
  const refresh = (entry) => {
    Promise.resolve(entry.refreshSection()).catch((error) => {
      saveError.textContent = entry.label + ' could not load: ' + (error?.message ?? String(error));
    });
  };

  const menu = h('ul', { class: 'settings-menu' }, ...entries.map((entry) => h('li', {}, entry.button)));
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' }, menu);
  const pane = h('div', { class: 'settings-pane' }, saveError, ...entries.map((entry) => entry.panel));
  const back = h('button', { class: 'icon-button settings-back', type: 'button', 'aria-label': 'All settings' }, icon('chevron'));
  const closeButton = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close settings' }, icon('close'));
  const head = h('header', { class: 'settings-head' }, back, h('h2', { id: 'settings-title', text: 'Settings' }), saved, closeButton);
  dialog.append(h('div', { class: 'settings-frame' }, head, h('div', { class: 'settings-body' }, nav, pane)));

  function choose(id) {
    current = entryOf(id).id;
    saved.hidden = entryOf(id).savesWithButtons;
    for (const entry of entries) {
      const chosen = entry.id === current;
      entry.panel.hidden = !chosen;
      if (chosen) entry.button.setAttribute('aria-current', 'true');
      else entry.button.removeAttribute('aria-current');
    }
    pane.scrollTop = 0;
  }
  // On a narrow window the menu and the section take turns; on a wide one the stylesheet shows both.
  function showSection() {
    dialog.dataset.view = 'section';
    const { button, panel } = entryOf(current);
    (isShown(button) ? button : panel).focus();
  }
  function showMenu() {
    dialog.dataset.view = 'menu';
    entryOf(current).button.focus();
  }

  menu.addEventListener('keydown', (event) => {
    const focused = entries.findIndex((entry) => entry.button === event.target);
    const at = focused === -1 ? ids.indexOf(current) : focused;
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: ids.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(ids[(next + ids.length) % ids.length]);
    entryOf(current).button.focus();
  });
  back.addEventListener('click', showMenu);
  closeButton.addEventListener('click', () => settingsWindow.close());
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    settingsWindow.close();
  });
  // Only a press that starts and ends on the backdrop closes the window, so a text selection dragged out of a field does not.
  let pressedBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => { pressedBackdrop = event.target === dialog; });
  dialog.addEventListener('click', (event) => {
    if (pressedBackdrop && event.target === dialog) settingsWindow.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') keepTabInside(event);
  });
  dialog.addEventListener('close', () => {
    dialog.classList.remove('open');
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  });
  // The stylesheet decides how long the window takes to leave: a short fade, or none.
  const leaveMs = () => parseFloat(getComputedStyle(dialog).transitionDuration) * 1000 || 0;

  // Chrome lets Tab leave a modal dialog for the browser's own toolbar, so the last control wraps to the first.
  function keepTabInside(event) {
    const stops = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.tabIndex >= 0 && isShown(el));
    if (stops.length === 0) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const settingsWindow = {
    get isOpen() {
      return dialog.open && dialog.classList.contains('open');
    },

    /** @param {string} [sectionId]   opens on that section, e.g. "claude"; without one, on the menu and the last section chosen */
    open(sectionId) {
      if (!dialog.open) opener = document.activeElement;
      choose(sectionId ?? current);
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => dialog.classList.add('open'));
      for (const entry of entries) refresh(entry);
      if (sectionId) showSection();
      else showMenu();
    },

    close() {
      if (!dialog.open) return;
      dialog.classList.remove('open');
      setTimeout(() => dialog.close(), leaveMs());
    },
  };
  return settingsWindow;
}
