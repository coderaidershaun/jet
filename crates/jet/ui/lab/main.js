// Wires the lab together: loads the rig and the saved settings, mounts the
// scenery and Jet on one stage, binds the controls, and runs the frame loop.
// A settings change saves after a short pause and replays the last button so the
// change is visible at once.

import { CLIPS } from '../jet/clips/catalogue.js';
import { createPlayer } from '../jet/player.js';
import { RING } from '../jet/state.js';
import { mountScene } from '../jet/scene.js';
import { mountJet } from '../jet/view.js';
import { loadRig } from '../bridge/rig.js';
import { loadSettings, saveSettings } from '../bridge/settings.js';
import { createDial } from './dial.js';
import { renderProgress, renderReadout } from './readout.js';
import { createWheel } from './wheel.js';

const REPLAY_AFTER_CHANGE_MS = 450;
const SAVE_AFTER_CHANGE_MS = 800;
const REPEAT_GAP_MS = 1400;
const FIRST_CLIP_MS = 700;

const TYPING_HOLD_MS = 2000;
const LOOP_BEFORE_STOP_MS = 1500;
const ANTIC_SHOW_MS = 5600;
const turnedNow = (state) => ({ rotate: state.ring[RING.ROTATE] });

// Each button plays its steps in order. A step names a catalogue clip and may add the
// options to build it with, or a function of Jet's state for a step that carries on
// from the loop. It may also add a readout label, `holdMs` to wait after the clip
// ends, or `runMs` to start the next step before the clip ends.
const BUTTONS = {
  hello: [{ clip: 'hello' }],
  helloBrief: [{ clip: 'hello', options: { brief: true }, label: 'Brief hello' }],
  zoom: [{ clip: 'zoom' }],
  working: [{ clip: 'working', options: { spinMs: 5000 } }, { clip: 'workingEnd', options: turnedNow }],
  thinking: [{ clip: 'thinking' }],
  excited: [{ clip: 'excited' }],
  annoyed: [{ clip: 'annoyed' }],
  done: [{ clip: 'done' }],
  doneLong: [{ clip: 'done', options: { long: true }, label: 'Done (long)' }],
  needsYou: [{ clip: 'needsYou' }],
  error: [{ clip: 'error' }],
  sorry: [{ clip: 'error', options: { exclaim: false }, label: 'Sorry' }],
  typing: [{ clip: 'lean', holdMs: TYPING_HOLD_MS }, { clip: 'leanBack' }],
  interrupted: [{ clip: 'working', options: { spinMs: 60000 }, runMs: LOOP_BEFORE_STOP_MS }, { clip: 'interrupted', options: turnedNow }],
  peer: [{ clip: 'peer', holdMs: TYPING_HOLD_MS }, { clip: 'leanBack' }],
  creep: [{ clip: 'creep', holdMs: TYPING_HOLD_MS }, { clip: 'leanBack' }],
  batBall: [{ clip: 'batBall', options: { loopMs: ANTIC_SHOW_MS } }, { clip: 'batBallEnd' }],
  doze: [{ clip: 'doze', options: { loopMs: ANTIC_SHOW_MS } }, { clip: 'dozeEnd' }],
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
  let sequence = null;

  function startStep(now) {
    const step = BUTTONS[sequence.button][sequence.index];
    const options = typeof step.options === 'function' ? step.options(player.state) : step.options;
    const clip = CLIPS[step.clip].build(rig, params(), options);
    renderReadout(step.label ?? CLIPS[step.clip].label, clip);
    player.play(clip, now);
    sequence.until = now + (step.runMs ?? clip.total + (step.holdMs ?? 0));
  }

  function play(button = current) {
    current = button;
    clearTimeout(repeatTimer);
    sequence = { button, index: 0, until: 0 };
    startStep(performance.now());
  }

  /** Moves to the next step when the current one is over. Returns true on the frame the last step ends. */
  function advance(now) {
    if (!sequence || now < sequence.until) return false;
    sequence.index += 1;
    if (sequence.index < BUTTONS[sequence.button].length) {
      startStep(now);
      return false;
    }
    sequence = null;
    return true;
  }

  function tuneIdle() {
    player.breathing = settings.expressiveness.channels.motion;
    player.eyes = settings.expressiveness.channels.eyes;
    player.reducedMotion = settings.reducedMotion;
  }

  let replayTimer = 0;
  let saveTimer = 0;
  let replayWanted = false;
  function changed() {
    tuneIdle();
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
  tuneIdle();
  renderReadout(CLIPS.hello.label, CLIPS.hello.build(rig, params()));

  for (const element of document.querySelectorAll('[data-button]')) {
    element.addEventListener('click', () => play(element.dataset.button));
  }
  repeatBox.addEventListener('change', () => {
    settings.repeat = repeatBox.checked;
    changed();
    if (settings.repeat && !sequence) replayWanted = true;
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
    const finished = advance(now);
    if (!sequence) {
      if (replayWanted) {
        replayWanted = false;
        play();
      } else if (finished && settings.repeat) {
        repeatTimer = setTimeout(() => { if (!sequence) play(); }, REPEAT_GAP_MS);
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
