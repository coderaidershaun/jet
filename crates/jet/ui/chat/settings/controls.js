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

export const button = (text, props = {}) => h('button', { type: 'button', class: 'action', ...props, text });
