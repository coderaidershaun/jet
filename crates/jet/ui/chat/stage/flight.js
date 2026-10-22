// The host moves Jet by offsets from its destination slot.

const MIN_CRUISE_MS = 520;
const MAX_CRUISE_MS = 1400;
const BRAKE_AT = 0.9;
const MAX_BOW_PX = 40;
const OVERSHOOT_PX = 5;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** How long the cruise lasts for a flight of this many pixels. */
export function cruiseMsFor(distancePx) {
  return clamp(260 + 0.8 * distancePx, MIN_CRUISE_MS, MAX_CRUISE_MS);
}

/** Points are the node's transform origin on screen. */
export function createFlight({ from, to, fromScale, toScale, startAt, durationMs }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const bow = Math.min(MAX_BOW_PX, distance * 0.15);
  const beyond = distance === 0 ? { x: 0, y: 0 } : { x: OVERSHOOT_PX * dx / distance, y: OVERSHOOT_PX * dy / distance };
  return {
    endsAt: startAt + durationMs,
    sample(now) {
      const progress = durationMs <= 0 ? (now >= startAt ? 1 : 0) : clamp((now - startAt) / durationMs, 0, 1);
      const outbound = progress <= BRAKE_AT;
      const travelled = smooth(outbound ? progress / BRAKE_AT : (progress - BRAKE_AT) / (1 - BRAKE_AT));
      const x = outbound ? lerp(-dx, beyond.x, travelled) + bow * Math.sin(Math.PI * travelled) : lerp(beyond.x, 0, travelled);
      const y = outbound ? lerp(-dy, beyond.y, travelled) : lerp(beyond.y, 0, travelled);
      return { x, y, scale: Math.min(1, lerp(fromScale, toScale, smooth(progress))) };
    },
  };
}
