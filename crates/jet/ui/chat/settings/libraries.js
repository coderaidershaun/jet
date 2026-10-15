// The settings for the two libraries Jet's Claude may use: whether each is on, its
// program and the folder it runs in. Jet keeps one copy of each running, so the sheet
// tells the page when a change needs the copies looked at again.

import { note, section, switchRow, textField } from './controls.js';

const LIBRARIES = [
  ['quanty', 'Quant finance books and papers'],
  ['polysim', 'Your trading engines'],
];

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildLibraries({ settings, changed }) {
  // Each edit looks the library up when it happens, not when the section is built, so it
  // changes the entry the settings hold now.
  const fields = LIBRARIES.flatMap(([name, help]) => [
    switchRow({
      label: name,
      note: help,
      checked: settings.mcp[name].enabled,
      onChange: (checked) => {
        settings.mcp[name].enabled = checked;
        changed('libraries');
      },
    }).el,
    textField({
      label: name + ' program',
      value: settings.mcp[name].command,
      onInput: (text) => {
        settings.mcp[name].command = text.trim();
        changed('library-path');
      },
    }).el,
    textField({
      label: name + ' folder',
      value: settings.mcp[name].cwd ?? '',
      placeholder: "Claude's folder",
      onInput: (text) => {
        settings.mcp[name].cwd = text.trim() || null;
        changed('library-path');
      },
    }).el,
  ]);
  return section(
    'libraries',
    'Libraries',
    note('Jet keeps one copy of each library running while the app is open. A switch takes effect at once; a program or folder takes effect when you close Settings. Changing polysim, or switching it off, restarts it, and every engine it started stops.'),
    ...fields,
  );
}
