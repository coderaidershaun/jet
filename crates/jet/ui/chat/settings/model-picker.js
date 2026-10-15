import { h } from '../../dom.js';
import { MODELS, isCodex, effortsFor } from '../../bridge/models.js';

export function modelPicker(settings, changed) {
  const model = h('select', { 'aria-label': 'Model' });
  for (const [provider, isCodexProvider] of [['Codex', true], ['Claude', false]]) {
    const options = MODELS
      .filter(([id]) => isCodex(id) === isCodexProvider)
      .map(([id, label]) => h('option', { value: id, text: label }));
    model.append(h('optgroup', { label: provider }, ...options));
  }
  const effort = h('select', { 'aria-label': 'Thinking level' });
  const refresh = () => {
    model.value = settings.model;
    const options = effortsFor(settings.model).map((value) => {
      const text = value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1);
      return h('option', { value, text });
    });
    effort.replaceChildren(...options);
    effort.value = settings.effort;
  };
  model.addEventListener('change', () => {
    settings.model = model.value;
    if (!effortsFor(settings.model).includes(settings.effort)) settings.effort = 'high';
    refresh();
    changed('model');
  });
  effort.addEventListener('change', () => {
    settings.effort = effort.value;
    changed('model');
  });
  refresh();
  return {
    el: h('div', { class: 'model-picker' },
      h('label', {}, h('span', { text: 'Model' }), model),
      h('label', {}, h('span', { text: 'Thinking' }), effort),
    ),
    refresh,
  };
}
