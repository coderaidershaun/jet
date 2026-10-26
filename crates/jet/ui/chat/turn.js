import { MOODS } from '../jet/director.js';
import { displayName } from '../bridge/settings.js';
import { randomId } from '../bridge/browser-agent.js';
import { localTimeLabel } from './clock.js';
import { createReveal } from './thread/throttle.js';

const FEELING_CAP_MS = 2200;
const SUPPORTED_MOODS = new Set(MOODS);

const TERMINAL = new Set(['finished', 'failed', 'stopped']);

/**
 * @param {{
 *   agent: {
 *     feel: (text: string) => Promise<{ mood: string, scores: object }>,
 *     send: (request: object, onEvent: (event: any) => void) => Promise<object>,
 *     stop: () => Promise<void>,
 *     renderMarkdown: (text: string) => Promise<string>,
 *   },
 *   settings: import('../bridge/settings.js').Settings,
 *   thread: ReturnType<typeof import('./thread/store.js').createThread>,
 *   view: ReturnType<typeof import('./thread/view.js').createThreadView>,
 *   follow: ReturnType<typeof import('./thread/scroll.js').createFollow>,
 *   composer: ReturnType<typeof import('./composer/state.js').createComposer>,
 *   composerView: ReturnType<typeof import('./composer/view.js').createComposerView>,
 *   live: ReturnType<typeof import('./stage/live.js').createLive>,
 *   page: { announce: HTMLElement },
 *   afterReply: () => void,
 * }} parts
 */
