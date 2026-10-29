import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createVADModule from '../../../vendor/ten-vad/ten_vad.js';
import { createVad, HOP_SAMPLES } from './vad.js';

const WAV_HEADER_BYTES = 44;
const wasmBinary = readFileSync(new URL('../../../vendor/ten-vad/ten_vad.wasm', import.meta.url));

/** The speech probability of every 256-sample hop of a 16 kHz mono 16-bit WAV file. */
async function probabilities(fileName) {
  const file = readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url));
  const samples = new Int16Array(file.buffer.slice(file.byteOffset + WAV_HEADER_BYTES, file.byteOffset + file.byteLength));
  const vad = await createVad({ moduleFactory: createVADModule, wasmBinary });
  try {
    const scores = [];
    for (let at = 0; at + HOP_SAMPLES <= samples.length; at += HOP_SAMPLES) scores.push(vad.probability(samples.subarray(at, at + HOP_SAMPLES)));
    return scores;
  } finally {
    vad.destroy();
  }
}

test('the real voice detector hears speech in a spoken sentence and mostly nothing in quiet noise with a cough-like burst, and says why when it cannot load', async () => {
  const sentence = await probabilities('hello.wav');
  let run = 0;
  let longest = 0;
  for (const p of sentence) {
    run = p > 0.6 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  assert.ok(longest * 16 >= 500, `the longest run above 0.6 is ${longest * 16} ms`);

  const noise = await probabilities('noise.wav');
  const quiet = noise.filter((p) => p < 0.4).length / noise.length;
  assert.ok(quiet >= 0.8, `${Math.round(quiet * 100)}% of the noise hops are under 0.4`);

  await assert.rejects(
    createVad({ moduleFactory: async () => { throw new Error('no wasm here'); } }),
    { kind: 'vadUnavailable', message: 'Voice detection could not load: no wasm here' },
  );
});
