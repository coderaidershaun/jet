import { note, section, switchRow } from './controls.js';

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildMotion({ settings, changed, systemReducesMotion }) {
  // SMELL: the system setting is read once, when the sheet is built. If it changes while the page is open, Jet
  // follows the change but this switch keeps its old state and note until the page reloads.
  const systemReduces = systemReducesMotion();
  const motion = switchRow({
    label: 'Reduced motion',
    checked: settings.reducedMotion || systemReduces,
    note: systemReduces ? 'On because your system asks for it' : 'Jet stops zooming and holds still',
    onChange: (on) => {
      settings.reducedMotion = on;
      changed('motion');
    },
  });
  motion.input.disabled = systemReduces;
  return section('motion', 'Motion', motion.el, note('Reduced motion also makes panels fade instead of slide.'));
}
