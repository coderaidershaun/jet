// The settings about Claude Code itself: where to find it, and the one
// destructive button, which forgets the conversation after a confirmation.

import { h } from '../dom.js';
import { button, note, section, textField } from './controls.js';

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildClaude({ settings, agent, changed, onClaudeChecked, onForget }) {
  const status = h('p', { class: 'status', role: 'status' });
  const path = textField({
    label: 'Path to claude',
    value: settings.claudePath ?? '',
    placeholder: 'Found automatically',
    onInput: (text) => {
      settings.claudePath = text.trim() === '' ? null : text.trim();
      changed('claude');
    },
  });

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
    h('p', { text: "Clears the thread and starts a fresh Claude Code session. Jet's memory notes are kept." }),
    h('div', { class: 'row-actions' }, cancel, button('Forget', { class: 'action danger', onClick: forget })),
  );
  const ask = button('Forget this conversation', {
    class: 'action danger',
    onClick: () => {
      ask.hidden = true;
      confirmBox.hidden = false;
      cancel.focus();
    },
  });

  return {
    el: [
      section('claude', 'Claude Code', path.el, status),
      section('forget', 'Forget this conversation', note('Start again with an empty thread.'), ask, confirmBox, failure),
    ],

    /** Asks where Claude Code is, and shows the answer here and in the page's banner. */
    async refresh() {
      try {
        const { claude } = await agent.status();
        status.textContent = claude.found ? 'Found at ' + claude.path : 'Not found. Looked in ' + claude.searched.join(', ');
        status.dataset.found = String(claude.found);
        onClaudeChecked(claude);
      } catch (error) {
        status.textContent = 'Could not check: ' + (error && error.message ? error.message : error);
      }
    },
  };
}
