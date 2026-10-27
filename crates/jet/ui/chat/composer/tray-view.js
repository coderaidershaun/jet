// The part of the composer that attaches files: the + button, the chips of the files on their way,
// and dragging, dropping and pasting. The tray model decides what a chip is; this draws it and
// sends the files to the server.

import { h, icon } from '../../dom.js';
import { ACCEPT, fileSheet } from '../files.js';
import { MOST_FILES } from './tray.js';

const warn = (what) => (error) => console.warn(what + ':', error);

/**
 * @param {{
 *   box: HTMLElement, trayEl: HTMLElement, composerEl: HTMLElement, dropTarget: HTMLElement,
 *   attachButton: HTMLElement, input: HTMLInputElement, field: HTMLElement,
 *   tray: ReturnType<typeof import('./tray.js').createTray>,
 *   agent: Pick<import('../../bridge/agent.js').Agent, 'uploadFile' | 'removeFile'>,
 *   refresh: () => void,
 *   announce: (message: string) => void,
 * }} options   `refresh` makes the composer ask again whether it may send; `dropTarget` is the area where a dropped file is taken
 */
export function createTrayView({ box, trayEl, composerEl, dropTarget, attachButton, input, field, tray, agent, refresh, announce }) {
  /** @type {Map<string, { el: HTMLElement, body: HTMLElement, bar: HTMLProgressElement, signature: string }>} */
  const nodes = new Map();
  const note = h('p', { class: 'tray-note', role: 'status', hidden: true });
  trayEl.after(note);

  input.accept = ACCEPT;
  attachButton.append(icon('plus'));

  const discard = (id) => agent.removeFile(id).catch(warn('the file could not be removed'));

  function signatureOf(chip) {
    const thumbnail = chip.state !== 'failed' && chip.preview;
    return [thumbnail ? 'picture' : 'sheet', chip.state, chip.reason, chip.about?.details].join('|');
  }

  function metaOf(chip) {
    if (chip.state === 'uploading') return 'Uploading…';
    if (chip.state === 'failed') return chip.reason;
    return [chip.tag, chip.about?.details].filter(Boolean).join(' · ');
  }

  function fill(record, chip) {
    const thumbnail = chip.state !== 'failed' && chip.preview;
    record.el.classList.toggle('is-picture', Boolean(thumbnail));
    record.el.title = thumbnail ? chip.name : chip.state === 'failed' ? chip.name + ': ' + chip.reason : '';
    record.body.replaceChildren(
      ...(thumbnail
        ? [h('img', { class: 'chip-thumb', src: chip.preview, alt: '' })]
        : [fileSheet(chip.tag, { small: true }), h('span', { class: 'chip-text' }, h('span', { class: 'chip-name', text: chip.name }), h('span', { class: 'chip-meta', text: metaOf(chip) }))]),
      record.bar,
    );
    record.el.setAttribute('aria-label', chip.name + ', ' + (chip.state === 'failed' ? chip.reason : chip.state === 'ready' ? 'ready' : 'uploading'));
  }

  function create(chip) {
    const bar = h('progress', { class: 'chip-bar', max: 1, value: 0, 'aria-hidden': 'true' });
    const body = h('span', { class: 'chip-body' });
    const remove = h('button', { class: 'chip-remove', type: 'button', 'aria-label': 'Remove ' + chip.name, onClick: () => removeChip(chip.id) }, icon('close'));
    const el = h('li', { class: 'chip', 'data-format': chip.tag.toLowerCase() }, body, remove);
    return { el, body, bar, signature: '' };
  }

  function paint() {
    const chips = tray.chips;
    trayEl.hidden = chips.length === 0;
    box.classList.toggle('has-tray', chips.length > 0);
    const present = new Set(chips.map((chip) => chip.id));
    for (const [id, record] of nodes) {
      if (present.has(id)) continue;
      record.el.remove();
      nodes.delete(id);
    }
    chips.forEach((chip, index) => {
      let record = nodes.get(chip.id);
      if (!record) {
        record = create(chip);
        nodes.set(chip.id, record);
      }
      record.el.dataset.state = chip.state;
      record.bar.value = chip.progress;
      const signature = signatureOf(chip);
      if (signature !== record.signature) {
        record.signature = signature;
        fill(record, chip);
      }
      if (trayEl.children[index] !== record.el) trayEl.insertBefore(record.el, trayEl.children[index] ?? null);
    });
    const { ready } = tray.counts();
    note.hidden = ready <= MOST_FILES;
    note.textContent = ready > MOST_FILES ? 'A message carries at most ' + MOST_FILES + ' files. Remove ' + (ready - MOST_FILES) + ' to send.' : '';
    refresh();
  }

  function removeChip(id) {
    const chip = tray.remove(id);
    if (chip?.state === 'ready') discard(chip.about.id);
    paint();
    field.focus();
  }

  function upload(chip) {
    const { id, file } = chip;
    const present = () => tray.chips.some((other) => other.id === id);
    agent.uploadFile(file, (fraction) => {
      tray.progress(id, fraction);
      paint();
    }).then(
      (about) => {
        // The chip was removed while the file was on its way, so the saved copy is not wanted.
        if (!present()) {
          discard(about.id);
          return;
        }
        tray.ready(id, about);
        paint();
      },
      (error) => {
        if (!present()) return;
        const reason = error?.message ?? 'The file could not be uploaded.';
        tray.fail(id, reason);
        announce(chip.name + ' was not attached. ' + reason);
        paint();
      },
    );
  }

  function add(files) {
    if (files.length === 0) return;
    for (const chip of tray.add(files)) {
      if (chip.state === 'uploading') upload(chip);
      else announce(chip.name + ' was not attached. ' + chip.reason);
    }
    paint();
  }

  attachButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    add([...input.files]);
    input.value = '';
  });

  const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  const over = (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    composerEl.classList.add('is-dropping');
  };
  dropTarget.addEventListener('dragenter', over);
  dropTarget.addEventListener('dragover', over);
  dropTarget.addEventListener('dragleave', (event) => {
    if (!dropTarget.contains(event.relatedTarget)) composerEl.classList.remove('is-dropping');
  });
  dropTarget.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    composerEl.classList.remove('is-dropping');
    add([...event.dataTransfer.files]);
  });
  // A file dropped anywhere else would make the browser leave the page for it.
  for (const kind of ['dragover', 'drop']) {
    window.addEventListener(kind, (event) => {
      if (carriesFiles(event)) event.preventDefault();
    });
  }
  field.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    add(files);
  });

  return {
    /** The files to send with a message; the tray empties. */
    take() {
      const taken = tray.take();
      paint();
      return taken;
    },

    /** Brings back files that were already saved, as when a held message is cancelled. */
    restore(abouts) {
      tray.restore(abouts);
      paint();
    },
  };
}
