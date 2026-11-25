// The user's chats as the left pane lists them: which one is open, how many Jet entries each one
// holds that the user has not seen, and the calls that add, rename and remove a chat.

import { KITES } from '../../dom.js';

const MARKS = Object.keys(KITES);
/**
 * The name of the icon a chat wears: the main chat its speech bubble, every other chat one of the twenty marks.
 * The id picks it, so it is the same on every draw; 7 shares no factor with 20, so chats made one after another all differ.
 * @param {{ id: number, kind: string }} chat
 */
export const chatIcon = (chat) => (chat.kind === 'main' ? 'chat' : MARKS[(chat.id * 7) % MARKS.length]);

/** The main chat first, then the others with the newest activity on top. @param {import('../../bridge/agent.js').ChatSummary[]} chats */
function orderChats(chats) {
  const others = chats.filter((chat) => chat.kind !== 'main').toSorted((a, b) => b.activeAt - a.activeAt);
  return [...chats.filter((chat) => chat.kind === 'main'), ...others];
}

/**
 * @param {{
 *   agent: Pick<import('../../bridge/agent.js').Agent, 'chats' | 'addChat' | 'renameChat' | 'removeChat' | 'markRead'>,
 *   attending?: () => boolean,
 *   onChange?: () => void,
 *   onGone?: () => void,
 * }} parts   `attending` is false while the user cannot see the page, so what arrives then stays unread;
 *   `onGone` runs when the open chat no longer exists
 */
export function createChats({ agent, attending = () => true, onChange = () => {}, onGone = () => {} }) {
  /** @type {import('../../bridge/agent.js').ChatSummary[]} */
  let items = [];
  let openId = null;
  let asked = 0;
  let shown = 0;
  const find = (id) => items.find((chat) => chat.id === id);
  const watching = (id) => id === openId && attending();
  const markRead = (id, through) => agent.markRead(id, through).catch((error) => console.warn('the read mark could not be moved:', error));

  const chats = {
    /** The rows to show. The chat the user is looking at never shows a badge. */
    get items() {
      return orderChats(items).map((chat) => ({ ...chat, unread: watching(chat.id) ? 0 : chat.unread }));
    },

    get openId() {
      return openId;
    },

    get mainId() {
      return items.find((chat) => chat.kind === 'main')?.id ?? null;
    },

    async refresh() {
      const read = ++asked;
      const fresh = await agent.chats();
      // Replies can arrive out of order: an answer older than one already shown is dropped.
      if (read < shown) return;
      shown = read;
      items = fresh;
      onChange();
      if (openId !== null && !find(openId)) onGone();
    },

    /** The chat is on screen: its badge clears, and the server is told once. */
    opened(id) {
      openId = id;
      const chat = find(id);
      if (chat) chat.unread = 0;
      onChange();
      markRead(id);
    },

    /** The page is visible again, so what arrived meanwhile in the open chat counts as seen. */
    attend() {
      const chat = find(openId);
      if (!chat || chat.unread === 0 || !attending()) return;
      chat.unread = 0;
      onChange();
      markRead(chat.id);
    },

    /** An event of the one stream that concerns the list: `unread`, `entryAdded` or `chatsChanged`. */
    handle({ chatId, event }) {
      switch (event.kind) {
        case 'unread': {
          const chat = find(chatId);
          if (!chat) return;
          if (event.unread > chat.unread) chat.activeAt = Date.now();
          chat.unread = event.unread;
          if (watching(chatId) && event.unread > 0) {
            chat.unread = 0;
            markRead(chatId);
          }
          onChange();
          break;
        }
        case 'chatsChanged':
          chats.refresh().catch((error) => console.warn('the chat list could not be read:', error));
          break;
        case 'entryAdded':
          // The thread shows the entry; the `unread` event that follows it moves the mark.
        case 'paneChanged':
          // The plan pane reads this one itself.
          break;
        default:
          console.warn('an event the chat list does not know:', event.kind);
      }
    },

    async add() {
      const chat = await agent.addChat();
      items = [...items.filter((item) => item.id !== chat.id), chat];
      onChange();
      return chat.id;
    },

    async rename(id, title) {
      await agent.renameChat(id, title);
      const chat = find(id);
      if (chat) chat.title = title;
      onChange();
    },

    async remove(id) {
      await agent.removeChat(id);
      items = items.filter((chat) => chat.id !== id);
      onChange();
      if (id === openId) onGone();
    },
  };
  return chats;
}
