// All chat components share one agent connection.

import { createCommands } from '../workspace/commands.js';
import { createCommandMenu } from '../workspace/completion.js';
import { createToolBrowser } from '../workspace/tools.js';
import { createWorkspace } from '../workspace/shell.js';
import { createSession } from '../signin/session.js';
import { h, icon } from '../dom.js';
import { failLoading, finishLoading } from '../loading.js';
import { connectAgent } from '../bridge/agent.js';
import { requestJson } from '../bridge/browser-agent.js';
import { displayName, loadSettings, saveSettings } from '../bridge/settings.js';
import { createComposer } from './composer/state.js';
import { createTray } from './composer/tray.js';
import { createTrayView } from './composer/tray-view.js';
import { createComposerView } from './composer/view.js';
import { showAccount } from './drawer/account.js';
import { createChats } from './drawer/chats.js';
import { createChatsView } from './drawer/chats-view.js';
import { createDrawerView } from './drawer/view.js';
import { connectHearing } from './hear/connect.js';
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
import { createWarning } from './warning.js';

const $ = (id) => document.getElementById(id);
const warn = (what) => (error) => console.warn(what + ':', error);

async function start() {
  const session = createSession({ fetch: globalThis.fetch });
  // Every request of the page goes through the renewal, also those of modules that call fetch themselves.
  globalThis.fetch = session.fetch;
  const user = await session.whoAmI();
  const settings = await loadSettings(user);
  const agent = connectAgent({ beforeReconnect: session.whoAmI });
  const [opening, status, voiceStatus] = await Promise.all([
    agent.snapshot(),
    agent.status(),
    agent.voiceStatus().catch((error) => {
      console.warn('the voice status could not be read:', error);
      return { available: false, reason: 'The voice could not be reached', cues: [] };
    }),
  ]);

  const { history } = opening;
  const page = $('page');
  const announce = (message) => { $('announce').textContent = message; };
  let toolBrowser, commandMenu, hear;
  const workspace = createWorkspace({ agent, page, onTools: appId => toolBrowser.open(appId), openChat: (id, entryId) => { workspace.showChat(); showChat(id, entryId); } });
  // The shell puts itself first in the page, so the skip link moves back in front of it to stay the first Tab stop.
  const skip = $('skip');
  document.body.prepend(skip);
  skip.addEventListener('click', (event) => { event.preventDefault(); workspace.showChat(); });
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
  $('gear').prepend(icon('gear'));
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
      react: (entryId, emoji) => turn.react(entryId, emoji),
    },
  });

  function submit(text) {
    hear?.userActive();
    const appId = workspace.activeAppId();
    // The files leave the tray at once, so the chips go as the message does. A command carries none.
    const attachments = text.trimStart().startsWith('/') ? [] : trayView.take();
    return commands.submit(text, () => composer.replying ? turn.hold(text, appId, attachments) : turn.send(text, appId, attachments)).then(() => {
      // A spoken message that was held or ran as a command leaves the thread. One that was sent is already its bubble.
      if (thread.forming !== text) return;
      thread.dropForming();
      turn.paint();
    });
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
    forming: () => thread.forming ?? '',
    handlers: {
      send: submit,
      hold: submit,
      input: (text) => { commandMenu?.input(text); live.typing(); hear?.fieldChanged(text); },
      keydown: (event) => commandMenu?.keydown(event),
      stop: () => turn.stop(),
      cancelHold: () => trayView.restore(turn.cancelHold()),
      formingTaken: () => hear?.formingTaken(),
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
  agent.onConnectionChanged?.((connected) => {
    drawer.setConnection(connected);
    // The banner can be seen at every width and is read out. A stream that resumes sends no snapshot, so the
    // banner goes as soon as the stream is open again, and the status read puts back a banner about the program.
    if (!connected) view.setBanner('Waiting for the connection…');
    else { view.setBanner(null); refreshStatus(); }
  });

  /** The plan pane, and each send or reply card in the thread, reads what it shows again. */
  const paneChanged = () => document.dispatchEvent(new CustomEvent('jet:pane-changed'));
  let shownChat = null;
  const chats = createChats({
    agent,
    attending: () => !document.hidden,
    onChange: () => {
      chatsView.paint();
      // The plan pane shows what belongs to the open chat.
      if (chats.openId !== shownChat) {
        shownChat = chats.openId;
        document.dispatchEvent(new CustomEvent('jet:chat-opened', { detail: { id: shownChat, mainId: chats.mainId } }));
      }
    },
    onGone: () => showChat(chats.mainId),
  });
  const chatsView = createChatsView({
    list: $('chat-list'),
    titleEl: $('chat-title'),
    newButton: $('new-chat'),
    chats,
    open: (id) => { workspace.showChat(); showChat(id); },
    announce: fail,
    showUnread: (count) => {
      workspace.setUnread(count);
      document.title = count === 0 ? 'Jet' : `(${count}) Jet`;
    },
  });
  agent.onChatEvent((envelope) => {
    chats.handle(envelope);
    const { event } = envelope;
    if (event.kind === 'entryAdded' && envelope.chatId === chats.openId) turn.addEntry(event.entry);
    if (event.kind === 'entryAdded' && event.entry?.check) {
      const title = chats.items.find((chat) => chat.id === envelope.chatId)?.title;
      announce(envelope.chatId === chats.openId || !title ? 'Jet checked in.' : `Jet checked in, in ${title}.`);
    }
    if (event.kind === 'paneChanged') paneChanged();
  });
  document.addEventListener('visibilitychange', () => chats.attend());

  /**
   * Opens a chat: its history and running reply replace the thread, and every later call carries its id.
   * With an entry id it then scrolls to that entry and marks it, as the plan pane does for a check-in.
   * @param {number | null} id
   * @param {number | null} [entryId]
   */
  async function showChat(id, entryId = null) {
    if (id === null) return;
    if (id !== chats.openId && !(await openOther(id))) return;
    if (Number.isInteger(entryId)) markEntry(entryId);
  }

  /** @returns {Promise<boolean>} whether the chat opened */
  async function openOther(id) {
    try {
      await agent.openChat(id, (snapshot) => {
        chats.opened(id);
        composer.reset();
        composerView.setHeld(null);
        turn.restore(snapshot, { fresh: true });
        if (snapshot.history.length === 0) live.showHero();
        view.scrollToBottom();
        refreshStatus();
      });
      return true;
    } catch (error) {
      console.warn('the chat could not be opened:', error);
      fail('Jet could not open that chat. Check the connection and try again.');
      return false;
    }
  }

  let marked = null;
  /** Scrolls to one entry of the open thread and marks it until another is marked. An entry that is not drawn is left alone. */
  function markEntry(entryId) {
    // A finished Jet row is the only row that carries its entry's id, on its reaction control.
    const row = $('rows').querySelector(`.react-open[data-entry="${entryId}"]`)?.closest('.row') ?? null;
    if (row === null) return;
    marked?.classList.remove('is-marked');
    marked = row;
    row.classList.add('is-marked');
    row.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // The plan pane holds no reference to the composer, so it puts a sentence in the message box through this event.
  document.addEventListener('jet:draft', (event) => {
    const text = /** @type {CustomEvent} */ (event).detail?.text;
    if (typeof text !== 'string') return;
    workspace.showChat();
    composerView.setText(text);
    $('field').focus();
  });

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
    const where = program.searched ? "I looked in: " + program.searched.join(', ') : "Ask an admin to set where it is.";
    const message = "I couldn't find " + (program.provider ?? "Claude Code") + ". " + where;
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
  // The first snapshot builds every row of the thread again, so a notice added before it would be lost, and the loading screen waits for it too.
  let resolveFirstSnapshot;
  const firstSnapshot = new Promise((resolve) => { resolveFirstSnapshot = resolve; });
  const notify = (message) => firstSnapshot.then(() => { thread.addWarning(message); turn.paint(); });
  /** A failure is said aloud and also shown in the thread, so a sighted user sees it too. */
  function fail(message) {
    announce(message);
    notify(message);
  }
  const voiceToggle = createVoiceToggle({
    button: $('voice'),
    status: voiceStatus,
    check: () => agent.voiceStatus(),
    replying: () => composer.replying,
    announce: (message) => { $('announce').textContent = message; },
    onChange: (on) => {
      if (on) {
        voicePlayer.unlock();
        agent.voiceStatus().then(speakerSwitchedOn, warn('the voice status could not be read'));
      } else turn.silence();
      hear?.repaint();
    },
  });
  const speechWarning = createWarning({ show: (message) => voiceToggle.setProblem(message), say: notify });
  const speechProblem = (message) => (message ? "Jet can't speak right now: " + message : null);
  /** Switching the speaker on says at once what Google last refused, without waiting for a reply to fail. */
  function speakerSwitchedOn(status) {
    speechWarning.switchedOn();
    speechWarning.report(speechProblem(status.warning));
  }
  if (voiceToggle.on) speakerSwitchedOn(voiceStatus);
  const showVoiceState = (state) => {
    voiceToggle.setSpeaking(state.speaking);
    live.speaking(state.speaking);
    if ('problem' in state) speechWarning.report(speechProblem(state.problem));
  };
  const cues = voiceStatus.cues ?? [];
  const voice = {
    on: () => voiceToggle.on,
    cues,
    unlock: () => { if (voiceToggle.on) voicePlayer.unlock(); },
    reveal: ({ render, paint }) => voiceToggle.on
      ? { reveal: createSpokenReveal({ render, paint, speak: (text, signal) => agent.speech(text, signal, thread.slot?.mood), player: voicePlayer, onState: showVoiceState, cues }), spoken: true }
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
    afterReply: () => { refreshStatus(); hear?.replyEnded(); chats.refresh().catch(warn('the chat list could not be read')); },
    activeAppId: workspace.activeAppId,
    voice,
  });

  hear = connectHearing({
    agent,
    status: voiceStatus.hear,
    button: $('hear'),
    pill: $('voice-pill'),
    trailCanvas: $('trail'),
    field: $('field'),
    composerView,
    thread,
    turn,
    live,
    voicePlayer,
    speakerOn: () => voiceToggle.on,
    settings,
    appLabels: workspace.appLabels,
    announce: (message) => { $('announce').textContent = message; },
    notify,
    reducedMotion,
  });

  showAccount({ user, announce: fail });
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
      isAdmin: user.isAdmin,
      systemReducesMotion: () => systemReduces.matches,
      onClaudeChecked: showProgramStatus,
      onForget: forget,
      chatTitle: () => $('chat-title').textContent,
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
  chats.refresh().then(() => chats.opened(opening.chatId), warn('the chat list could not be read'));
  agent.watch?.((snapshot) => {
    turn.restore(snapshot);
    workspace.refresh();
    chats.refresh().catch(warn('the chat list could not be read'));
    // A snapshot holds none of the events before it, so a change of the plan may have been missed.
    paneChanged();
    resolveFirstSnapshot();
    refreshStatus();
  }, (event) => turn.observe(event));
  finishLoading({ cover: $('loading'), settled: Promise.all([workspace.ready, firstSnapshot]), reducedMotion });
  // With a mouse the user can type at once. On a touch screen a focused field would raise the keyboard over the thread.
  if (matchMedia('(pointer: fine)').matches) $('field').focus({ preventScroll: true });
}

start().catch((error) => {
  // The page is already on its way to the sign-in page.
  if (error?.kind === 'signedOut') return;
  console.error(error);
  failLoading({ cover: $('loading'), message: 'Jet could not start: ' + (error && error.message ? error.message : error) });
});
