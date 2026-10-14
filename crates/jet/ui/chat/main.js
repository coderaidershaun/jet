// Starts the chat page: loads the rig, the saved settings and the history, builds
// every part of the page and hands each the parts it needs. The agent is connected
// here and nowhere else; every other part is handed it.

import { connectAgent } from '../bridge/agent.js';
import { loadRig } from '../bridge/rig.js';
import { loadSettings, saveSettings } from '../bridge/settings.js';
import { cssColour } from '../jet/state.js';
import { createComposer } from './composer/state.js';
import { createComposerView } from './composer/view.js';
import { icon } from './dom.js';
import { describeCache } from './drawer/cache.js';
import { createLog } from './drawer/log.js';
import { createDrawerView } from './drawer/view.js';
import { createSheet } from './settings/sheet.js';
import { createLive } from './stage/live.js';
import { createFollow } from './thread/scroll.js';
import { createThread } from './thread/store.js';
import { createThreadView } from './thread/view.js';
import { createTurn } from './turn.js';

const LEAN_BACK_AFTER_MS = 1500;
const CACHE_CHECK_MS = 60 * 1000;
const $ = (id) => document.getElementById(id);
const warn = (what) => (error) => console.warn(what + ':', error);

async function start() {
  const [rig, settings] = await Promise.all([loadRig(), loadSettings()]);
  const defaultColour = rig.palette.rest.slice();
  const agent = connectAgent();
  const [history, status] = await Promise.all([agent.history(), agent.status()]);

  const page = $('page');
  const systemReduces = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => settings.reducedMotion || systemReduces.matches;
  const params = () => ({
    candid: settings.behaviour.candid,
    playful: settings.behaviour.playful,
    ...settings.expressiveness.channels,
    reducedMotion: reducedMotion(),
  });
  const applyReduced = () => document.documentElement.classList.toggle('reduced', reducedMotion());
  const applyColour = () => {
    rig.palette.rest.splice(0, 3, ...(settings.bodyColour ?? defaultColour));
    document.documentElement.style.setProperty('--jet', cssColour(rig.palette.rest));
  };
  applyReduced();
  applyColour();

  const thread = createThread();
  thread.load(history);
  const follow = createFollow();
  const composer = createComposer({ empty: history.length === 0 });
  const totals = { costUsd: 0, tokens: 0, cacheReadTokens: 0 };
  let cache = status.cache;
  let leanTimer = 0;

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
      send: (text) => turn.send(text),
      hold: (text) => turn.hold(text),
      stop: () => turn.stop(),
      cancelHold: () => turn.cancelHold(),
      typing: (text) => {
        live.typing(text !== '', performance.now());
        clearTimeout(leanTimer);
        if (text !== '') leanTimer = setTimeout(() => live.typing(false, performance.now()), LEAN_BACK_AFTER_MS);
      },
    },
  });

  const drawer = createDrawerView({
    page,
    toggle: $('drawer-toggle'),
    scrim: $('scrim'),
    jetSvg: $('drawer-jet'),
    nameEl: $('drawer-name'),
    titleEl: $('drawer-title'),
    chipEl: $('cache-chip'),
    modelEl: $('model-caption'),
    logList: $('log-list'),
    copyButton: $('log-copy'),
    clearButton: $('log-clear'),
    gearButton: $('gear'),
    rig,
    log: createLog(),
    handlers: {
      openSettings: () => sheet.open(),
      dockedChanged: (open) => {
        settings.drawerOpen = open;
        saveSettings(settings);
      },
    },
  });

  const live = createLive({
    rig,
    params,
    heroSlot: $('hero'),
    scrollToBottom: () => view.scrollToBottom(),
    motion: () => settings.expressiveness.channels.motion,
  });

  const paintCache = () => drawer.setCache(describeCache(cache, Date.now()));
  function showClaude(claude) {
    if (claude.found) {
      view.setBanner(null);
      return;
    }
    const message = "I couldn't find Claude Code. I looked in: " + claude.searched.join(', ');
    view.setBanner(message, { label: 'Settings', run: () => sheet.open('claude') });
  }
  async function refreshStatus() {
    try {
      const latest = await agent.status();
      cache = latest.cache;
      showClaude(latest.claude);
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
    totals,
    page: { headerStatus: $('header-status'), announce: $('announce') },
    afterReply: refreshStatus,
  });

  function paintPersona() {
    const name = settings.persona.name.trim() || 'Jet';
    const title = settings.persona.jobTitle.trim() || 'assistant';
    $('header-name').textContent = name;
    $('greeting').textContent = "Hi, I'm " + name + ', your ' + title.charAt(0).toLowerCase() + title.slice(1) + '.';
    composerView.setPlaceholder('Message ' + name);
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
      defaultColour,
      totals,
      systemReducesMotion: () => systemReduces.matches,
      onClaudeChecked: showClaude,
      onForget: forget,
    },
    save: () => saveSettings(settings),
    onChange: (kind) => {
      if (kind === 'persona') paintPersona();
      else if (kind === 'colour') {
        applyColour();
        drawer.recolour();
        live.recolour();
      } else if (kind === 'model') drawer.setModel(settings.model);
      else if (kind === 'motion') {
        applyReduced();
        live.refresh();
      } else if (kind === 'expressiveness') live.refresh();
    },
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const action = composer.escape({ sheetOpen: sheet.isOpen, overlayDrawerOpen: drawer.overlayOpen });
    if (action === 'none') return;
    event.preventDefault();
    if (action === 'closeSheet') sheet.close();
    else if (action === 'closeDrawer') drawer.setOpen(false);
    else turn.stop();
  });
  systemReduces.addEventListener('change', () => {
    applyReduced();
    live.refresh();
  });

  drawer.init(settings.drawerOpen);
  drawer.setModel(settings.model);
  paintPersona();
  showClaude(status.claude);
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
}

start().catch((error) => {
  console.error(error);
  const message = document.createElement('p');
  message.className = 'boot-error';
  message.textContent = 'Jet could not start: ' + (error && error.message ? error.message : error);
  document.body.append(message);
});
