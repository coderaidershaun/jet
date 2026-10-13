// The behaviour wheel: a draggable point inside a unit circle, plus presets and
// two sliders that move the same point for keyboard and precision use.

import { clamp } from '../jet/rig.js';

const WHEEL_RADIUS = 100; // viewBox units
const KEY_STEP = 0.05;

/**
 * @param {{ onChange: (behaviour: import('./settings.js').Behaviour) => void }} options
 */
export function createWheel({ onChange }) {
  const svg = /** @type {SVGSVGElement} */ (document.getElementById('wheel'));
  const handle = document.getElementById('wheel-handle');
  const line = document.getElementById('wheel-line');
  const readout = document.getElementById('wheel-read');
  const sliderX = /** @type {HTMLInputElement} */ (document.getElementById('candid'));
  const sliderY = /** @type {HTMLInputElement} */ (document.getElementById('playful'));
  const presets = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('#presets .chip')]);

  document.getElementById('preset-dots').innerHTML = presets
    .map((b) => '<circle cx="' + Number(b.dataset.candid) * WHEEL_RADIUS + '" cy="' + -Number(b.dataset.playful) * WHEEL_RADIUS + '" r="4.5"/>')
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
    for (const b of presets) {
      const hit = Math.abs(Number(b.dataset.candid) - x) < 0.03 && Math.abs(Number(b.dataset.playful) - y) < 0.03;
      b.setAttribute('aria-pressed', String(hit));
    }
    if (!silent) onChange({ candid, playful });
  }

  function pointFromEvent(event) {
    const box = svg.getBoundingClientRect();
    const scale = 260 / box.width;
    return [((event.clientX - box.left) * scale - 130) / WHEEL_RADIUS, -(((event.clientY - box.top) * scale - 130) / WHEEL_RADIUS)];
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
  for (const b of presets) b.addEventListener('click', () => apply(Number(b.dataset.candid), Number(b.dataset.playful)));

  return {
    /** @param {import('./settings.js').Behaviour} behaviour */
    set(behaviour) {
      apply(behaviour.candid, behaviour.playful, { silent: true });
    },
  };
}
