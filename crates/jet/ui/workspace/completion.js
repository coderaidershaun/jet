import { h } from '../dom.js';

export function createCommandMenu({ field, container, commands, setText }) {
  const menu = h('div', { id: 'command-menu', class: 'command-menu', role: 'listbox', 'aria-label': 'Commands', hidden: true });
  container.append(menu, h('link', { rel: 'stylesheet', href: new URL('./commands.css', import.meta.url).href }));
  field.setAttribute('aria-controls', 'command-menu');
  field.setAttribute('aria-autocomplete', 'list');
  let choices = [], selected = 0;
  function close() { menu.hidden = true; field.setAttribute('aria-expanded', 'false'); field.removeAttribute('aria-activedescendant'); }
  function choose(index) { const value = choices[index].value; close(); setText(value + ' '); }
  function paint() {
    menu.replaceChildren(...choices.map((choice, index) => h('button', { type: 'button', id: 'command-choice-' + index, role: 'option', 'aria-selected': String(index === selected), onMousedown: event => event.preventDefault(), onClick: () => choose(index) }, h('strong', { text: choice.value }), h('span', { text: choice.description }))));
    menu.hidden = choices.length === 0;
    field.setAttribute('aria-expanded', String(!menu.hidden));
    if (choices.length) field.setAttribute('aria-activedescendant', 'command-choice-' + selected);
    else field.removeAttribute('aria-activedescendant');
  }
  field.addEventListener('blur', () => { setTimeout(() => { if (!menu.contains(document.activeElement)) close(); }, 0); });
  return {
    input(text) { choices = commands.suggestions(text); selected = 0; paint(); },
    keydown(event) {
      if (event.isComposing || event.shiftKey || menu.hidden) return false;
      if (event.key === 'Escape') { close(); return true; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { selected = (selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; paint(); return true; }
      if (event.key === 'Tab' || event.key === 'Enter') { choose(selected); return true; }
      return false;
    },
    close,
  };
}
