// Two sections: where the agent programs are, with the admin-only paths to them, and forgetting the open chat.

import { displayName } from '../../bridge/settings.js';
import { h } from '../../dom.js';
import { button, note, section, textField } from './controls.js';
import { named } from './names.js';

/** @param {import('./window.js').SettingsContext} ctx */
export function buildPrograms({ settings, agent, isAdmin, changed, onClaudeChecked }) {
  const status = h('p', { class: 'status', role: 'status' });
  const pathField = (key, label) => textField({
    label,
    value: settings[key] ?? '',
    placeholder: 'Found automatically',
    onInput: (text) => {
      settings[key] = text.trim() === '' ? null : text.trim();
      changed('claude');
    },
  }).el;
  // Whoever sets a path chooses the program the server runs, so only an admin gets the fields.
  const paths = isAdmin ? [pathField('codexPath', 'Path to codex'), pathField('agyPath', 'Path to agy'), pathField('claudePath', 'Path to claude')] : [];

  return {
    el: section('claude', 'Agent programs', ...paths, status),

    /** Asks where the selected agent is, and shows the answer here and in the page's banner. */
    async refresh() {
      try {
        const { program } = await agent.status();
        status.textContent = programStatus(program);
        status.dataset.found = String(program.found);
        onClaudeChecked(program);
      } catch (error) {
        status.textContent = 'Could not check: ' + (error && error.message ? error.message : error);
      }
    },
  };
}

/** @param {import('./window.js').SettingsContext} ctx */
export function buildForget({ settings, onForget, chatTitle = () => '' }) {
  const failure = h('p', { class: 'problem', role: 'alert' });
  const showAsk = () => {
    confirmBox.hidden = true;
    ask.hidden = false;
  };
  const forget = async () => {
    try {
      await onForget();
      showAsk();
      failure.textContent = '';
    } catch (error) {
      failure.textContent = error && error.message ? error.message : 'Could not forget the conversation.';
    }
  };
  const cancel = button('Cancel', { onClick: showAsk });
  const confirmBox = h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm forgetting', hidden: true },
    named(h('p'), "Clears the thread and starts a fresh agent session. {name}'s memory notes are kept.", displayName(settings)),
    h('div', { class: 'row-actions' }, cancel, button('Forget', { class: 'action danger', onClick: forget })),
  );
  const ask = button('Forget this chat', {
    class: 'action danger',
    onClick: () => {
      ask.hidden = true;
      confirmBox.hidden = false;
      cancel.focus();
    },
  });

  return {
    el: section('forget', 'Forget this conversation', note('Start again with an empty thread.'), ask, confirmBox, failure),

    refresh() {
      // The user has many chats, so the button names the one it clears.
      const title = chatTitle();
      ask.textContent = title ? 'Forget “' + title + '”' : 'Forget this chat';
      showAsk();
    },
  };
}

/** A non-admin's status has no path and no list of places searched. */
function programStatus({ provider, found, path, searched }) {
  const name = provider ?? 'Agent';
  if (found) return path ? name + ' found at ' + path : name + ' found';
  return searched ? 'Not found. Looked in ' + searched.join(', ') : name + ' was not found on the server. Ask an admin to set where it is.';
}
