import { MOODS } from '../jet/director.js';
import { displayName } from '../bridge/settings.js';
import { randomId } from '../bridge/browser-agent.js';
import { localTimeLabel } from './clock.js';
import { createReveal } from './thread/throttle.js';
import { withoutCues } from './voice/segment.js';

const FEELING_CAP_MS = 2200;
const SUPPORTED_MOODS = new Set(MOODS);

const TERMINAL = new Set(['finished', 'failed', 'stopped', 'noReply']);
/** The events that put something in Jet's row, so a turn that a reaction started opens the row on the first of them. */
const SHOWN = new Set(['text', 'toolStarted', 'toolProgress', 'toolFinished', 'finished', 'failed', 'stopped']);

const SILENT = { on: () => false, performsCues: () => false, cues: [], reveal: (options) => ({ reveal: createReveal(options), spoken: false }), unlock() {} };

/**
 * @param {{
 *   agent: {
 *     feel: (text: string) => Promise<{ mood: string, scores: object }>,
 *     send: (request: object, onEvent: (event: any) => void) => Promise<object>,
 *     react: (request: object) => Promise<object>,
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
 *   voice?: {
 *     on: () => boolean,
 *     performsCues: () => boolean,
 *     cues: { tag: string, weight: number }[],
 *     reveal: (options: { render: (text: string) => Promise<string>, paint: (html: string) => void }) => { reveal: ReturnType<typeof createReveal> | ReturnType<typeof import('./voice/spoken.js').createSpokenReveal>, spoken: boolean },
 *     unlock: () => void,
 *   },
 * }} parts   `voice` gives the reply to each sent message its reveal: spoken while the speaker is on, plain when it is off
 */
