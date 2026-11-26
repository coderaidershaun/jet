// Small helpers for building elements. The page's content rules forbid style
// attributes and inline scripts, so elements are built with properties and
// listeners, never with markup strings that carry either.

const SVG = 'http://www.w3.org/2000/svg';

/**
 * `h('button', { class: 'chip', onClick: fn, 'aria-pressed': 'true' }, 'Save')`
 * Keys starting with "on" are listeners; "text" sets text; other keys become
 * attributes. A child is an element, a string, or null to skip.
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'style') throw new Error('h(): the page forbids style attributes; set a class or use element.style');
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

/** Twenty marks of air, sky and kite. Every chat but the main one wears the one its id picks (`chatIcon` in chat/drawer/chats.js). */
export const KITES = {
  kite: 'M17.5 3l3 7-10.5 5-.5-11zM17.5 3L10 15M9.5 4l11 6M10 15c-.5 3-5 2.5-6 6',
  spool: 'M10 21a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM10 7l10-4',
  paperPlane: 'M21 3L3 10.5l7.5 3 3 7.5L21 3zM10.5 13.5L21 3',
  plane: 'M12 3v18M12 8.5L3 14l9-1.5 9 1.5zM12 17.5l-3.5 3 3.5-.8 3.5.8z',
  balloon: 'M12 2.5c3.3 0 6 2.9 6 6.5s-3.5 6.5-6 6.5-6-2.9-6-6.5 2.7-6.5 6-6.5zM12 15.5l-1.3 1.8h2.6zM12 17.3c-1.8 1.3 1.8 2.5 0 4.2',
  parachute: 'M3 11a9 8 0 0 1 18 0zM3 11l9 9.5 9-9.5M12 11v9.5',
  birds: 'M2 14c3-4.5 6.5-4 8.5 1.5 2-5.5 5.5-6 8.5-1.5M13 6.5c1.5-2 3.3-1.8 4.2.8.9-2.6 2.7-2.8 4.2-.8',
  butterfly: 'M12 8.5v9.5M12 8l-1.5-3.5M12 8l1.5-3.5M12 10.5C10 5.5 3.5 5 3.5 9.5c0 2.5 2.5 4 5 3.5-2 .5-3 2.5-2 4 1.3 2 4.3 1 5.5-3.5M12 10.5c2-5 8.5-5.5 8.5-1 0 2.5-2.5 4-5 3.5 2 .5 3 2.5 2 4-1.3 2-4.3 1-5.5-3.5',
  feather: 'M4 20L14.5 9.5M7 17C5.5 12 9.5 5.5 19.5 4.5c1 4.5-1 8-2.5 9.5h-4l2 2c-2.5 1.5-5.5 2-8 1z',
  bubbles: 'M9 18.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM17.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  cloud: 'M7 19h10.5a3.5 3.5 0 0 0 .4-7A6 6 0 0 0 6.3 11 4 4 0 0 0 7 19z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
  moon: 'M12.5 5.5A7.5 7.5 0 1 0 19 16.5 6 6 0 0 1 12.5 5.5zM18.5 3v4M16.5 5h4',
  rainbow: 'M3 17a9 9 0 0 1 18 0M6.5 17a5.5 5.5 0 0 1 11 0M10 17a2 2 0 0 1 4 0',
  bolt: 'M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z',
  wind: 'M3 8h9.5a2.5 2.5 0 1 0-2.5-2.5M3 12h15a3 3 0 1 1-3 3M3 16h6',
  pinwheel: 'M12 10.5V3a3.75 3.75 0 0 1 0 7.5zM12 10.5h7.5a3.75 3.75 0 0 1-7.5 0zM12 10.5V18a3.75 3.75 0 0 1 0-7.5zM12 10.5H4.5a3.75 3.75 0 0 1 7.5 0zM12 18v4',
  windsock: 'M5 21V3M5 3l14 5-1.5 4.5L5 13M10.5 5v7.5M15 6.6l-1 5.4',
  pennant: 'M5 21V3M5 4q7 1 14 4q-7 2-14 4',
  sailboat: 'M3 20.5c3 0 3-1 6-1s3 1 6 1 3-1 6-1M4 14h16l-2.5 3h-11zM11 3v11M11 4l7 8h-7',
};

const ICONS = {
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  send: 'M12 19V5M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  close: 'M6 6l12 12M18 6L6 18',
  down: 'M12 5v14M5 12l7 7 7-7',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  chevron: 'M6 9l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  speaker: 'M16.5 5L11.5 9H7.5v6h4l5 4V5z',
  speakerWaves: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  chat: 'M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.2A8 8 0 1 1 21 12z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  tasks: 'M4 6h4v4H4zM4 14h4v4H4zM12 8h8M12 16h8',
  files: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7zM14 3v4h4',
  signOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  ...KITES,
};
const FILLED = new Set(['stop']);

/** A 24 px line icon that takes the text colour. @param {keyof typeof ICONS} name */
export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', FILLED.has(name) ? 'currentColor' : 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
