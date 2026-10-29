// Runs in the audio thread. Turns the microphone into 16 kHz 16-bit hops of 256 samples and posts
// them two at a time (every 32 ms) with the loudness of each. It does no analysis beyond that.

const TARGET_RATE = 16000;
const HOP_SAMPLES = 256;
const HOPS_PER_MESSAGE = 2;

// SMELL: this path is used only when the browser will not give a 16 kHz context, and Chrome does,
// so it has never run in the browser Jet is built for. Its low-pass is a plain average, which lets
// some high sound fold back into speech. A check in Safari is the only real proof that it works.
class Resampler {
  constructor(inputRate) {
    this.step = inputRate / TARGET_RATE;
    this.window = new Float32Array(Math.max(1, Math.round(this.step)));
    this.windowAt = 0;
    this.windowSum = 0;
    this.previous = 0;
    this.progress = 0;
  }

  /** @param {Float32Array} input   @param {(sample: number) => void} emit */
  run(input, emit) {
    for (const sample of input) {
      this.windowSum += sample - this.window[this.windowAt];
      this.window[this.windowAt] = sample;
      this.windowAt = (this.windowAt + 1) % this.window.length;
      const smooth = this.windowSum / this.window.length;
      this.progress += 1;
      while (this.progress >= this.step) {
        this.progress -= this.step;
        emit(smooth - (smooth - this.previous) * this.progress);
      }
      this.previous = smooth;
    }
  }
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the audio context's rate, a global of the audio thread.
    this.resampler = sampleRate === TARGET_RATE ? null : new Resampler(sampleRate);
    if (this.resampler) this.port.postMessage({ fallbackFrom: sampleRate });
    this.hops = new Int16Array(HOP_SAMPLES * HOPS_PER_MESSAGE);
    this.filled = 0;
    this.energy = [0, 0];
    this.samplesSent = 0;
  }

  take(sample) {
    const clipped = Math.max(-1, Math.min(1, sample));
    const hop = Math.floor(this.filled / HOP_SAMPLES);
    this.hops[this.filled++] = Math.round(clipped * 32767);
    this.energy[hop] += clipped * clipped;
    if (this.filled < this.hops.length) return;
    const rms = this.energy.map((sum) => Math.sqrt(sum / HOP_SAMPLES));
    const at = (this.samplesSent * 1000) / TARGET_RATE;
    this.samplesSent += this.hops.length;
    this.port.postMessage({ hops: this.hops, rms, at }, [this.hops.buffer]);
    this.hops = new Int16Array(HOP_SAMPLES * HOPS_PER_MESSAGE);
    this.filled = 0;
    this.energy = [0, 0];
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    if (this.resampler) this.resampler.run(channel, (sample) => this.take(sample));
    else for (const sample of channel) this.take(sample);
    return true;
  }
}

registerProcessor('jet-capture', CaptureProcessor);
