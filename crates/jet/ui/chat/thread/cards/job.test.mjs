import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';
import { createJobWatcher } from './job-watch.js';
import { createCardList } from './view.js';
import { createThread } from '../store.js';

const APP = 'b5e97310-4825-4b89-ace2-e330a4ed8509';
const JOB = '0b9d3a8e-5c1f-4f0e-9d62-7a3c1e2b4f10';
const running = { job_id: JOB, kind: 'ingest', state: 'running', stage: { name: 'converting', words: 'converting 12 of 32 pages', done: 12, total: 32, share: 0.375 }, started_at: 't', updated_at: 't' };
const call = (tool, result, rest = {}) => ({ id: 'c1', server: APP, tool, input: {}, ok: true, result, durationMs: 800, ...rest });
const fieldsOf = (card) => Object.fromEntries(card.body.fields.map((field) => [field.term, field.text]));

test('job cards read the Job shape and the old shape', () => {
  // Through the facade the server is the app's ID, so the tool name or the shape finds the reader.
  const started = cardOf(call('ingest_pdf', running));
  assert.equal(started.meta, 'running · converting 12 of 32 pages · 0.8 s');
  assert.deepEqual(started.job, { id: JOB, state: 'running', share: 0.375, words: 'converting 12 of 32 pages' });
  assert.equal(started.tone, 'quiet');
  assert.deepEqual(fieldsOf(started), { State: 'running', Kind: 'ingest', Stage: 'converting 12 of 32 pages' });

  const finished = cardOf(call('job_status', { job_id: JOB, kind: 'ingest', state: 'done', media: 'Options', file: 'Hull ch1.pdf', document_id: 'doc-1', items: 41, cost_usd: 0.124, summary: 'Hull, chapter 1', usage: [] }));
  assert.equal(finished.meta, 'done · 41 items · 0.8 s');
  assert.equal(finished.tone, 'ok');
  assert.deepEqual(fieldsOf(finished), { State: 'done', Kind: 'ingest', Media: 'Options', File: 'Hull ch1.pdf', Document: 'doc-1', Items: '41', Cost: '$0.12', Summary: 'Hull, chapter 1' });
  assert.equal(finished.body.fields.at(-1).pre, true);
  assert.equal(finished.job.share, null, 'a job that is not running has no stage to draw');

  assert.equal(cardOf(call('watch_job', { job_id: JOB, state: 'already_ingested' })).tone, 'ok');
  assert.equal(cardOf(call('watch_job', { job_id: JOB, state: 'already_ingested' })).meta, 'already in the library · 0.8 s');
  const failed = cardOf(call('ingest_pdf', { job_id: JOB, state: 'failed', error: 'the PDF has no pages' }));
  assert.equal(failed.tone, 'invalid');
  assert.deepEqual(fieldsOf(failed), { State: 'failed', Error: 'the PDF has no pages' });
  const stopped = cardOf(call('stop_something', { job_id: JOB, state: 'stopped', error: 'start it again' }));
  assert.equal(stopped.meta, 'stopped · 0.8 s', 'a job is read by its shape on any tool');
  assert.equal(stopped.tone, 'quiet');

  // The old shape: a stage that is only text, no job id.
  const old = cardOf({ id: 'c2', server: 'quanty', tool: 'ingest_status', input: {}, ok: true, result: { state: 'running', stage: 'converting', media: 'Options' }, durationMs: 100 });
  assert.equal(old.meta, 'running · converting · 0.1 s');
  assert.deepEqual(fieldsOf(old), { State: 'running', Stage: 'converting', Media: 'Options' });
  assert.equal(old.job, null);

  // Results come from outside: no shape throws, and a share is held between 0 and 1.
  for (const result of [{ job_id: JOB, state: 'running', stage: 7 }, { job_id: JOB, state: 'running', stage: { share: 'half', words: 5 } }, { state: 7, items: 'many', cost_usd: 'free' }, { job_id: JOB, state: 'done', items: NaN, summary: {} }, null, 'text', []]) {
    assert.doesNotThrow(() => cardOf(call('ingest_pdf', result)), JSON.stringify(result));
  }
  assert.equal(cardOf(call('job_status', { ...running, stage: { name: 'x', words: 'x', share: 1.7 } })).job.share, 1);
  assert.equal(cardOf(call('job_status', { ...running, stage: { name: 'x', words: 'x', share: -2 } })).job.share, 0);
  assert.equal(cardOf(call('ingest_pdf', { state: 'running' })).meta, 'running · 0.8 s');

  // The bar draws the progress of the whole job, and the share of the stage only when it is missing.
  assert.equal(cardOf(call('job_status', { ...running, progress: 0.42 })).job.share, 0.42);
  assert.equal(cardOf(call('job_status', { ...running, progress: 1.7 })).job.share, 1);
  assert.equal(cardOf(call('job_status', { ...running, progress: 0 })).job.share, 0);
  assert.equal(cardOf(call('job_status', { ...running, progress: 'half' })).job.share, 0.375);

  // While a job tool runs, its card says which.
  const line = (tool, input = {}) => cardOf({ id: 'r', server: APP, tool, input }).line;
  assert.equal(line('job_status'), 'Checking a job');
  assert.equal(line('watch_job'), 'Watching a job');
  assert.equal(line('ingest_pdf', { file_name: 'Hull ch1.pdf', pdf_url: 'http://x/api/files/y' }), 'Adding a PDF · Hull ch1.pdf');
  assert.equal(line('ingest_pdf', { path: '/books/Hull ch1.pdf' }), 'Adding a PDF · Hull ch1.pdf');
});

