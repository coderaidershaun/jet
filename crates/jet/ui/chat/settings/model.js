import { h } from '../../dom.js';
import { note, section } from './controls.js';

import { providerOf } from '../../bridge/models.js';
import { modelPicker } from './model-picker.js';

export function buildModel({ settings, changed }) {
  const picker = modelPicker(settings, (kind) => { budgetField.hidden = providerOf(settings.model) !== 'Claude'; showNotes(); changed(kind); });
  const budget = h('input', { type: 'number', min: '0.1', step: '0.25', inputmode: 'decimal' });
  budget.value = settings.turnBudgetUsd.toFixed(2);
  budget.addEventListener('change', () => {
    const value = Number(budget.value);
    if (Number.isFinite(value) && value > 0) settings.turnBudgetUsd = value;
    else budget.value = settings.turnBudgetUsd.toFixed(2);
    changed('model');
  });
  const budgetField = h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Budget per turn (USD)' }), budget);

  const appliesNote = note('Changes apply to the next reply. Codex memory review uses GPT-6 Luna, agy uses Gemini 4 Neon, Claude uses Haiku. Codex and agy do not provide a dollar budget limit.');
  budgetField.hidden = providerOf(settings.model) !== 'Claude';
  const webNote = note('Codex cannot search or read the web in Jet. Choose a Claude model when you want Jet to look things up.');
  const agyWebNote = note('agy cannot search or read the web in Jet. Choose a Claude model when you want Jet to look things up.');
  const showNotes = () => { webNote.hidden = providerOf(settings.model) !== 'Codex'; agyWebNote.hidden = providerOf(settings.model) !== 'agy'; };
  showNotes();
  return {
    el: section('model', 'Model and thinking', picker.el, webNote, agyWebNote, budgetField, appliesNote),
    refresh() { picker.refresh(); budgetField.hidden = providerOf(settings.model) !== 'Claude'; showNotes(); },
  };
}
