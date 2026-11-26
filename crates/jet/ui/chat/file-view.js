// The one place a saved file opens, whatever its kind: a dialog with the file on the left and what can be done with it on the right.
// A user's or Jet's HTML is untrusted, so it is never fetched and inserted. Its frame holds Jet's own wrapper
// document (/api/files/{id}/frame), which holds the file in a frame of its own: sandboxed to scripts only and, by the
// wrapper's policy, unable to send itself to another site. The sandbox is there, and in the file's own response
// headers, not on this outer frame: a sandboxed wrapper would lose its origin, and its inner request the sign-in.

import { h, icon } from '../dom.js';
import { chatIcon } from './drawer/chats.js';
import { fileLinks, sizeOf } from './files.js';
import { files } from './library/store.js';
import { deleteAsk, kindLabel, splitName, whenWords } from './library/words.js';

const CONFIRM_MS = 4000;
const NO_PREVIEW = { xlsx: "Excel workbooks can't be shown here. Download it to open it." };
const PREVIEW_FAILED = "This file can't be shown here. Download it to open it.";
const GONE = 'This file was deleted.';
const IMAGES = new Set(['png', 'jpeg', 'gif', 'webp']);
const TEXTS = new Set(['text', 'markdown', 'csv']);
/** A text preview shows this much of the file; a longer file says it is cut. */
const TEXT_LIMIT = 200000;

/** @type {{ chats: () => { id: number, title: string, kind: string, activeAt: number }[], openChat: (id: number) => void, announce: (message: string) => void }} */
let page = { chats: () => [], openChat: () => {}, announce: () => {} };
let dialog = null, parts = null;
/** The file asked for: its id and what the opener knew of it, for the moment before the list is read. */
let asked = null;
/** The last full record of that file, which the dialog keeps showing, greyed, once the file is deleted. */
let lastKnown = null;
/** Where the focus goes back to on close: the opener, or when its file is gone, the next row or the library's search. */
let opener = null, openerKey = null, nearKey = null, search = null;
let picking = false, renaming = false, armed = false, busy = false, drawing = false, armTimer = 0;
let previewKey = '', versionsKey = '', sideLook = '';
/** When each version of the open file was written, by number. */
let versionTimes = new Map();

/** The address a file opens at in a tab of its own: an HTML page in its wrapper, a workbook as a download. */
export function tabHref(file) {
  const links = fileLinks(file.id);
  if (!links) return null;
  return file.kind === 'html' ? links.frame : file.kind === 'xlsx' ? links.download : links.view;
}

const textButton = (label, onClick, props = {}) => h('button', { type: 'button', class: 'text-button', onClick: (event) => onClick(event.currentTarget), ...props }, label);
const titleOf = (chatId) => page.chats().find((chat) => chat.id === chatId)?.title ?? 'A chat';
const say = (what, error) => page.announce(`${(lastKnown ?? asked).name} could not be ${what}: ${error?.message ?? 'Jet did not answer.'}`);

function build() {
  const name = h('h2', { class: 'file-view-name', id: 'file-view-name' });
  const rename = h('button', { type: 'button', class: 'icon-button file-view-rename', 'data-key': 'rename', title: 'Rename', onClick: startRename }, icon('pencil'));
  const close = h('button', { type: 'button', class: 'icon-button file-view-close', 'aria-label': 'Close', title: 'Close', onClick: () => dialog.close() }, icon('close'));
  const preview = h('div', { class: 'file-view-preview' });
  const side = h('div', { class: 'file-view-side' });
  dialog = h('dialog', { class: 'file-view', 'aria-labelledby': 'file-view-name' },
    h('header', { class: 'file-view-head' }, name, rename, close),
    h('div', { class: 'file-view-body' }, preview, side));
  parts = { name, rename, close, preview, side };
  // A tap on the dim edge around the sheet closes it.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  // Escape leaves the chat picker or the rename first, and only then the dialog.
  dialog.addEventListener('cancel', (event) => {
    if (renaming) { event.preventDefault(); return; }
    if (!picking) return;
    event.preventDefault();
    picking = false;
    draw();
    focusKey('add');
  });
  dialog.addEventListener('close', () => {
    preview.replaceChildren();
    previewKey = sideLook = '';
    versionsKey = '';
    picking = renaming = armed = false;
    clearTimeout(armTimer);
    const byKey = (key) => (key ? document.querySelector(`[data-key="${CSS.escape(key)}"]`) : null);
    [opener, byKey(openerKey), byKey(nearKey), search].find((el) => el?.isConnected)?.focus();
    opener = openerKey = nearKey = search = null;
  });
  document.body.append(dialog);
}

