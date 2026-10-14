// The settings about how Claude is asked: which model, how hard it thinks, the
// budget for one turn, and what this page session has used so far.

import { h } from '../dom.js';
import { note, section, segmented } from './controls.js';

const MODELS = [
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildModel({ settings, changed, totals }) {
  const pickModel = (value) => {
    settings.model = value;
    changed('model');
  };
  const pickEffort = (value) => {
    settings.effort = value;
    changed('model');
  };
  const model = segmented({ label: 'Model', options: MODELS, value: settings.model, onChange: pickModel });
  const effort = segmented({ label: 'Thinking', options: EFFORTS, value: settings.effort, onChange: pickEffort });

  const budget = h('input', { type: 'number', min: '0.1', step: '0.25', inputmode: 'decimal' });
  budget.value = settings.turnBudgetUsd.toFixed(2);
  budget.addEventListener('change', () => {
    const value = Number(budget.value);
    if (Number.isFinite(value) && value > 0) settings.turnBudgetUsd = value;
    else budget.value = settings.turnBudgetUsd.toFixed(2);
    changed('model');
  });
  const budgetField = h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Budget per turn (USD)' }), budget);

  const used = h('dl', { class: 'totals' });
  const paintTotals = () => {
    const rows = [
      ['Cost', '$' + totals.costUsd.toFixed(4)],
      ['Tokens', totals.tokens.toLocaleString('en-GB')],
      ['Cache reads', totals.cacheReadTokens.toLocaleString('en-GB')],
    ];
    used.replaceChildren(...rows.flatMap(([term, value]) => [h('dt', { text: term }), h('dd', { text: value })]));
  };
  paintTotals();

  const appliesNote = note('Applies to the next conversation. Memory review always uses Haiku.');
  return {
    el: section('model', 'Model and thinking', model.el, effort.el, budgetField, appliesNote, h('h4', { text: 'This session' }), used),
    refresh: paintTotals,
  };
}
