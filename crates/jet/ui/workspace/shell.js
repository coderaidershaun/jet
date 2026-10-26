import { h } from '../dom.js';
import { requestJson } from '../bridge/browser-agent.js';
import { createFrameContainer } from './frames.js';

export function createWorkspace({ agent, page, onTools = () => {} }) {
  const narrow = matchMedia('(max-width: 759px)');
  let expanded = !narrow.matches;
  let mode = 'chat', apps = [], selected = null, refreshNumber = 0;
  const drawer = document.getElementById('drawer');
  const inner = drawer.querySelector('.drawer-inner');
  const button = (label, glyph, onClick, attrs = {}) => h('button', { type: 'button', class: 'workspace-button', 'aria-label': label, title: label, onClick, ...attrs }, h('span', { class: 'nav-icon', 'aria-hidden': 'true', text: glyph }));
  const toggle = document.getElementById('jet-toggle');
  toggle.addEventListener('click', () => { if (mode !== 'chat') api.showChat(); else { expanded = !expanded; paint(); } });
  const list = inner.querySelector('.app-list');
  const frameHost = h('div', { class: 'workspace-frames', tabindex: '-1', 'aria-label': 'App content' });
  const notice = h('p', { class: 'workspace-notice', role: 'status' });
  const toolsContent = h('section', { id: 'tools-content', 'aria-label': 'App tools', tabindex: '-1' });
  const content = h('main', { class: 'workspace-content' }, page, frameHost, toolsContent, notice);
  const root = h('div', { class: 'workspace-shell' }, drawer, content);
  document.body.prepend(root);
  const frames = createFrameContainer(frameHost);

  function paint() {
    root.dataset.expanded = String(expanded);
    root.dataset.mode = mode;
    content.inert = narrow.matches && expanded;
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
      list.replaceChildren(...apps.map(app => button(app.label + (app.enabled ? '' : ' · disabled'), app.label.slice(0, 1).toUpperCase(), () => select(app), { 'data-app-id': app.id })));
      paint();
      return true;
    } catch (error) { if (current === refreshNumber) notice.textContent = 'Apps could not be loaded: ' + (error.message ?? String(error)); }
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.target.id === 'field' && document.querySelector('.command-menu:not([hidden])')) return;
    if (expanded && (narrow.matches || drawer.contains(event.target))) {
      expanded = false;
      paint();
      toggle.focus();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  narrow.addEventListener('change', () => { expanded = !narrow.matches && mode === 'chat'; paint(); });
  window.addEventListener('focus', refresh);
  agent.onRegistryChanged?.(refresh);
  const api = {
    activeAppId: () => selected,
    refresh,
    toolsContent,
    openApp(id) { const app = apps.find(item => item.id === id); if (!app) throw new Error('This app is no longer registered.'); select(app); },
    async reloadApp(id) { if (!await refresh()) throw new Error('Apps could not be refreshed. Try reloading again.'); if (!apps.some(item => item.id === id)) throw new Error('This app is no longer registered.'); frames.reload(id); },
    showChat() { mode = 'chat'; expanded = !narrow.matches; paint(); document.getElementById('field').focus(); },
    showTools(appId = null) { mode = 'tools'; expanded = false; paint(); toolsContent.focus(); onTools(appId); },
  };
  paint();
  refresh();
  return api;
}