// A clock the test moves by hand, and a Jet server that answers from a script.
function harness({ marker = { version: 1, statusTool: 'job_status', idField: 'job_id' }, answers = [] } = {}) {
  const timers = [];
  const requests = [];
  const catalogue = { tools: [{ name: 'ingest_pdf', _meta: marker ? { 'jet/job': marker } : {} }] };
  const request = async (path, body) => {
    requests.push({ path, body });
    if (path.endsWith('/tools')) return catalogue;
    if (path.endsWith('/status')) {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { result: typeof next === 'function' ? await next() : next };
    }
    return {};
  };
  const watcher = createJobWatcher({
    request,
    intervalMs: 5000,
    setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].run = null; },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async () => {
    const waiting = timers.findLast((timer) => timer.run);
    const run = waiting?.run;
    if (waiting) waiting.run = null;
    run?.();
    await flush();
    return Boolean(run);
  };
  const statusRequests = () => requests.filter((item) => item.path.endsWith('/status'));
  return { watcher, requests, statusRequests, tick, flush, timers };
}
const progressing = (share) => ({ structuredContent: { ...running, stage: { ...running.stage, share } }, isError: false });
const ended = { structuredContent: { job_id: JOB, kind: 'ingest', state: 'done', items: 3 }, isError: false };

test('a job card polls its status tool until the job ends', async () => {
  const run = harness({ answers: [progressing(0.5), progressing(0.75), ended] });
  const seen = [];
  const stop = run.watcher.watch(call('ingest_pdf', running), (job) => seen.push(job));
  await run.flush();
  assert.equal(run.statusRequests().length, 0, 'the first look waits one interval');
  assert.equal(run.timers.at(-1).ms, 5000);
  assert.equal(run.requests[0].path, `/api/apps/${APP}/tools`);

  await run.tick();
  const first = run.statusRequests()[0];
  assert.equal(first.path, `/api/apps/${APP}/status`);
  assert.equal(first.body.tool, 'job_status');
  assert.deepEqual(first.body.arguments, { job_id: JOB });
  assert.equal(typeof first.body.requestId, 'string');
  await run.tick();
  await run.tick();
  assert.deepEqual(seen.map((job) => job.state), ['running', 'running', 'done']);
  assert.equal(seen[1].stage.share, 0.75);
  assert.equal(await run.tick(), false, 'a job that has ended is not looked at again');
  assert.equal(run.statusRequests().length, 3);
  stop();

  // Nothing to poll without the marker, for a name that is not an app ID, or for a job that has ended.
  for (const [watching, setup] of [
    ['no marker', harness({ marker: null })],
    ['not a version the page knows', harness({ marker: { version: 2, statusTool: 'job_status', idField: 'job_id' } })],
    ['missing field', harness({ marker: { version: 1, statusTool: 'job_status' } })],
  ]) {
    setup.watcher.watch(call('ingest_pdf', running), () => assert.fail(watching));
    await setup.flush();
    assert.equal(await setup.tick(), false, watching);
    assert.equal(setup.statusRequests().length, 0, watching);
  }
  const named = harness();
  named.watcher.watch({ ...call('ingest_pdf', running), server: 'quanty' }, () => {});
  named.watcher.watch(call('ingest_pdf', { ...running, state: 'done' }), () => {});
  named.watcher.watch(call('ingest_pdf', { ...running, job_id: 7 }), () => {});
  named.watcher.watch(call('ingest_pdf', running, { ok: undefined }), () => {});
  await named.flush();
  assert.equal(named.requests.length, 0, 'a saved call by name, an ended job, a bad id and a running call are left alone');

  // Three failures in a row stop it; one failure and an answer that is an error do not end it alone.
  const failing = harness({ answers: [new Error('offline'), { isError: true, content: [] }, progressing(0.5), new Error('offline'), new Error('offline'), new Error('offline'), progressing(0.9)] });
  const heard = [];
  failing.watcher.watch(call('ingest_pdf', running), (job) => heard.push(job));
  await failing.flush();
  while (await failing.tick());
  assert.equal(failing.statusRequests().length, 6);
  assert.equal(heard.length, 1);

  // Stopping clears the timer, and cancels a request that is on its way.
  const waiting = harness({ answers: [progressing(0.5)] });
  const stopWaiting = waiting.watcher.watch(call('ingest_pdf', running), () => {});
  await waiting.flush();
  stopWaiting();
  assert.equal(await waiting.tick(), false);
  assert.equal(waiting.statusRequests().length, 0);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const slow = harness({ answers: [() => held.then(() => ended)] });
  const late = [];
  const stopSlow = slow.watcher.watch(call('ingest_pdf', running), (job) => late.push(job));
  await slow.flush();
  await slow.tick();
  stopSlow();
  assert.deepEqual(slow.requests.at(-1).path, '/api/tools/cancel');
  assert.equal(slow.requests.at(-1).body.requestId, slow.requests.find((item) => item.path.endsWith('/status')).body.requestId);
  release();
  await slow.flush();
  assert.deepEqual(late, [], 'the late answer of a stopped watch is ignored');
});

