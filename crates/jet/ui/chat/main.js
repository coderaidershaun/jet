// Starts the chat page: loads the saved settings and the history, builds
// every part of the page and hands each the parts it needs. The agent is connected
// here and nowhere else; every other part is handed it.

import { createCommands } from '../workspace/commands.js';
import { createCommandMenu } from '../workspace/completion.js';
import { createToolBrowser } from '../workspace/tools.js';
import { createWorkspace } from '../workspace/shell.js';
import { h, icon } from '../dom.js';
import { connectAgent } from '../bridge/agent.js';
import { displayName, loadSettings, saveSettings } from '../bridge/settings.js';
import { createComposer } from './composer/state.js';
import { createComposerView } from './composer/view.js';
import { describeCache } from './drawer/cache.js';
import { createLog } from './drawer/log.js';
import { createUsageTracker } from './drawer/usage.js';
import { createDrawerView } from './drawer/view.js';
import { modelPicker } from './settings/model-picker.js';
import { createSheet } from './settings/sheet.js';
import { createLive } from './stage/live.js';
import { createFollow } from './thread/scroll.js';
import { createThread } from './thread/store.js';
import { createThreadView } from './thread/view.js';
import { createTurn } from './turn.js';

const CACHE_CHECK_MS = 60 * 1000;
const $ = (id) => document.getElementById(id);
const warn = (what) => (error) => console.warn(what + ':', error);

