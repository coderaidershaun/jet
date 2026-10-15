// The settings about how Jet looks and moves: body colour, behaviour presets,
// the expressiveness master and its channels, and reduced motion.

import { PRESETS, displayName } from '../../bridge/settings.js';
import { h } from '../../dom.js';
import { button, note, section, sliderField, switchRow, textField } from './controls.js';
import { hexToRgb, masterWord, moveMaster, presetFor, rgbToHex, setFollow, takeOverChannel } from './form.js';
import { named } from './names.js';

const SWATCHES = [
  ['Coral', '#ff6a3d'],
  ['Orange', '#ff8c42'],
  ['Pink', '#ff5c8a'],
  ['Violet', '#9b7bff'],
  ['Blue', '#4da3ff'],
  ['Green', '#3ddc97'],
];
const CHANNELS = [
  ['shape', 'Shape', 'how far it leaves the circle'],
  ['eyes', 'Eyes', 'how much face appears'],
  ['colour', 'Colour', 'how much it warms at the peak'],
  ['motion', 'Motion', 'anticipation, overshoot, lag, breathing'],
];

/** @param {import('./sheet.js').SheetContext} ctx */
export function buildLook(ctx) {
  return [colourSection(ctx), behaviourSection(ctx), expressivenessSection(ctx), motionSection(ctx)];
}

/** @param {import('./sheet.js').SheetContext} ctx */
function colourSection({ settings, changed, defaultColour }) {
  const current = () => settings.bodyColour ?? defaultColour;
  const problem = h('p', { class: 'problem', role: 'status', hidden: true, text: 'Use six hex digits, like #ff6a3d' });
  const hex = textField({
    label: 'Hex colour',
    value: rgbToHex(current()),
    onInput: (text) => {
      const rgb = hexToRgb(text);
      problem.hidden = rgb !== null;
      if (rgb) pick(rgb);
    },
  });

  const swatches = SWATCHES.map(([name, value]) => h('button', {
    type: 'button',
    class: 'swatch',
    'aria-label': name,
    'data-hex': value,
    onClick: () => {
      pick(hexToRgb(value));
      hex.set(value);
      problem.hidden = true;
    },
  }));
  for (const swatch of swatches) swatch.style.setProperty('--swatch', swatch.dataset.hex);
  const paintSwatches = () => {
    for (const swatch of swatches) swatch.setAttribute('aria-pressed', String(swatch.dataset.hex === rgbToHex(current())));
  };
  function pick(rgb) {
    settings.bodyColour = rgb;
    paintSwatches();
    changed('colour');
  }
  paintSwatches();

  const reset = button('', {
    onClick: () => {
      settings.bodyColour = null;
      hex.set(rgbToHex(defaultColour));
      problem.hidden = true;
      paintSwatches();
      changed('colour');
    },
  });
  named(reset, "Reset to {name}'s coral", displayName(settings));
  return section('look', 'Look', h('div', { class: 'swatches' }, ...swatches), hex.el, problem, reset);
}

/** @param {import('./sheet.js').SheetContext} ctx */
function behaviourSection({ settings, changed }) {
  const chips = PRESETS.map((preset) => h('button', {
    type: 'button',
    class: 'chip',
    'data-name': preset.name,
    text: preset.name,
    onClick: () => {
      settings.behaviour = { candid: preset.candid, playful: preset.playful };
      paintChips();
      changed('behaviour');
    },
  }));
  const customChip = h('button', { type: 'button', class: 'chip', text: 'Custom', disabled: true });
  function paintChips() {
    const match = presetFor(settings.behaviour);
    for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.name === match));
    customChip.hidden = match !== 'Custom';
    customChip.setAttribute('aria-pressed', 'true');
  }
  paintChips();
  const labLink = h('a', { class: 'lab-link', href: './lab.html', text: 'Fine-tune in the lab' });
  return section('behaviour', 'Behaviour', h('div', { class: 'chips' }, ...chips, customChip), labLink);
}

/** @param {import('./sheet.js').SheetContext} ctx */
function expressivenessSection({ settings, changed }) {
  const master = sliderField({
    label: 'Master',
    min: 0,
    max: 10,
    step: 0.1,
    value: settings.expressiveness.master,
    format: (v) => v.toFixed(1) + ' · ' + masterWord(v),
    onInput: (value) => {
      settings.expressiveness = moveMaster(settings.expressiveness, value);
      paintChannels();
      changed('expressiveness');
    },
  });
  const rows = CHANNELS.map(([name, label, hint]) => {
    const slider = sliderField({
      label,
      hint,
      min: 0,
      max: 10,
      step: 0.1,
      value: settings.expressiveness.channels[name],
      format: (v) => v.toFixed(1),
      onInput: (value) => {
        settings.expressiveness = takeOverChannel(settings.expressiveness, name, value);
        paintChannels();
        changed('expressiveness');
      },
    });
    const follow = switchRow({
      label: 'Follows master',
      checked: settings.expressiveness.follow[name],
      onChange: (on) => {
        settings.expressiveness = setFollow(settings.expressiveness, name, on);
        paintChannels();
        changed('expressiveness');
      },
    });
    return { name, slider, follow };
  });
  function paintChannels() {
    const { channels, follow } = settings.expressiveness;
    master.set(settings.expressiveness.master);
    for (const row of rows) {
      row.slider.set(channels[row.name]);
      row.follow.input.checked = follow[row.name];
    }
  }
  return section('expressiveness', 'Expressiveness', master.el, ...rows.flatMap((row) => [row.slider.el, row.follow.el]));
}

/** @param {import('./sheet.js').SheetContext} ctx */
function motionSection({ settings, changed, systemReducesMotion }) {
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
