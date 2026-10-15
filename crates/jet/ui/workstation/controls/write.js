// Changes the page only where a value changed. The painters run on every frame, and writing the
// same text or attribute again still makes the browser redo work.

/** Sets the element's text, unless it already shows that text. */
export function writeText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/** Sets an attribute, unless it already has that value. `null` removes it. */
export function writeAttribute(element, name, value) {
  if (value === null) element.removeAttribute(name);
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
