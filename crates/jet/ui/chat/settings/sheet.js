// The settings sheet: a dialog that slides in from the right (or up from the
// bottom on a phone), holds the nine sections, and saves a short while after
// the last edit.

import { displayName } from '../../bridge/settings.js';
import { h, icon } from '../dom.js';
import { buildClaude } from './claude.js';
import { buildLook } from './look.js';
import { buildMemory } from './memory.js';
import { buildModel } from './model.js';
import { paintNames } from './names.js';
import { buildPersona } from './persona.js';

const SAVE_AFTER_EDIT_MS = 600;

/**
 * @typedef {object} SheetContext
 * @property {import('../../bridge/settings.js').Settings} settings   edited in place
 * @property {*} agent   what the page talks to Claude through
 * @property {(kind: string) => void} changed   tell the page what changed; saving follows
 * @property {number[]} defaultColour   the rig's own rest colour
 * @property {() => import('../drawer/usage.js').UsageTotals} totals   what the replies since the app started have used, read on each refresh
 * @property {() => boolean} systemReducesMotion   true when the system asks for less motion
 * @property {(claude: import('../../bridge/agent.js').ClaudeStatus) => void} onClaudeChecked   the page's banner follows each check
 * @property {() => Promise<void>} onForget
 */

/**
 * @param {{ dialog: HTMLDialogElement, context: Omit<SheetContext, 'changed'>, onChange: (kind: string) => void, save: () => Promise<void> }} options
 */
export function createSheet({ dialog, context, onChange, save }) {
  let saveTimer = 0;
  let claudePathEdited = false;
  let opener = null;
  // The Rust side looks for Claude Code at the saved path, so a new path is checked only after its save.
  const saveEdits = async () => {
    const recheckClaude = claudePathEdited;
    claudePathEdited = false;
    await save();
    if (recheckClaude) claude.refresh();
  };
  const changed = (kind) => {
    onChange(kind);
    if (kind === 'persona') paintNames(body, displayName(ctx.settings));
    if (kind === 'claude') claudePathEdited = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveEdits, SAVE_AFTER_EDIT_MS);
  };
  const ctx = { ...context, changed };
  // The stylesheet decides how long the sheet takes to leave: a slide, a longer slide on a phone, or a fade.
  const leaveMs = () => parseFloat(getComputedStyle(dialog).transitionDuration) * 1000 || 0;

  const model = buildModel(ctx);
  const memory = buildMemory(ctx);
  const claude = buildClaude(ctx);
  const body = h('div', { class: 'sheet-body' }, buildPersona(ctx), ...buildLook(ctx), model.el, memory.el, ...claude.el);

  const closeButton = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close settings', onClick: () => sheet.close() }, icon('close'));
  dialog.append(h('header', { class: 'sheet-head' }, h('h2', { id: 'sheet-title', text: 'Settings' }), closeButton), body);

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    sheet.close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) sheet.close();
  });

  const sheet = {
    get isOpen() {
      return dialog.open && dialog.classList.contains('open');
    },

    /** @param {string} [sectionId]   scrolls to that section, e.g. "claude" */
    open(sectionId) {
      opener = document.activeElement;
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => dialog.classList.add('open'));
      model.refresh();
      memory.refresh();
      claude.refresh();
      if (sectionId) {
        const target = body.querySelector('#section-' + sectionId);
        if (target) target.scrollIntoView({ block: 'start' });
      }
    },

    close() {
      if (!dialog.open) return;
      dialog.classList.remove('open');
      setTimeout(() => {
        dialog.close();
        if (opener instanceof HTMLElement) opener.focus();
      }, leaveMs());
    },
  };
  return sheet;
}