export function createTurn({ agent, settings, thread, view, follow, composer, composerView, live, page, afterReply, activeAppId = () => null }) {
  /** @type {ReturnType<typeof createReveal> | null} */
  let reveal = null;
  let pendingEntry = null;
  let heldAppId = null;
  let active = null;
  let warned = false;

  function paint() {
    view.render(thread.rows());
    composer.replying = thread.replying;
    composerView.refresh();
  }

  function endReply() {
    active?.cancelFeeling?.();
    active = null;
    if (reveal) reveal.end();
    reveal = null;
    pendingEntry = null;
    composer.replying = false;
    paint();
    afterReply();
    const held = thread.takeHeld();
    if (held !== null) {
      composerView.setHeld(null);
      const appId = heldAppId;
      heldAppId = null;
      turn.send(held, appId);
    }
  }

  function onEvent(event) {
    const now = performance.now();
    switch (event.kind) {
      case 'started':
        if (event.fresh) afterReply();
        break;
      case 'notice':
        thread.addNotice(event.message);
        break;
      case 'toolStarted':
        thread.startTool(event);
        break;
      case 'toolFinished':
        thread.finishTool(event);
        break;
      case 'mood':
        thread.setMood(event.mood);
        reveal.holdUntil(live.mood(event.mood, now).revealAt);
        break;
      case 'text':
        if (thread.slot.text === '') live.replying(now);
        thread.appendText(event.delta);
        reveal.text(thread.slot.text);
        break;
      case 'finished':
        pendingEntry = event.entry;
        live.done(now);
        reveal.finish(() => {
          thread.finish(event.entry);
          page.announce.textContent = event.entry.text;
          endReply();
        });
        return;
      case 'failed':
        reveal.end();
        thread.fail(event.failure, event.entry);
        live.failed(now);
        break;
      case 'stopped':
        reveal.end();
        thread.stop(event.entry);
        live.stopped(now);
        break;
      default:
        break;
    }
    if (TERMINAL.has(event.kind)) endReply();
    else paint();
  }

  function request(text, appId) {
    return {
      text,
      activeAppId: appId,
      model: settings.model,
      effort: settings.effort,
      budgetUsd: settings.turnBudgetUsd,
      persona: { ...settings.persona },
      localTime: localTimeLabel(Date.now()),
    };
  }

  const turn = {
    paint,

    restore(snapshot) {
      if (active && !active.turnId && !snapshot.active && !snapshot.history.some((entry) => entry.turn?.requestId === active.requestId)) return;
      active?.cancelFeeling?.();
      reveal?.end();
      const held = thread.held;
      thread.load(snapshot.history);
      if (held !== null) thread.hold(held);
      active = null;
      reveal = null;
      pendingEntry = null;
      if (snapshot.history.length) composer.sent();
      const current = snapshot.active;
      if (current) {
        const mine = { dispatched: true, requestId: current.identity.requestId, turnId: current.identity.turnId };
        active = mine;
        thread.openSlot(current.user.at);
        reveal = createReveal({ render: (text) => agent.renderMarkdown(text), paint: (html) => {
          if (active !== mine || !thread.slot) return;
          thread.reveal(html);
          paint();
        } });
        if (current.mood) thread.setMood(current.mood);
        for (const tool of current.tools) {
          thread.startTool(tool);
          if (tool.kind === 'toolFinished') thread.finishTool(tool);
        }
        thread.appendText(current.text);
        reveal.text(current.text);
      }
      composerView.setLayout(composer.layout);
      paint();
      if (snapshot.history.length) live.showInLane(view.liveLane());
      if (current) live.replying(performance.now());
    },

    observe(envelope) {
      if (envelope.event.kind === 'accepted') { turn.restore(envelope.event.snapshot); return; }
      if (active && active.turnId === envelope.turn?.turnId && thread.slot) onEvent(envelope.event);
    },

    /** Sends a message: the bubble, the new slot, the flight, then the agent. */
    async send(text, appId = activeAppId()) {
      const mine = { dispatched: false, cancelFeeling: null };
      active = mine;
      const now = performance.now();
      const message = request(text, appId);
      if (agent.serverEvents) { message.requestId = randomId(); mine.requestId = message.requestId; }
      const takeoff = live.measure();
      follow.onSend();
      thread.addUser(text);
      thread.openSlot();
      composer.sent();
      composer.replying = true;
      composerView.setLayout(composer.layout);
      view.render(thread.rows());
      live.send(view.liveLane(), now, takeoff);
      page.announce.textContent = displayName(settings) + ' is replying';
      paint();

      reveal = createReveal({
        render: (partial) => agent.renderMarkdown(partial),
        paint: (html) => {
          if (active !== mine || !thread.slot) return;
          thread.reveal(html);
          paint();
        },
      });
      const warn = () => {
        if (warned) return;
        warned = true;
        console.warn('Feeling classification unavailable; continuing with neutral.');
      };
      const feeling = await new Promise((resolve) => {
        let settled = false;
        const finish = (word) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          mine.cancelFeeling = null;
          resolve(SUPPORTED_MOODS.has(word) ? word : 'neutral');
        };
        const timer = setTimeout(() => { warn(); finish('neutral'); }, FEELING_CAP_MS);
        mine.cancelFeeling = () => finish('neutral');
        try {
          Promise.resolve(agent.feel(text)).then(
            (result) => finish(result?.mood),
            () => { if (!settled && active === mine) warn(); finish('neutral'); },
          );
        } catch {
          warn();
          finish('neutral');
        }
      });
      if (active !== mine) return;
      reveal.holdUntil(live.feel(feeling, performance.now()).revealAt);
      message.feeling = feeling;
      mine.dispatched = true;
      const receive = (event) => {
        if (active !== mine) return;
        if (mine.stopping) {
          if (TERMINAL.has(event.kind)) onEvent({ kind: 'stopped', entry: { ...event.entry, text: thread.slot.text, html: thread.slot.html, status: 'stopped' } });
        } else onEvent(event);
      };
      try {
        await agent.send(message, receive);
      } catch (error) {
        if (active !== mine) return;
        const failure = {
          kind: error && error.kind ? error.kind : 'io',
          message: error && error.message ? error.message : 'The message could not be sent.',
        };
        const entry = { id: null, role: 'jet', text: '', html: '', status: 'failed', error: failure.message, at: Date.now() };
        receive({ kind: 'failed', failure, entry });
      }
    },

    retry() {
      const text = thread.lastUserText();
      if (text !== null && !thread.replying) turn.send(text);
    },

    stop() {
      const mine = active;
      if (!mine) return;
      if (mine.dispatched && !pendingEntry) {
        mine.stopping = true;
        reveal.end();
        live.stopped(performance.now());
        agent.stop(mine.requestId).catch((error) => console.warn('Stop could not be sent:', error));
        return;
      }
      const entry = pendingEntry ?? { id: null, role: 'jet', at: Date.now() };
      reveal.end();
      thread.stop({ ...entry, text: thread.slot.text, html: thread.slot.html, status: 'stopped' });
      live.stopped(performance.now());
      endReply();
    },

    hold(text, appId = activeAppId()) {
      heldAppId = appId;
      thread.hold(text);
      composerView.setHeld(thread.held);
    },

    cancelHold() {
      heldAppId = null;
      composerView.setText(thread.cancelHold());
      composerView.setHeld(null);
    },
  };
  return turn;
}
