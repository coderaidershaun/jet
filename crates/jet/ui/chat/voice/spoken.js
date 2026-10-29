// Holds a reply's words back and shows each one as the voice reaches it. It has the methods of
// the plain reveal, so a turn can use either, plus `flush` and `speaking`.
//
// Gemini gives no word times, so a word's time is guessed from its share of the clip's letters
// and can drift inside a long clip. That is why a clip holds at most two sentences and words show
// early, never late. A clip that fails or comes late shows its words, so voice never costs text.

import { createReveal, realClock } from '../thread/throttle.js';
import { nextBatch, segment, speechText } from './segment.js';

const LEAD_MS = 200;
const RENDER_GUESS_MS = 100;
const SEGMENT_EVERY_MS = 100;
const LATE_MS = 8000;
const MOST_AHEAD = 2;
const MIN_START_S = 0.05;
const PAUSE_INSIDE_BLOCK_S = 0.25;
const PAUSE_NEW_BLOCK_S = 0.45;
const PAUSE_AFTER_SILENT_S = 0.6;
const FATAL_KINDS = new Set(['notConfigured', 'rejected']);
const BLOCKED_MESSAGE = 'The browser blocked sound; click the speaker to allow it.';

/**
 * @param {{
 *   render: (text: string) => Promise<string>,
 *   paint: (html: string) => void,
 *   speak: (markdown: string, signal: AbortSignal) => Promise<ArrayBuffer>,
 *   player: { ready: () => boolean, now: () => number, outputLatency: () => number, play: (pcm: ArrayBuffer, at: number) => { start: number, end: number }, silence: () => void },
 *   clock?: { now: () => number, after: (fn: () => void, ms: number) => () => void },
 *   onState?: (state: { speaking: boolean, problem?: string | null }) => void,
 * }} options   `speak` rejects with `{ kind, message }`; `problem` is a message when the voice failed and null once a clip plays again
 */
