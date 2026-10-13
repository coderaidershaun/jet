// Wires the lab together: loads the rig and the saved settings, mounts the
// scenery and Jet on one stage, binds the controls, and runs the frame loop.
// A settings change saves after a short pause and replays the last clip so the
// change is visible at once.

import { buildHello } from '../jet/clips/hello.js';
import { createPlayer } from '../jet/player.js';
import { mountScene } from '../jet/scene.js';
import { mountJet } from '../jet/view.js';
import { buildZoom } from '../jet/clips/zoom.js';
import { createDial } from './dial.js';
import { renderProgress, renderReadout } from './readout.js';
import { loadRig, loadSettings, saveSettings } from './settings.js';
import { createWheel } from './wheel.js';

const REPLAY_AFTER_CHANGE_MS = 450;
const SAVE_AFTER_CHANGE_MS = 800;
const REPEAT_GAP_MS = 1400;
const FIRST_CLIP_MS = 700;

const CLIPS = {
  hello: { name: 'This hello', build: (rig, params) => buildHello(rig, params) },
  zoom: { name: 'This zoom', build: (rig, params) => buildZoom(rig, params) },
};

async function start() {
  const rig = await loadRig();
  const settings = await loadSettings();

  const stage = /** @type {SVGSVGElement} */ (document.getElementById('stage'));
  const updateScene = mountScene(stage);
  const draw = mountJet(stage, rig);
  const player = createPlayer(rig);

  const params = () => ({
    candid: settings.behaviour.candid,
    playful: settings.behaviour.playful,
    ...settings.expressiveness.channels,
    reducedMotion: settings.reducedMotion,
  });

  let current = 'hello';
  let repeatTimer = 0;
  function play(which = current) {
    current = which;
    clearTimeout(repeatTimer);
    const clip = CLIPS[which].build(rig, params());
    renderReadout(CLIPS[which].name, clip);
    player.play(clip, performance.now());
  }

  let replayTimer = 0;
  let saveTimer = 0;
  let replayWanted = false;
  function changed() {
    player.breathing = settings.expressiveness.channels.motion;
    clearTimeout(replayTimer);
    replayTimer = setTimeout(() => { replayWanted = true; }, REPLAY_AFTER_CHANGE_MS);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSettings(settings), SAVE_AFTER_CHANGE_MS);
  }

  const wheel = createWheel({ onChange: (behaviour) => { settings.behaviour = behaviour; changed(); } });
  const dial = createDial({ onChange: (expressiveness) => { settings.expressiveness = expressiveness; changed(); } });
  const repeatBox = /** @type {HTMLInputElement} */ (document.getElementById('repeat'));
  const reducedBox = /** @type {HTMLInputElement} */ (document.getElementById('reduced'));

  wheel.set(settings.behaviour);
  dial.set(settings.expressiveness);
  repeatBox.checked = settings.repeat;
  reducedBox.checked = settings.reducedMotion;
  player.breathing = settings.expressiveness.channels.motion;
  renderReadout(CLIPS.hello.name, buildHello(rig, params()));

  document.getElementById('play-hello').addEventListener('click', () => play('hello'));
  document.getElementById('play-zoom').addEventListener('click', () => play('zoom'));
  repeatBox.addEventListener('change', () => {
    settings.repeat = repeatBox.checked;
    changed();
    if (settings.repeat && !player.playing) replayWanted = true;
  });
  reducedBox.addEventListener('change', () => {
    settings.reducedMotion = reducedBox.checked;
    changed();
  });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(100, now - last);
    last = now;
    const progress = player.tick(now);
    draw(player.state);
    updateScene(dt, player.state);
    renderProgress(progress);
    if (!player.playing) {
      if (replayWanted) {
        replayWanted = false;
        play();
      } else if (progress && settings.repeat) {
        // the clip ended on this frame
        repeatTimer = setTimeout(() => { if (!player.playing) play(); }, REPEAT_GAP_MS);
      }
    }
    requestAnimationFrame(frame);
  }

  draw(player.state);
  requestAnimationFrame(frame);
  setTimeout(() => play('hello'), FIRST_CLIP_MS);
}

start().catch((error) => {
  console.error(error);
  const note = document.createElement('p');
  note.className = 'lede';
  note.textContent = 'Jet could not start: ' + (error && error.message ? error.message : error);
  document.querySelector('.head').append(note);
});
