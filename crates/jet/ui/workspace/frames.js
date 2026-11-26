// The app frames of the workspace: one frame per opened app, kept while other apps are shown, with its reachability.
import { h } from '../dom.js';

// A direct app is a page of another site that Jet does not proxy, so the frame alone keeps it from navigating Jet's tab.
const DIRECT_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';
// A proxied page reaches its app through a proof in its own address that lasts an hour, and only a new load of the
// frame gets a new one, so the frame is loaded again before that hour ends. State the app keeps only in its page is lost,
// so a frame the person is working in waits for the focus to leave it, a minute at a time, until the hour is nearly up.
const PROOF_RENEW_MS = 50 * 60_000;
const IN_USE_RETRY_MS = 60_000;
const IN_USE_RETRIES = 8;

export function createFrameContainer(container) {
  const entries = new Map();
  container.append(h('link', { rel: 'stylesheet', href: new URL('./frames.css', import.meta.url).href }));

  function showStatus(entry, state, message) {
    entry.panel.dataset.state = state;
    entry.message.textContent = message;
    entry.retry.hidden = state === 'reachable' || state === 'loading';
  }

  async function check(entry) {
    entry.check?.abort();
    const controller = new AbortController();
    entry.check = controller;
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(entry.app.id)}/ui-status`, { signal: controller.signal });
      if (!response.ok) throw new Error('Jet could not check this registered app.');
      const status = await response.json();
      if (entry.check !== controller) return;
      const state = ['reachable', 'offline', 'incompatible'].includes(status.status) ? status.status : 'incompatible';
      showStatus(entry, state, status.message ?? 'Rendering is controlled by your browser. Open externally if the page is blank.');
    } catch (error) {
      if (entry.check === controller) showStatus(entry, 'offline', error.name === 'AbortError' ? 'App check timed out. Retry when the app is available.' : error.message);
    } finally { clearTimeout(timer); }
  }

  function mount(entry) {
    clearTimeout(entry.renewal);
    entry.frame?.remove();
    entry.frame = null;
    entry.check?.abort();
    entry.check = null;
    const { app } = entry;
    let source;
    try {
      const ui = new URL(app.uiUrl), base = new URL(app.baseUrl);
      if (!['http:', 'https:'].includes(ui.protocol)) throw new Error('This app needs a valid HTTP or HTTPS UI address.');
      if (app.embedding === 'relative-paths') {
        if (ui.origin !== base.origin || !ui.pathname.startsWith(base.pathname)) throw new Error('The UI is outside its registered base. Open externally.');
        source = `/apps/${encodeURIComponent(app.id)}/${ui.pathname.slice(base.pathname.length)}${ui.search}${ui.hash}`;
      } else if (app.embedding === 'direct') {
        if (location.protocol === 'https:' && ui.protocol === 'http:') throw new Error('This direct HTTP app cannot be embedded in HTTPS Jet. Open externally.');
        source = ui.href;
      } else {
        throw new Error('This app does not declare supported embedding. Open externally.');
      }
    } catch (error) { showStatus(entry, 'incompatible', error.message); return; }
    showStatus(entry, 'loading', 'Loading app. Browser framing restrictions may prevent display.');
    const sandbox = app.embedding === 'direct' ? DIRECT_SANDBOX : undefined;
    entry.frame = h('iframe', { class: 'app-frame-page', title: app.label, src: source, sandbox });
    entry.panel.append(entry.frame);
    if (app.embedding === 'relative-paths') renewLater(entry, PROOF_RENEW_MS, IN_USE_RETRIES);
    check(entry);
  }

  function renewLater(entry, waitMs, retriesLeft) {
    entry.renewal = setTimeout(() => {
      const inUse = !entry.panel.hidden && document.activeElement === entry.frame;
      if (inUse && retriesLeft > 0) renewLater(entry, IN_USE_RETRY_MS, retriesLeft - 1);
      else mount(entry);
    }, waitMs);
  }

  function open(app) {
    for (const [id, entry] of entries) entry.panel.hidden = id !== app.id;
    let entry = entries.get(app.id);
    if (!entry) {
      const message = h('span', { role: 'status', 'aria-live': 'polite' });
      const external = h('a', { target: '_blank', rel: 'noopener noreferrer', text: 'Open externally' });
      const retry = h('button', { type: 'button', text: 'Retry', onClick: () => reload(app.id) });
      const panel = h('section', { class: 'app-frame', 'aria-label': app.label }, h('div', { class: 'app-frame-status' }, message, retry, external));
      panel.dataset.appId = app.id;
      entry = { app, panel, message, retry, external, frame: null, check: null, renewal: 0 };
      entries.set(app.id, entry);
      container.append(panel);
      mount(entry);
    } else {
      entry.app = app;
      entry.panel.hidden = false;
      entry.panel.setAttribute('aria-label', app.label);
      entry.frame?.setAttribute('title', app.label);
      if (entry.frame) check(entry);
    }
    update(app);
  }

  function update(app) {
    const entry = entries.get(app.id);
    if (!entry) return;
    entry.app = app;
    entry.panel.setAttribute('aria-label', app.label);
    entry.frame?.setAttribute('title', app.label);
    try {
      const url = new URL(app.uiUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid UI address');
      entry.external.setAttribute('href', url.href);
      entry.external.hidden = false;
    } catch { entry.external.hidden = true; }
  }

  function reload(id) {
    const entry = entries.get(id);
    if (entry) mount(entry);
  }

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.check?.abort();
    entry.check = null;
    clearTimeout(entry.renewal);
    entry.panel.remove();
    entries.delete(id);
  }

  return { open, reload, remove, update };
}
