// All chat components share one agent connection.

import { createCommands } from '../workspace/commands.js';
import { createCommandMenu } from '../workspace/completion.js';
import { createToolBrowser } from '../workspace/tools.js';
import { createWorkspace } from '../workspace/shell.js';
import { h, icon } from '../dom.js';
import { failLoading, finishLoading } from '../loading.js';
import { connectAgent } from '../bridge/agent.js';
import { requestJson } from '../bridge/browser-agent.js';
import { displayName, loadSettings, saveSettings } from '../bridge/settings.js';
import { createComposer } from './composer/state.js';
import { createTray } from './composer/tray.js';
import { createTrayView } from './composer/tray-view.js';
import { createComposerView } from './composer/view.js';
import { createDrawerView } from './drawer/view.js';
import { createSheet } from './settings/sheet.js';
import { createLive } from './stage/live.js';
import { createFollow } from './thread/scroll.js';
import { createThread } from './thread/store.js';
import { createReveal } from './thread/throttle.js';
import { createThreadView } from './thread/view.js';
import { createJobWatcher } from './thread/cards/job-watch.js';
import { createTurn } from './turn.js';
import { createVoicePlayer } from './voice/player.js';
import { createSpokenReveal } from './voice/spoken.js';
import { createVoiceToggle } from './voice/toggle.js';

const $ = (id) => document.getElementById(id);
const warn = (what) => (error) => console.warn(what + ':', error);

