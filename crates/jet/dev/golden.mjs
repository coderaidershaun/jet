// Pulls the numbers the tests compare against out of the two baked animation
// files, jet-wave.svg and jet-flip.svg, and writes them as two small JSON
// fixtures. Each animation in those files sits on a line of its own, so they
// are read one line at a time. Run it from crates/jet:
//
//   node dev/golden.mjs [wave.svg] [flip.svg]
//
// Running it again on the same files changes no byte.

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const FIXTURES = new URL('../ui/jet-next/fixtures/', import.meta.url);
const [waveFile = '/Users/shaun/Downloads/jet-wave.svg', flipFile = '/Users/shaun/Downloads/jet-flip.svg'] = process.argv.slice(2);

const WAVE = { frames: 75, fps: 25 };
const FLIP = { frames: 120, fps: 25, every: 5 };
const LEFT_EYE = '84.5 89.9';
const RIGHT_EYE = '115.5 89.9';

async function readAnimations(path, onAnimation) {
  let parent = '';
  let groupOrigin = '';
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    const translated = line.match(/^\s*<g transform="translate\(([^)]*)\)">/);
    if (translated) groupOrigin = translated[1];
    if (/^\s*<animate/.test(line)) onAnimation({ line, parent, origin: groupOrigin });
    else parent = line;
  }
}

// Each track must turn up exactly once in its file.
function trackRecorder(file) {
  const found = {};
  const record = (name, list) => {
    if (found[name]) throw new Error(`${file}: more than one ${name} track`);
    found[name] = list;
  };
  const complete = (names) => {
    for (const name of names) if (!found[name]) throw new Error(`${file}: no ${name} track found`);
    return found;
  };
  return { record, complete };
}

// The value each frame shows. A key at time k covers the frames from
// round(k * frames) until the next key; the last key is the loop back to frame 0.
function valuesByFrame(line, frames, where) {
  const keys = line.match(/keyTimes="([^"]*)"/)?.[1].split(';').map(Number);
  const values = line.match(/values="([^"]*)"/)?.[1].split(';');
  if (!keys || !values || keys.length !== values.length) throw new Error(`${where}: key times and values do not pair up`);
  const starts = keys.slice(0, -1).map((k) => Math.round(k * frames));
  const perFrame = [];
  for (let frame = 0; frame < frames; frame++) {
    let held = -1;
    starts.forEach((start, i) => {
      if (start <= frame) held = i;
    });
    if (held < 0) throw new Error(`${where}: no value for frame ${frame}`);
    perFrame.push(values[held]);
  }
  return perFrame;
}

const numbers = (text) => text.match(/-?\d+(?:\.\d+)?/g).map(Number);
const firstNumber = (text) => numbers(text)[0];
const secondNumber = (text) => numbers(text)[1];

// The end points of a path of cubic curves: its start, then the last pair of every curve.
function curveEnds(d) {
  const [start, ...curves] = d.split('C');
  const ends = [numbers(start)];
  for (const curve of curves) ends.push(numbers(curve).slice(-2));
  return ends;
}

// The control points of the quadratic curves, which are an eye's corners.
const eyeCorners = (d) => [...d.matchAll(/Q(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

async function waveFixture() {
  const { record, complete } = trackRecorder(waveFile);
  await readAnimations(waveFile, ({ line, parent, origin }) => {
    if (line.includes('type="rotate"')) record('roll', valuesByFrame(line, WAVE.frames, 'roll').map(firstNumber));
    else if (line.includes('attributeName="opacity"') && parent.includes('<path fill="#6DA7FA"')) {
      record('handOpacity', valuesByFrame(line, WAVE.frames, 'handOpacity').map(Number));
    } else if (line.includes('type="scale"') && origin === RIGHT_EYE) {
      record('winkScale', valuesByFrame(line, WAVE.frames, 'winkScale').map(secondNumber));
    }
  });
  const found = complete(['roll', 'handOpacity', 'winkScale']);

  const frames = Array.from({ length: WAVE.frames }, (_, f) => [f, found.roll[f], found.handOpacity[f], found.winkScale[f]]);
  return {
    header: { from: `jet-wave.svg: ${WAVE.frames} frames at ${WAVE.fps} fps (${(WAVE.frames / WAVE.fps).toFixed(1)} s), every frame`, fps: WAVE.fps },
    frames: frames.map((frame) => JSON.stringify(frame)),
  };
}

async function flipFixture() {
  const { record, complete } = trackRecorder(flipFile);
  await readAnimations(flipFile, ({ line, parent, origin }) => {
    if (line.includes('type="rotate"')) record('roll', valuesByFrame(line, FLIP.frames, 'roll').map(firstNumber));
    else if (line.includes('type="translate"')) record('dy', valuesByFrame(line, FLIP.frames, 'dy').map(secondNumber));
    else if (line.includes('attributeName="d"') && parent.includes('<path fill="none" stroke="#8FBBFA"')) {
      record('string', valuesByFrame(line, FLIP.frames, 'string').map(curveEnds));
    } else if (line.includes('attributeName="d"') && origin === LEFT_EYE) {
      record('eyeLeft', valuesByFrame(line, FLIP.frames, 'left eye').map(eyeCorners));
    } else if (line.includes('attributeName="d"') && origin === RIGHT_EYE) {
      record('eyeRight', valuesByFrame(line, FLIP.frames, 'right eye').map(eyeCorners));
    }
  });
  const found = complete(['roll', 'dy', 'string', 'eyeLeft', 'eyeRight']);

  const frames = [];
  for (let frame = 0; frame < FLIP.frames; frame += FLIP.every) {
    frames.push({
      frame,
      roll: found.roll[frame],
      dy: found.dy[frame],
      string: found.string[frame],
      eyes: [found.eyeLeft[frame], found.eyeRight[frame]],
    });
  }
  const last = frames.at(-1).frame;
  return {
    header: {
      from: `jet-flip.svg: every fifth frame (0, ${FLIP.every}, …, ${last}) of ${FLIP.frames} at ${FLIP.fps} fps (${(FLIP.frames / FLIP.fps).toFixed(1)} s)`,
      fps: FLIP.fps,
    },
    frames: frames.map((frame) => JSON.stringify(frame)),
  };
}

// One frame per line, so a change shows up as a readable diff.
function write(name, { header, frames }) {
  const text = `{\n"from": ${JSON.stringify(header.from)},\n"fps": ${header.fps},\n"frames": [\n${frames.join(',\n')}\n]\n}\n`;
  // The text is put together by hand, so make sure it is valid JSON before it is written.
  JSON.parse(text);
  const path = fileURLToPath(new URL(name, FIXTURES));
  writeFileSync(path, text);
  console.log(`${path}: ${Buffer.byteLength(text)} bytes`);
}

write('wave.json', await waveFixture());
write('flip.json', await flipFixture());
