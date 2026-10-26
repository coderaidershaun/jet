import { h } from '../../dom.js';
import { note, section } from './controls.js';

import { isCodex } from '../../bridge/models.js';
import { modelPicker } from './model-picker.js';

export function buildModel({ settings, changed }) {
  const picker = modelPicker(settings, (kind) => { budgetField.hidden = isCodex(settings.model); changed(kind); });
  const budget = h('input', { type: 'number', min: '0.1', step: '0.25', inputmode: 'decimal' });
  budget.value = settings.turnBudgetUsd.toFixed(2);
  budget.addEventListener('change', () => {
    const value = Number(budget.value);
    if (Number.isFinite(value) && value > 0) settings.turnBudgetUsd = value;
    else budget.value = settings.turnBudgetUsd.toFixed(2);
    changed('model');
  });
  const budgetField = h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Budget per turn (USD)' }), budget);

  const appliesNote = note('Changes apply to the next reply. Codex memory review uses GPT-6 Luna; Claude uses Haiku. Codex reports tokens, but does not provide a dollar budget limit.');
  budgetField.hidden = isCodex(settings.model);
  return {
    el: section('model', 'Model and thinking', picker.el, budgetField, appliesNote),
    refresh() { picker.refresh(); budgetField.hidden = isCodex(settings.model); },
  };
}