// Just enough of a page for the card list: elements that keep their attributes, children and text.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.parent = null; this.className = ''; this.hidden = false; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener() {}
  append(...nodes) { for (const node of nodes) { if (typeof node === 'object') node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get textContent() { return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join(''); }
  set textContent(text) { this.children = [String(text)]; }
  insertBefore(node, before) { node.remove?.(); node.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); }
  replaceWith(node) { node.parent = this.parent; this.parent.children[this.parent.children.indexOf(this)] = node; this.parent = null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
}
const find = (node, tag, name) => (typeof node === 'string' ? null : node.tag === tag && (!name || node.className === name) ? node : node.children.map((child) => find(child, tag, name)).find(Boolean) ?? null);

test('cards draw live progress', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    // The thread keeps the latest report on the running call, and drops it when the call comes back.
    const thread = createThread();
    thread.openSlot();
    thread.startTool({ id: 'p1', server: APP, tool: 'progress', input: {} });
    thread.progressTool({ id: 'nobody', progress: 1, total: null, message: null });
    thread.progressTool({ id: 'p1', progress: 40, total: 100, message: 'step 4' });
    assert.deepEqual(thread.slot.tools[0].progress, { progress: 40, total: 100, message: 'step 4' });
    thread.finishTool({ id: 'p1', server: APP, tool: 'progress', ok: true, result: {}, summary: '', durationMs: 1 });
    thread.progressTool({ id: 'p1', progress: 50, total: 100, message: 'late' });
    assert.equal('progress' in thread.slot.tools[0], false);

    const stopped = [];
    let hear;
    const container = new Element('div');
    const cards = createCardList(container, { render: async () => '', readImage: async () => '', seal() {}, watchJob: (watched, onJob) => { hear = onJob; return () => stopped.push(watched.id); } });
    const working = { id: 'p1', server: APP, tool: 'progress', input: {}, progress: { progress: 40, total: 100, message: 'step 4' } };
    cards.sync([working], []);
    let bar = find(container, 'progress');
    assert.deepEqual([bar.attributes.value, bar.attributes.max], ['40', '100']);
    assert.equal(find(container, 'span', 'card-words').textContent, 'step 4');

    cards.sync([{ ...working, progress: { progress: 150, total: 100, message: null } }], []);
    bar = find(container, 'progress');
    assert.equal(bar.attributes.value, '100', 'a value past the total is held at the total');
    assert.equal(find(container, 'span', 'card-words'), null);
    cards.sync([{ ...working, progress: { progress: 5, total: null, message: 'working' } }], []);
    bar = find(container, 'progress');
    assert.equal('value' in bar.attributes, false, 'with no total the bar has no value, which draws it as waiting');
    assert.equal(container.children.length, 1);

    // A job that was still running when the call came back is followed, and its card changes in place.
    const started = { id: 'j1', server: APP, tool: 'ingest_pdf', input: {}, ok: true, result: structuredClone(running), durationMs: 800 };
    cards.sync([started], []);
    const card = container.children[0];
    bar = find(card, 'progress');
    assert.equal(bar.attributes.value, '0.375');
    assert.equal(find(card, 'span', 'job-words').textContent, 'converting 12 of 32 pages');
    hear({ ...structuredClone(running), stage: { name: 'converting', words: 'converting 24 of 32 pages', share: 0.75 } });
    assert.equal(container.children[0], card, 'the card is not built again');
    assert.equal(find(card, 'progress'), bar);
    assert.equal(bar.attributes.value, '0.75');
    assert.equal(find(card, 'span', 'job-words').textContent, 'converting 24 of 32 pages');
    assert.equal(find(card, 'span', 'card-meta').textContent, 'running · converting 24 of 32 pages · 0.8 s');
    hear({ job_id: JOB, kind: 'ingest', state: 'done', items: 3 });
    assert.equal(find(card, 'span', 'job').hidden, true, 'the bar goes when the job ends');
    assert.equal(card.attributes['data-tone'], 'ok');
    assert.equal(find(card, 'span', 'card-meta').textContent, 'done · 3 items · 0.8 s');
    assert.equal(find(card, 'dl', 'fields').children.length, 6, 'the fields are the ones of the finished job');

    cards.sync([], []);
    assert.deepEqual(stopped, ['j1'], 'a card that leaves stops following its job');
  } finally {
    globalThis.document = previous;
  }
});
