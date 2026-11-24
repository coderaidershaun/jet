// Draws the chat list in the left pane and turns taps into calls: open, new chat, rename in place,
// and delete after a second tap on the same row. It also tells the page how many entries are unread in all.

import { h, icon } from '../../dom.js';

const CONFIRM_MS = 4000;
const TITLE_LIMIT = 80;

/**
 * @param {{
 *   list: HTMLElement,
 *   titleEl: HTMLElement,
 *   newButton: HTMLElement,
 *   chats: ReturnType<typeof import('./chats.js').createChats>,
 *   open: (id: number) => void,
 *   announce: (message: string) => void,
 *   showUnread?: (count: number) => void,
 * }} parts
 */
export function createChatsView({ list, titleEl, newButton, chats, open, announce, showUnread = () => {} }) {
  let renaming = null;
  let confirming = null;
  let confirmTimer = 0;
  let repainting = false;
  /** Each row keeps its element while nothing it shows has changed, so a tap that lands as the list repaints still lands. */
  const rows = new Map();

  const problem = (what) => (error) => announce(`${what}: ${error?.message ?? 'Jet did not answer.'}`);
  // Each chat but the main one shows its first letter, so two objectives in the rail can be told apart; the style marks an objective's.
  const glyph = (chat) => (chat.kind === 'main' ? icon('chat') : chat.title.trim().charAt(0).toUpperCase() || '#');

  function stopConfirming() {
    clearTimeout(confirmTimer);
    if (confirming === null) return;
    confirming = null;
    paint();
  }

  function startRename(chat) {
    stopConfirming();
    renaming = chat.id;
    paint();
    const input = list.querySelector('.chat-rename');
    input.focus();
    input.select();
  }

  function endRename(chat, input, save) {
    if (renaming !== chat.id) return;
    renaming = null;
    const title = input.value.trim();
    if (save && title !== '' && title !== chat.title) chats.rename(chat.id, title).catch(problem('The chat could not be renamed'));
    paint();
  }

  function renameInput(chat) {
    const input = h('input', { class: 'chat-rename', type: 'text', value: chat.title, maxlength: TITLE_LIMIT, 'aria-label': 'Chat title', enterkeyhint: 'done' });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') endRename(chat, input, true);
      else if (event.key === 'Escape') endRename(chat, input, false);
    });
    input.addEventListener('blur', () => endRename(chat, input, true));
    return input;
  }

  function askDelete(chat) {
    if (confirming !== chat.id) {
      confirming = chat.id;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(stopConfirming, CONFIRM_MS);
      paint();
      list.querySelector('.chat-delete.is-confirming')?.focus();
      return;
    }
    clearTimeout(confirmTimer);
    confirming = null;
    chats.remove(chat.id).catch(problem('The chat could not be deleted'));
    paint();
  }

  function actions(chat) {
    const rename = h('button', { class: 'chat-action', type: 'button', title: 'Rename', 'aria-label': `Rename ${chat.title}`, onClick: () => startRename(chat) }, icon('pencil'));
    if (chat.kind === 'main') return h('span', { class: 'chat-actions' }, rename);
    const sure = confirming === chat.id;
    const remove = h('button', {
      class: sure ? 'chat-action chat-delete is-confirming' : 'chat-action chat-delete',
      type: 'button',
      title: sure ? 'Tap again to delete' : 'Delete',
      'aria-label': sure ? `Delete ${chat.title} for good` : `Delete ${chat.title}`,
      onClick: () => askDelete(chat),
      onBlur: () => { if (!repainting && confirming === chat.id) stopConfirming(); },
    }, sure ? h('span', { text: 'Delete?' }) : icon('trash'));
    return h('span', { class: 'chat-actions' }, rename, remove);
  }

  function row(chat) {
    const current = chat.id === chats.openId;
    const mark = h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, glyph(chat));
    const item = h('li', { class: 'chat-row', 'data-chat-id': chat.id, 'data-kind': chat.kind });
    if (renaming === chat.id) {
      item.append(mark, renameInput(chat));
      return item;
    }
    const label = chat.unread > 0 ? `${chat.title}, ${chat.unread} unread` : chat.title;
    const badge = chat.unread > 0 ? h('span', { class: 'badge', text: chat.unread > 99 ? '99+' : String(chat.unread) }) : null;
    item.append(
      h('button', { class: 'chat-open', type: 'button', title: chat.title, 'aria-label': label, 'aria-current': String(current), onClick: () => open(chat.id) },
        mark, h('span', { class: 'nav-label chat-title', text: chat.title }), badge),
      actions(chat),
    );
    return item;
  }

  function paint() {
    // A list that is rebuilt under a field being typed in would take the cursor away.
    if (renaming !== null && list.querySelector('.chat-rename')) return;
    titleEl.textContent = chats.items.find((chat) => chat.id === chats.openId)?.title ?? '';
    showUnread(chats.items.reduce((sum, chat) => sum + chat.unread, 0));
    repainting = true;
    const shown = chats.items.map((chat) => {
      const look = [chat.title, chat.unread, chat.kind, chat.id === chats.openId, renaming === chat.id, confirming === chat.id].join('|');
      const kept = rows.get(chat.id);
      if (kept?.look === look) return kept;
      const made = { look, el: row(chat) };
      rows.set(chat.id, made);
      return made;
    });
    for (const id of rows.keys()) if (!shown.some((made) => rows.get(id) === made)) rows.delete(id);
    list.replaceChildren(...shown.map((made) => made.el));
    repainting = false;
  }

  newButton.prepend(icon('plus'));
  newButton.addEventListener('click', async () => {
    try { open(await chats.add()); }
    catch (error) { problem('A new chat could not be made')(error); }
  });
  return { paint };
}
