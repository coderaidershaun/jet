// One conversation turn from the user's side: what happens on a send, how each
// event of the reply reaches the thread, the drawer and Jet, and what follows
// when the reply ends (the held message, the cache chip, the announcement).
// It is handed the agent and every part of the page instead of importing them,
// so the agent is chosen in one place.

import { displayName } from '../bridge/settings.js';
import { localTimeLabel } from './clock.js';
import { createReveal } from './thread/throttle.js';

const TERMINAL = new Set(['finished', 'failed', 'stopped']);

function parsedOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   agent: {
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
 *   drawer: ReturnType<typeof import('./drawer/view.js').createDrawerView>,
 *   tracker: ReturnType<typeof import('./drawer/usage.js').createUsageTracker>,
 *   page: { headerStatus: HTMLElement, announce: HTMLElement },
 *   afterReply: () => void,
 * }} parts
 */
export function createTurn({ agent, settings, thread, view, follow, composer, composerView, live, drawer, tracker, page, afterReply }) {
  /** @type {ReturnType<typeof createReveal> | null} */
  let reveal = null;
  let sentAt = 0;

  function paint() {
    view.render(thread.rows());
    const slot = thread.slot;
    page.headerStatus.textContent = !slot ? '' : slot.html === '' ? '· thinking…' : '· typing…';
    composer.replying = thread.replying;
    composerView.refresh();
  }

  function endReply() {
    if (reveal) reveal.end();
    reveal = null;
    composer.replying = false;
    paint();
    afterReply();
    const held = thread.takeHeld();
    if (held !== null) {
      composerView.setHeld(null);
      turn.send(held);
    }
  }

  const showUsage = () => drawer.setUsage(tracker.snapshot());

  function onEvent(event) {
    const now = performance.now();
    switch (event.kind) {
      case 'rawLine':
        tracker.raw(parsedOrNull(event.line));
        drawer.addLine(event.line);
        showUsage();
        return;
      case 'started':
        tracker.started(event);
        showUsage();
        break;
      case 'notice':
        thread.addNotice(event.message);
        break;
      case 'mood':
        thread.setMood(event.mood);
        reveal.mood();
        live.mood(event.mood, now);
        break;
      case 'text':
        if (thread.slot.text === '') live.replying(now);
        thread.appendText(event.delta);
        reveal.text(thread.slot.text);
        break;
      case 'finished':
        tracker.finished(event);
        showUsage();
        reveal.end();
        thread.finish(event.entry);
        live.done({ elapsedMs: now - sentAt }, now);
        page.announce.textContent = event.entry.text;
        break;
      case 'failed':
        tracker.failed();
        showUsage();
        reveal.end();
        thread.fail(event.failure, event.entry);
        live.failed(now);
        break;
      case 'stopped':
        tracker.stopped();
        showUsage();
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

  function request(text) {
    return {
      text,
      model: settings.model,
      effort: settings.effort,
      budgetUsd: settings.turnBudgetUsd,
      persona: { ...settings.persona },
      behaviour: { ...settings.behaviour },
      localTime: localTimeLabel(Date.now()),
      claudePath: settings.claudePath,
    };
  }

  const turn = {
    paint,

    /** Sends a message: the bubble, the new slot, the flight, then the agent. */
    send(text) {
      const now = performance.now();
      sentAt = now;
      const takeoff = live.measure();
      tracker.sent({ effort: settings.effort, at: Date.now() });
      showUsage();
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
          if (!thread.slot) return;
          thread.reveal(html);
          paint();
        },
      });
      agent.send(request(text), onEvent).catch((error) => {
        if (!thread.replying) return;
        const failure = {
          kind: error && error.kind ? error.kind : 'io',
          message: error && error.message ? error.message : 'The message could not be sent.',
        };
        const entry = { id: null, role: 'jet', text: '', html: '', status: 'failed', error: failure.message, at: Date.now() };
        onEvent({ kind: 'failed', failure, entry });
      });
    },

    retry() {
      const text = thread.lastUserText();
      if (text !== null && !thread.replying) turn.send(text);
    },

    stop() {
      agent.stop().catch((error) => console.warn('Stop could not be sent:', error));
    },

    hold(text) {
      thread.hold(text);
      composerView.setHeld(thread.held);
    },

    cancelHold() {
      composerView.setText(thread.cancelHold());
      composerView.setHeld(null);
    },
  };
  return turn;
}
