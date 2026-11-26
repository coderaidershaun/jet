// The few line icons the plan pane and the task list draw that the shared set lacks, in the same style as it.

const SVG = 'http://www.w3.org/2000/svg';
export const PATHS = {
  plan: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  people: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.9M16 4.1a3.5 3.5 0 0 1 0 6.8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  dash: 'M7 12h10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  chat: 'M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.2A8 8 0 1 1 21 12z',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M6 9l6 6 6-6',
};

/** A line icon that takes the text colour. @param {keyof typeof PATHS} name */
export function svgIcon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '24', height: '24', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(key, value);
  const path = document.createElementNS(SVG, 'path');
  for (const [key, value] of Object.entries({ d: PATHS[name], fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(key, value);
  svg.append(path);
  return svg;
}
