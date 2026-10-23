import { h } from '../dom.js';
import { requestJson, randomId } from '../bridge/browser-agent.js';

const MAX_DEPTH = 16;
const MAX_NODES = 200;
const MAX_RAW_BYTES = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const discoveryMarker = tool => object(tool?._meta?.['jet/discovery']) && tool._meta['jet/discovery'].version === 1 ? tool._meta['jet/discovery'] : null;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function rawResult(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(value, null, 2) ?? 'null');
  const text = new TextDecoder().decode(encoded.subarray(0, MAX_RAW_BYTES), { stream: true });
  return h('details', { class: 'tools-raw' }, h('summary', { text: 'Raw result' }), encoded.length > MAX_RAW_BYTES && h('p', { text: 'Raw result truncated at 256 KiB.' }), h('pre', { text }));
}

export function createDiscovery({ container, app, catalogue, updated, details, visibility }) {
  let path = [];
  let generation = 0;
  let pending = null;
  let currentResult = null;
  const button = (text, click) => h('button', { type: 'button', text, onClick: click });
  const status = h('p', { role: 'status' });
  const body = h('div');
  const breadcrumbs = h('nav', { 'aria-label': 'Discovery path' });
  const cancelButton = button('Cancel discovery', () => cancel());
  container.replaceChildren(breadcrumbs, status, cancelButton, body);
  container.hidden = true;
  cancelButton.hidden = true;

  function paintPath() {
    breadcrumbs.replaceChildren(button('Catalogue', () => reset()), ...path.map((step, index) => button(step.label, () => {
      const ancestors = path.slice(0, index);
      expand(step.tool, step.arguments, step.label, ancestors);
    })));
    if (path.length) breadcrumbs.append(button('Back', () => {
      if (path.length < 2) reset();
      else { const parent = path.at(-2); expand(parent.tool, parent.arguments, parent.label, path.slice(0, -2)); }
    }));
  }

  function cancel() {
    generation++;
    const requestId = pending;
    pending = null;
    cancelButton.hidden = true;
    if (!requestId) return;
    status.textContent = 'Discovery cancelled.';
    const current = generation;
    requestJson('/api/tools/cancel', { requestId }).catch(error => {
      if (current === generation) status.textContent = 'Cancellation could not be confirmed: ' + (error.message ?? JSON.stringify(error));
    });
  }

  function reset() {
    cancel();
    path = [];
    currentResult = null;
    body.replaceChildren();
    container.hidden = true;
    visibility(false);
  }

  async function expand(toolName, args, label = toolName, ancestors = path) {
    cancel();
    container.hidden = false;
    visibility(true);
    const metadata = catalogue();
    const tool = metadata?.tools.find(tool => tool.name === toolName);
    if (!tool || !discoveryMarker(tool) || !object(args) || metadata.isStale) {
      status.textContent = 'This target is not available for supported free discovery. Refresh its catalogue.';
      return;
    }
    const key = JSON.stringify([toolName, canonical(args)]);
    if (ancestors.some(step => step.key === key)) { status.textContent = 'Discovery cycle stopped.'; return; }
    if (ancestors.length >= MAX_DEPTH) { status.textContent = 'Discovery depth limit reached (16).'; return; }
    const current = ++generation;
    const requestId = randomId();
    pending = requestId;
    cancelButton.hidden = false;
    status.textContent = 'Loading discovery…';
    body.replaceChildren();
    try {
      const response = await requestJson(`/api/apps/${encodeURIComponent(app.id)}/discovery`, { requestId, tool: toolName, arguments: args });
      if (current !== generation) return;
      updated(response.catalogue);
      path = [...ancestors, { tool: toolName, arguments: args, label, key }];
      currentResult = response.result;
      paintPath();
      render();
    } catch (error) {
      if (current === generation) status.textContent = 'Discovery failed: ' + (error.message ?? JSON.stringify(error.error ?? error));
    } finally {
      if (current === generation) { pending = null; cancelButton.hidden = true; }
    }
  }

  function render() {
    body.replaceChildren();
    const value = currentResult?.structuredContent;
    if (currentResult?.isError || !object(value) || value.version !== 1 || !Array.isArray(value.nodes)) {
      status.textContent = currentResult?.isError ? 'Discovery returned a tool error.' : 'Unsupported discovery result. Raw data is available below.';
      body.append(rawResult(currentResult));
      return;
    }
    status.textContent = value.nodes.length > MAX_NODES ? 'Showing the first 200 nodes. Result limit reached.' : `${value.nodes.length} discovery nodes`;
    let unsupported = false;
    for (const node of value.nodes.slice(0, MAX_NODES)) {
      const tool = catalogue()?.tools.find(tool => tool.name === node?.tool);
      if (!object(node) || typeof node.label !== 'string' || !object(node.arguments) || !tool || !['tool', 'discover'].includes(node.kind) || (node.kind === 'discover' && !discoveryMarker(tool))) {
        unsupported = true;
        body.append(h('p', { class: 'tools-unsupported', text: 'Unsupported target: ' + (typeof node?.label === 'string' ? node.label : 'unknown node') }));
      } else if (node.kind === 'discover') {
        body.append(button('Expand ' + node.label, () => expand(node.tool, node.arguments, node.label)));
      } else {
        body.append(button('Inspect ' + node.label, () => {
          cancel();
          status.textContent = 'Suggested arguments are a draft. Browsing does not execute this tool.';
          body.replaceChildren(details(tool, node.arguments));
        }));
      }
    }
    if (unsupported) body.append(h('p', { text: 'Unsupported targets were not called.' }));
    body.append(rawResult(currentResult));
  }

  paintPath();
  return { start: (tool, args) => expand(tool, args, tool, []), cancel, reset };
}
