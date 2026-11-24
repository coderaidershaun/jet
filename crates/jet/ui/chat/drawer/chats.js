// The user's chats as the left pane lists them: which one is open, how many Jet entries each one
// holds that the user has not seen, and the calls that add, rename and remove a chat.

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
      items = await agent.chats();
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