export function createTurn({ agent, settings, thread, view, follow, composer, composerView, live, page, afterReply, activeAppId = () => null, voice = SILENT }) {
  /** @type {ReturnType<typeof createReveal> | ReturnType<typeof import('./voice/spoken.js').createSpokenReveal> | null} */
  let reveal = null;
  let pendingEntry = null;
  let heldAppId = null;
  let active = null;
  /** A reaction turn that started while the last reply was still being revealed. Its events wait here until that reply ends. */
  let waiting = null;
  let warned = false;

  function paint() {
    view.render(thread.rows());
    // While Jet thinks about a reaction the server takes no message, so one typed meanwhile is held.
    composer.replying = thread.replying || Boolean(active?.reaction);
    composerView.refresh();
  }

  function revealFor(mine) {
    const made = voice.reveal({
      render: (partial) => agent.renderMarkdown(partial),
      paint: (html) => {
        if (active !== mine || !thread.slot) return;
        thread.reveal(html);
        paint();
      },
    });
    mine.spoken = made.spoken;
    return made.reveal;
  }

  /** A turn that a reaction started has no Jet row until Jet has something to show; then Jet flies to it. */
  function openReply(now) {
    const takeoff = live.measure();
    thread.openSlot();
    view.render(thread.rows());
    live.send(view.liveLane(), now, takeoff);
    reveal = revealFor(active);
    if (active.mood) {
      thread.setMood(active.mood);
      reveal.holdUntil(live.mood(active.mood, now).revealAt);
    }
  }

  function endReply() {
    active?.cancelFeeling?.();
    active = null;
    if (reveal) reveal.end();
    reveal = null;
    pendingEntry = null;
    composer.replying = false;
    composer.speaking = false;
    paint();
    afterReply();
    if (waiting) {
      active = waiting;
      waiting = null;
      paint();
      for (const event of active.events.splice(0)) onEvent(event);
      return;
    }
    const held = thread.takeHeld();
    if (held !== null) {
      composerView.setHeld(null);
      const appId = heldAppId;
      heldAppId = null;
      turn.send(held.text, appId, held.attachments);
    }
  }

  function backToLastReply(now) {
    live.done(now);
    view.render(thread.rows());
    const lane = view.liveLane();
    if (lane) live.showInLane(lane);
  }

  /**
   * Follows a reaction turn without reloading the thread, which would cut off the voice of the last reply.
   * The server takes no message while it runs, so a message of this page that it has not accepted yet goes
   * back to the held message, which is sent when the reaction turn ends.
   */
  function followReaction({ requestId, turnId }) {
    const next = { dispatched: true, requestId, turnId, reaction: true, mood: null, events: [] };
    if (pendingEntry) {
      waiting = next;
      return;
    }
    if (active) {
      const unsent = active;
      unsent.cancelFeeling?.();
      reveal?.end();
      reveal = null;
      thread.unsend();
      const later = thread.cancelHold();
      thread.hold(unsent.text, unsent.attachments);
      thread.hold(later.text, later.attachments);
      heldAppId = unsent.appId;
      composerView.setHeld(thread.held);
      backToLastReply(performance.now());
    }
    active = next;
    paint();
  }

  function onEvent(event) {
    const now = performance.now();
    if (!thread.slot && SHOWN.has(event.kind)) openReply(now);
    switch (event.kind) {
      case 'started':
        if (event.fresh) afterReply();
        break;
      case 'notice':
        thread.addNotice(event.message);
        break;
      case 'toolStarted':
        thread.startTool(event);
        // The server puts the text after a tool call in a new paragraph, so the sentence before the
        // call is complete now, and the voice can say it while the tool runs.
        if (active?.spoken && thread.slot.text !== '') reveal.text(thread.slot.text + '\n\n');
        break;
      case 'toolFinished':
        thread.finishTool(event);
        break;
      case 'toolProgress':
        thread.progressTool(event);
        break;
      case 'mood':
        if (!thread.slot) {
          active.mood = event.mood;
          break;
        }
        thread.setMood(event.mood);
        reveal.holdUntil(live.mood(event.mood, now).revealAt);
        break;
      case 'text':
        if (thread.slot.text === '') live.replying(now);
        thread.appendText(event.delta);
        reveal.text(thread.slot.text);
        break;
      case 'finished': {
        pendingEntry = event.entry;
        // Jet settles after a spoken reply only when the voice has finished.
        const spoken = Boolean(active?.spoken);
        if (!spoken) live.done(now);
        reveal.finish(() => {
          if (spoken) live.done(performance.now());
          thread.finish(event.entry);
          page.announce.textContent = withoutCues(event.entry.text, voice.cues);
          endReply();
        });
        // Read after `finish`, which is what starts the speech of a reply that arrived in one piece.
        composer.speaking = reveal.speaking === true;
        composerView.refresh();
        return;
      }
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
      case 'noReply':
        reveal?.end();
        if (thread.slot) {
          // Jet only reacted to the message: the waiting bubble leaves, and Jet goes back to his last reply.
          thread.dropSlot();
          backToLastReply(now);
        }
        break;
      default:
        break;
    }
    if (TERMINAL.has(event.kind)) endReply();
    else paint();
  }

  /** The settings of the turn that a message or a reaction starts, the same for both. */
  function turnSettings(appId) {
    return {
      activeAppId: appId,
      model: settings.model,
      effort: settings.effort,
      budgetUsd: settings.turnBudgetUsd,
      persona: { ...settings.persona },
      localTime: localTimeLabel(Date.now()),
      spoken: voice.on(),
      voiceCues: voice.performsCues(),
    };
  }

  function request(text, appId, attachments) {
    return {
      text,
      ...(attachments.length > 0 && { attachments: attachments.map((file) => file.id) }),
      ...turnSettings(appId),
    };
  }

  const turn = {
    paint,

    /** @param {{ fresh?: boolean }} [options]   `fresh` shows another chat: nothing of the old one is kept, not even a held message */
    restore(snapshot, { fresh = false } = {}) {
      if (!fresh && active && !active.turnId && !snapshot.active && !snapshot.history.some((entry) => entry.turn?.requestId === active.requestId)) return;
      active?.cancelFeeling?.();
      reveal?.end();
      // A message still waiting for its feeling goes on to the chat it was typed in.
      if (fresh && active && !active.dispatched) active.leftBehind = true;
      const held = fresh ? null : thread.held;
      thread.load(snapshot.history);
      if (held !== null) thread.hold(held.text, held.attachments);
      active = null;
      waiting = null;
      reveal = null;
      pendingEntry = null;
      composer.speaking = false;
      if (snapshot.history.length) composer.sent();
      const current = snapshot.active;
      if (current) {
        const mine = { dispatched: true, requestId: current.identity.requestId, turnId: current.identity.turnId, reaction: Boolean(current.reaction), mood: current.mood };
        active = mine;
        if (current.user || current.text || current.tools.length > 0) {
          thread.openSlot(current.user?.at);
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
      }
      composerView.setLayout(composer.layout);
      paint();
      if (snapshot.history.length) live.showInLane(view.liveLane());
      if (thread.slot) live.replying(performance.now());
    },

    /** Shows an entry that Jet saved with no message to answer, such as the first line of an objective's chat. */
    addEntry(entry) {
      thread.addEntry(entry);
      composer.sent();
      composerView.setLayout(composer.layout);
      paint();
      live.showInLane(view.liveLane());
    },

    observe(envelope) {
      const { event } = envelope;
      // A list of emoji replaces the old one, inside a turn or outside, so one seen twice changes nothing.
      if (event.kind === 'reactions') {
        thread.react(event.entryId, event.reactions);
        paint();
        return;
      }
      if (event.kind === 'accepted') {
        const current = event.snapshot.active;
        // The page that sent the message already shows its bubble and has Jet in flight; it only needs the ids.
        if (active && !active.turnId && envelope.turn?.requestId === active.requestId) {
          active.turnId = envelope.turn.turnId;
          if (current?.user) thread.userSaved(current.user.id);
        } else if (current?.reaction && (!active || !active.turnId || pendingEntry)) followReaction(current.identity);
        else turn.restore(event.snapshot);
        return;
      }
      if (waiting && waiting.turnId === envelope.turn?.turnId) waiting.events.push(event);
      else if (active && active.turnId === envelope.turn?.turnId && (thread.slot || active.reaction)) onEvent(event);
    },

    /**
     * Sends a message: the bubble, the new slot, the flight, then the agent.
     * @param {import('./thread/store.js').Attachment[]} [attachments]   the uploaded files that go with it
     */
    async send(text, appId = activeAppId(), attachments = []) {
      voice.unlock();
      const mine = { dispatched: false, cancelFeeling: null, spoken: false, text, appId, attachments, chatId: agent.chatId?.() ?? null };
      active = mine;
      const now = performance.now();
      const message = { ...request(text, appId, attachments), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      if (agent.serverEvents) { message.requestId = randomId(); mine.requestId = message.requestId; }
      const takeoff = live.measure();
      follow.onSend();
      thread.addUser(text, undefined, attachments);
      thread.openSlot();
      composer.sent();
      composer.replying = true;
      composerView.setLayout(composer.layout);
      view.render(thread.rows());
      live.send(view.liveLane(), now, takeoff);
      page.announce.textContent = displayName(settings) + ' is replying';
      paint();

      reveal = revealFor(mine);
      const warn = () => {
        if (warned) return;
        warned = true;
        console.warn('Feeling classification unavailable; continuing with neutral.');
      };
      // A message of files alone has no words to read a feeling from.
      const feeling = text.trim() === '' ? 'neutral' : await new Promise((resolve) => {
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
      if (active !== mine) {
        if (mine.leftBehind) agent.send({ ...message, feeling: 'neutral', chatId: mine.chatId }, () => {}).catch((error) => console.warn('the message could not be sent to its chat:', error));
        return;
      }
      reveal.holdUntil(live.feel(feeling, performance.now()).revealAt);
      message.feeling = feeling;
      mine.dispatched = true;
      const receive = (event) => {
        if (active !== mine) return;
        if (mine.stopping) {
          // A spoken reply holds words back, so the page shows less than was received; the saved entry has it all.
          const kept = mine.spoken ? {} : { text: thread.slot.text, html: thread.slot.html };
          if (TERMINAL.has(event.kind)) onEvent({ kind: 'stopped', entry: { ...event.entry, ...kept, status: 'stopped' } });
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

    /** Puts the user's emoji on a Jet message, or takes it off with null. The new list comes back as a `reactions` event. */
    react(entryId, emoji) {
      return agent.react({ ...turnSettings(activeAppId()), entryId, emoji }).catch((error) => {
        thread.addWarning('The reaction could not be saved: ' + (error?.message ?? 'the server did not answer'));
        paint();
      });
    },

    retry() {
      const last = thread.lastUser();
      if (last !== null && !thread.replying) turn.send(last.text, undefined, last.attachments);
    },

    stop() {
      const mine = active;
      if (!mine) return;
      if (mine.dispatched && !pendingEntry) {
        mine.stopping = true;
        // A turn that a reaction started may have shown nothing yet, so there is no reply to end on the page.
        if (reveal) {
          reveal.end();
          live.stopped(performance.now());
        }
        agent.stop(mine.requestId).catch((error) => console.warn('Stop could not be sent:', error));
        return;
      }
      // Once a spoken reply is written, Stop only quiets the voice, and the reply ends complete. This checks
      // `spoken`, not `speaking`, so that a second Stop before the reply ends cannot mark it stopped.
      if (pendingEntry && mine.spoken) {
        reveal.flush();
        return;
      }
      const entry = pendingEntry ?? { id: null, role: 'jet', at: Date.now() };
      reveal.end();
      thread.stop({ ...entry, text: thread.slot.text, html: thread.slot.html, status: 'stopped' });
      live.stopped(performance.now());
      endReply();
    },

    hold(text, appId = activeAppId(), attachments = []) {
      heldAppId = appId;
      thread.hold(text, attachments);
      // While Jet only speaks, a new message cuts in: the voice stops, and the message goes as soon as the reply ends.
      if (pendingEntry && active?.spoken) {
        reveal.flush();
        return;
      }
      composerView.setHeld(thread.held);
    },

    /** Quiets the voice of the reply that is running, as when the speaker is switched off. The reply goes on as normal. */
    silence() {
      if (active?.spoken) reveal?.flush();
    },

    /** Puts the held text back in the field. @returns {import('./thread/store.js').Attachment[]} the held files, for the tray to take back */
    cancelHold() {
      heldAppId = null;
      const back = thread.cancelHold();
      composerView.setText(back.text);
      composerView.setHeld(null);
      return back.attachments;
    },
  };
  return turn;
}
