import { h } from '../dom.js';
import { requestJson } from '../bridge/browser-agent.js';
import { createFrameContainer } from './frames.js';
import { createAppForm } from './form.js';

export function createWorkspace({ agent, page }) {
  const narrow = matchMedia('(max-width: 759px)');
  let preference = {};
  try { preference = JSON.parse(localStorage.getItem('jet.workspace')) ?? {}; } catch { /* Storage can be unavailable in private browser sessions. */ }
  let width = Number.isFinite(preference.width) ? Math.max(300, Math.min(720, preference.width)) : 360;
  let navOpen = preference.navOpen !== false;
  let dockOpen = preference.dockOpen !== false;
  let mode = 'chat';
  let apps = [];
  let selected = null;
  let refreshNumber = 0;
  const button = (text, onClick, attrs = {}) => h('button', { type: 'button', class: 'workspace-button', text, onClick, ...attrs });
  const list = h('nav', { class: 'app-list', 'aria-label': 'Registered apps' });
  const notice = h('p', { class: 'workspace-notice', role: 'status' });
  const name = h('h1', { class: 'workspace-title', tabindex: '-1', text: 'Your workspace' });
  const frameHost = h('div', { class: 'workspace-frames' });
  const empty = h('div', { class: 'workspace-empty' }, h('h2', { text: 'Bring your apps together' }), h('p', { text: 'Add a running app by address, or start a conversation with Jet.' }));
  const edit = button('Edit app', () => form.open(apps.find((app) => app.id === selected)));
  const reload = button('Reload app', () => frames.reload(selected));
  const navToggle = button('Apps', () => { navOpen = !navOpen; if (narrow.matches && navOpen) dockOpen = false; paint(); }, { 'aria-controls': 'app-navigation' });
  const dockToggle = button('Chat', () => api.showChat(), { 'aria-controls': 'workspace-dock' });
  const nav = h('aside', { id: 'app-navigation', class: 'app-navigation', 'aria-label': 'Apps' }, h('div', { class: 'workspace-bar' }, h('strong', { text: 'Apps' }), button('Hide apps', () => { navOpen = false; paint(); navToggle.focus(); })), button('Add app', () => form.open()), list);
  empty.append(button('Add app', () => form.open()));
  const chatTab = button('Chat', () => api.showChat(), { 'aria-controls': 'page' });
  const toolsTab = button('Tools', () => api.showTools(), { 'aria-controls': 'tools-content' });
  const toolsContent = h('section', { id: 'tools-content', 'aria-label': 'App tools', tabindex: '-1' }, h('p', { text: 'Select an app to explore its tools.' }));
  const resize = h('div', { class: 'dock-resize', role: 'separator', tabindex: '0', 'aria-label': 'Chat dock width', 'aria-orientation': 'vertical', 'aria-valuemin': '300', 'aria-valuemax': '720' });
  const dock = h('aside', { id: 'workspace-dock', class: 'workspace-dock', 'aria-label': 'Jet dock' }, resize, h('div', { class: 'workspace-bar' }, chatTab, toolsTab, button('Hide dock', () => { api.hideDock(); dockToggle.focus(); })), page, toolsContent);
  const workspace = h('main', { class: 'app-workspace' }, h('header', { class: 'workspace-bar' }, navToggle, name, edit, reload, dockToggle), notice, empty, frameHost);
  const root = h('div', { class: 'workspace-shell' }, nav, workspace, dock);
  document.body.prepend(root);
  const frames = createFrameContainer(frameHost);
  const form = createAppForm({ saved: async (result) => {
    selected = result.app.id;
    await refresh();
    const discovery = result.discovery;
    notice.textContent = discovery && !['ready', 'available', 'found'].includes(discovery.status ?? discovery.kind) ? 'App saved. Discovery: ' + (discovery.message ?? discovery.reason ?? discovery.status ?? discovery.kind ?? JSON.stringify(discovery)) : 'App saved.';
  } });

  function paint() {
    if (narrow.matches && dockOpen) navOpen = false;
    nav.hidden = !navOpen;
    dock.hidden = !dockOpen;
    page.hidden = mode !== 'chat';
    toolsContent.hidden = mode !== 'tools';
    navToggle.setAttribute('aria-expanded', String(navOpen));
    dockToggle.setAttribute('aria-expanded', String(dockOpen));
    chatTab.setAttribute('aria-pressed', String(mode === 'chat'));
    toolsTab.setAttribute('aria-pressed', String(mode === 'tools'));
    root.style.setProperty('--dock-width', Math.min(width, Math.max(300, innerWidth - (navOpen ? 208 : 0) - 300)) + 'px');
    resize.setAttribute('aria-valuenow', String(width));
    root.dataset.nav = String(navOpen);
    root.dataset.dock = String(dockOpen);
    const overlay = narrow.matches && (navOpen || dockOpen);
    workspace.inert = overlay;
    try { localStorage.setItem('jet.workspace', JSON.stringify({ width, navOpen, dockOpen })); } catch { /* Panel controls also work without storage. */ }
  }
  function select(app) {
    selected = app.id;
    name.textContent = app.label;
    empty.hidden = true;
    edit.hidden = reload.hidden = false;
    frames.open(app);
    for (const item of list.children) item.setAttribute('aria-current', String(item.dataset.appId === selected));
    if (narrow.matches) { navOpen = false; dockOpen = false; }
    paint();
    if (narrow.matches) name.focus();
  }
  async function refresh() {
    const current = ++refreshNumber;
    try {
      const next = await requestJson('/api/apps');
      if (current !== refreshNumber) return;
      for (const app of apps) if (!next.some((item) => item.id === app.id)) frames.remove(app.id);
      apps = next;
      if (!apps.some((app) => app.id === selected)) selected = null;
      list.replaceChildren(...apps.map((app) => button(app.label + (app.enabled ? '' : ' · disabled'), () => select(app), { 'data-app-id': app.id, 'aria-current': String(app.id === selected), title: app.baseUrl })));
      const active = apps.find((app) => app.id === selected);
      if (active) { name.textContent = active.label; frames.open(active); }
      else { name.textContent = 'Your workspace'; }
      empty.hidden = Boolean(active);
      edit.hidden = reload.hidden = !active;
    } catch (error) { if (current === refreshNumber) notice.textContent = 'Apps could not be loaded: ' + (error.message ?? String(error)); }
  }
  resize.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    width = event.key === 'Home' ? 300 : event.key === 'End' ? 720 : Math.max(300, Math.min(720, width + (event.key === 'ArrowLeft' ? 20 : -20)));
    paint();
  });
  resize.addEventListener('pointerdown', (event) => {
    resize.setPointerCapture(event.pointerId);
    const start = event.clientX, initial = width;
    const move = (next) => { width = Math.max(300, Math.min(720, initial + start - next.clientX)); paint(); };
    const done = () => { resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', done); resize.removeEventListener('pointercancel', done); };
    resize.addEventListener('pointermove', move);
    resize.addEventListener('pointerup', done);
    resize.addEventListener('pointercancel', done);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (narrow.matches && (navOpen || dockOpen)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (dockOpen) { dockOpen = false; paint(); dockToggle.focus(); }
      else { navOpen = false; paint(); navToggle.focus(); }
    }
  }, true);
  window.addEventListener('resize', paint);
  window.addEventListener('focus', refresh);
  agent.onRegistryChanged?.(refresh);
  const api = {
    activeAppId: () => selected,
    refresh,
    toolsContent,
    showChat() { mode = 'chat'; dockOpen = true; if (narrow.matches) navOpen = false; paint(); chatTab.focus(); },
    showTools(appId) { if (appId) { const app = apps.find((item) => item.id === appId); if (app) select(app); } mode = 'tools'; dockOpen = true; if (narrow.matches) navOpen = false; paint(); toolsTab.focus(); },
    hideDock() { dockOpen = false; paint(); dockToggle.focus(); },
  };
  paint();
  refresh();
  return api;
}
