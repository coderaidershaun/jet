// Draws one hit or page piece by its kind. The typesetter is loaded the first time
// it is needed, from a module that may not be in this build; without it a
// formula shows its TeX as text.

import { h } from '../../dom.js';

const PICTURE_ADDRESS = /^data:image\/(png|jpeg);base64,/;
const PICTURE_UNSHOWABLE = 'The picture came back in a form the page cannot show.';

let typesetter = null;

/**
 * The page's typesetter, or null when this build has none.
 * SMELL: when the module is missing, the first open of a source logs one 404 in the console. The failure is
 * caught, so a formula shows its TeX as text. A plain import is better once every build has the module.
 */
function loadTypeset() {
  typesetter ??= import('../math.js').then((math) => math.typeset, () => null);
  return typesetter;
}

async function fillMarkdown(element, { text, footnote }, { render, seal }) {
  const body = h('div', { class: footnote ? 'body footnote' : 'body' });
  element.append(body);
  try {
    body.innerHTML = await render(text);
  } catch (error) {
    console.warn('a source could not be rendered:', error);
    body.replaceWith(h('p', { class: 'plain', text }));
    return;
  }
  seal(body);
  (await loadTypeset())?.(body);
}

async function showPicture(slot, { picture, label }, readImage) {
  const unavailable = (reason) => slot.replaceChildren(h('p', { class: 'picture-missing', title: reason, text: 'Picture unavailable' }));
  slot.replaceChildren(h('p', { class: 'picture-wait', text: 'Loading the picture…' }));
  let address;
  try {
    address = await readImage(picture);
  } catch (error) {
    unavailable(error?.message || PICTURE_UNSHOWABLE);
    return;
  }
  if (typeof address !== 'string' || !PICTURE_ADDRESS.test(address)) {
    unavailable(PICTURE_UNSHOWABLE);
    return;
  }
  slot.replaceChildren(h('img', { class: 'picture', src: address, alt: label ?? 'Figure', onError: () => unavailable(PICTURE_UNSHOWABLE) }));
}

/**
 * Appends the nodes of one hit or piece to `element`. Where a node comes from an async step, its place is kept first.
 * @param {HTMLElement} element
 * @param {import('./model.js').Show} show
 * @param {{ render: (text: string) => Promise<string>, readImage: (path: string) => Promise<string>, seal: (body: HTMLElement) => void }} parts
 */
export async function fillShow(element, show, parts) {
  switch (show.as) {
    case 'markdown':
      await fillMarkdown(element, show, parts);
      break;
    case 'heading':
      element.append(h('h4', { class: 'piece-heading', text: show.text }));
      break;
    case 'formula': {
      const wrapper = h(
        'div',
        { class: 'formula' },
        h('div', { class: 'math math-display', 'data-tex': show.tex, text: show.tex }),
        show.label ? h('span', { class: 'formula-label', text: show.label }) : null,
      );
      element.append(wrapper);
      // The typesetter only looks inside the node it is given, so it gets the wrapper.
      (await loadTypeset())?.(wrapper);
      break;
    }
    case 'table':
      if (show.label) element.append(h('p', { class: 'show-label', text: show.label }));
      await fillMarkdown(element, show, parts);
      break;
    case 'figure': {
      const slot = h('div', { class: 'picture-slot' });
      element.append(h('figure', { class: 'figure' }, slot, show.label ? h('figcaption', { text: show.label }) : null));
      if (show.picture === null) slot.append(h('p', { class: 'picture-missing', text: 'No picture was stored for this figure.' }));
      else showPicture(slot, show, parts.readImage);
      await fillMarkdown(element, show, parts);
      break;
    }
    case 'code': {
      const block = h('div', {}, h('pre', {}, h('code', { class: show.language ? 'language-' + show.language : null, text: show.text })));
      parts.seal(block);
      element.append(block);
      break;
    }
    default:
      element.append(h('p', { class: 'plain', text: show.text }));
  }
}
