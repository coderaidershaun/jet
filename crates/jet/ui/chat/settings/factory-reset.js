// The admin's way to wipe the server back to a fresh install. The admin types the word RESET first, and the server
// checks the word again.

import { h } from '../../dom.js';
import { button, note, section } from './controls.js';

const WORD = 'RESET';
const WARNING = "This deletes every user's data on this server: chats, goals, tasks, files, notes, settings, apps, MCP servers and every sign-in. It cannot be undone. Everyone is signed out, and the demo accounts are set up again.";

/** @param {import('./window.js').SettingsContext} ctx */
export function buildFactoryReset({ onFactoryReset }) {
  const failure = h('p', { class: 'problem', role: 'alert' });
  const status = h('span', { class: 'status', role: 'status' });
  const word = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters' });
  const showAsk = () => {
    confirmBox.hidden = true;
    ask.hidden = false;
    word.value = '';
    run.disabled = true;
    status.textContent = '';
  };
  const restore = async () => {
    run.disabled = true;
    cancel.disabled = true;
    word.disabled = true;
    failure.textContent = '';
    status.textContent = 'Restoring…';
    try {
      await onFactoryReset(word.value);
    } catch (error) {
      failure.textContent = error && error.message ? error.message : 'Could not restore the server.';
      status.textContent = '';
      cancel.disabled = false;
      word.disabled = false;
      run.disabled = word.value !== WORD;
    }
  };
  const cancel = button('Cancel', { onClick: showAsk });
  const run = button('Delete everything', { class: 'action danger', disabled: true, onClick: restore });
  word.addEventListener('input', () => { run.disabled = word.value !== WORD; });
  const confirmBox = h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm restoring', hidden: true },
    h('p', { text: WARNING }),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Type ' + WORD + ' to confirm' }), word),
    h('div', { class: 'row-actions' }, cancel, run, status),
  );
  const ask = button('Restore this server', {
    class: 'action danger',
    onClick: () => {
      ask.hidden = true;
      confirmBox.hidden = false;
      word.focus();
    },
  });

  return {
    el: section('factory-reset', 'Restore to factory defaults', note('Wipe this server back to a fresh install.'), ask, confirmBox, failure),

    refresh() {
      failure.textContent = '';
      showAsk();
    },
  };
}
