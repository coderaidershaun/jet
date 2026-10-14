// A stand-in for the director that decides which clip Jet plays when. It plays
// the real hello and zoom through the real player and holds the circle for
// everything else, while keeping the same status words the real director uses.

import { buildHello } from '../../jet/clips/hello.js';
import { buildZoom } from '../../jet/clips/zoom.js';

export const MOODS = ['neutral', 'happy', 'excited', 'thinking', 'curious', 'sorry', 'alert', 'annoyed', 'hello'];

const SETTLE_MS = { reacting: 450, failed: 1500, stopped: 1200 };

/**
 * @param {{
 *   player: ReturnType<typeof import('../../jet/player.js').createPlayer>,
 *   rig: import('../../jet/rig.js').Rig,
 *   params: () => import('../../jet/clip.js').Params,
 * }} options
 */
export function createDirector({ player, rig, params }) {
  /** @type {'idle' | 'typing' | 'travelling' | 'working' | 'reacting' | 'stopped' | 'failed'} */
  let status = 'idle';
  let clipName = null;
  let running = false;
  let travelling = false;
  let afterTravel = null;
  let settleAt = 0;

  const play = (name, clip, now) => {
    clipName = name;
    player.play(clip, now);
  };

  function end(next, now) {
    running = false;
    if (travelling) {
      afterTravel = next;
      return;
    }
    status = next;
    settleAt = now + SETTLE_MS[next];
  }

  return {
    hello(now, { brief = false } = {}) {
      const clip = buildHello(rig, params(), { brief });
      play('hello', clip, now);
      status = 'reacting';
      settleAt = now + clip.total;
    },

    typing(active, _now) {
      if (active && status === 'idle') status = 'typing';
      else if (!active && status === 'typing') status = 'idle';
    },

    send({ cruiseMs }, now) {
      running = true;
      afterTravel = null;
      if (params().reducedMotion) {
        status = 'working';
        return { moveAt: 0, moveMs: 0 };
      }
      const clip = buildZoom(rig, params(), { cruiseMs });
      play('zoom', clip, now);
      travelling = true;
      status = 'travelling';
      return { moveAt: clip.phases[0].end, moveMs: clip.phases[1].end - clip.phases[0].end };
    },

    /** The real director plays a clip for the mood; the circle needs nothing. */
    mood(_word, _now) {},

    /** The real director closes the working loop here; the circle needs nothing. */
    replying(_now) {},

    done(_job, now) {
      end('reacting', now);
    },

    failed(now) {
      end('failed', now);
    },

    stopped(now) {
      end('stopped', now);
    },

    /** Moves Jet to `now`. Once per frame, before drawing. */
    tick(now) {
      player.tick(now);
      if (travelling && !player.playing) {
        travelling = false;
        if (afterTravel) {
          status = afterTravel;
          settleAt = now + SETTLE_MS[afterTravel];
          afterTravel = null;
        } else {
          status = running ? 'working' : 'idle';
        }
      }
      if (settleAt && now >= settleAt) {
        settleAt = 0;
        if (!running && !travelling) status = 'idle';
      }
      return { clip: player.playing ? clipName : null, busy: player.playing || running };
    },

    get status() {
      return status;
    },
  };
}