function focusKey(key) {
  const target = dialog.querySelector(`[data-key="${CSS.escape(key)}"]`);
  target?.focus();
  return target;
}

function previewOf(file) {
  const links = fileLinks(file.id);
  const words = (text) => h('p', { class: 'file-view-words', text });
  if (NO_PREVIEW[file.kind]) return words(NO_PREVIEW[file.kind]);
  if (IMAGES.has(file.kind)) {
    const picture = h('img', { class: 'file-view-image', src: links.view, alt: file.name });
    picture.addEventListener('error', () => picture.replaceWith(words(PREVIEW_FAILED)));
    return picture;
  }
  if (TEXTS.has(file.kind)) return textPreview(links.view, words);
  return h('iframe', { referrerpolicy: 'no-referrer', title: file.name, src: file.kind === 'html' ? links.frame : links.view });
}

/** Text, Markdown and CSV are shown as plain text on the dialog's own ground. The text goes in as text, never as markup. */
function textPreview(src, words) {
  const box = h('div', { class: 'file-view-text', tabindex: '0' });
  const key = previewKey;
  readText(src).then((text) => {
    if (previewKey !== key) return;
    box.append(h('pre', { text: text.slice(0, TEXT_LIMIT) }));
    if (text.length > TEXT_LIMIT) box.append(h('p', { class: 'file-view-cut', text: 'This is the start of the file. Download it to see all of it.' }));
  }, (error) => {
    console.warn('the text of the file could not be read:', error);
    if (previewKey === key) box.replaceWith(words(PREVIEW_FAILED));
  });
  return box;
}

async function readText(src) {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`the server answered ${response.status} for ${src}`);
  return response.text();
}

/** `status` is the store's word for the file: an unknown file shows nothing until the server has said whether it is there. */
function drawPreview(file, status) {
  const key = status === 'present' ? `${file.id}:${file.version ?? 0}` : status;
  if (key === previewKey) return;
  previewKey = key;
  parts.preview.dataset.kind = status === 'present' ? file.kind : status;
  parts.preview.replaceChildren(...(status === 'gone' ? [h('p', { class: 'file-view-words', text: GONE })] : status === 'present' ? [previewOf(file)] : []));
}

/** The facts of the file, as plain muted lines. What the opener knew is enough until the list is read. */
function factLines(file) {
  const now = Date.now();
  const lines = [[kindLabel(file.kind), file.bytes === undefined ? '' : sizeOf(file.bytes)].filter(Boolean).join(' · ')];
  if (file.changedAt !== undefined) lines.push(`Changed ${whenWords(file.changedAt, now)} · version ${file.version}`);
  if (file.by) lines.push(file.by === 'jet' ? 'Written by Jet' : 'Sent by you');
  return h('div', { class: 'file-view-facts' }, ...lines.map((text) => h('p', { text })));
}

function takeActions(file, gone) {
  const links = fileLinks(file.id);
  const link = (props, ...children) => h('a', gone ? { class: props.class, 'aria-disabled': 'true' } : props, ...children);
  return h('div', { class: 'file-view-actions' },
    link({ class: 'file-view-download', href: links.download, download: file.name, 'data-key': 'download' }, icon('download'), 'Download'),
    link({ class: 'file-view-tab', href: tabHref(file), target: '_blank', rel: 'noopener', 'data-key': 'tab' }, 'Open in a new tab'));
}

