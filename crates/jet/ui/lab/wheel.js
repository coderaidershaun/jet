// The behaviour wheel: a draggable point inside a unit circle, plus the preset
// chips and two sliders that move the same point for keyboard and precision use.

import { clamp } from '../jet/maths.js';
import { PRESETS } from '../bridge/settings.js';

const WHEEL_RADIUS = 100; // viewBox units
const KEY_STEP = 0.05;

function presetChip({ name, candid, playful }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.candid = String(candid);
  chip.dataset.playful = String(playful);
  chip.textContent = name;
  return chip;
}

/**
 * @param {{ onChange: (behaviour: import('../bridge/settings.js').Behaviour) => void }} options
 */
export function createWheel({ onChange }) {
  const svg = /** @type {SVGSVGElement} */ (document.getElementById('wheel'));
  const handle = document.getElementById('wheel-handle');
  const line = document.getElementById('wheel-line');
  const readout = document.getElementById('wheel-read');
  const sliderX = /** @type {HTMLInputElement} */ (document.getElementById('candid'));
  const sliderY = /** @type {HTMLInputElement} */ (document.getElementById('playful'));
  const chips = PRESETS.map(presetChip);
  document.getElementById('presets').append(...chips);

  document.getElementById('preset-dots').innerHTML = chips
    .map((chip) => '<circle cx="' + Number(chip.dataset.candid) * WHEEL_RADIUS + '" cy="' + -Number(chip.dataset.playful) * WHEEL_RADIUS + '" r="4.5"/>')
    .join('');

  let candid = 0;
  let playful = 0;

  function apply(x, y, { fromSlider = false, silent = false } = {}) {
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    candid = x;
    playful = y;
    handle.setAttribute('cx', String(x * WHEEL_RADIUS));
    handle.setAttribute('cy', String(-y * WHEEL_RADIUS));
    line.setAttribute('x2', String(x * WHEEL_RADIUS));
    line.setAttribute('y2', String(-y * WHEEL_RADIUS));
    const horizontal = x >= 0 ? 'Candid ' + Math.round(x * 100) : 'Deferential ' + Math.round(-x * 100);
    const vertical = y >= 0 ? 'Playful ' + Math.round(y * 100) : 'Serious ' + Math.round(-y * 100);
    readout.textContent = horizontal + ' · ' + vertical + ' · ' + Math.round(Math.hypot(x, y) * 100) + '%';
    if (!fromSlider) {
      sliderX.value = String(Math.round(x * 100));
      sliderY.value = String(Math.round(y * 100));
    }
    document.getElementById('candid-v').textContent = (x >= 0 ? '+' : '') + x.toFixed(2);
    document.getElementById('playful-v').textContent = (y >= 0 ? '+' : '') + y.toFixed(2);
    for (const chip of chips) {
      const hit = Math.abs(Number(chip.dataset.candid) - x) < 0.03 && Math.abs(Number(chip.dataset.playful) - y) < 0.03;
      chip.setAttribute('aria-pressed', String(hit));
    }
    if (!silent) onChange({ candid, playful });
  }

  function pointFromEvent(event) {
    const box = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const scale = view.width / box.width;
    const x = (event.clientX - box.left) * scale + view.x;
    const y = (event.clientY - box.top) * scale + view.y;
    return [x / WHEEL_RADIUS, -y / WHEEL_RADIUS];
  }

  let dragging = false;
  svg.addEventListener('pointerdown', (event) => {
    dragging = true;
    svg.setPointerCapture(event.pointerId);
    apply(...pointFromEvent(event));
  });
  svg.addEventListener('pointermove', (event) => {
    if (dragging) apply(...pointFromEvent(event));
  });
  svg.addEventListener('pointerup', () => { dragging = false; });
  svg.addEventListener('pointercancel', () => { dragging = false; });
  handle.addEventListener('keydown', (event) => {
    let x = candid;
    let y = playful;
    if (event.key === 'ArrowLeft') x -= KEY_STEP;
    else if (event.key === 'ArrowRight') x += KEY_STEP;
    else if (event.key === 'ArrowUp') y += KEY_STEP;
    else if (event.key === 'ArrowDown') y -= KEY_STEP;
    else return;
    event.preventDefault();
    apply(clamp(x, -1, 1), clamp(y, -1, 1));
  });
  sliderX.addEventListener('input', () => apply(Number(sliderX.value) / 100, playful, { fromSlider: true }));
  sliderY.addEventListener('input', () => apply(candid, Number(sliderY.value) / 100, { fromSlider: true }));
  for (const chip of chips) chip.addEventListener('click', () => apply(Number(chip.dataset.candid), Number(chip.dataset.playful)));

  return {
    /** @param {import('../bridge/settings.js').Behaviour} behaviour */
    set(behaviour) {
      apply(behaviour.candid, behaviour.playful, { silent: true });
    },
  };
}
