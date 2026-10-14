// Texts in the settings sheet that say Jet's name. Each keeps its template on
// the element, so a name change repaints them all without rebuilding the sheet.

const TEMPLATE_ATTR = 'data-name-text';

/** @param {string} template   `{name}` stands for the name */
export function fillName(template, name) {
  return template.replaceAll('{name}', name);
}

/** Sets the element's text from the template and remembers the template for later repaints. */
export function named(el, template, name) {
  el.setAttribute(TEMPLATE_ATTR, template);
  el.textContent = fillName(template, name);
  return el;
}

/** Repaints every named text under `root` with the new name. */
export function paintNames(root, name) {
  for (const el of root.querySelectorAll('[' + TEMPLATE_ATTR + ']')) {
    el.textContent = fillName(el.getAttribute(TEMPLATE_ATTR), name);
  }
}