async function start() {
  const settings = await loadSettings();
  const agent = connectAgent();
  const [history, status, voiceStatus] = await Promise.all([
    agent.history(),
    agent.status(),
    agent.voiceStatus().catch((error) => {
      console.warn('the voice status could not be read:', error);
      return { available: false, reason: 'The voice could not be reached' };
    }),
  ]);

  const page = $('page');
  let toolBrowser, commandMenu;
  const workspace = createWorkspace({ agent, page, onTools: appId => toolBrowser.open(appId) });
  const commandResult = h('pre', { class: 'command-result', role: 'status', 'aria-label': 'Command result' });
  $('rows').after(commandResult);
  function reportCommand(text) {
    commandResult.textContent = text;
    page.classList.toggle('has-command-result', Boolean(text));
    if (text && !page.hidden) commandResult.scrollIntoView({ block: 'nearest' });
  }
  const commands = createCommands({ workspace, report: reportCommand, settings, save: saveSettings, changed: () => { drawer.setContext(settings.model); refreshStatus(); } });
  const systemReduces = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => settings.reducedMotion || systemReduces.matches;
  const applyReduced = () => document.documentElement.classList.toggle('reduced', reducedMotion());
  applyReduced();

  const jobs = createJobWatcher({ request: (path, body) => requestJson(path, body) });
  const thread = createThread();
  thread.load(history);
  const follow = createFollow();
  const tray = createTray({
    held: () => thread.held?.attachments.length ?? 0,
    preview: { make: (file) => URL.createObjectURL(file), revoke: (url) => URL.revokeObjectURL(url) },
  });
  const composer = createComposer({ empty: history.length === 0, tray });
  $('gear').append(icon('gear'));
  $('context-toggle').append(icon('chevron'));
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
      readImage: (appId, path) => agent.readAppImage(appId, path),
      watchJob: jobs.watch,
    },
  });

  function submit(text) {
    const appId = workspace.activeAppId();
    // The files leave the tray at once, so the chips go as the message does. A command carries none.
    const attachments = text.trimStart().startsWith('/') ? [] : trayView.take();
    return commands.submit(text, () => composer.replying ? turn.hold(text, appId, attachments) : turn.send(text, appId, attachments));
  }

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
      send: submit,
      hold: submit,
      input: (text) => { commandMenu?.input(text); live.typing(); },
      keydown: (event) => commandMenu?.keydown(event),
      stop: () => turn.stop(),
      cancelHold: () => trayView.restore(turn.cancelHold()),
    },
  });

  const trayView = createTrayView({
    box: $('field-box'),
    trayEl: $('tray'),
    composerEl: $('composer'),
    dropTarget: document.querySelector('.main'),
    attachButton: $('attach'),
    input: $('attach-input'),
    field: $('field'),
    tray,
    agent,
    refresh: composerView.refresh,
    announce: (message) => { $('announce').textContent = message; },
  });

  commandMenu = createCommandMenu({ field: $('field'), container: $('composer'), commands, setText: composerView.setText });
  toolBrowser = createToolBrowser({ container: workspace.toolsContent, agent, draft: text => { workspace.showChat(); composerView.setText(text); } });
  agent.onAppOpened?.(async (action, current) => {
    await workspace.refresh();
    if (!current()) return;
    try { workspace.openApp(action.appId); }
    catch (error) { reportCommand(error.message); }
  });

  const drawer = createDrawerView({
    jetSvg: $('drawer-jet'),
    nameEl: $('drawer-name'),
    titleEl: $('drawer-title'),
    statusEl: $('drawer-status'), drawerEl: $('drawer'), contextEl: $('context'), contextToggle: $('context-toggle'),
    modelEl: $('context-model'), tokensEl: $('context-tokens'), barEl: $('context-bar'),
    percentEl: $('context-percent'), noteEl: $('context-note'), gearButton: $('gear'),
    handlers: {
      openSettings: () => sheet.open(),
    },
  });
  agent.onConnectionChanged?.(drawer.setConnection);

  const live = createLive({
    reducedMotion: reducedMotion(),
    heroSlot: $('hero'),
    scrollToBottom: () => view.scrollToBottom(),
  });

  function showProgramStatus(program) {
    if (program.found) {
      view.setBanner(null);
      return;
    }
    const message = "I couldn't find " + (program.provider ?? "Claude Code") + ". I looked in: " + program.searched.join(', ');
    view.setBanner(message, { label: 'Settings', run: () => sheet.open('claude') });
  }
  let statusNumber = 0;
  async function refreshStatus() {
    const current = ++statusNumber, model = settings.model;
    try {
      const latest = await agent.status();
      if (current !== statusNumber || model !== settings.model) return;
      drawer.setContext(model, latest.context);
      showProgramStatus(latest.program);
    } catch (error) {
      console.warn('the agent status could not be read:', error);
    }
  }

  const voicePlayer = createVoicePlayer();
  const voiceToggle = createVoiceToggle({
    button: $('voice'),
    status: voiceStatus,
    check: () => agent.voiceStatus(),
    replying: () => composer.replying,
    announce: (message) => { $('announce').textContent = message; },
    onChange: (on) => { if (on) voicePlayer.unlock(); else turn.silence(); },
  });
  const showVoiceState = (state) => {
    voiceToggle.setSpeaking(state.speaking);
    live.speaking(state.speaking);
    if ('problem' in state) voiceToggle.setProblem(state.problem);
  };
  const voice = {
    unlock: () => { if (voiceToggle.on) voicePlayer.unlock(); },
    reveal: ({ render, paint }) => voiceToggle.on
      ? { reveal: createSpokenReveal({ render, paint, speak: (text, signal) => agent.speech(text, signal), player: voicePlayer, onState: showVoiceState }), spoken: true }
      : { reveal: createReveal({ render, paint }), spoken: false },
  };

  const turn = createTurn({
    agent,
    settings,
    thread,
    view,
    follow,
    composer,
    composerView,
    live,
    page: { announce: $('announce') },
    afterReply: refreshStatus,
    activeAppId: workspace.activeAppId,
    voice,
  });

  function paintPersona() {
    const name = displayName(settings);
    const title = settings.persona.jobTitle.trim() || 'assistant';
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
    trayView.take();
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
      systemReducesMotion: () => systemReduces.matches,
      onClaudeChecked: showProgramStatus,
      onForget: forget,
    },
    save: async () => { await saveSettings(settings); await refreshStatus(); },
    onChange: (kind) => {
      if (kind === 'persona') paintPersona();
      else if (kind === 'model') { drawer.setContext(settings.model); }
      else if (kind === 'motion') {
        applyReduced();
        live.setReducedMotion(reducedMotion());
      }
    },
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const action = composer.escape({ sheetOpen: sheet.isOpen });
    if (action === 'none') return;
    event.preventDefault();
    if (action === 'closeSheet') sheet.close();
    else turn.stop();
  });
  systemReduces.addEventListener('change', () => {
    applyReduced();
    live.setReducedMotion(reducedMotion());
  });

  drawer.init();
  drawer.setContext(settings.model, status.context);
  paintPersona();
  showProgramStatus(status.program);
  page.dataset.layout = composer.layout;
  if (history.length === 0) {
    live.showHero();
  } else {
    turn.paint();
    view.scrollToBottom();
    live.showInLane(view.liveLane());
  }
  live.start();
  // The first snapshot builds every row of the thread again, so the loading screen waits for it.
  let resolveFirstSnapshot;
  const firstSnapshot = new Promise((resolve) => { resolveFirstSnapshot = resolve; });
  agent.watch?.((snapshot) => { turn.restore(snapshot); workspace.refresh(); resolveFirstSnapshot(); refreshStatus(); }, (event) => turn.observe(event));
  finishLoading({ cover: $('loading'), settled: Promise.all([workspace.ready, firstSnapshot]), reducedMotion });
}

start().catch((error) => {
  console.error(error);
  failLoading({ cover: $('loading'), message: 'Jet could not start: ' + (error && error.message ? error.message : error) });
});
