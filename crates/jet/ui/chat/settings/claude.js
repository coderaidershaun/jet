import { displayName } from '../../bridge/settings.js';
import { h } from '../../dom.js';
import { button, note, section, textField } from './controls.js';
import { named } from './names.js';

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

  const codexPath = textField({
    label: 'Path to codex', value: settings.codexPath ?? '', placeholder: 'Found automatically',
    onInput: (text) => { settings.codexPath = text.trim() || null; changed('claude'); },
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
    named(h('p'), "Clears the thread and starts a fresh agent session. {name}'s memory notes are kept.", displayName(settings)),
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
      section('claude', 'Agent programs', codexPath.el, path.el, status),
      section('forget', 'Forget this conversation', note('Start again with an empty thread.'), ask, confirmBox, failure),
    ],

    /** Asks where the selected agent is, and shows the answer here and in the page's banner. */
    async refresh() {
      try {
        const { claude: program } = await agent.status();
        status.textContent = program.found ? (program.provider ?? 'Agent') + ' found at ' + program.path : 'Not found. Looked in ' + program.searched.join(', ');
        status.dataset.found = String(program.found);
        onClaudeChecked(program);
      } catch (error) {
        status.textContent = 'Could not check: ' + (error && error.message ? error.message : error);
      }
    },
  };
}
