// Scores 16 ms hops of sound with TEN VAD, a small voice detector compiled to WebAssembly.
// Its loader does not export getValue, so results are read straight from the module's memory,
// looked up again on every call because that memory can move when it grows.

export const HOP_SAMPLES = 256;
const THRESHOLD = 0.5;
const AUDIO_BYTES = HOP_SAMPLES * 2;
const PROBABILITY_AT = AUDIO_BYTES;
const FLAG_AT = AUDIO_BYTES + 4;
const HANDLE_AT = AUDIO_BYTES + 8;
const BLOCK_BYTES = AUDIO_BYTES + 12;

function failure(what, detail) {
  return { kind: 'vadUnavailable', message: `Voice detection could not ${what}${detail ? `: ${detail}` : '.'}` };
}

/**
 * @param {{ moduleFactory: (options: object) => Promise<any>, wasmBinary?: Uint8Array }} options
 *   `moduleFactory` is the default export of `ten_vad.js`. `wasmBinary` is for Node, which cannot fetch the file itself.
 * @returns {Promise<{ probability: (hop: Int16Array) => number, reset: () => void, destroy: () => void }>}
 *   rejects with `{ kind, message }` when the WebAssembly cannot load or start
 */
export async function createVad({ moduleFactory, wasmBinary }) {
  let module;
  try {
    module = await moduleFactory(wasmBinary ? { wasmBinary } : {});
  } catch (error) {
    throw failure('load', error?.message ?? String(error));
  }
  let block = module._malloc(BLOCK_BYTES);
  let handle = null;

  function open() {
    if (module._ten_vad_create(block + HANDLE_AT, HOP_SAMPLES, THRESHOLD) !== 0) throw failure('start');
    handle = module.HEAP32[(block + HANDLE_AT) >> 2];
  }

  function close() {
    if (handle === null) return;
    module._ten_vad_destroy(block + HANDLE_AT);
    handle = null;
  }

  try {
    open();
  } catch (error) {
    module._free(block);
    throw error;
  }

  return {
    /** The chance, 0 to 1, that the hop holds speech. */
    probability(hop) {
      if (block === null) throw new Error('The voice detector was destroyed.');
      if (hop.length !== HOP_SAMPLES) throw new RangeError(`A hop holds ${HOP_SAMPLES} samples, not ${hop.length}.`);
      module.HEAP16.set(hop, block >> 1);
      const status = module._ten_vad_process(handle, block, HOP_SAMPLES, block + PROBABILITY_AT, block + FLAG_AT);
      if (status !== 0) throw failure('score a hop');
      return module.HEAPF32[(block + PROBABILITY_AT) >> 2];
    },

    /** Forgets the sound so far, as at the start of a new recording. */
    reset() {
      if (block === null) throw new Error('The voice detector was destroyed.');
      close();
      open();
    },

    destroy() {
      if (block === null) return;
      close();
      module._free(block);
      block = null;
    },
  };
}
