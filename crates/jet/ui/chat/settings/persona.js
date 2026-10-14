// The settings about who Jet is: its name, job title and how it should talk.

import { countCodePoints } from './form.js';
import { note, section, textField } from './controls.js';

const NAME_LIMIT = 24;
const TITLE_LIMIT = 32;
const NOTES_LIMIT = 600;

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildPersona({ settings, changed }) {
  const field = (key, label, maxLength, lines = 1) => textField({
    label,
    value: settings.persona[key],
    maxLength,
    lines,
    count: countCodePoints,
    onInput: (text) => {
      settings.persona[key] = text;
      changed('persona');
    },
  }).el;
  return section(
    'persona',
    'Persona',
    field('name', 'Name', NAME_LIMIT),
    field('jobTitle', 'Job title', TITLE_LIMIT),
    field('notes', 'How should Jet talk to you?', NOTES_LIMIT, 4),
    note('Changes apply to the next conversation.'),
  );
}
