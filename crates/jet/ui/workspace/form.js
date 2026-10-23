import { h } from '../dom.js';
import { requestJson } from '../bridge/browser-agent.js';

export function createAppForm({ saved }) {
  const title = h('h2', { id: 'app-form-title' });
  const address = h('input', { name: 'address', required: true, placeholder: '8080 or https://example.com/app/' });
  const label = h('input', { name: 'label', placeholder: 'Use the app name' });
  const ui = h('input', { name: 'ui', placeholder: 'Discover automatically' });
  const mcp = h('select', { name: 'mcp' }, ...[['discover', 'Discover automatically'], ['disabled', 'No tools (UI only)'], ['url', 'Manual MCP URL']].map(([value, text]) => h('option', { value, text })));
  const mcpUrl = h('input', { name: 'mcpUrl', placeholder: 'mcp or https://example.com/mcp' });
  const embedding = h('select', { name: 'embedding' }, ...[['', 'Discover automatically'], ['relative-paths', 'App supports mounted paths'], ['direct', 'Embed browser-reachable URL'], ['external', 'Open externally']].map(([value, text]) => h('option', { value, text })));
  const field = (text, input) => h('label', {}, h('span', { text }), input);
  const error = h('p', { role: 'alert', class: 'app-form-error' });
  const save = h('button', { type: 'submit', class: 'action', text: 'Save app' });
  const cancel = h('button', { type: 'button', class: 'text-button', text: 'Cancel', onClick: close });
  const advanced = h('details', {}, h('summary', { text: 'Advanced endpoints' }), field('UI URL', ui), field('MCP tools', mcp), field('MCP URL', mcpUrl), field('Embedding', embedding));
  const form = h('form', {}, title, field('Address', address), field('Label override', label), advanced, error, h('div', { class: 'app-form-actions' }, cancel, save));
  const dialog = h('dialog', { class: 'app-form', 'aria-labelledby': 'app-form-title' }, form);
  document.body.append(dialog);
  let generation = 0;
  let editing = null;
  let opener = null;
  function close() { generation++; dialog.close(); }
  mcp.addEventListener('change', () => { mcpUrl.disabled = mcp.value !== 'url'; mcpUrl.required = mcp.value === 'url'; });
  dialog.addEventListener('close', () => opener?.focus());
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = generation;
    save.disabled = true;
    error.textContent = '';
    const overrides = { ...editing?.overrides, label: label.value.trim() || null, ui: ui.value.trim() || null, embedding: embedding.value || null, mcp: mcp.value === 'url' ? { mode: 'url', url: mcpUrl.value.trim() } : { mode: mcp.value } };
    try {
      const result = await requestJson('/api/apps', { action: editing ? 'edit' : 'add', ...(editing ? { id: editing.id } : {}), address: address.value.trim(), overrides });
      if (current !== generation) return;
      close();
      await saved(result);
    } catch (failure) { if (current === generation) error.textContent = failure.message ?? String(failure); }
    finally { if (current === generation) save.disabled = false; }
  });
  return {
    open(app = null) {
      generation++;
      save.disabled = false;
      editing = app;
      opener = document.activeElement;
      title.textContent = app ? 'Edit app' : 'Add app';
      address.value = app?.baseUrl ?? '';
      label.value = app?.overrides.label ?? '';
      ui.value = app?.overrides.ui ?? '';
      mcp.value = app?.overrides.mcp?.mode ?? 'discover';
      mcpUrl.value = app?.overrides.mcp?.url ?? '';
      mcp.dispatchEvent(new Event('change'));
      embedding.value = app?.overrides.embedding ?? '';
      advanced.open = false;
      error.textContent = '';
      dialog.showModal();
      address.focus();
    },
  };
}
