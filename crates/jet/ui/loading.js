// The loading screen covers the page while it is built, so the user never sees it half built.

const MAX_WAIT_MS = 1500;

// Keep this longer than the fade in the cover's stylesheet, so the cover is removed only when invisible.
// A timer is used instead of waiting for the fade to end, because a fade that never runs never ends.
const AFTER_FADE_MS = 250;

const nextFrame = (frame) => new Promise((resolve) => frame(() => resolve()));

/**
 * Takes the loading screen away once `settled` and the fonts are done and the page has painted.
 * It never waits longer than MAX_WAIT_MS for them.
 * @param {{ cover: HTMLElement | null, settled: Promise<unknown>, reducedMotion: () => boolean,
 *           fonts?: () => Promise<unknown>, frame?: (run: () => void) => void }} options
 */
export async function finishLoading({ cover, settled, reducedMotion, fonts = () => document.fonts.ready, frame = requestAnimationFrame }) {
  if (!cover) return;
  await nextFrame(frame);
  let timer;
  const timeUp = new Promise((resolve) => { timer = setTimeout(resolve, MAX_WAIT_MS); });
  // A failed fetch or font must not keep the cover up.
  const arrived = Promise.all([settled, fonts()]).catch(() => {});
  await Promise.race([arrived, timeUp]);
  clearTimeout(timer);
  await nextFrame(frame);
  await nextFrame(frame);
  cover.classList.add('is-leaving');
  setTimeout(() => cover.remove(), reducedMotion() ? 0 : AFTER_FADE_MS);
}

/**
 * Leaves the loading screen up and says why Jet could not start.
 * @param {{ cover: HTMLElement | null, message: string }} options
 */
export function failLoading({ cover, message }) {
  if (!cover) return;
  // The role changes before the text, so screen readers announce the new text as an alert.
  cover.setAttribute('role', 'alert');
  cover.querySelector('.loading-text').textContent = message;
  cover.classList.add('is-failed');
}
