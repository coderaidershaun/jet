// Which page the main area shows, the chat or the workstation: switching between
// them, saving the choice, what Esc does first, and how the drawer looks beside
// each page. No DOM; the page asks and obeys.

/** The pages, with the word the page announces when it opens. */
export const PAGE_NAMES = Object.freeze({ chat: 'Chat', workstation: 'Workstation' });

/** @typedef {keyof typeof PAGE_NAMES} Page */

const known = (page) => Object.hasOwn(PAGE_NAMES, page);

/**
 * @param {{ saved: unknown, save: (page: Page) => void, onShow: (page: Page) => void }} options
 *   saved: the page in the settings; anything not known opens the chat
 */
export function createPageState({ saved, save, onShow }) {
  let current = known(saved) ? saved : 'chat';
  return {
    get current() {
      return current;
    },

    /** Opens `next`, saves it and tells the page. A page already shown, or not known, changes nothing. @returns {boolean} */
    show(next) {
      if (!known(next) || next === current) return false;
      current = next;
      save(next);
      onShow(next);
      return true;
    },

    /**
     * What Esc does before the composer's own rules: the open sheet closes first,
     * then the workstation goes back to the chat.
     * @param {{ sheetOpen: boolean }} open
     * @returns {'closeSheet' | 'showChat' | 'composer'}
     */
    escape({ sheetOpen }) {
      if (sheetOpen) return 'closeSheet';
      return current === 'workstation' ? 'showChat' : 'composer';
    },
  };
}

// SMELL: the drawer works out its first state at start-up with its own copy of this rule; change both together.
/**
 * Whether the drawer stands open after the page or the window width changes: the docked choice on
 * the chat page; never beside the workstation, and never as the narrow overlay.
 * @param {{ page: Page, dockedPreference: boolean, narrow: boolean }} state
 */
export function drawerOpens({ page, dockedPreference, narrow }) {
  return page === 'chat' && dockedPreference && !narrow;
}

/**
 * How the drawer looks. The rail stands in for the closed drawer beside the workstation on a wide screen.
 * @param {{ page: Page, open: boolean, narrow: boolean }} state
 * @returns {'open' | 'closed' | 'rail'}
 */
export function drawerLayout({ page, open, narrow }) {
  if (open) return 'open';
  return page === 'workstation' && !narrow ? 'rail' : 'closed';
}
