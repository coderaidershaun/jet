// The engine that hears the user, how Phonon-2 decodes, and the engine that speaks Jet's replies. An engine that
// cannot hear or speak right now is greyed out with the reason, and a note says which engine does instead.

import { h } from '../../dom.js';
import { HEARING, SPEAKING, engineInUse, engineLabel, enginesOf } from '../voice/engines.js';
import { note, section } from './controls.js';

const MODES = Object.freeze([
  Object.freeze(['fast', 'Fast path']),
  Object.freeze(['exact', 'Exact decoding']),
  Object.freeze(['cpu', 'CPU only']),
]);

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildVoice({ settings, agent, changed }) {
  const mode = h('select', { 'aria-label': 'Phonon-2 mode' }, ...MODES.map(([value, text]) => h('option', { value, text })));
  const modeField = h('label', {}, h('span', { text: 'Phonon-2 mode' }), mode);
  mode.addEventListener('change', () => {
    settings.phonon2Mode = mode.value;
    changed('voice');
  });
  const input = picker({ way: HEARING, key: 'hearingEngine', id: 'voice', title: 'Voice input', label: 'Voice engine', field: 'Hears you with', settings, changed }, modeField);
  const output = picker({ way: SPEAKING, key: 'speakingEngine', id: 'voice-output', title: 'Voice output', label: 'Voice output engine', field: 'Speaks with', settings, changed });
  // The mode applies whenever Phonon-2 hears, also when it stands in for the engine the user chose.
  const paintMode = () => {
    mode.value = settings.phonon2Mode;
    modeField.hidden = input.inUse() !== 'phonon2';
  };
  input.onPaint = paintMode;
  paintMode();

  const el = document.createDocumentFragment();
  el.append(input.el, output.el);
  return {
    el,
    async refresh() {
      let status;
      try {
        status = await agent.voiceStatus();
      } catch (error) {
        console.warn('the voice status could not be read:', error);
      }
      input.paint(enginesOf(HEARING, status?.hear));
      output.paint(enginesOf(SPEAKING, status?.speak));
    },
  };
}

/** One section with a select of the engines of one way, the engine in use, and why the others cannot work. */
function picker({ way, key, id, title, label, field, settings, changed }, ...extra) {
  let engines = enginesOf(way, undefined);
  const options = way.ids.map((engine) => h('option', { value: engine, text: engineLabel(engine) }));
  const select = h('select', { 'aria-label': label }, ...options);
  const reasons = h('div', { class: 'reasons' });
  const inUseNote = h('p', { class: 'note in-use' });
  const self = {
    el: section(id, title, h('div', { class: 'voice-picker' }, h('label', {}, h('span', { text: field }), select), ...extra), inUseNote, reasons),
    onPaint: () => {},
    inUse: () => engineInUse(way, settings[key], engines),
    paint(latest = engines) {
      engines = latest;
      for (const option of options) {
        const { available } = engines[option.value];
        option.disabled = !available;
        option.textContent = engineLabel(option.value) + (available ? '' : ' (unavailable)');
      }
      select.value = settings[key];
      const unavailable = way.ids.filter((engine) => !engines[engine].available);
      reasons.replaceChildren(...unavailable.map((engine) => note(`${engineLabel(engine)}: ${engines[engine].reason ?? 'unavailable'}`)));
      const working = self.inUse();
      if (working === null) inUseNote.textContent = `No engine can ${way.verb} right now, so the ${way.button} is off.`;
      else if (working !== settings[key]) inUseNote.textContent = `${engineLabel(settings[key])} cannot ${way.verb} right now, so Jet ${way.uses} ${engineLabel(working)}.`;
      else inUseNote.textContent = '';
      inUseNote.hidden = inUseNote.textContent === '';
      self.onPaint();
    },
  };
  select.addEventListener('change', () => {
    settings[key] = select.value;
    self.paint();
    changed('voice');
  });
  self.paint();
  return self;
}