function chatLines(file) {
  const canRemove = file.chats.length >= 2;
  const line = (chatId) => {
    const title = titleOf(chatId);
    const chat = page.chats().find((item) => item.id === chatId) ?? { id: chatId, kind: 'chat' };
    return h('li', { class: 'file-view-chat' },
      h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon(chatIcon(chat))),
      h('button', { type: 'button', class: 'file-view-chat-open', 'data-key': `chat-${chatId}`, title, onClick: () => { dialog.close(); page.openChat(chatId); } }, title),
      canRemove ? textButton('Remove', (el) => act(el, 'removed from that chat', () => files.takeFrom(file.id, chatId)), { 'aria-label': `Remove from ${title}`, 'data-key': `remove-${chatId}` }) : null);
  };
  return h('section', { class: 'file-view-section' },
    h('h3', { text: 'In chats' }),
    h('ul', { class: 'file-view-list' }, ...file.chats.map(line)),
    textButton('Add to a chat', () => { picking = true; draw(); (dialog.querySelector('.file-view-pick') ?? focusKey('pick-cancel'))?.focus(); }, { class: 'text-button file-view-add', 'data-key': 'add' }));
}

function versionLines(file) {
  if (file.earlier.length === 0) return null;
  const when = (version) => (versionTimes.has(version) ? ` · ${whenWords(versionTimes.get(version), Date.now())}` : '');
  return h('section', { class: 'file-view-section' },
    h('h3', { text: 'Versions' }),
    h('ul', { class: 'file-view-list' },
      h('li', { class: 'file-view-version' }, h('span', { text: `Version ${file.version}${when(file.version)}` }), h('span', { class: 'file-view-current', text: 'Current' })),
      ...file.earlier.map((version) => h('li', { class: 'file-view-version' }, h('span', { text: `Version ${version}${when(version)}` }),
        textButton('Restore', (el) => act(el, 'restored', () => files.restore(file.id, version)), { 'aria-label': `Restore version ${version}`, 'data-key': `restore-${version}` })))));
}

function deleteButton(file, gone) {
  const label = armed ? deleteAsk(file.chats.length) : 'Delete';
  return h('button', {
    type: 'button', class: armed ? 'text-button file-view-delete is-armed' : 'text-button file-view-delete', 'data-key': 'delete', disabled: gone,
    onClick: (event) => askDelete(file, event.currentTarget),
    onBlur: () => { if (armed && !drawing) disarm(); },
  }, label);
}

function picker(file) {
  const open = page.chats().filter((chat) => !file.chats.includes(chat.id)).toSorted((a, b) => b.activeAt - a.activeAt);
  const pick = (chat) => h('li', {}, h('button', { type: 'button', class: 'file-view-pick', 'data-key': `pick-${chat.id}`, onClick: (event) => act(event.currentTarget, 'added to that chat', () => files.addTo(file.id, chat.id), () => { picking = false; }) },
    h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon(chatIcon(chat))), h('span', { class: 'file-view-pick-title', text: chat.title })));
  return [h('section', { class: 'file-view-section' },
    h('h3', { text: 'Add to a chat' }),
    open.length ? h('ul', { class: 'file-view-list' }, ...open.map(pick)) : h('p', { class: 'file-view-hint', text: 'Every chat already holds this file.' }),
    textButton('Cancel', () => { picking = false; draw(); focusKey('add'); }, { 'data-key': 'pick-cancel' }))];
}

function draw() {
  if (!dialog?.open) return;
  const status = files.statusOf(asked.id);
  const gone = status === 'gone';
  lastKnown = files.byId(asked.id) ?? lastKnown;
  const file = lastKnown ?? asked;
  const known = 'chats' in file;
  if (gone) { picking = renaming = armed = false; }
  if (!renaming) parts.name.textContent = file.name;
  parts.rename.disabled = gone || !known;
  parts.rename.hidden = renaming;
  parts.rename.setAttribute('aria-label', `Rename ${file.name}`);
  drawPreview(file, status);
  dialog.dataset.gone = String(gone);
  // The column is kept while nothing it shows has changed, so a tap that lands as the list is read again still lands.
  const look = JSON.stringify([file, gone, picking, armed, [...versionTimes], page.chats().map((chat) => [chat.id, chat.title])]);
  if (look !== sideLook) drawSide(file, gone, known);
  sideLook = look;
  if (!gone && known && file.earlier.length && versionsKey !== `${file.id}:${file.version}`) readVersions(file);
}

