// Typesets the formulas in a reply. The reply's HTML only carries each formula's TeX inside an
// inert `.math` element; KaTeX draws it here. The page's content rules block `style`
// attributes, so the drawing is built through the DOM and not from KaTeX's markup string, and
// the few style attributes KaTeX makes itself (the arrow over a vector, tall braces) are moved
// onto the element's style object, which the rules allow. A streaming bubble is refilled many
// times a second, so each drawing is kept and copied back instead of being drawn again.

import katex from '../../vendor/katex/katex.mjs';

// Walks KaTeX's tree and, for each node that has a style attribute, deletes it and sets the same
// declarations on the element once that node is built.
function moveStyleAttributes(node) {
  const style = node.attributes && node.attributes.style;
  if (style) {
    delete node.attributes.style;
    const build = node.toNode;
    node.toNode = function toNodeWithStyle() {
      const element = build.call(this);
      element.style.cssText = style;
      return element;
    };
  }
  for (const child of node.children || []) moveStyleAttributes(child);
}

// The tree comes from KaTeX's unstable `__renderToDomTree`; the vendored version is pinned. With
// `throwOnError` a bad formula throws before any DOM is built.
function drawWithKatex(tex, element, displayMode) {
  const tree = katex.__renderToDomTree(tex, { displayMode, output: 'html', throwOnError: true, strict: 'ignore' });
  moveStyleAttributes(tree);
  element.replaceChildren(tree.toNode());
}

/**
 * @param {{ draw?: (tex: string, element: Element, displayMode: boolean) => void, limit?: number }} [options]
 *   `draw` leaves exactly one child in the element; `limit` is how many drawings are kept.
 * @returns {(root: ParentNode) => void}
 */
export function createTypesetter({ draw = drawWithKatex, limit = 200 } = {}) {
  /** @type {Map<string, Node>} */
  const drawings = new Map();

  function fill(element, tex, display) {
    const key = (display ? 'display:' : 'inline:') + tex;
    const kept = drawings.get(key);
    if (kept) {
      // Re-inserting moves it to the newest end of the map.
      drawings.delete(key);
      drawings.set(key, kept);
      element.replaceChildren(kept.cloneNode(true));
      return;
    }
    draw(tex, element, display);
    drawings.set(key, element.firstChild.cloneNode(true));
    if (drawings.size > limit) drawings.delete(drawings.keys().next().value);
  }

  return function typeset(root) {
    for (const element of root.querySelectorAll('.math[data-tex]')) {
      const tex = element.getAttribute('data-tex');
      try {
        fill(element, tex, element.classList.contains('math-display'));
      } catch (error) {
        // A formula KaTeX cannot read is shown as written. Nothing is kept, so the next paint tries again.
        element.textContent = tex;
        element.classList.add('math-error');
        element.setAttribute('title', error.message);
      }
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', tex);
    }
  };
}

/** Draws every `.math` element below `root`. */
export const typeset = createTypesetter();