export function createSpokenReveal({ render, paint, speak, player, clock = realClock, onState = () => {} }) {
  let renderMs = null;
  const reveal = createReveal({
    render: async (text) => {
      const started = clock.now();
      try { return await render(text); } finally {
        const took = clock.now() - started;
        renderMs = renderMs === null ? took : renderMs * 0.7 + took * 0.3;
      }
    },
    paint,
    clock,
  });

  let full = '';
  let parts = [];
  let segmentedText = null;
  let segmentedFinished = false;
  let lastSegmentAt = -Infinity;
  let nextPart = 0;
  let spokenCount = 0;
  /** @type {{ from: number, to: number, silent: boolean, opensBlock: boolean, text: string, marks: { end: number, weight: number }[], status: string, pcm?: ArrayBuffer, error?: any, abort?: () => void, requestedAt?: number, playAt?: number }[]} */
  const batches = [];
  let scheduled = 0;
  let cursor = 0;
  let afterSilent = false;
  let holdAt = -Infinity;
  let endAt = -Infinity;
  /** @type {{ at: number, end: number }[]} */
  let releases = [];
  let shownEnd = 0;
  let failures = 0;
  let finishing = false;
  let done = null;
  let engaged = false;
  let passingThrough = false;
  let ended = false;
  let cancelWake = null;
  let reportedSpeaking = false;

  const clockAt = (audioSeconds) => clock.now() + (audioSeconds - player.now()) * 1000;
  const audioAt = (clockMs) => player.now() + (clockMs - clock.now()) / 1000;
  const leadMs = () => LEAD_MS + player.outputLatency() * 1000 + (renderMs ?? RENDER_GUESS_MS);

  /** Jet is talking, or a clip of this reply is on its way to be played. A quiet wait, such as a tool call, is not talking. */
  function isTalking() {
    if (!engaged || passingThrough || ended) return false;
    return endAt > clock.now() || scheduled < batches.length;
  }

  function report(problem) {
    const speaking = isTalking();
    if (speaking === reportedSpeaking && problem === undefined) return;
    reportedSpeaking = speaking;
    onState(problem === undefined ? { speaking } : { speaking, problem });
  }

  function stopTimers() {
    cancelWake?.();
    cancelWake = null;
  }

  function dropClips() {
    stopTimers();
    for (const batch of batches) {
      if (batch.status === 'fetching') batch.abort?.();
      batch.status = 'dropped';
    }
    releases = [];
    player.silence();
  }

  /** The voice is over for this reply: everything shows now, and the rest of the text goes straight through. */
  function giveUpVoice(problem) {
    if (passingThrough || ended) return;
    passingThrough = true;
    dropClips();
    if (full !== '') reveal.text(full);
    if (finishing) reveal.finish(done);
    report(problem);
  }

  function segmentNow(now) {
    if (full === segmentedText && finishing === segmentedFinished) return;
    if (!finishing && now - lastSegmentAt < SEGMENT_EVERY_MS) return;
    parts = segment(full, finishing);
    segmentedText = full;
    segmentedFinished = finishing;
    lastSegmentAt = now;
  }

  /** How many clips have been asked for and have not started yet. A silent block costs nothing to ask for. */
  function ahead(now) {
    return batches.filter((batch) => !batch.silent && (batch.playAt === undefined || batch.playAt > now)).length;
  }

  function plan(now) {
    while (nextPart < parts.length && ahead(now) < MOST_AHEAD) {
      const { to, silent } = nextBatch(parts, nextPart, spokenCount === 0);
      const batch = {
        from: nextPart,
        to,
        silent,
        opensBlock: parts[nextPart].opensBlock,
        text: silent ? '' : speechText(full, parts, nextPart, to),
        marks: parts.slice(nextPart, to).flatMap((part) => part.marks),
        status: silent ? 'quiet' : 'fetching',
      };
      batches.push(batch);
      nextPart = to;
      engaged = true;
      if (!silent) {
        spokenCount++;
        fetchClip(batch, now);
      }
    }
  }

  function fetchClip(batch, now) {
    const controller = new AbortController();
    batch.abort = () => controller.abort();
    batch.requestedAt = now;
    speak(batch.text, controller.signal).then(
      (pcm) => {
        if (batch.status !== 'fetching') return;
        batch.status = pcm.byteLength === 0 ? 'quiet' : 'ready';
        batch.pcm = pcm;
        // The clip goes on the audio clock now, not at the next timer, because a hidden tab slows its timers.
        tick();
      },
      (error) => {
        if (batch.status !== 'fetching') return;
        batch.status = 'failed';
        batch.error = error;
        tick();
      },
    );
  }

  /** Puts what has arrived on the clock, in order. Returns false once the voice has been given up. */
  function schedule(now) {
    while (scheduled < batches.length) {
      const batch = batches[scheduled];
      if (batch.status === 'fetching' && now >= Math.max(batch.requestedAt, clockAt(cursor)) + LATE_MS) {
        batch.abort();
        batch.status = 'failed';
        batch.error = { kind: 'late', message: 'The voice was too slow to answer.' };
      }
      if (batch.status === 'fetching') return true;
      if (batch.status === 'ready' && !playClip(batch)) return false;
      if (batch.status === 'failed' && !failClip(batch)) return false;
      if (batch.status === 'quiet') showAtItsTurn(batch);
      scheduled++;
    }
    return true;
  }

  function playClip(batch) {
    if (!player.ready()) {
      giveUpVoice(BLOCKED_MESSAGE);
      return false;
    }
    const pause = scheduled === 0 || afterSilent ? 0 : batch.opensBlock ? PAUSE_NEW_BLOCK_S : PAUSE_INSIDE_BLOCK_S;
    let clip;
    try {
      clip = player.play(batch.pcm, Math.max(player.now() + MIN_START_S, cursor + pause, audioAt(holdAt)));
    } catch (error) {
      batch.status = 'failed';
      batch.error = { kind: 'playback', message: error?.message ?? 'The sound could not be played.' };
      return failClip(batch);
    }
    batch.playAt = clockAt(clip.start);
    cursor = clip.end;
    afterSilent = false;
    failures = 0;
    endAt = Math.max(endAt, clockAt(clip.end));
    const total = batch.marks.reduce((sum, mark) => sum + mark.weight, 0);
    let before = 0;
    for (const mark of batch.marks) {
      const heard = total > 0 ? clip.start + (before / total) * (clip.end - clip.start) : clip.start;
      releases.push({ at: clockAt(heard) - leadMs(), end: mark.end });
      before += mark.weight;
    }
    report(null);
    return true;
  }

  function failClip(batch) {
    const message = batch.error?.message ?? 'The voice could not be reached.';
    failures++;
    if (FATAL_KINDS.has(batch.error?.kind) || failures >= 2) {
      giveUpVoice(message);
      return false;
    }
    batch.status = 'quiet';
    report(message);
    return true;
  }

  /** A silent block, or a clip that failed: its words show when the voice reaches them. */
  function showAtItsTurn(batch) {
    const turn = Math.max(cursor, player.now(), audioAt(holdAt));
    batch.playAt = clockAt(turn);
    releases.push({ at: batch.playAt - leadMs(), end: batch.marks.at(-1).end });
    if (batch.silent) {
      cursor = turn + PAUSE_AFTER_SILENT_S;
      afterSilent = true;
    }
    endAt = Math.max(endAt, batch.playAt);
  }

  function release(now) {
    releases.sort((a, b) => a.at - b.at);
    let end = shownEnd;
    while (releases.length > 0 && releases[0].at <= now) end = Math.max(end, releases.shift().end);
    if (end > shownEnd) {
      shownEnd = end;
      reveal.text(full.slice(0, shownEnd));
    }
  }

  function finishWhenSpoken(now) {
    const spoken = finishing && segmentedFinished && nextPart === parts.length && scheduled === batches.length;
    if (!spoken || releases.length > 0 || now < endAt) return;
    passingThrough = true;
    if (full !== '') reveal.text(full);
    reveal.finish(done);
    report();
  }

  function nextWake(now) {
    const times = releases.map((item) => item.at);
    if (full !== segmentedText || finishing !== segmentedFinished) times.push(lastSegmentAt + SEGMENT_EVERY_MS);
    const head = batches[scheduled];
    if (head?.status === 'fetching') times.push(Math.max(head.requestedAt, clockAt(cursor)) + LATE_MS);
    if (nextPart < parts.length) times.push(...batches.map((batch) => batch.playAt).filter((at) => at !== undefined && at > now));
    // Waking when the voice runs out ends a finished reply, and tells the button that Jet has gone quiet.
    if (endAt > now) times.push(endAt);
    return times.length > 0 ? Math.min(...times) : null;
  }

  function tick() {
    if (passingThrough || ended) return;
    stopTimers();
    const now = clock.now();
    segmentNow(now);
    plan(now);
    if (!schedule(now)) return;
    plan(now);
    release(now);
    finishWhenSpoken(now);
    report();
    if (passingThrough || ended) return;
    const wake = nextWake(now);
    if (wake !== null) cancelWake = clock.after(tick, Math.max(0, wake - now));
  }

  return {
    /** True while Jet is talking or a clip of this reply is on its way, and the voice has not been stopped. */
    get speaking() {
      return isTalking();
    },

    /** @param {string} fullText   everything received so far */
    text(fullText) {
      if (passingThrough || ended) {
        reveal.text(fullText);
        return;
      }
      full = fullText;
      tick();
    },

    /** Holds the first sound and the first words until an absolute monotonic deadline. */
    holdUntil(at) {
      holdAt = Math.max(holdAt, at);
      reveal.holdUntil(at);
    },

    /** Calls `done` once the whole reply has been heard and shown. */
    finish(callback) {
      if (passingThrough) {
        reveal.finish(callback);
        return;
      }
      finishing = true;
      done = callback;
      tick();
    },

    /** Silences the voice and shows every word now. The reply goes on as if it had never been spoken. */
    flush() {
      giveUpVoice();
    },

    /** The reply is over: the voice stops and the words held back stay hidden, because the final HTML comes from the entry. */
    end() {
      if (ended) return;
      ended = true;
      dropClips();
      reveal.end();
      report();
    },
  };
}
