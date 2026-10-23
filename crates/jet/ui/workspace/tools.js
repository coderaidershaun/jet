import { h } from '../dom.js';
import { requestJson } from '../bridge/browser-agent.js';
import { createDiscovery, discoveryMarker, rawResult } from './discovery.js';

export function createToolBrowser({ container, agent, draft }) {
  const selector = h('select', { 'aria-label': 'Tool app' });
  const status = h('p', { role: 'status', class: 'tools-status' });
  const configuration = h('p', { class: 'tools-configuration' });
  const search = h('input', { type: 'search', placeholder: 'Search tools', 'aria-label': 'Search tools' });
  const metadata = h('section', { class: 'tools-server', 'aria-label': 'Tool server' });
  const list = h('div', { class: 'tools-catalogue' });
  const discoveryView = h('section', { class: 'discovery-view', 'aria-label': 'Discovery', hidden: true });
  const refreshButton = h('button', { type: 'button', text: 'Refresh tools', onClick: () => refresh() });
  container.replaceChildren(h('link', { rel: 'stylesheet', href: new URL('./tools.css', import.meta.url).href }), h('label', {}, 'App', selector), configuration, status, refreshButton, metadata, search, list, discoveryView);
  let selected = null;
  let apps = [];
  let catalogue = null;
  let catalogueAppId = null;
  let generation = 0;
  let discovery = null;

  function toolDetails(tool, args = {}) {
    const app = apps.find(app => app.id === selected);
    return h('section', { class: 'tool-details' }, h('h3', { text: tool.name }), h('p', { text: tool.description ?? 'No description supplied.' }),
      h('h4', { text: 'Input schema' }), h('pre', { text: JSON.stringify(tool.inputSchema, null, 2) }),
      tool.outputSchema && h('h4', { text: 'Output schema' }), tool.outputSchema && h('pre', { text: JSON.stringify(tool.outputSchema, null, 2) }),
      h('h4', { text: 'Annotations' }), h('pre', { text: JSON.stringify(tool.annotations ?? {}, null, 2) }),
      h('h4', { text: 'Suggested arguments' }), h('pre', { text: JSON.stringify(args, null, 2) }),
      h('button', { type: 'button', text: 'Ask Jet about ' + tool.name, onClick: () => draft(`Please help me use ${tool.name} from ${app.label} (app ID ${app.id}). Suggested arguments: ${JSON.stringify(args)}. Inspect its schema and clarify anything missing before calling it.`) }));
  }

  function renderCatalogue() {
    list.replaceChildren();
    if (!catalogue) return;
    const query = search.value.trim().toLowerCase();
    const tools = catalogue.tools.filter(tool => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query));
    for (const tool of tools) {
      const marker = discoveryMarker(tool);
      const root = marker?.entryArguments;
      const canBrowse = root !== null && typeof root === 'object' && !Array.isArray(root);
      const detail = h('details', { class: 'tool-summary', 'data-tool': tool.name }, h('summary', { text: tool.name }), h('p', { text: tool.description ?? '' }), toolDetails(tool));
      if (canBrowse) detail.append(h('button', { type: 'button', text: 'Browse ' + tool.name, disabled: catalogue.isStale, onClick: () => discovery.start(tool.name, root) }));
      list.append(detail);
    }
    if (!tools.length) list.append(h('p', { text: 'No matching tools.' }));
  }

  function showCatalogue(value) {
    catalogue = value;
    catalogueAppId = selected;
    const server = value.server;
    metadata.replaceChildren(h('h3', { text: `${server.name} ${server.version}` }), h('p', { text: 'Protocol: ' + server.protocolVersion }), h('details', {}, h('summary', { text: 'Server instructions and capabilities' }), h('p', { text: server.instructions ?? 'No instructions supplied.' }), h('pre', { text: JSON.stringify(server.capabilities, null, 2) })));
    status.textContent = value.isStale ? 'Stale metadata: ' + (value.lastError ?? 'Refresh to reconnect.') : `${value.tools.length} tools available`;
    renderCatalogue();
  }

  async function load(force, current) {
    const app = apps.find(app => app.id === selected);
    const previous = catalogueAppId === app?.id ? catalogue : null;
    catalogue = null;
    metadata.replaceChildren();
    list.replaceChildren();
    configuration.textContent = app ? `${app.label} · ${app.id}\nMCP endpoint: ${app.mcpUrl ?? 'not configured'}` : '';
    refreshButton.disabled = !app || !app.mcpUrl || !app.enabled;
    search.disabled = refreshButton.disabled;
    if (!app) { status.textContent = selected ? 'This app is no longer registered.' : apps.length ? 'Choose an app to inspect its tools.' : 'No apps registered. Add an app to browse its tools.'; return; }
    if (!app.mcpUrl || !app.enabled) { status.textContent = !app.enabled ? 'This app is disabled. Enable it to load tools.' : 'This app has no MCP endpoint configured. Its UI remains available.'; return; }
    discovery = createDiscovery({ container: discoveryView, app, catalogue: () => catalogue, updated: showCatalogue, details: toolDetails, visibility: active => { list.hidden = search.hidden = metadata.hidden = active; } });
    status.textContent = 'Loading tools…';
    try {
      const value = await requestJson(`/api/apps/${encodeURIComponent(app.id)}/tools`, force ? {} : undefined);
      if (current !== generation) return;
      showCatalogue(value);
    } catch (error) {
      if (current !== generation) return;
      const message = error.message ?? JSON.stringify(error.error ?? error);
      if (previous) showCatalogue({ ...previous, isStale: true, lastError: message });
      else { status.textContent = 'Tool metadata could not be loaded: ' + message; metadata.append(rawResult(error)); }
    }
  }

  async function open(appId = null) {
    discovery?.reset();
    discoveryView.hidden = true;
    metadata.replaceChildren();
    list.replaceChildren();
    configuration.textContent = '';
    search.disabled = refreshButton.disabled = true;
    const current = ++generation;
    selected = appId;
    status.textContent = 'Loading apps…';
    try {
      const next = await requestJson('/api/apps');
      if (current !== generation) return;
      apps = next;
      selector.replaceChildren(h('option', { value: '', text: 'Choose an app' }), ...apps.map(app => h('option', { value: app.id, text: app.label + (app.enabled ? '' : ' · disabled') })));
      selector.value = selected ?? '';
      await load(false, current);
    } catch (error) { if (current === generation) status.textContent = 'Apps could not be loaded: ' + (error.message ?? String(error)); }
  }
  async function refresh() {
    discovery?.reset();
    await load(true, ++generation);
  }
  selector.addEventListener('change', () => open(selector.value || null));
  search.addEventListener('input', renderCatalogue);
  agent.onRegistryChanged?.(() => open(selected));
  return { open, refresh, cancel() { generation++; discovery?.cancel(); } };
}