function drawSide(file, gone, known) {
  const focused = parts.side.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  drawing = true;
  parts.side.replaceChildren(...(picking && known ? picker(file) : [
    factLines(file),
    takeActions(file, gone),
    !gone && file.context ? h('p', { class: 'file-view-note', text: file.context }) : null,
    !gone && known ? chatLines(file) : null,
    !gone && known ? versionLines(file) : null,
    known ? h('div', { class: 'file-view-foot' }, deleteButton(file, gone)) : null,
  ].filter(Boolean)));
  drawing = false;
  if (focused) focusKey(focused);
}

async function readVersions(file) {
  versionsKey = `${file.id}:${file.version}`;
  try {
    const read = await files.versions(file.id);
    if (versionsKey !== `${file.id}:${file.version}`) return;
    versionTimes = new Map(read.map((version) => [version.version, version.changedAt]));
    draw();
  } catch (error) {
    // The versions still show by number; only their times are missing.
    console.warn('the versions could not be read:', error);
  }
}

/** One change asked of the server. The control rests while it runs; the list shows the change when the page hears of it. */
async function act(el, what, call, done = () => {}) {
  if (busy) return;
  busy = true;
  el.disabled = true;
  try {
    await call();
    done();
  } catch (error) {
    say(what, error);
  }
  busy = false;
  el.disabled = false;
  draw();
}

function disarm() {
  clearTimeout(armTimer);
  armed = false;
  draw();
}

function askDelete(file, el) {
  if (!armed) {
    armed = true;
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, CONFIRM_MS);
    draw();
    focusKey('delete');
    return;
  }
  clearTimeout(armTimer);
  armed = false;
  // The Delete button turns off once the file is gone, so the focus moves to Close and does not fall to the page.
  act(el, 'deleted', () => files.remove(file.id), () => parts.close.focus());
}

function startRename() {
  const file = files.byId(asked.id);
  if (!file) return;
  renaming = true;
  const { stem, extension } = splitName(file.name);
  const input = h('input', { class: 'file-view-rename-input', type: 'text', value: stem, 'aria-label': 'File name', enterkeyhint: 'done' });
  const end = (save) => {
    if (!renaming) return;
    renaming = false;
    const name = input.value.trim() + (extension ? '.' + extension : '');
    if (save && input.value.trim() !== '' && name !== file.name) files.rename(file.id, name).catch((error) => say('renamed', error));
    draw();
    parts.rename.focus();
  };
  input.addEventListener('keydown', (event) => {
    // Without preventDefault the Enter would go on to press the Rename button that takes the focus back.
    if (event.key === 'Enter') { event.preventDefault(); end(true); }
    else if (event.key === 'Escape') { event.preventDefault(); end(false); }
  });
  input.addEventListener('blur', () => end(true));
  parts.rename.hidden = true;
  parts.name.replaceChildren(input, extension ? h('span', { class: 'file-view-extension', text: '.' + extension }) : '');
  input.focus();
  input.select();
}

/**
 * Gives the dialog what it needs of the rest of the page: the chats, a way to open one, and the announcer.
 * @param {typeof page} given
 */
export function connectFileView(given) {
  page = given;
  files.subscribe(draw);
}

/** Shows a saved file in the dialog; nothing happens for an id that is not a saved file's. @param {{ id: string, name: string, kind: string }} file */
export function viewFile(file) {
  if (!fileLinks(file.id)) return;
  if (!dialog) build();
  if (!dialog.open) {
    opener = document.activeElement;
    openerKey = opener?.dataset?.key ?? null;
    const row = opener?.closest?.('li');
    nearKey = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector('[data-key]')?.dataset.key ?? null;
    search = opener?.closest?.('.library')?.querySelector('.library-search') ?? null;
  }
  asked = { id: file.id.toLowerCase(), name: file.name, kind: file.kind };
  lastKnown = null;
  picking = renaming = armed = false;
  previewKey = sideLook = '';
  versionTimes = new Map();
  if (!dialog.open) dialog.showModal();
  draw();
  parts.close.focus();
}

/** A plain click opens the file here; a middle or modified click keeps its link and opens the tab. @param {{ id: string, name: string, kind: string }} file */
export const viewOnClick = (file) => (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  viewFile(file);
};

/** The link attributes that open a file in the dialog, and in a tab on a middle or modified click. Null for an id that is not a saved file's. */
export function openProps(file) {
  const href = tabHref(file);
  return href ? { href, target: '_blank', rel: 'noopener', onClick: viewOnClick(file) } : null;
}
