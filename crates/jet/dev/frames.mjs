// Draws the kite for looking at, outside the app. Run it from crates/jet:
//
//   node dev/frames.mjs still (--standing | --hovering) [options] [out-dir]
//   node dev/frames.mjs <clip mode> [--standing | --hovering] [--layers off] [--reduced-motion] [out-dir]
//
// A still is written as an SVG and as two PNGs (twice the size, and the size it
// shows at in the chat lane), and all stills in a run are laid side by side on
// a contact sheet. A clip mode plays the real clip through the real player on
// a fixed clock and writes every frame the same way, then a contact sheet of
// the key moments. The PNGs come from rsvg-convert. Nothing is written into the
// repository unless you name a folder in it.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLIPS } from '../ui/jet/clips/catalogue.js';
import { createFlight } from '../ui/chat/stage/flight.js';
import { KINDS } from '../ui/jet/parts/eyes.js';
import { CENTRE, HOVER_Y, TIP, kite } from '../ui/jet/parts/forms.js';
import { paint, restingFrame } from '../ui/jet/draw/paint.js';
import { createPlayer, stretchFromSpeed } from '../ui/jet/player.js';
import { fistRoute, HAND_SCALE } from '../ui/jet/parts/routes.js';
import { REST_LENGTH, SEGMENTS, createChain, jPose, lyingPose } from '../ui/jet/parts/string.js';

const RSVG = '/opt/homebrew/bin/rsvg-convert';
const DEFAULT_OUT_FOLDER = join(tmpdir(), 'jet-renders');
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const BACKGROUND = '#13191F';
const WIDTH = 200;
const HEIGHT = 240;
const GUTTER = 10;
const LANE_UNIT_PX = 0.24;
const LANE_DEVICE_RATIO = 2;
// The hovering kite is the reference pose; standing moves it down by the hover height.
const REFERENCE_TIP = kite()[TIP];
const STANDING_TIP = [REFERENCE_TIP[0], REFERENCE_TIP[1] + HOVER_Y];
const FRAME_MS = 40;

// A clip mode plays its steps in turn. A step's options may be a function of the
// player, and `playMs` cuts the step short. The contact sheet shows the moments
// in `sheetMs`, or else the start and the end of every phase.
const HELLO_SHEET_MS = [0, 180, 500, 1150, 2300];
const WORKING_PLAY_MS = 3000;
const CLIP_MODES = {
  hello: { steps: [{ clip: 'hello' }], sheetMs: HELLO_SHEET_MS },
  'hello-brief': { steps: [{ clip: 'hello', options: { brief: true } }], sheetMs: HELLO_SHEET_MS },
  fly: { steps: [{ clip: 'fly', options: { cruiseMs: 800 } }], carry: true },
  settle: { steps: [{ clip: 'settle' }] },
  working: {
    steps: [
      { clip: 'working', playMs: WORKING_PLAY_MS },
      { clip: 'workingEnd', options: (player) => ({ roll: player.state.roll, elapsedMs: WORKING_PLAY_MS }) },
    ],
  },
};

const USAGE = `usage: node dev/frames.mjs still (--standing | --hovering) [--lift L,R] [--form k] [--pose j]
         [--speed V] [--eyes round|lid|B|C] [--anger a] [--squint q] [--lids l,r] [--no-string] [out-dir]
       node dev/frames.mjs ${Object.keys(CLIP_MODES).join('|')} [--standing | --hovering] [--layers off] [--reduced-motion] [out-dir]

A flag given more than once draws one still for each value.
  --lift L,R    corner lift in degrees, left then right
  --speed V     speed in degrees per second of the more lifted corner (draws its speed lines and stretch)
  --form k      0 kite .. 1 spinner
  --pose j      the string raised in the J and writing the fist
  --lids l,r    how shut each lid is, 0 open .. 1 shut

A clip mode plays at 25 frames a second with no blinks. It starts hovering unless you say --standing,
and writes into <out-dir>/<mode>-<hovering|standing>[-no-layers] one SVG and two PNGs for every frame, and a contact sheet
of the first frame and the end of each phase (hello: the wave's own key moments).
  --layers off  leaves out the idle bob and sway, so only the clip moves the kite`;

