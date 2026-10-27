import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOST_BYTES, createTray } from './tray.js';
import { createComposer } from './state.js';

const ID = '3f1c9a52-7b0e-4d6a-8f21-5c9e0b7a41d3';
const file = (name, size = 1000) => ({ name, size });
const saved = (name, kind) => ({ id: ID, name, kind, bytes: 1000, details: '12 pages' });
const enter = { shiftKey: false, isComposing: false };

test('the tray takes supported files, refuses the rest and holds send until every upload is done', () => {
  let heldFiles = 0;
  const made = [], freed = [];
  const tray = createTray({ held: () => heldFiles, preview: { make: (upload) => { made.push(upload.name); return 'blob:' + upload.name; }, revoke: (url) => freed.push(url) } });
  const composer = createComposer({ empty: false, tray });
  assert.equal(composer.button(''), 'disabled', 'nothing to send');
  assert.equal(composer.button('hello'), 'send');

  const [report, photo, program, huge] = tray.add([file('Q3 report.pdf'), file('Photo.PNG', 5000), file('setup.exe'), file('big.pdf', MOST_BYTES + 1)]);
  assert.deepEqual([report, photo, program, huge].map((chip) => chip.state), ['uploading', 'uploading', 'failed', 'failed']);
  assert.match(program.reason, /^Only PDF, Markdown, HTML, Excel \(\.xlsx\), CSV, text and images/);
  assert.equal(huge.reason, 'Over 32 MB');
  assert.deepEqual([report.kind, photo.kind, report.tag, photo.tag, program.tag], ['pdf', 'png', 'PDF', 'PNG', 'EXE']);
  assert.deepEqual(made, ['Photo.PNG'], 'only a picture gets a thumbnail');
  assert.deepEqual(tray.counts(), { uploading: 2, failed: 2, ready: 0 });

  // Send waits while anything uploads, and while a failed chip is still there.
  assert.equal(composer.button('hello'), 'disabled');
  assert.equal(composer.enter(enter, 'hello'), 'ignore');
  tray.progress(report.id, 0.5);
  assert.equal(report.progress, 0.5);
  tray.ready(report.id, saved('Q3 report.pdf', 'pdf'));
  tray.ready(photo.id, saved('Photo.PNG', 'png'));
  assert.equal(composer.button('hello'), 'disabled', 'the two failed chips still hold send');
  assert.equal(tray.remove(program.id).name, 'setup.exe');
  assert.equal(tray.remove(huge.id).name, 'big.pdf');

  // Files alone are a message: the button and Enter send, or hold while Jet replies.
  assert.equal(composer.button(''), 'send');
  assert.equal(composer.enter(enter, ''), 'send');
  composer.replying = true;
  assert.equal(composer.enter(enter, ''), 'hold');
  assert.equal(composer.button(''), 'stop');
  composer.replying = false;

  // Ten files a message, counting the files of a held message.
  heldFiles = 3;
  const more = tray.add(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'].map((name) => file(name)));
  assert.deepEqual(more.map((chip) => chip.state), ['uploading', 'uploading', 'uploading', 'uploading', 'uploading', 'failed']);
  assert.equal(more[5].reason, 'Only 10 files per message');
  tray.remove(more[5].id);
  for (const chip of more.slice(0, 5)) tray.ready(chip.id, saved(chip.name, 'text'));
  tray.restore([saved('x.csv', 'csv'), saved('y.csv', 'csv'), saved('z.csv', 'csv')]);
  assert.equal(composer.button('hello'), 'send');
  tray.restore([saved('w.csv', 'csv'), saved('v.csv', 'csv'), saved('u.csv', 'csv')]);
  assert.equal(composer.button('hello'), 'disabled', 'a cancelled hold can bring the tray past ten, and one must go first');
  assert.equal(composer.enter(enter, 'hello'), 'ignore');

  // Taking the files empties the tray and frees the thumbnails that were made here.
  assert.equal(tray.remove(more[0].id).name, 'a.txt');
  const taken = tray.take();
  assert.equal(taken.length, 12);
  assert.deepEqual(taken[0], saved('Q3 report.pdf', 'pdf'));
  assert.deepEqual(freed, ['blob:Photo.PNG']);
  assert.deepEqual(tray.counts(), { uploading: 0, failed: 0, ready: 0 });
  assert.equal(composer.button(''), 'disabled');
});