async function start() {
  const settings = await loadSettings();
  const agent = connectAgent();
  const [history, status] = await Promise.all([agent.history(), agent.status()]);

  const page = $('page');
  const diagnostics = h('details', { class: 'diagnostics' }, h('summary', { text: 'Usage and diagnostics' }), $('drawer'));
  page.prepend(diagnostics);
  page.querySelector('.header').append($('gear'));
  let toolBrowser, commandMenu;
  const workspace = createWorkspace({ agent, page, onTools: appId => toolBrowser.open(appId) });
  const commandResult = h('pre', { class: 'command-result', role: 'status', 'aria-label': 'App command result' });
  page.prepend(commandResult);
  const commands = createCommands({ workspace, report: text => { commandResult.textContent = text; } });
  const systemReduces = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => settings.reducedMotion || systemReduces.matches;
  const applyReduced = () => document.documentElement.classList.toggle('reduced', reducedMotion());
  applyReduced();

  const thread = createThread();
  thread.load(history);
  const follow = createFollow();
  const composer = createComposer({ empty: history.length === 0 });
  const tracker = createUsageTracker();
  let cache = status.cache;

  const quickModel = modelPicker(settings, async () => {
    drawer.setModel(settings);
    await saveSettings(settings);
    const latest = await agent.status();
    showProgramStatus(latest.claude);
  });
  $('composer').append(quickModel.el);

  $('gear').append(icon('gear'));
  $('drawer-toggle').append(icon('menu'));
  $('held-cancel').append(icon('close'));
  $('jump').prepend(icon('down'));

  const view = createThreadView({
    scroller: $('thread'),
    rowsEl: $('rows'),
    bannerEl: $('banner'),
    jumpButton: $('jump'),
    follow,
    handlers: {
      retry: () => turn.retry(),
      openSettings: (section) => sheet.open(section),
      openLink: (url) => agent.openLink(url).catch(warn('the link could not be opened')),
      render: (text) => agent.renderMarkdown(text),
      readImage: (path) => agent.readLibraryImage(path),
    },
  });

  const composerView = createComposerView({
    page,
    composer: $('composer'),
    field: $('field'),
    button: $('send'),
    heldChip: $('held'),
    heldCancel: $('held-cancel'),
    state: composer,
    reducedMotion,
    handlers: {
      send: (text) => commands.submit(text, () => turn.send(text)),
      hold: (text) => commands.submit(text, () => turn.hold(text)),
      input: (text) => commandMenu?.input(text),
      keydown: (event) => commandMenu?.keydown(event),
      stop: () => turn.stop(),
      cancelHold: () => turn.cancelHold(),
    },
  });

  commandMenu = createCommandMenu({ field: $('field'), container: $('composer'), commands, setText: composerView.setText });
  toolBrowser = createToolBrowser({ container: workspace.toolsContent, agent, draft: text => { workspace.showChat(); composerView.setText(text); } });
  agent.onAppOpened?.(async (action, current) => {
    await workspace.refresh();
    if (!current()) return;
    try { workspace.openApp(action.appId); }
    catch (error) { commandResult.textContent = error.message; }
  });

  const drawer = createDrawerView({
    page,
    toggles: [$('drawer-toggle')],
    scrim: $('scrim'),
    jetSvg: $('drawer-jet'),
    nameEl: $('drawer-name'),
    titleEl: $('drawer-title'),
    chipEl: $('cache-chip'),
    modelEl: $('model-caption'),
    usageEl: $('usage'),
    logToggle: $('log-toggle'),
    logList: $('log-list'),
    copyButton: $('log-copy'),
    clearButton: $('log-clear'),
    gearButton: $('gear'),
    log: createLog(),
    handlers: {
      openSettings: () => sheet.open(),
      dockedChanged: (open) => {
        settings.drawerOpen = open;
        saveSettings(settings);
      },
    },
  });

  diagnostics.addEventListener('toggle', () => { if (diagnostics.open) drawer.init(false); });

  const live = createLive({
    reducedMotion: reducedMotion(),
    heroSlot: $('hero'),
    scrollToBottom: () => view.scrollToBottom(),
  });

  const paintCache = () => drawer.setCache(describeCache(cache, Date.now()));
  function showProgramStatus(program) {
    if (program.found) {
      view.setBanner(null);
      return;
    }
    const message = "I couldn't find " + (program.provider ?? "Claude Code") + ". I looked in: " + program.searched.join(', ');
    view.setBanner(message, { label: 'Settings', run: () => sheet.open('claude') });
  }
  async function refreshStatus() {
    try {
      const latest = await agent.status();
      cache = latest.cache;
      showProgramStatus(latest.claude);
    } catch (error) {
      console.warn('the agent status could not be read:', error);
    }
    paintCache();
  }

  const turn = createTurn({
    agent,
    settings,
    thread,
    view,
    follow,
    composer,
    composerView,
    live,
    drawer,
    tracker,
    page: { headerStatus: $('header-status'), announce: $('announce') },
    afterReply: refreshStatus,
    activeAppId: workspace.activeAppId,
  });

  function paintPersona() {
    const name = displayName(settings);
    const title = settings.persona.jobTitle.trim() || 'assistant';
    $('header-name').textContent = name;
    $('greeting').textContent = "Hi, I'm " + name + ', your ' + title.charAt(0).toLowerCase() + title.slice(1) + '.';
    composerView.setPlaceholder('Message ' + name);
    $('held-text').textContent = 'Sends when ' + name + ' finishes';
    live.setName(name);
    drawer.setPersona({ name, jobTitle: title });
  }

  async function forget() {
    await agent.forget();
    thread.clear();
    view.render([]);
    composer.reset();
    composerView.setHeld(null);
    composerView.setLayout('centred');
    live.showHero();
    sheet.close();
    refreshStatus();
  }

  const sheet = createSheet({
    dialog: $('sheet'),
    context: {
      settings,
      agent,
      totals: () => tracker.snapshot().total,
      systemReducesMotion: () => systemReduces.matches,
      onClaudeChecked: showProgramStatus,
      onForget: forget,
    },
    save: () => saveSettings(settings),
    onChange: (kind) => {
      if (kind === 'persona') paintPersona();
      else if (kind === 'model') { drawer.setModel(settings); quickModel.refresh(); }
      else if (kind === 'motion') {
        applyReduced();
        live.setReducedMotion(reducedMotion());
      }
    },
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (diagnostics.open && !sheet.isOpen) { event.preventDefault(); diagnostics.open = false; diagnostics.querySelector('summary').focus(); return; }
    const action = composer.escape({ sheetOpen: sheet.isOpen, overlayDrawerOpen: drawer.overlayOpen });
    if (action === 'none') return;
    event.preventDefault();
    if (action === 'closeSheet') sheet.close();
    else if (action === 'closeDrawer') drawer.setOpen(false);
    else turn.stop();
  });
  systemReduces.addEventListener('change', () => {
    applyReduced();
    live.setReducedMotion(reducedMotion());
  });

  drawer.init(false);
  drawer.setModel({ model: settings.model, effort: settings.effort });
  drawer.setUsage(tracker.snapshot());
  paintPersona();
  showProgramStatus(status.claude);
  page.dataset.layout = composer.layout;
  if (history.length === 0) {
    live.showHero();
  } else {
    turn.paint();
    view.scrollToBottom();
    live.showInLane(view.liveLane());
  }
  paintCache();
  setInterval(paintCache, CACHE_CHECK_MS);
  live.start();
  agent.watch?.((snapshot) => { turn.restore(snapshot); workspace.refresh(); }, (event) => turn.observe(event));
}

start().catch((error) => {
  console.error(error);
  const message = document.createElement('p');
  message.className = 'boot-error';
  message.textContent = 'Jet could not start: ' + (error && error.message ? error.message : error);
  document.body.append(message);
});