class UsageError extends Error {}

const VALUE_FLAGS = ['lift', 'speed', 'form', 'pose', 'eyes', 'anger', 'squint', 'lids'];
const CLIP_VALUE_FLAGS = ['layers'];
const ALL_VALUE_FLAGS = [...VALUE_FLAGS, ...CLIP_VALUE_FLAGS];
const SWITCHES = ['standing', 'hovering', 'no-string', 'reduced-motion'];

function parseArguments(args) {
  const values = Object.fromEntries(ALL_VALUE_FLAGS.map((name) => [name, []]));
  const switches = new Set();
  let folder = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name && SWITCHES.includes(name)) switches.add(name);
    else if (name && ALL_VALUE_FLAGS.includes(name)) {
      if (i + 1 >= args.length) throw new UsageError(`--${name} needs a value`);
      values[name].push(args[++i]);
    } else if (name) throw new UsageError(`unknown option ${arg}`);
    else folder = arg;
  }
  if (switches.has('standing') && switches.has('hovering')) throw new UsageError('give --standing or --hovering, not both');
  return { values, switches, folder };
}

function numbersFrom(text, count, flag) {
  const parts = text.split(',').map(Number);
  if (parts.length !== count || parts.some(Number.isNaN)) throw new UsageError(`--${flag} needs ${count} number${count > 1 ? 's' : ''}, like ${count > 1 ? '0,30' : '0.5'}; got "${text}"`);
  return parts;
}

// Every combination of the values given for each flag, in the order of VALUE_FLAGS.
function variants(values) {
  let combos = [{}];
  for (const flag of VALUE_FLAGS) {
    if (values[flag].length === 0) continue;
    combos = combos.flatMap((combo) => values[flag].map((value) => ({ ...combo, [flag]: value })));
  }
  return combos;
}

function valueInName(value) {
  if (value.includes(',')) return value.split(',').map(Number).join('-');
  if (/^[-\d.]+$/.test(value)) return String(Number(value));
  return '-' + value;
}

function stillName(base, combo, switches) {
  const suffix = Object.entries(combo).map(([flag, value]) => `-${flag}${valueInName(value)}`);
  if (switches.has('no-string')) suffix.push('-no-string');
  return base + suffix.join('');
}

function buildFrame(standing, combo, switches) {
  const frame = restingFrame();
  frame.y = standing ? 0 : HOVER_Y;
  frame.pivot = standing ? [...REFERENCE_TIP] : [...CENTRE];
  if (combo.lift) frame.lift = numbersFrom(combo.lift, 2, 'lift');
  if (combo.form) frame.form = numbersFrom(combo.form, 1, 'form')[0];
  if (combo.lids) frame.eyes.lids = numbersFrom(combo.lids, 2, 'lids');
  if (combo.anger) frame.eyes.anger = numbersFrom(combo.anger, 1, 'anger')[0];
  if (combo.squint) frame.eyes.squint = numbersFrom(combo.squint, 1, 'squint')[0];
  if (combo.eyes) {
    if (!KINDS.includes(combo.eyes)) throw new UsageError(`--eyes must be one of ${KINDS.join(', ')}; got "${combo.eyes}"`);
    frame.eyes.kind = combo.eyes;
  }
  if (combo.speed) {
    const speed = numbersFrom(combo.speed, 1, 'speed')[0];
    // The corner that is lifted more is the one moving; the other stays still. A tie goes to the right.
    const moving = Math.abs(frame.lift[0]) > Math.abs(frame.lift[1]) ? 0 : 1;
    frame.liftSpeed = [0, 0];
    frame.liftSpeed[moving] = speed;
    frame.stretch = [0, 0];
    frame.stretch[moving] = stretchFromSpeed(speed);
  }
  if (combo.pose && combo.pose !== 'j') throw new UsageError(`--pose must be j; got "${combo.pose}"`);
  if (!switches.has('no-string')) frame.string = stillString(standing, combo.pose);
  return frame;
}

