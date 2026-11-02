// The trail beside the mic: bars that show how loud the microphone's sound is, born at the right
// and flowing left, so the user sees that Jet hears them. Bars stand tall only for speech; other
// sound stays low. The bars are kept apart from the drawing so they can be tested without a browser.

const BAR_STEP_PX = 4;
/** One bar for every two levels, and the engine sends a level every 32 ms. */
const BAR_MS = 64;
const PX_PER_MS = BAR_STEP_PX / BAR_MS;
const BAR_WIDTH_PX = 2;
const SHORTEST_BAR_PX = 2;
const TALLEST_SPEECH_BAR_PX = 24;
/** Sound that is not speech, such as keys, a door or breath, stays a low line so spoken words stand out. */
const TALLEST_NOISE_BAR_PX = 6;
const FADED_ALPHA = 0.15;

/** The bars and when each was born, apart from any drawing. */
export function createTrailBars() {
  let bars = [];
  let waiting = null;

  return {
    /** Every second level makes a bar, as loud as the louder of the two and speech if either was; the first only waits for its partner. */
    add(level, speech, now) {
      if (waiting === null) {
        waiting = { level, speech };
        return;
      }
      const tallest = waiting.speech || speech ? TALLEST_SPEECH_BAR_PX : TALLEST_NOISE_BAR_PX;
      const height = SHORTEST_BAR_PX + (tallest - SHORTEST_BAR_PX) * Math.max(waiting.level, level);
      bars.push({ height, bornAt: now });
      waiting = null;
    },

    /** The bars still in view, oldest first, each with the x of its right end and its height; a bar that has left is gone for good. */
    at(now, width) {
      const xOf = (bar) => width - (now - bar.bornAt) * PX_PER_MS;
      bars = bars.filter((bar) => xOf(bar) > 0);
      return bars.map((bar) => ({ x: xOf(bar), height: bar.height }));
    },
  };
}

/**
 * Draws the bars on the trail's canvas while any are left; the loop sleeps until the next level.
 * @param {{ canvas: HTMLCanvasElement, reducedMotion: () => boolean }} options
 */
export function createTrail({ canvas, reducedMotion }) {
  const bars = createTrailBars();
  const context = canvas.getContext('2d');
  let colour;
  let running = false;

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = devicePixelRatio;
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    colour ??= getComputedStyle(canvas).getPropertyValue('--accent').trim();
    // Setting a canvas size resets its context, so the transform and the colour are set on every frame.
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = colour;
    context.clearRect(0, 0, width, height);
    const inView = bars.at(performance.now(), width);
    for (const { x, height: barHeight } of inView) {
      context.globalAlpha = FADED_ALPHA + (1 - FADED_ALPHA) * x / width;
      context.beginPath();
      context.roundRect(x - BAR_WIDTH_PX, (height - barHeight) / 2, BAR_WIDTH_PX, barHeight, BAR_WIDTH_PX / 2);
      context.fill();
    }
    if (inView.length === 0) running = false;
    else requestAnimationFrame(draw);
  }

  return {
    add(level, speech) {
      if (reducedMotion()) return;
      bars.add(level, speech, performance.now());
      if (running) return;
      running = true;
      requestAnimationFrame(draw);
    },
  };
}
