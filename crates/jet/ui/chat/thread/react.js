// The small row of emoji that opens on a Jet message, so the user can react to it as on
// WhatsApp. Its "+" opens a field that takes any emoji, from the system emoji keyboard or pasted.

import { h, icon } from '../../dom.js';

const QUICK = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🙏']);
const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const graphemes = new Intl.Segmenter();

/** The first emoji the user put in the field, or null while it holds none. */
function firstEmoji(text) {
  const first = graphemes.segment(text.trim())[Symbol.iterator]().next().value?.segment ?? '';
  return PICTURE.test(first) && !/[\sA-Za-z]/.test(first) ? first : null;
}

/** An outline smiley in the style of the page's line icons. */
function smiley() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  for (const d of ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 14.5a5 5 0 0 0 8 0', 'M9 9.5h.01M15 9.5h.01']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
  }
  return svg;
}

/** The button on a Jet bubble that opens the chooser. It carries the message id and the user's emoji on it. */
export function reactButton(entryId, mine) {
  return h('button', { class: 'react-open', type: 'button', tabindex: -1, 'aria-label': 'React', 'data-entry': entryId, 'data-mine': mine ?? '' }, smiley());
}

/**
 * @param {{ onPick: (entryId: number, emoji: string | null) => void }} options
 *   `emoji` is null when the user chose the emoji that is already theirs, which takes it off
 */
export function createReactChooser({ onPick }) {
  const picks = QUICK.map((emoji) => h('button', { class: 'react-pick', type: 'button', 'aria-label': 'React with ' + emoji, 'data-emoji': emoji, text: emoji }));
  const more = h('button', { class: 'react-more', type: 'button', 'aria-label': 'Any other emoji' }, icon('plus'));
  const field = h('input', { class: 'react-field', type: 'text', 'aria-label': 'Any emoji', placeholder: 'Type or paste an emoji', autocomplete: 'off', enterkeyhint: 'done', hidden: true });
  const el = h('div', { class: 'react-chooser', role: 'group', 'aria-label': 'React' }, ...picks, more, field);
  /** @type {{ entryId: number, mine: string | null, opener: HTMLElement | null } | null} */
  let target = null;

  /** With `refocus`, the focus goes back to the control that opened the chooser, or its message when that control is hidden. */
  function close(refocus = false) {
    const opener = target?.opener;
    target = null;
    el.remove();
    el.style.removeProperty('translate');
    if (refocus && opener) {
      opener.focus();
      if (document.activeElement !== opener) opener.closest('.bubble')?.focus();
    }
  }

  function pick(emoji) {
    if (!target) return;
    const { entryId, mine } = target;
    close();
    onPick(entryId, emoji === mine ? null : emoji);
  }

  el.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button');
    if (button?.dataset.emoji) pick(button.dataset.emoji);
    else if (button === more) {
      for (const each of [...picks, more]) each.hidden = true;
      field.hidden = false;
      field.focus();
    }
  });
  field.addEventListener('input', () => {
    const emoji = firstEmoji(field.value);
    if (emoji) pick(emoji);
  });
  el.addEventListener('keydown', (event) => {
    const shown = [...picks, more].filter((each) => !each.hidden);
    const at = shown.indexOf(/** @type {HTMLButtonElement} */ (event.target));
    if (event.key === 'Escape') {
      // The page's own Escape stops a running reply; this one only closes the chooser.
      event.preventDefault();
      close(true);
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && at !== -1) {
      event.preventDefault();
      shown[(at + (event.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length].focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (target && !el.contains(/** @type {Node} */ (event.target))) close();
  }, true);

  return {
    /** Opens on a bubble, above it, or below it when the bubble is at the top of the thread. */
    open(bubble, { entryId, mine, below, opener = null }) {
      target = { entryId, mine, opener };
      for (const each of picks) each.setAttribute('aria-pressed', String(each.dataset.emoji === mine));
      for (const each of [...picks, more]) each.hidden = false;
      field.hidden = true;
      field.value = '';
      el.classList.toggle('below', below);
      el.style.removeProperty('translate');
      bubble.append(el);
      // On a narrow screen the row would run past the window's right edge, so it moves left until it fits.
      const overflow = el.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
      if (overflow > 0) el.style.translate = -overflow + 'px 0';
      picks[0].focus({ preventScroll: true });
    },
    close,
  };
}