function stillString(standing, poseName) {
  const tip = standing ? STANDING_TIP : REFERENCE_TIP;
  const everySegment = Array(SEGMENTS).fill(1);
  const chain = createChain();
  if (poseName === 'j') {
    const pose = jPose();
    const route = fistRoute();
    return chain.points({
      tip,
      t: 0,
      pose: { ...pose, blend: everySegment },
      payout: pose.length / REST_LENGTH,
      written: { route, length: route.totalLength, scale: HAND_SCALE, tremor: 0 },
    });
  }
  if (standing) return chain.points({ tip, t: 0, pose: { ...lyingPose(), blend: everySegment } });
  return chain.points({ tip, t: 0 });
}

const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function serialise(node) {
  const attributes = Object.entries(node.attrs).map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`).join('');
  if (!node.children) return `<${node.tag}${attributes}/>`;
  return `<${node.tag}${attributes}>${node.children.map(serialise).join('')}</${node.tag}>`;
}

const stillSvg = (frame, unitPx) =>
  `<svg xmlns="${SVG_NAMESPACE}" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
  `<rect width="${WIDTH}" height="${HEIGHT}" fill="${BACKGROUND}"/>${serialise(paint(frame, { unitPx }))}</svg>`;

function render(svg, width, height, outputPath) {
  execFileSync(RSVG, ['-w', String(width), '-h', String(height), '-o', outputPath], { input: svg });
}

function writeStill(folder, name, frame) {
  const svgPath = join(folder, `${name}.svg`);
  const bigPath = join(folder, `${name}@2x.png`);
  const lanePath = join(folder, `${name}@lane.png`);
  const svg = stillSvg(frame, 1);
  writeFileSync(svgPath, svg);
  render(svg, WIDTH * 2, HEIGHT * 2, bigPath);
  const laneWidth = Math.round(WIDTH * LANE_UNIT_PX * LANE_DEVICE_RATIO);
  const laneHeight = Math.round(HEIGHT * LANE_UNIT_PX * LANE_DEVICE_RATIO);
  render(stillSvg(frame, LANE_UNIT_PX), laneWidth, laneHeight, lanePath);
  return { svg, written: [svgPath, bigPath, lanePath] };
}

function writeSheet(folder, stills) {
  const width = stills.length * WIDTH + (stills.length - 1) * GUTTER;
  const nested = stills.map((still, i) => still.svg.replace('<svg ', `<svg x="${i * (WIDTH + GUTTER)}" y="0" `)).join('');
  const sheet =
    `<svg xmlns="${SVG_NAMESPACE}" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">` +
    `<rect width="${width}" height="${HEIGHT}" fill="${BACKGROUND}"/>${nested.replaceAll(` xmlns="${SVG_NAMESPACE}"`, '')}</svg>`;
  writeFileSync(join(folder, 'sheet.svg'), sheet);
  render(sheet, width * 2, HEIGHT * 2, join(folder, 'sheet.png'));
  return [join(folder, 'sheet.svg'), join(folder, 'sheet.png')];
}

function stillsMode(args) {
  const { values, switches, folder } = parseArguments(args);
  if (switches.has('standing') === switches.has('hovering')) throw new UsageError('give exactly one of --standing and --hovering');
  if (values.layers.length > 0) throw new UsageError('--layers works with the clip modes only');
  const standing = switches.has('standing');
  const outFolder = resolve(folder ?? DEFAULT_OUT_FOLDER);
  mkdirSync(outFolder, { recursive: true });

  const stills = variants(values).map((combo) => {
    const name = stillName(standing ? 'standing' : 'hovering', combo, switches);
    return { name, ...writeStill(outFolder, name, buildFrame(standing, combo, switches)) };
  });
  return [...stills.flatMap((still) => still.written), ...writeSheet(outFolder, stills)];
}

// Plays the mode's steps through a real player, one frame every 40 ms, and writes each frame as it is made.
// `phaseEndsMs` are the moments the steps' phases end, for the contact sheet.
function playFrames(mode, { standing, layers, reducedMotion }, folder) {
  const player = createPlayer({ random: () => 1, layers, standing, reducedMotion });
  const frames = [];
  const written = [];
  const phaseEndsMs = [0];
  let now = 0;
  const flight = mode.carry ? createFlight({
    from: { x: 0, y: 0 },
    to: { x: 240, y: 120 },
    fromScale: LANE_UNIT_PX,
    toScale: LANE_UNIT_PX,
    startAt: 500,
    durationMs: 800,
  }) : null;
  let lastPoint = flight?.sample(0);
  const record = () => {
    if (flight) {
      const point = flight.sample(now);
      player.carry((point.x - lastPoint.x) / LANE_UNIT_PX, (point.y - lastPoint.y) / LANE_UNIT_PX);
      lastPoint = point;
    }
    player.tick(now);
    const name = `frame-${String(frames.length).padStart(3, '0')}`;
    const still = writeStill(folder, name, player.frame);
    frames.push(still);
    written.push(...still.written);
  };
  mode.steps.forEach((step, index) => {
    const start = { standing: player.standing, eyeKind: player.state.eyeKind, reducedMotion };
    const options = typeof step.options === 'function' ? step.options(player) : step.options;
    const began = now;
    const clip = CLIPS[step.clip].build(start, options);
    const playMs = step.playMs ?? Infinity;
    phaseEndsMs.push(...clip.phases.map((phase) => began + phase.end).filter((ms) => ms - began <= playMs));
    player.play(clip, now);
    // The step's first frame is the last frame of the one before, so only the very first step draws it.
    if (index === 0) record();
    while (player.playing && now - began < playMs) {
      now += FRAME_MS;
      record();
    }
    if (playMs < Infinity) phaseEndsMs.push(now);
  });
  return { frames, written, lastMs: now, phaseEndsMs };
}

function clipMode(modeName, args) {
  const { values, switches, folder } = parseArguments(args);
  if (VALUE_FLAGS.some((flag) => values[flag].length > 0) || switches.has('no-string')) throw new UsageError(`"${modeName}" takes only --standing, --hovering, --layers off and --reduced-motion`);
  const [layersValue] = values.layers;
  if (layersValue !== undefined && !['on', 'off'].includes(layersValue)) throw new UsageError(`--layers must be on or off; got "${layersValue}"`);
  const layers = layersValue !== 'off';
  const reducedMotion = switches.has('reduced-motion');
  const standing = switches.has('standing') || reducedMotion;
  const name = `${modeName}-${standing ? 'standing' : 'hovering'}${layers ? '' : '-no-layers'}${reducedMotion ? '-reduced' : ''}`;
  const outFolder = join(resolve(folder ?? DEFAULT_OUT_FOLDER), name);
  mkdirSync(outFolder, { recursive: true });

  const mode = CLIP_MODES[modeName];
  const { frames, written, lastMs, phaseEndsMs } = playFrames(mode, { standing, layers, reducedMotion }, outFolder);
  const sheetMs = [...new Set(mode.sheetMs ?? phaseEndsMs)].sort((a, b) => a - b);
  // Each moment shows the last frame at or before it, as the reference contact sheets pick them.
  const sheetFrames = sheetMs.filter((ms) => ms <= lastMs).map((ms) => frames[Math.floor(ms / FRAME_MS + 1e-9)]);
  return [...written, ...writeSheet(outFolder, sheetFrames)];
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'still') return console.log(stillsMode(rest).join('\n'));
  if (!(mode in CLIP_MODES)) throw new UsageError(mode ? `"${mode}" is not a mode; give still or one of ${Object.keys(CLIP_MODES).join(', ')}` : 'give a mode');
  console.log(clipMode(mode, rest).join('\n'));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  if (error.message) console.error(`frames.mjs: ${error.message}\n`);
  console.error(USAGE);
  process.exit(1);
}
