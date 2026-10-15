// The ladder's header: the unit toggle, the grouping combo and the level stepper. It is built once
// and only sends commands; the view the bridge sends back is what changes what it shows.

import { h } from '../../dom.js';
import { DEFAULT_LEVELS, groupingChoices, levelAt, levelFill, levelReadout, stepLevel } from './controls.js';

const UNITS = [
  { unit: 'ticks', label: 'Ticks', tip: 'Rows in ticks' },
  { unit: 'bps', label: 'bps', tip: 'Rows in basis points of the mid' },
];

function createUnitToggle(send) {
  let unit = null;
  const segments = UNITS.map(({ unit: segmentUnit, label, tip }) => h('button', {
    type: 'button',
    class: 'ladder-segment',
    'data-unit': segmentUnit,
    'aria-pressed': 'false',
    title: tip,
    onClick: () => {
      if (segmentUnit !== unit) send({ cmd: 'dom_unit', unit: segmentUnit });
    },
  }, label));

  return {
    element: h('div', { class: 'ladder-unit', role: 'group', 'aria-label': 'Ladder unit' }, ...segments),

    paint(view) {
      unit = view?.domUnit ?? null;
      for (const segment of segments) segment.setAttribute('aria-pressed', String(segment.dataset.unit === unit));
    },
  };
}

function createGroupingCombo(send) {
  let options = [];
  let optionsKey = null;
  const placeholder = h('option', { value: '', disabled: true, hidden: true }, '--');
  const select = h('select', {
    class: 'ladder-grouping',
    'aria-label': 'Row grouping',
    title: 'How much price each row covers',
    onChange: () => {
      const choice = options[Number(select.value)];
      if (choice) send(choice.command);
    },
  }, placeholder);

  return {
    element: h('div', { class: 'ladder-combo' }, select),

    paint(hello, view) {
      const choices = groupingChoices(hello?.groupings, view);
      options = choices.options;
      const key = (view?.domUnit ?? 'bps') + '|' + options.map((option) => option.label).join('|');
      if (key !== optionsKey) {
        optionsKey = key;
        select.replaceChildren(placeholder, ...options.map((option, index) => h('option', { value: String(index) }, option.label)));
      }
      select.value = choices.selected >= 0 ? String(choices.selected) : '';
    },
  };
}

function createLevelStepper(send) {
  let range = DEFAULT_LEVELS;
  let value = DEFAULT_LEVELS.default;
  // The level last sent, until a new view arrives: a drag sends each level once, not once per pointer move.
  let lastSent = null;

  const stepped = (by) => stepLevel(lastSent ?? value, by, range);
  function choose(level) {
    if (level === (lastSent ?? value)) return;
    lastSent = level;
    send({ cmd: 'dom_levels', levels: level });
  }
  const chooseAt = (event) => {
    const rect = track.getBoundingClientRect();
    choose(levelAt((event.clientX - rect.left) / rect.width, range));
  };
  const release = (event) => {
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };
  const levelForKey = {
    ArrowRight: () => stepped(1),
    ArrowUp: () => stepped(1),
    ArrowLeft: () => stepped(-1),
    ArrowDown: () => stepped(-1),
    Home: () => range.min,
    End: () => range.max,
  };

  const fill = h('span', { class: 'ladder-track-fill' });
  const capped = h('span', { class: 'ladder-capped', hidden: true });
  const levelValue = h('span', { class: 'ladder-value' });
  const track = h('div', {
    class: 'ladder-track',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Levels per side',
    title: 'Levels per side: click, drag or use the arrow keys',
    onPointerdown: (event) => {
      if (event.button !== 0) return;
      track.setPointerCapture(event.pointerId);
      chooseAt(event);
    },
    onPointermove: (event) => {
      if (track.hasPointerCapture(event.pointerId)) chooseAt(event);
    },
    onPointerup: release,
    onPointercancel: release,
    onKeydown: (event) => {
      const next = levelForKey[event.key];
      if (!next) return;
      event.preventDefault();
      choose(next());
    },
  }, fill, h('span', { class: 'ladder-track-text' }, capped, levelValue, h('span', { class: 'ladder-label' }, 'LVL')));

  return {
    element: h('div', { class: 'ladder-levels', role: 'group', 'aria-label': 'Levels per side' },
      h('button', { type: 'button', class: 'ladder-step', 'aria-label': 'Fewer levels', title: 'Fewer levels per side', onClick: () => choose(stepped(-1)) }, '-'),
      track,
      h('button', { type: 'button', class: 'ladder-step', 'aria-label': 'More levels', title: 'More levels per side', onClick: () => choose(stepped(1)) }, '+'),
    ),

    paint(hello, view, fit) {
      lastSent = null;
      range = hello?.levels ?? DEFAULT_LEVELS;
      value = view?.domLevels ?? range.default;
      const reading = levelReadout(value, fit);
      track.setAttribute('aria-valuemin', String(range.min));
      track.setAttribute('aria-valuemax', String(range.max));
      track.setAttribute('aria-valuenow', String(value));
      track.setAttribute('aria-valuetext', reading.capped === null ? reading.value : reading.value + ', ' + fit + ' fit');
      track.style.setProperty('--ladder-fill', String(levelFill(value, range)));
      levelValue.textContent = reading.value;
      capped.textContent = reading.capped ?? '';
      capped.hidden = reading.capped === null;
    },
  };
}

/**
 * @param {{ send: (command: object) => void }} options
 * @returns {{ element: HTMLElement, paint: (state: { hello?: object, view?: object, fit: number | null }) => void }}
 */
export function createLadderHeader({ send }) {
  const unitToggle = createUnitToggle(send);
  const groupingCombo = createGroupingCombo(send);
  const levelStepper = createLevelStepper(send);

  return {
    element: h('div', { class: 'ladder-head' }, unitToggle.element, groupingCombo.element, levelStepper.element),

    /** Shows the view's unit, grouping and levels. Called only when one of them changed. */
    paint({ hello, view, fit }) {
      unitToggle.paint(view);
      groupingCombo.paint(hello, view);
      levelStepper.paint(hello, view, fit);
    },
  };
}
