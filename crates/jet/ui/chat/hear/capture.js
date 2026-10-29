// The microphone. It asks for permission, runs the audio through the capture worklet and reports
// 16 kHz hops. It says plainly when the microphone is blocked, missing, muted or suspended.
// Browser only: there is no test for it, so it is kept short.

const WORKLET_URL = new URL('./capture-worklet.js', import.meta.url).href;
const TARGET_RATE = 16000;
const RESUME_WAIT_MS = 500;
const CONSTRAINTS = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

function describeMicrophoneError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return { kind: 'permissionDenied', message: "The microphone is blocked. Allow it in the browser's site settings, then click." };
  }
  return { kind: 'noDevice', message: error?.name === 'NotFoundError' ? 'No microphone was found.' : `The microphone could not be used: ${error?.message ?? error}` };
}

/**
 * @returns {{
 *   start: () => Promise<{ sampleRate: number }>,
 *   stop: () => void,
 *   onFrames: ((hops: Int16Array, rms: number[], atMs: number) => void) | null,
 *   onEnded: ((reason: { kind: string, message: string }) => void) | null,
 * }}   `start` rejects with `{ kind: 'permissionDenied' | 'noDevice' | 'suspended' | 'stopped', message }`, `stopped` when
 *   `stop` or a later `start` came first; `onEnded` is called with `kind` `trackEnded`, `muted` or `suspended`
 */
export function createCapture() {
  /** @type {{ stream: MediaStream | null, context: AudioContext | null, node: AudioWorkletNode | null } | null} */
  let live = null;
  let attempts = 0;

  /** Some browsers refuse a 16 kHz context, so with no `rate` this asks for the device's own rate instead. */
  async function connect(stream, rate) {
    const options = rate ? { sampleRate: rate, latencyHint: 'interactive' } : { latencyHint: 'interactive' };
    const context = new AudioContext(options);
    try {
      return { context, source: context.createMediaStreamSource(stream) };
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  function releaseParts({ stream, context, node }) {
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.onmute = null;
      track.stop();
    }
    if (context) context.onstatechange = null;
    if (node) node.port.onmessage = null;
    node?.disconnect();
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }

  function release() {
    if (live) releaseParts(live);
    live = null;
  }

  function ended(reason) {
    if (!live) return;
    release();
    capture.onEnded?.(reason);
  }

  /** Fills `parts` as each piece is made, so a failure part way can still release what was made. */
  async function open(parts) {
    try {
      parts.stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    } catch (error) {
      throw describeMicrophoneError(error);
    }
    try {
      const { context, source } = await connect(parts.stream, TARGET_RATE).catch(() => connect(parts.stream, null));
      parts.context = context;
      await context.audioWorklet.addModule(WORKLET_URL);
      parts.node = new AudioWorkletNode(context, 'jet-capture');
      parts.node.port.onmessage = ({ data }) => {
        if (live !== parts) return;
        if (data.hops) capture.onFrames?.(data.hops, data.rms, data.at);
        else console.warn(`The microphone runs at ${data.fallbackFrom} Hz, so Jet resamples it itself.`);
      };
      // Some browsers only run a node whose output reaches the speakers, so it goes there at zero volume.
      const silence = new GainNode(context, { gain: 0 });
      source.connect(parts.node).connect(silence).connect(context.destination);
      if (context.state !== 'running') await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS))]);
      if (context.state !== 'running') throw { kind: 'suspended', message: 'Click anywhere to start listening.' };
    } catch (error) {
      throw error.kind ? error : describeMicrophoneError(error);
    }
  }

  const capture = {
    onFrames: null,
    onEnded: null,

    async start() {
      const mine = ++attempts;
      release();
      const parts = { stream: null, context: null, node: null };
      try {
        await open(parts);
      } catch (error) {
        releaseParts(parts);
        throw error;
      }
      // Asking for the microphone can take as long as the user looks at the prompt, and the user may switch off meanwhile.
      if (mine !== attempts) {
        releaseParts(parts);
        throw { kind: 'stopped', message: 'Listening was switched off while the microphone started.' };
      }
      live = parts;
      const [track] = parts.stream.getAudioTracks();
      track.onended = () => ended({ kind: 'trackEnded', message: 'The microphone stopped. Click to listen again.' });
      track.onmute = () => ended({ kind: 'muted', message: 'The browser muted the microphone. Click to listen again.' });
      parts.context.onstatechange = () => {
        if (parts.context.state !== 'running') ended({ kind: 'suspended', message: 'The browser paused listening. Click to listen again.' });
      };
      return { sampleRate: parts.context.sampleRate };
    },

    /** Lets go of the microphone, and of one that a start is still asking for. */
    stop() {
      attempts++;
      release();
    },
  };
  return capture;
}
