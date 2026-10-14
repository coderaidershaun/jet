// The live Jet and the host that runs it: one node that stands in the empty
// state's hero spot or in the lane of the newest Jet message, the director that
// decides its clips, the flight that carries it down the thread on a send, and
// the frame loop that draws it. The director advances the player itself, so this
// file never ticks the player, and it hands the director the time on every call.

import { createDirector } from '../../jet/director.js';
import { createPlayer } from '../../jet/player.js';
import { mountJet } from '../../jet/view.js';
import { createFlight, cruiseMsFor } from './flight.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BODY_CENTRE = 0.56;
const IDLE_FRAME_MS = 50;
const HERO_FADE_IN_MS = 200;
const HELLO_AFTER_FADE_IN_MS = 600;
const FADE_OUT_MS = 120;
const FADE_IN_MS = 160;

/**
 * @param {{
 *   rig: import('../../jet/rig.js').Rig,
 *   params: () => import('../../jet/clip.js').Params,
 *   heroSlot: HTMLElement,
 *   scrollToBottom: () => void,
 *   motion: () => number,
 * }} options   `motion` is the motion channel, 0 to 10, which sets how much Jet breathes
 */
export function createLive({ rig, params, heroSlot, scrollToBottom, motion }) {
  const player = createPlayer(rig);
  const director = createDirector({ player, rig, params });

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'jet-svg');
  svg.setAttribute('aria-hidden', 'true');
  const draw = mountJet(svg, rig);
  const node = document.createElement('div');
  node.className = 'jet-live';
  node.setAttribute('role', 'img');
  let name = 'Jet';
  node.setAttribute('aria-label', name + ', idle');
  node.append(svg);

  /** @type {ReturnType<typeof createFlight> | null} */
  let flight = null;
  let helloTimer = 0;
  let lastLabel = 'idle';
  let lastDrawAt = -Infinity;
  let needsDraw = true;

  const reduced = () => params().reducedMotion;
  const anchorOf = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height * BODY_CENTRE });
  const scaleOf = () => node.getBoundingClientRect().width / (node.offsetWidth || 1);

  function applyFlight(now) {
    const s = flight.sample(now);
    const translate = 'translate(' + s.x.toFixed(2) + 'px,' + s.y.toFixed(2) + 'px)';
    const scale = 'scale(' + (s.mirror ? -s.scale : s.scale).toFixed(4) + ',' + s.scale.toFixed(4) + ')';
    node.style.transform = translate + ' ' + scale + ' rotate(' + s.rotate.toFixed(2) + 'deg)';
  }

  function endFlight() {
    flight = null;
    node.style.transform = '';
  }

  function tuneIdle() {
    player.breathing = motion();
    player.eyes = params().eyes;
    player.reducedMotion = reduced();
  }

  function frame(now) {
    const { busy } = director.tick(now);
    // Idle frames are skipped or drawn rarely, which would miss the faint eyes opening or blinking.
    if (player.eyesMoved) needsDraw = true;
    const label = name + ', ' + director.status;
    if (label !== lastLabel) {
      lastLabel = label;
      node.setAttribute('aria-label', label);
    }
    if (flight) {
      applyFlight(now);
      // Jet brakes after it lands, still facing the way it flew, so the mirror stays until the travel is over.
      if (now >= flight.endsAt && director.status !== 'travelling') endFlight();
    }
    const stillIdle = !busy && !flight;
    const sleeping = stillIdle && (reduced() || motion() === 0);
    if (sleeping && !needsDraw) return;
    if (stillIdle && !needsDraw && now - lastDrawAt < IDLE_FRAME_MS) return;
    draw(player.state);
    lastDrawAt = now;
    needsDraw = false;
  }

  function loop(now) {
    frame(now);
    requestAnimationFrame(loop);
  }

  async function fadeOver(move) {
    await node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_OUT_MS, fill: 'forwards' }).finished;
    move();
    await node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, fill: 'forwards' }).finished;
    for (const animation of node.getAnimations()) animation.cancel();
  }

  return {
    /** The persona name, read by the label that tells screen readers what Jet is doing. */
    setName(next) {
      name = next;
      lastLabel = '';
      needsDraw = true;
    },

    start() {
      tuneIdle();
      requestAnimationFrame(loop);
    },

    /** Empty state: Jet fades in at the hero spot, then waves once. */
    showHero() {
      endFlight();
      heroSlot.append(node);
      node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: HERO_FADE_IN_MS });
      clearTimeout(helloTimer);
      helloTimer = setTimeout(() => director.hello(performance.now()), HERO_FADE_IN_MS + HELLO_AFTER_FADE_IN_MS);
      needsDraw = true;
    },

    /** Relaunch: Jet stands in the newest Jet lane and gives a short hello. */
    showInLane(lane) {
      endFlight();
      lane.append(node);
      clearTimeout(helloTimer);
      director.hello(performance.now(), { brief: true });
      needsDraw = true;
    },

    /** Where Jet stands now. Take it before the page changes layout for a send. */
    measure() {
      endFlight();
      return { first: anchorOf(node.getBoundingClientRect()), fromScale: scaleOf() };
    },

    /** The send: Jet leaves where it stood and flies to the new lane. */
    send(lane, now, { first, fromScale }) {
      clearTimeout(helloTimer);
      if (reduced()) {
        director.send({ cruiseMs: 0 }, now);
        const moveToLane = () => {
          lane.append(node);
          scrollToBottom();
        };
        fadeOver(moveToLane).catch((error) => console.warn('the fade to the new lane failed:', error));
        return;
      }
      lane.append(node);
      scrollToBottom();
      const last = anchorOf(node.getBoundingClientRect());
      const toScale = scaleOf();
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const cruiseMs = cruiseMsFor(Math.hypot(dx, dy));
      const { moveAt, moveMs, profile } = director.send({ cruiseMs, dx, dy }, now);
      flight = createFlight({ from: first, to: last, fromScale, toScale, startAt: now + moveAt, durationMs: moveMs, profile });
      applyFlight(now);
      needsDraw = true;
    },

    typing: (active, now = performance.now()) => director.typing(active, now),
    mood: (word, now = performance.now()) => director.mood(word, now),
    replying: (now = performance.now()) => director.replying(now),
    done: (job, now = performance.now()) => director.done(job, now),
    failed: (now = performance.now()) => director.failed(now),
    stopped: (now = performance.now()) => director.stopped(now),

    /** The body colour changed: a resting Jet takes it at once. */
    recolour() {
      if (!player.playing) player.state.colour = rig.palette.rest.slice();
      needsDraw = true;
    },

    /** Settings changed how Jet rests: its breathing, its faint eyes and their blinking. */
    refresh() {
      tuneIdle();
      needsDraw = true;
    },
  };
}
