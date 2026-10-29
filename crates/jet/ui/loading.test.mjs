import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishLoading } from './loading.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function gate() {
  let open, fail;
  const promise = new Promise((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

// Starts the loading screen with fakes that the test controls. A frame runs only when the test calls `paint`.
function load({ reducedMotion = false } = {}) {
  const frames = [];
  const cover = { leaving: false, removed: false, classList: { add: () => { cover.leaving = true; } }, remove: () => { cover.removed = true; } };
  const page = gate();
  const fonts = gate();
  finishLoading({ cover, settled: page.promise, reducedMotion: () => reducedMotion, fonts: () => fonts.promise, frame: (run) => frames.push(run) });
  const paint = async () => { frames.splice(0).forEach((run) => run()); await flush(); };
  // This plays more frames than the cover waits for, so a cover that leaves too early is caught.
  const paintMany = async () => { for (let count = 0; count < 4; count++) await paint(); };
  return { cover, page, fonts, paint, paintMany };
}

test('the loading screen leaves only after the page is settled and painted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const waiting = load();
  await waiting.paint();
  waiting.page.open();
  await waiting.paintMany();
  assert.equal(waiting.cover.leaving, false, 'the fonts have not arrived');
  waiting.fonts.open();
  await flush();
  await waiting.paint();
  assert.equal(waiting.cover.leaving, false, 'one frame is not enough to lay out and paint what arrived');
  await waiting.paint();
  assert.equal(waiting.cover.leaving, true);
  t.mock.timers.tick(249);
  assert.equal(waiting.cover.removed, false, 'the cover fades before it goes');
  t.mock.timers.tick(1);
  assert.equal(waiting.cover.removed, true);

  const unsettled = load();
  await unsettled.paint();
  unsettled.fonts.open();
  await unsettled.paintMany();
  assert.equal(unsettled.cover.leaving, false, 'the page behind the cover has not settled');

  const hanging = load();
  await hanging.paint();
  t.mock.timers.tick(1499);
  await hanging.paintMany();
  assert.equal(hanging.cover.leaving, false, 'before the cap the cover keeps waiting');
  t.mock.timers.tick(1);
  await hanging.paintMany();
  assert.equal(hanging.cover.leaving, true, 'a page that never settles does not hold the cover forever');

  const reduced = load({ reducedMotion: true });
  reduced.page.open();
  reduced.fonts.open();
  await reduced.paintMany();
  assert.equal(reduced.cover.leaving, true);
  t.mock.timers.tick(1);
  assert.equal(reduced.cover.removed, true, 'with reduced motion there is no fade to wait for');

  const broken = load();
  broken.page.fail(new Error('the stream failed'));
  broken.fonts.open();
  await broken.paintMany();
  assert.equal(broken.cover.leaving, true, 'a failed fetch must not keep the cover up');
});
