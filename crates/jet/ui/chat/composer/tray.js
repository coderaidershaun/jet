// The files on their way into the next message: which are uploading, which are ready, which
// failed and why. It knows nothing of the DOM or the network; the view feeds it what happens.

import { KINDS, extensionOf, fileLinks, kindOfName } from '../files.js';

/** The most files one message may carry. */
export const MOST_FILES = 10;
/** The largest file, in bytes. */
export const MOST_BYTES = 32 * 1024 * 1024;

const UNSUPPORTED = 'Only PDF, Markdown, HTML, Excel (.xlsx), CSV, text and images';

/** What the composer's rules see when there is no tray. */
export const emptyTray = { counts: () => ({ uploading: 0, failed: 0, ready: 0 }) };

/**
 * @typedef {object} Chip
 * @property {string} id           local to this page, until the server gives the file its own
 * @property {string} name
 * @property {number} size         bytes
 * @property {string | null} kind  a key of KINDS, or null for a file that is not accepted
 * @property {string} tag          the band on the file's sheet
 * @property {'uploading' | 'ready' | 'failed'} state
 * @property {number} progress     0 to 1 while uploading
 * @property {import('../thread/store.js').Attachment | null} about   the server's details, once ready
 * @property {string} reason       why it failed
 * @property {string | null} preview   an address a picture's thumbnail can load
 * @property {File | null} file    what to upload
 */

/**
 * @param {{
 *   held?: () => number,
 *   preview?: { make: (file: File) => string | null, revoke: (url: string) => void },
 * }} [options]   `held` counts the files of a message held back, which also take places; `preview` makes and frees the addresses of thumbnails
 */
export function createTray({ held = () => 0, preview = { make: () => null, revoke: () => {} } } = {}) {
  /** @type {Chip[]} */
  let chips = [];
  let counter = 0;
  /** The thumbnail addresses that were made here and so must be freed here. */
  const owned = new Set();

  const find = (id) => chips.find((chip) => chip.id === id);

  function free(chip) {
    if (chip.preview && owned.delete(chip.preview)) preview.revoke(chip.preview);
  }

  function tagOf(name, kind) {
    if (kind) return KINDS[kind].tag;
    return extensionOf(name).slice(0, 4).toUpperCase() || 'FILE';
  }

  function chipFor(file) {
    const kind = kindOfName(file.name);
    const chip = { id: 'c' + ++counter, name: file.name, size: file.size, kind, tag: tagOf(file.name, kind), state: 'uploading', progress: 0, about: null, reason: '', preview: null, file };
    const places = chips.filter((other) => other.state !== 'failed').length + held();
    if (!kind) return fail(chip, UNSUPPORTED);
    if (file.size > MOST_BYTES) return fail(chip, 'Over 32 MB');
    if (places >= MOST_FILES) return fail(chip, 'Only ' + MOST_FILES + ' files per message');
    if (KINDS[kind].image) {
      chip.preview = preview.make(file);
      if (chip.preview) owned.add(chip.preview);
    }
    return chip;
  }

  function fail(chip, reason) {
    chip.state = 'failed';
    chip.reason = reason;
    chip.file = null;
    return chip;
  }

  return {
    get chips() {
      return chips;
    },

    /**
     * Takes files the user chose, dropped or pasted. Each becomes a chip: uploading, or failed at once
     * with a plain reason.
     * @param {File[]} files
     * @returns {Chip[]} the new chips; the caller uploads those that are still uploading
     */
    add(files) {
      return files.map((file) => {
        const chip = chipFor(file);
        chips.push(chip);
        return chip;
      });
    },

    progress(id, fraction) {
      const chip = find(id);
      if (chip?.state === 'uploading') chip.progress = Math.min(1, Math.max(0, fraction));
    },

    ready(id, about) {
      const chip = find(id);
      if (!chip) return;
      chip.state = 'ready';
      chip.progress = 1;
      chip.about = about;
      chip.file = null;
    },

    fail(id, reason) {
      const chip = find(id);
      if (chip) fail(chip, reason);
    },

    /** @returns {Chip | null} the chip that was removed, so a ready one can be deleted on the server */
    remove(id) {
      const chip = find(id);
      if (!chip) return null;
      chips = chips.filter((other) => other !== chip);
      free(chip);
      return chip;
    },

    /** Puts files that were already sent to the server back, as when a held message is cancelled. @param {import('../thread/store.js').Attachment[]} abouts */
    restore(abouts) {
      for (const about of abouts) {
        const kind = Object.hasOwn(KINDS, about.kind) ? about.kind : null;
        const thumbnail = kind && KINDS[kind].image ? fileLinks(about.id)?.view ?? null : null;
        chips.push({ id: 'c' + ++counter, name: about.name, size: about.bytes, kind, tag: tagOf(about.name, kind), state: 'ready', progress: 1, about, reason: '', preview: thumbnail, file: null });
      }
    },

    /** The files to send with a message. The tray empties, and the thumbnails made here are freed, because the thread loads the saved files instead. @returns {import('../thread/store.js').Attachment[]} */
    take() {
      const taken = chips.filter((chip) => chip.state === 'ready').map((chip) => chip.about);
      for (const chip of chips) free(chip);
      chips = [];
      return taken;
    },

    counts() {
      const count = (state) => chips.filter((chip) => chip.state === state).length;
      return { uploading: count('uploading'), failed: count('failed'), ready: count('ready') };
    },
  };
}
