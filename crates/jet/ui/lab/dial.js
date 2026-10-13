// The expressiveness dial: one master value on a draggable arc, and four
// channels that copy the master until the user takes one over.

import { clamp } from '../jet/maths.js';

const CENTRE = [130, 124];
const RADIUS = 96;
const START_DEG = 135; // bottom-left, screen angles run clockwise
const END_DEG = 405; // bottom-right
const CHANNELS = /** @type {const} */ (['shape', 'eyes', 'colour', 'motion']);
const STOPS = [[0, 'still'], [2, 'subtle'], [5, 'expressive'], [8, 'theatrical'], [10, 'cartoon']];

function wordFor(value) {
  return value < 1 ? 'still' : value < 3.5 ? 'subtle' : value < 6.5 ? 'expressive' : value < 9 ? 'theatrical' : 'cartoon';
}

/**
 * @param {{ onChange: (expressiveness: import('./settings.js').Expressiveness) => void }} options
 */
export function createDial({ onChange }) {
  const svg = /** @type {SVGSVGElement} */ (document.getElementById('dial'));
  const handle = document.getElementById('dial-handle');
  const fill = document.getElementById('dial-fill');
  const number = document.getElementById('dial-number');
  const word = document.getElementById('dial-word');
  const readout = document.getElementById('dial-read');
  const masterSlider = /** @type {HTMLInputElement} */ (document.getElementById('master'));
  const sliders = Object.fromEntries(CHANNELS.map((c) => [c, /** @type {HTMLInputElement} */ (document.getElementById('ch-' + c))]));
  const followBoxes = Object.fromEntries(CHANNELS.map((c) => [c, /** @type {HTMLInputElement} */ (document.getElementById('f-' + c))]));

  const polar = (deg, r) => [CENTRE[0] + r * Math.cos((deg * Math.PI) / 180), CENTRE[1] + r * Math.sin((deg * Math.PI) / 180)];
  const arc = (from, to) => {
    const p = polar(from, RADIUS);
    const q = polar(to, RADIUS);
    return 'M' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ' A' + RADIUS + ' ' + RADIUS + ' 0 ' + (to - from > 180 ? 1 : 0) + ' 1 ' + q[0].toFixed(1) + ' ' + q[1].toFixed(1);
  };
  const angleFor = (value) => START_DEG + ((END_DEG - START_DEG) * value) / 10;

  document.getElementById('dial-track').setAttribute('d', arc(START_DEG, END_DEG));
  document.getElementById('dial-stops').innerHTML = STOPS.map(([v]) => {
    const p = polar(angleFor(v), RADIUS);
    return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.5"/>';
  }).join('');
  document.getElementById('dial-labels').innerHTML = STOPS.map(([v]) => {
    const p = polar(angleFor(v), RADIUS + 20);
    return '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 4).toFixed(1) + '" text-anchor="middle">' + v + '</text>';
  }).join('');

  /** @type {import('./settings.js').Expressiveness} */
  let state = { master: 6, channels: { shape: 6, eyes: 4, colour: 6, motion: 6 }, follow: { shape: true, eyes: false, colour: true, motion: true } };

  function paint() {
    const v = state.master;
    const a = angleFor(v);
    const p = polar(a, RADIUS);
    handle.setAttribute('cx', String(p[0]));
    handle.setAttribute('cy', String(p[1]));
    fill.setAttribute('d', v > 0.05 ? arc(START_DEG, a) : '');
    number.textContent = v.toFixed(v % 1 ? 1 : 0);
    word.textContent = wordFor(v);
    readout.textContent = v.toFixed(1) + ' · ' + wordFor(v);
    masterSlider.value = String(v);
    document.getElementById('master-v').textContent = v.toFixed(1);
    for (const c of CHANNELS) {
      sliders[c].value = String(state.channels[c]);
      followBoxes[c].checked = state.follow[c];
    }
  }

  function setMaster(value, { silent = false } = {}) {
    state.master = clamp(Math.round(value * 10) / 10, 0, 10);
    for (const c of CHANNELS) if (state.follow[c]) state.channels[c] = state.master;
    paint();
    if (!silent) onChange(snapshot());
  }

  function snapshot() {
    return { master: state.master, channels: { ...state.channels }, follow: { ...state.follow } };
  }

  function valueFromEvent(event) {
    const box = svg.getBoundingClientRect();
    const scale = 260 / box.width;
    const x = (event.clientX - box.left) * scale - CENTRE[0];
    const y = (event.clientY - box.top) * scale - CENTRE[1];
    let deg = (Math.atan2(y, x) * 180) / Math.PI;
    if (deg < 90) deg += 360; // the gap at the bottom is where the two ends meet
    return ((clamp(deg, START_DEG, END_DEG) - START_DEG) / (END_DEG - START_DEG)) * 10;
  }

  let dragging = false;
  svg.addEventListener('pointerdown', (event) => {
    dragging = true;
    svg.setPointerCapture(event.pointerId);
    setMaster(valueFromEvent(event));
  });
  svg.addEventListener('pointermove', (event) => {
    if (dragging) setMaster(valueFromEvent(event));
  });
  svg.addEventListener('pointerup', () => { dragging = false; });
  svg.addEventListener('pointercancel', () => { dragging = false; });
  masterSlider.addEventListener('input', () => setMaster(Number(masterSlider.value)));
  for (const c of CHANNELS) {
    sliders[c].addEventListener('input', () => {
      state.follow[c] = false;
      state.channels[c] = Number(sliders[c].value);
      paint();
      onChange(snapshot());
    });
    followBoxes[c].addEventListener('change', () => {
      state.follow[c] = followBoxes[c].checked;
      if (state.follow[c]) state.channels[c] = state.master;
      paint();
      onChange(snapshot());
    });
  }

  return {
    /** @param {import('./settings.js').Expressiveness} expressiveness */
    set(expressiveness) {
      state = { master: expressiveness.master, channels: { ...expressiveness.channels }, follow: { ...expressiveness.follow } };
      paint();
    },
  };
}
