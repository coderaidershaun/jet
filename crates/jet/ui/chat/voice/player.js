// Plays the voice's clips on one audio clock, so that a clip starts at an exact time whatever the
// page is doing.

const SAMPLE_RATE = 24000;
const QUIET = 0.02;
const EDGE_S = 0.03;
const FADE_S = 0.08;
const DUCKED_GAIN = 0.15;

/**
 * @param {{ AudioContext?: typeof AudioContext }} [options]
 */
export function createVoicePlayer({ AudioContext: Context = globalThis.AudioContext ?? globalThis.webkitAudioContext } = {}) {
  /** @type {AudioContext | null} */
  let context = null;
  /** @type {GainNode | null} */
  let gain = null;
  /** A second gain after the first, so that `silence` can reset its own gain without undoing a duck. @type {GainNode | null} */
  let duckGain = null;
  /** Each scheduled source with the audio times it sounds between. */
  const sources = new Map();

  function rampDuck(to) {
    if (!duckGain) return;
    const now = context.currentTime;
    duckGain.gain.cancelScheduledValues(now);
    duckGain.gain.setValueAtTime(duckGain.gain.value, now);
    duckGain.gain.linearRampToValueAtTime(to, now + FADE_S);
  }

  return {
    /** Starts the audio clock. Browsers allow sound only after the person has touched the page, so the first call must come from a click or a key press. */
    unlock() {
      try {
        if (!context) {
          context = new Context({ latencyHint: 'interactive' });
          gain = context.createGain();
          duckGain = context.createGain();
          gain.connect(duckGain);
          duckGain.connect(context.destination);
        }
        if (context.state !== 'running') context.resume().catch((error) => console.warn('sound could not be started:', error));
      } catch (error) {
        console.warn('sound is not available:', error);
      }
    },

    /** True when the browser lets the page make sound now. */
    ready() {
      return context?.state === 'running';
    },

    /** The audio clock, in seconds. */
    now() {
      return context?.currentTime ?? 0;
    },

    /** How long sound takes to leave the device, in seconds; 0 when the browser does not say. */
    outputLatency() {
      return context?.outputLatency || 0;
    },

    /**
     * Schedules a clip of raw 16-bit mono samples at an audio time. The silence at its two ends is
     * cut off, so the pauses between clips are the ones the page chooses.
     * @param {ArrayBuffer} pcm
     * @param {number} at   audio time, in seconds
     * @returns {{ start: number, end: number }}   when the speech starts and ends, in audio time
     */
    play(pcm, at) {
      const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      let first = samples.length;
      let last = -1;
      for (let i = 0; i < samples.length; i++) {
        channel[i] = samples[i] / 32768;
        if (Math.abs(channel[i]) > QUIET) {
          if (first === samples.length) first = i;
          last = i;
        }
      }
      const from = Math.max(0, first / SAMPLE_RATE - EDGE_S);
      const to = Math.min(samples.length / SAMPLE_RATE, (last + 1) / SAMPLE_RATE + EDGE_S);
      const length = Math.max(0, to - from);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => sources.delete(source);
      source.start(at, from, length);
      const span = { start: at, end: at + length };
      sources.set(source, span);
      return span;
    },

    /** True while a clip is sounding now, not merely fetched or waiting its turn. */
    audible() {
      if (!context) return false;
      const now = context.currentTime;
      for (const { start, end } of sources.values()) if (now >= start && now < end) return true;
      return false;
    },

    /** Turns the voice down to a murmur, so a person who speaks over Jet can tell they were heard. */
    duck() {
      rampDuck(DUCKED_GAIN);
    },

    /** Brings the voice back to full after a murmur. */
    unduck() {
      rampDuck(1);
    },

    /** Fades the sound out over 80 milliseconds and drops every clip that has not played. */
    silence() {
      if (!context || sources.size === 0) return;
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      for (const source of sources.keys()) source.stop(now + FADE_S);
      sources.clear();
      gain.gain.setValueAtTime(1, now + FADE_S + 0.01);
    },
  };
}
