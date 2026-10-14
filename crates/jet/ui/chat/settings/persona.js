// The settings about who Jet is: its name, job title and how it should talk.

import { displayName } from '../../bridge/settings.js';
import { countCodePoints } from './form.js';
import { named } from './names.js';
import { note, section, textField } from './controls.js';

const NAME_LIMIT = 24;
const TITLE_LIMIT = 32;
const NOTES_LIMIT = 600;
const NOTES_TEXT = 'How should {name} talk to you?';

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
  const notes = field('notes', NOTES_TEXT, NOTES_LIMIT, 4);
  named(notes.querySelector('.field-label'), NOTES_TEXT, displayName(settings));
  return section(
    'persona',
    'Persona',
    field('name', 'Name', NAME_LIMIT),
    field('jobTitle', 'Job title', TITLE_LIMIT),
    notes,
    note('Changes apply to the next conversation.'),
  );
}
