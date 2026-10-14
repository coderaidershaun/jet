// The settings for the workstation: where polysim-bridge and the polysim folder
// are, the strategy it shows, the engines it links to and their token.

import { note, section, textField } from './controls.js';

const NOT_SET_UP = { bridgePath: null, polysimDir: null, strategyId: '', links: [], token: null };

const orNull = (text) => text.trim() || null;
const splitList = (text) => text.split(',').map((part) => part.trim()).filter(Boolean);

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildWorkstation({ settings, changed }) {
  // SMELL: once the defaults carry a workstation block this never runs; remove it then.
  settings.workstation ??= { ...NOT_SET_UP, links: [] };

  const field = ({ key, label, value, placeholder, toSetting }) => textField({
    label,
    value,
    placeholder,
    onInput: (text) => {
      settings.workstation[key] = toSetting(text);
      changed('workstation');
    },
  }).el;
  const { bridgePath, polysimDir, strategyId, links, token } = settings.workstation;
  return section(
    'workstation',
    'Workstation',
    field({ key: 'bridgePath', label: 'Path to polysim-bridge', value: bridgePath ?? '', placeholder: 'Not set', toSetting: orNull }),
    field({ key: 'polysimDir', label: 'Polysim folder', value: polysimDir ?? '', placeholder: 'Not set', toSetting: orNull }),
    field({ key: 'strategyId', label: 'Strategy', value: strategyId, placeholder: 'strat-micro-recorder', toSetting: (text) => text.trim() }),
    field({ key: 'links', label: 'Engine links', value: links.join(', '), placeholder: '127.0.0.1:9310', toSetting: splitList }),
    field({ key: 'token', label: 'Link token', value: token ?? '', placeholder: 'None', toSetting: orNull }),
    note('Engine links are host:port, separated by commas. The workstation starts again with these a moment after an edit.'),
  );
}
