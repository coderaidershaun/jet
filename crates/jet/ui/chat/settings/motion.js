// The reduced-motion switch. When the system asks for less motion the switch is on and locked, and it follows the
// system setting as it changes.

import { section, switchRow } from './controls.js';

const OWN_NOTE = 'Jet holds still, and panels fade instead of sliding';
const SYSTEM_NOTE = 'On because your system asks for it. Jet holds still, and panels fade';

/** @param {import('./window.js').SettingsContext} ctx */
export function buildMotion({ settings, changed, systemMotion }) {
  const motion = switchRow({
    label: 'Reduced motion',
    checked: false,
    note: OWN_NOTE,
    onChange: (on) => {
      settings.reducedMotion = on;
      changed('motion');
    },
  });
  const paint = () => {
    const systemReduces = systemMotion.matches;
    motion.input.checked = settings.reducedMotion || systemReduces;
    motion.input.disabled = systemReduces;
    motion.help.textContent = systemReduces ? SYSTEM_NOTE : OWN_NOTE;
  };
  systemMotion.addEventListener('change', paint);
  paint();
  return { el: section('motion', 'Motion', motion.el), refresh: paint };
}
