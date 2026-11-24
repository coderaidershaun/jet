import { h, icon } from '../dom.js';
import { requestJson } from '../bridge/browser-agent.js';
import { createFrameContainer } from './frames.js';
import { createPlanPane } from '../plan/pane.js';

export function createWorkspace({ agent, page, onTools = () => {}, openChat = () => {} }) {
  const narrow = matchMedia('(max-width: 759px)');
  let expanded = !narrow.matches;
  let mode = 'chat', apps = [], selected = null, refreshNumber = 0;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const drawer = document.getElementById('drawer');
  const inner = drawer.querySelector('.drawer-inner');
  const appButton = app => { const label = app.label + (app.enabled ? '' : ' · disabled'); return h('button', { type: 'button', class: 'workspace-button', 'aria-label': label, title: label, 'data-app-id': app.id, onClick: () => select(app) }, h('span', { class: 'nav-icon', 'aria-hidden': 'true', text: app.label.slice(0, 1).toUpperCase() }), h('span', { class: 'nav-label', text: app.label })); };
  const toggle = document.getElementById('jet-toggle');
  toggle.addEventListener('click', () => { if (mode !== 'chat') api.showChat(); else { expanded = !expanded; paint(); } });
  const list = inner.querySelector('.app-list');
  const frameHost = h('div', { class: 'workspace-frames', tabindex: '-1', 'aria-label': 'App content' });
  const notice = h('p', { class: 'workspace-notice', role: 'status' });
  const toolsContent = h('section', { id: 'tools-content', 'aria-label': 'App tools', tabindex: '-1' });
  const content = h('main', { class: 'workspace-content' }, page, frameHost, toolsContent, notice);
  const sidePane = h('aside', { class: 'side-pane', id: 'side-pane', hidden: true });
  // On a phone the chats are one button in the chat's head, and open over the page with a scrim that closes them.
  const chatsCount = h('span', { class: 'chats-count', 'aria-hidden': 'true', hidden: true });
  const chatsButton = h('button', { type: 'button', class: 'chats-toggle', 'aria-controls': 'drawer', 'aria-expanded': 'false', 'aria-label': 'Chats', title: 'Chats', onClick: openChats }, icon('menu'), chatsCount);
  const scrim = h('div', { class: 'drawer-scrim', 'aria-hidden': 'true', hidden: true, onClick: () => closeChats() });
  const root = h('div', { class: 'workspace-shell' }, drawer, content, sidePane, scrim);
  document.body.prepend(root);
  content.append(chatsButton, createPlanPane({ shell: root, host: sidePane, agent, openChat }).button);

  function openChats() {
    expanded = true;
    paint();
    (drawer.querySelector('.chat-open[aria-current="true"]') ?? drawer.querySelector('button'))?.focus();
  }
  /** Folds the drawer, and gives the focus back to whichever control opens it at this width. */
  function closeChats() {
    expanded = false;
    paint();
    (narrow.matches ? chatsButton : toggle).focus();
  }
  const frames = createFrameContainer(frameHost);

  function paint() {
    root.dataset.expanded = String(expanded);
    root.dataset.mode = mode;
    content.inert = narrow.matches && expanded;
    sidePane.inert = narrow.matches && expanded;
    scrim.hidden = !(narrow.matches && expanded);
    chatsButton.setAttribute('aria-expanded', String(narrow.matches && expanded));
    page.hidden = mode !== 'chat';
    frameHost.hidden = mode !== 'app';
    toolsContent.hidden = mode !== 'tools';
    toggle.setAttribute('aria-expanded', String(expanded));
    const label = mode !== 'chat' ? 'Return to chat' : expanded ? 'Collapse drawer' : 'Expand drawer';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    toggle.setAttribute('aria-current', String(mode === 'chat'));
    for (const item of list.children) item.setAttribute('aria-current', String(mode === 'app' && item.dataset.appId === selected));
  }
  function select(app) {
    selected = app.id;
    mode = 'app';
    expanded = false;
    frames.open(app);
    paint();
    frameHost.focus();
  }
  async function refresh() {
    const current = ++refreshNumber;
    try {
      const next = await requestJson('/api/apps');
      if (current !== refreshNumber) return;
      for (const app of apps) if (!next.some(item => item.id === app.id)) frames.remove(app.id);
      apps = next;
      notice.textContent = '';
      if (selected && !apps.some(app => app.id === selected)) {
        selected = null;
        if (mode === 'app') { mode = 'chat'; expanded = !narrow.matches; }
      }
      for (const app of apps) frames.update(app);
      list.replaceChildren(...apps.map(appButton));
      paint();
      resolveReady();
      return true;
    } catch (error) {
      if (current === refreshNumber) {
        notice.textContent = 'Apps could not be loaded: ' + (error.message ?? String(error));
        resolveReady();
      }
    }
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.target.id === 'field' && document.querySelector('.command-menu:not([hidden])')) return;
    if (event.target.classList?.contains('chat-rename')) return;
    if (expanded && (narrow.matches || drawer.contains(event.target))) {
      closeChats();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  narrow.addEventListener('change', () => { expanded = !narrow.matches && mode === 'chat'; paint(); });
  agent.onRegistryChanged?.(refresh);
  const api = {
    activeAppId: () => selected,
    appLabels: () => apps.map(app => app.label),
    refresh,
    ready,
    toolsContent,
    openApp(id) { const app = apps.find(item => item.id === id); if (!app) throw new Error('This app is no longer registered.'); select(app); },
    async reloadApp(id) { if (!await refresh()) throw new Error('Apps could not be refreshed. Try reloading again.'); if (!apps.some(item => item.id === id)) throw new Error('This app is no longer registered.'); frames.reload(id); },
    showChat() { mode = 'chat'; expanded = !narrow.matches; paint(); document.getElementById('field').focus(); },
    /** The number of unread entries in all chats, on the phone's chats button. */
    setUnread(count) {
      chatsCount.hidden = count === 0;
      chatsCount.textContent = count > 99 ? '99+' : String(count);
      const label = count === 0 ? 'Chats' : `Chats, ${count} unread`;
      chatsButton.setAttribute('aria-label', label);
      chatsButton.title = label;
    },
    showTools(appId = null) { mode = 'tools'; expanded = false; paint(); toolsContent.focus(); onTools(appId); },
  };
  paint();
  refresh();
  return api;
}
