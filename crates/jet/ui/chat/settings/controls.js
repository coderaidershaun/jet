// The few form controls the settings sheet is made of, so each section reads as
// a list of fields rather than a pile of elements.

import { h } from '../../dom.js';

/** A titled block of the sheet. */
export function section(id, title, ...children) {
  const heading = h('h3', { id: 'heading-' + id, text: title });
  return h('section', { class: 'group', id: 'section-' + id, 'aria-labelledby': 'heading-' + id }, heading, ...children);
}

export const note = (text) => h('p', { class: 'note', text });

/**
 * A one-line or multi-line text field with an optional counter.
 * @param {{
 *   label: string, value: string, maxLength?: number, lines?: number, placeholder?: string,
 *   count?: (text: string) => number, onInput: (text: string) => void,
 * }} options
 */
export function textField({ label, value, maxLength, lines = 1, placeholder, count, onInput }) {
  const input = lines > 1
    ? h('textarea', { rows: lines })
    : h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  if (maxLength) input.setAttribute('maxlength', String(maxLength));
  const counter = h('span', { class: 'counter', 'aria-live': 'off' });
  const paint = () => {
    if (count) counter.textContent = count(input.value) + (maxLength ? ' / ' + maxLength : '');
  };
  input.addEventListener('input', () => {
    paint();
    onInput(input.value);
  });
  paint();
  const top = h('span', { class: 'field-top' }, h('span', { class: 'field-label', text: label }), count ? counter : null);
  return {
    el: h('label', { class: 'field' }, top, input),
    /** Replaces the text without calling onInput. */
    set(text) {
      input.value = text;
      paint();
    },
  };
}

/** @param {{ label: string, checked: boolean, note?: string, onChange: (checked: boolean) => void }} options */
export function switchRow({ label, checked, note: help, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = h('span', { class: 'switch-text' }, h('span', { text: label }), help ? h('span', { class: 'help', text: help }) : null);
  return { el: h('label', { class: 'switch-row' }, text, input), input };
}

/**
 * @param {{
 *   label: string, hint?: string, min: number, max: number, step: number, value: number,
 *   format?: (value: number) => string, onInput: (value: number) => void,
 * }} options
 */
export function sliderField({ label, hint, min, max, step, value, format = String, onInput }) {
  const input = h('input', { type: 'range', min, max, step });
  const reading = h('span', { class: 'reading' });
  const paint = () => { reading.textContent = format(Number(input.value)); };
  input.value = String(value);
  input.addEventListener('input', () => {
    paint();
    onInput(Number(input.value));
  });
  paint();
  const top = h('span', { class: 'field-top' }, h('span', { class: 'field-label', text: label }), reading);
  return {
    el: h('label', { class: 'field slider' }, top, hint ? h('span', { class: 'help', text: hint }) : null, input),
    set(next) {
      input.value = String(next);
      paint();
    },
  };
}

/**
 * A row of exclusive buttons.
 * @param {{ label: string, options: { value: string, label: string }[], value: string, onChange: (value: string) => void }} options
 */
export function segmented({ label, options, value, onChange }) {
  const buttons = options.map((option) => h('button', { type: 'button', class: 'segment', 'data-value': option.value, text: option.label }));
  const group = h('div', { class: 'segments', role: 'group', 'aria-label': label }, ...buttons);
  const paint = (current) => {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.value === current));
  };
  group.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('.segment');
    if (!button) return;
    paint(button.dataset.value);
    onChange(button.dataset.value);
  });
  paint(value);
  return { el: h('div', { class: 'field' }, h('span', { class: 'field-label', text: label }), group) };
}

export const button = (text, props = {}) => h('button', { type: 'button', class: 'action', ...props, text });
