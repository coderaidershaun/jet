import { createDirector } from '../../jet/director.js';
import { createPlayer } from '../../jet/player.js';
import { mountJet } from '../../jet/draw/view.js';
import { createFlight, cruiseMsFor } from './flight.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const IDLE_FRAME_MS = 1000 / 60;
const HERO_FADE_IN_MS = 200;
const HELLO_AFTER_FADE_IN_MS = 600;
const FADE_OUT_MS = 120;
const FADE_IN_MS = 160;

/** One kite, carried between its hero spot and the newest reply's lane. */
export function createLive({ reducedMotion = false, heroSlot, scrollToBottom }) {
  const player = createPlayer({ reducedMotion });
  const director = createDirector({ player });

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'jet-svg');
  svg.setAttribute('aria-hidden', 'true');
  const draw = mountJet(svg);
  const node = document.createElement('div');
  node.className = 'jet-live';
  node.setAttribute('role', 'img');
  let name = 'Jet';
  let speaking = false;
  node.setAttribute('aria-label', name + ', idle');
  node.append(svg);

  /** @type {ReturnType<typeof createFlight> | null} */
  let flight = null;
  let helloTimer = 0;
  let lastLabel = 'idle';
  let lastDrawAt = -Infinity;
  let needsDraw = true;
  let generation = 0;
  const fades = new Set();
  let pendingMove = null;

  function cancelFades({ finishMove = false } = {}) {
    if (finishMove) pendingMove?.();
    pendingMove = null;
    generation++;
    for (const animation of fades) animation.cancel();
    fades.clear();
  }

  const reduced = () => player.reducedMotion;
  const anchorOf = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height });
  const scaleOf = () => node.getBoundingClientRect().width / (node.offsetWidth || 1);

  let lastFlightPoint = null;

  function applyFlight(now) {
    const point = flight.sample(now);
    const unitPx = Math.max(point.scale, 0.001);
    if (lastFlightPoint) player.carry((point.x - lastFlightPoint.x) / unitPx, (point.y - lastFlightPoint.y) / unitPx);
    lastFlightPoint = point;
    node.style.transform = `translate(${point.x.toFixed(2)}px,${point.y.toFixed(2)}px) scale(${point.scale.toFixed(4)})`;
  }

  function endFlight() {
    flight = null;
    lastFlightPoint = null;
    node.style.transform = '';
  }

  function measure() {
    endFlight();
    return { first: anchorOf(node.getBoundingClientRect()), fromScale: scaleOf() };
  }

  function frame(now) {
    if (flight) {
      applyFlight(now);
      if (now >= flight.endsAt) endFlight();
    }
    const { busy } = director.tick(now);
    const label = name + ', ' + (speaking ? 'speaking' : director.status);
    if (label !== lastLabel) {
      lastLabel = label;
      node.setAttribute('aria-label', label);
    }
    if (!busy && !flight && !needsDraw && now - lastDrawAt < IDLE_FRAME_MS) return;
    draw(player.frame, { unitPx: Math.max(scaleOf(), 0.001) });
    lastDrawAt = now;
    needsDraw = false;
  }

  function loop(now) {
    frame(now);
    requestAnimationFrame(loop);
  }

  async function fadeOver(move, mine) {
    async function fade(from, to, duration) {
      const animation = node.animate([{ opacity: from }, { opacity: to }], { duration, fill: 'forwards' });
      fades.add(animation);
      try { await animation.finished; } finally {
        if (mine !== generation) animation.cancel();
      }
      return animation;
    }
    try {
      await fade(1, 0, FADE_OUT_MS);
      if (mine !== generation) return;
      move();
      await fade(0, 1, FADE_IN_MS);
    } catch (error) {
      if (mine === generation) console.warn('the fade to the new lane failed:', error);
    } finally {
      if (mine === generation) {
        for (const animation of fades) animation.cancel();
        fades.clear();
      }
    }
  }

  return {
    /** The persona name, read by the label that tells screen readers what Jet is doing. */
    setName(next) {
      name = next;
      lastLabel = '';
      needsDraw = true;
    },

    start() {
      requestAnimationFrame(loop);
    },

    /** Empty state: Jet fades in at the hero spot, then waves once. */
    showHero() {
      cancelFades();
      const mine = generation;
      endFlight();
      player.rest({ standing: false });
      heroSlot.append(node);
      node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: HERO_FADE_IN_MS });
      clearTimeout(helloTimer);
      helloTimer = setTimeout(() => { if (mine === generation) director.hello(performance.now()); }, HERO_FADE_IN_MS + HELLO_AFTER_FADE_IN_MS);
      needsDraw = true;
    },

    /** Relaunch: Jet stands in the newest Jet lane and gives a short hello. */
    showInLane(lane) {
      cancelFades();
      endFlight();
      player.rest({ standing: true });
      lane.append(node);
      clearTimeout(helloTimer);
      director.hello(performance.now(), { brief: true });
      needsDraw = true;
    },

    /** Where Jet stands now. Take it before the page changes layout for a send. */
    measure,

    /** The send: Jet leaves where it stood and flies to the new lane. */
    send(lane, now, takeoff) {
      cancelFades();
      const mine = generation;
      clearTimeout(helloTimer);
      if (reduced()) {
        director.send({ cruiseMs: 0 }, now);
        const moveToLane = () => {
          pendingMove = null;
          lane.append(node);
          scrollToBottom();
        };
        pendingMove = moveToLane;
        fadeOver(moveToLane, mine);
        return;
      }
      // The send scrolls the thread, so a Jet in a lane leaves from where his line is now, or he would only hover while
      // the thread moved under him. The hero spot moves with the layout, so it was measured before the send.
      const { first, fromScale } = node.isConnected && !heroSlot.contains(node) ? measure() : takeoff;
      lane.append(node);
      scrollToBottom();
      const last = anchorOf(node.getBoundingClientRect());
      const toScale = scaleOf();
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const cruiseMs = cruiseMsFor(Math.hypot(dx, dy));
      const { moveAt, moveMs } = director.send({ cruiseMs }, now);
      flight = createFlight({ from: first, to: last, fromScale, toScale, startAt: now + moveAt, durationMs: moveMs });
      applyFlight(now);
      needsDraw = true;
    },

    /** While the voice speaks, screen readers hear "speaking" instead of what the animation is doing. */
    speaking(on) {
      speaking = on;
      lastLabel = '';
    },

    /** The user typed: a Jet the wind has lands, and the quiet time starts again. */
    typing: (now = performance.now()) => director.typing(now),
    feel: (word, now = performance.now()) => director.feel(word, now),
    mood: (word, now = performance.now()) => director.mood(word, now),
    replying: (now = performance.now()) => director.replying(now),
    done: (now = performance.now()) => director.done(now),
    failed(now = performance.now()) { cancelFades({ finishMove: true }); clearTimeout(helloTimer); director.failed(now); },
    stopped(now = performance.now()) { cancelFades({ finishMove: true }); clearTimeout(helloTimer); director.stopped(now); },

    /** App setting and system preference have already been combined by the page. */
    setReducedMotion(on) {
      cancelFades({ finishMove: true });
      player.reducedMotion = on;
      if (on) endFlight();
      needsDraw = true;
    },
  };
}
