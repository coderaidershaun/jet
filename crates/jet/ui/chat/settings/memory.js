// The three notes Jet keeps between conversations, as editors. Each saves on
// its own button. When the notes change behind the editor's back, edits that
// were not saved are kept and a reload is offered instead.

import { displayName } from '../../bridge/settings.js';
import { h } from '../../dom.js';
import { button, section } from './controls.js';
import { countCodePoints } from './form.js';
import { named } from './names.js';

const NOTES = [
  ['memory', 'MEMORY.md', 'Ongoing work, decisions and things {name} agreed to do'],
  ['user', 'USER.md', 'Who you are and how you like to work'],
  ['recent', 'RECENT.md', 'What the last conversation was about'],
];

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildMemory({ agent, settings }) {
  /** @type {Record<string, string>} */
  let saved = { memory: '', user: '', recent: '' };
  /** @type {Record<string, number> | null} Sent by the server with the notes; until then nothing is capped. */
  let limits = null;

  const editors = NOTES.map(([key, file, hint]) => {
    const area = h('textarea', { class: 'mono', rows: 6, spellcheck: 'false', 'aria-label': file });
    const counter = h('span', { class: 'counter' });
    const status = h('span', { class: 'status', role: 'status' });
    const reload = button('Reload', { hidden: true });
    const save = button('Save', { disabled: true });
    const dirty = () => area.value !== saved[key];
    const paint = () => {
      const used = countCodePoints(area.value);
      const limit = limits ? limits[key] : Infinity;
      counter.textContent = used + (limits ? ' / ' + limit : '');
      counter.classList.toggle('over', used > limit);
      save.disabled = !dirty() || used > limit;
    };
    area.addEventListener('input', () => { status.textContent = ''; paint(); });
    save.addEventListener('click', async () => {
      try {
        const notes = await agent.saveMemory({ ...saved, [key]: area.value });
        saved = { memory: notes.memory, user: notes.user, recent: notes.recent };
        status.textContent = 'Saved';
      } catch (error) {
        status.textContent = 'Could not save: ' + (error && error.message ? error.message : error);
      }
      paint();
    });
    reload.addEventListener('click', () => {
      area.value = saved[key];
      reload.hidden = true;
      paint();
    });
    const top = h('span', { class: 'field-top' }, h('span', { class: 'field-label', text: file }), counter);
    const actions = h('div', { class: 'row-actions' }, save, reload, status);
    const el = h('div', { class: 'field' }, top, named(h('span', { class: 'help' }), hint, displayName(settings)), area, actions);
    return { key, area, reload, paint, el, dirty };
  });

  function take(notes) {
    const unsaved = editors.map((editor) => editor.dirty());
    saved = { memory: notes.memory, user: notes.user, recent: notes.recent };
    if (notes.limits) limits = notes.limits;
    editors.forEach((editor, i) => {
      editor.reload.hidden = !unsaved[i];
      if (!unsaved[i]) editor.area.value = saved[editor.key];
      editor.paint();
    });
  }

  agent.onMemoryUpdated(take);

  return {
    el: section('memory', 'Memory', ...editors.map((editor) => editor.el)),

    /** Loads the notes each time the sheet opens. */
    async refresh() {
      try {
        take(await agent.loadMemory());
      } catch (error) {
        console.warn('the memory notes could not be loaded:', error);
      }
    },
  };
}
