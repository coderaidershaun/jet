import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAgent } from './browser-agent.js';
import { connectAgent } from './agent.js';

test('browser bridge retries one identity, deduplicates events and resnapshots after reconnect', async () => {
  const sources = [];
  class Source {
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.closed = true; }
    emit(value) { this.onmessage({ data: JSON.stringify(value) }); }
  }
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const calls = [];
  let ids = 0;
  const request = { text: 'hello', activeAppId: 'app-a' };
  const agent = createBrowserAgent({ EventSource: Source, storage, uuid: () => `id-${++ids}`, delay: async () => {}, fetch: async (path, options) => {
    calls.push({ path, request: JSON.parse(options.body) });
    if (calls.length === 1) { request.activeAppId = 'app-b'; throw new Error('acknowledgment lost'); }
    return { ok: true, json: async () => ({ user: { text: 'hello' } }) };
  } });
  const snapshots = [], events = [], registry = [], connection = [];
  const unsubscribe = agent.onRegistryChanged((event) => registry.push(event));
  agent.onConnectionChanged((connected) => connection.push(connected));
  const stop = agent.watch((snapshot) => snapshots.push(snapshot), (event) => events.push(event));
  sources[0].emit({ kind: 'snapshot', data: { epoch: 'epoch-a', cursor: 7, history: [], active: null } });
  assert.deepEqual(await agent.send(request, () => {}), { text: 'hello' });
  assert.deepEqual(calls[0].request, calls[1].request);
  assert.equal(calls[0].request.clientId, 'id-1');
  const envelope = { cursor: 8, turn: { requestId: 'id-2' }, event: { kind: 'text', delta: 'reply' } };
  sources[0].emit({ kind: 'event', data: envelope });
  sources[0].emit({ kind: 'event', data: envelope });
  assert.equal(events.length, 1);
  const changed = { cursor: 9, event: { kind: 'registryChanged', appId: 'app-b', change: 'edited' } };
  sources[0].emit({ kind: 'event', data: changed });
  sources[0].emit({ kind: 'event', data: changed });
  assert.deepEqual(registry, [changed.event]);
  unsubscribe();
  sources[0].emit({ kind: 'event', data: { ...changed, cursor: 10 } });
  assert.equal(registry.length, 1);
  assert.equal(calls[1].request.activeAppId, 'app-a');
  sources[0].onerror();
  assert.deepEqual(connection, [false]);
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.equal(sources[1].url, '/api/events?epoch=epoch-a&cursor=10');
  sources[1].onopen();
  sources[1].onopen();
  assert.deepEqual(connection, [false, true], 'the drawer hears each change once');
  sources[1].emit({ kind: 'resync' });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.equal(sources[2].url, '/api/events');
  sources[2].emit({ kind: 'snapshot', data: { epoch: 'epoch-b', cursor: 0, history: [{ text: 'saved' }], active: null } });
  assert.equal(snapshots.length, 2);
  stop();
  assert.equal(sources[2].closed, true);

  const cancelledCalls = [], delays = [];
  let sendCalls = 0, stopCalls = 0;
  const cancelling = createBrowserAgent({ EventSource: Source, storage, uuid: () => 'pending', delay: () => new Promise((resolve) => delays.push(resolve)), fetch: async (path, options) => {
    cancelledCalls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('/send') && ++sendCalls === 1) throw new Error('send outcome unknown');
    if (path.endsWith('/stop') && ++stopCalls === 1) throw new Error('stop acknowledgment lost');
    return { ok: true, json: async () => ({ user: { text: 'should not run' } }) };
  } });
  const sending = cancelling.send({ requestId: 'pending', text: 'cancel me' }, () => {});
  const rejected = assert.rejects(sending, (error) => error.kind === 'cancelled');
  await new Promise(setImmediate);
  const stopping = cancelling.stop('pending');
  const stopped = stopping.then(() => null, (error) => error);
  await new Promise(setImmediate);
  for (const resolve of delays.splice(0)) resolve();
  await rejected;
  assert.equal(await stopped, null);
  assert.equal(sendCalls, 1);
  assert.equal(stopCalls, 2);
  assert.deepEqual(cancelledCalls.filter((call) => call.path.endsWith('/stop')).map((call) => call.body), [{ requestId: 'pending' }, { requestId: 'pending' }]);

  const opened = [], checks = [];
  const actionAgent = createBrowserAgent({ EventSource: Source, storage, fetch: async path => {
    if (path === '/api/snapshot') return { ok: true, json: () => new Promise(resolve => checks.push(resolve)) };
    return { ok: true, json: async () => ({}) };
  } });
  actionAgent.onAppOpened((action, current) => { if (current()) opened.push(action.appId); });
  const unwatch = actionAgent.watch(() => {}, () => {});
  const actionSource = sources.at(-1);
  const identity = { clientId: actionAgent.clientId, requestId: 'first-request', turnId: 'first-turn' };
  const snapshot = { epoch: 'actions', cursor: 100, active: { identity }, history: [] };
  actionSource.emit({ kind: 'snapshot', data: snapshot });
  let next = 100;
  const emit = (event, turn = identity) => actionSource.emit({ kind: 'event', data: { cursor: ++next, turn, event } });
  const action = { kind: 'appOpened', appId: 'first-app', ...identity };
  emit({ ...action, clientId: 'another-browser' });
  assert.equal(checks.length, 0);
  emit(action);
  await new Promise(setImmediate);
  checks.shift()({ ...snapshot, cursor: next });
  await new Promise(setImmediate);
  assert.deepEqual(opened, ['first-app']);
  emit({ ...action, appId: 'late-app' });
  await new Promise(setImmediate);
  emit({ kind: 'finished' });
  checks.shift()({ ...snapshot, cursor: next });
  await new Promise(setImmediate);
  assert.deepEqual(opened, ['first-app']);
  const newer = { ...identity, requestId: 'new-request', turnId: 'new-turn' };
  emit({ kind: 'accepted' }, newer);
  emit(action);
  await new Promise(setImmediate);
  assert.equal(checks.length, 0);
  emit({ kind: 'accepted' }, identity);
  emit(action);
  await new Promise(setImmediate);
  checks.shift()({ ...snapshot, cursor: next, active: { identity: newer } });
  await new Promise(setImmediate);
  assert.deepEqual(opened, ['first-app'], 'replayed accepted/action must consult authoritative current turn');
  emit({ kind: 'accepted' }, newer);
  emit({ ...action, ...newer });
  await new Promise(setImmediate);
  await actionAgent.stop(newer.requestId);
  checks.shift()({ ...snapshot, cursor: next, active: { identity: newer } });
  await new Promise(setImmediate);
  assert.deepEqual(opened, ['first-app'], 'local Stop invalidates an outstanding snapshot immediately');
  emit({ kind: 'accepted' }, newer);
  emit({ ...action, ...newer });
  await new Promise(setImmediate);
  assert.equal(checks.length, 0, 'replay cannot reauthorize a locally stopped request');
  unwatch();

  const original = { storage: globalThis.sessionStorage, crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto') };
  try {
    globalThis.sessionStorage = storage;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes) => bytes.fill(17) } });
    saved.clear();
    assert.equal(connectAgent().serverEvents, true);
  } finally { globalThis.sessionStorage = original.storage; Object.defineProperty(globalThis, 'crypto', original.crypto); }
});

test('registered_app_images_keep_their_origin_and_reject_escape', async () => {
  let apps = [{ id: 'origin-app', baseUrl: 'https://example.test/library/', embedding: 'relative-paths', enabled: false }];
  const requests = [];
  const agent = createBrowserAgent({ uuid: () => 'browser', fetch: async path => {
    requests.push(path);
    assert.equal(path, '/api/apps');
    return { ok: true, json: async () => apps };
  } });
  assert.equal(await agent.readAppImage('origin-app', 'content/a%20b.png?size=1&name=a%2Fb'), '/apps/origin-app/content/a%20b.png?size=1&name=a%2Fb');
  assert.equal(await agent.readAppImage('origin-app', 'https://example.test/library/content/a.png'), '/apps/origin-app/content/a.png');
  for (const path of ['../a.png', './a.png', 'content/%2e%2e/a.png', 'content/%252e%252e/a.png', 'content/a%2fb.png', 'content/a%5cb.png', 'content/%00.png', 'content/%ZZ.png', 'content/a.png?bad=%ZZ', 'content/\\a.png', 'content/a\n.png', '//other.test/a.png', '/etc/passwd', 'file:///tmp/a.png', 'data:image/png;base64,a', '/apps/other/a.png', 'https://example.test/library-other/a.png', 'https://other.test/library/a.png', 'https://example.test/library/../a.png', 'https://user@example.test/library/a.png']) {
    await assert.rejects(agent.readAppImage('origin-app', path), /Picture unavailable/, path);
  }
  apps[0].baseUrl = 'https://example.test/new/';
  await assert.rejects(agent.readAppImage('origin-app', 'https://example.test/library/a.png'), /Picture unavailable/);
  assert.equal(await agent.readAppImage('origin-app', 'a.png'), '/apps/origin-app/a.png');
  for (const embedding of ['direct', 'external']) {
    apps[0].embedding = embedding;
    await assert.rejects(agent.readAppImage('origin-app', 'a.png'), /Picture unavailable/);
  }
  apps = [];
  await assert.rejects(agent.readAppImage('origin-app', 'a.png'), /Picture unavailable/);
  assert.ok(requests.length > 0);
});

test('hear_posts_exactly_the_clip_bytes_with_its_vocabulary_and_throws_refusals_as_kind_and_message', async () => {
  const requests = [];
  const answer = { ok: true, json: async () => ({ text: 'What time is it?' }) };
  const agent = createBrowserAgent({ uuid: () => 'browser', fetch: async (path, options) => { requests.push({ path, options }); return answer; } });
  const whole = Int16Array.from([9, 9, 1, 2, 3, 4, 9, 9]);
  const clip = whole.subarray(2, 6);
  assert.deepEqual(await agent.hear(clip, ['Jet', 'Quanty & Co'], undefined), { text: 'What time is it?' });
  const [{ path, options }] = requests;
  assert.equal(path, '/api/voice/hear?vocabulary=Jet&vocabulary=Quanty%20%26%20Co');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'audio/L16;rate=16000;channels=1');
  assert.deepEqual(new Int16Array(options.body), clip, 'the bytes of the view, not of the buffer behind it');
  assert.equal(options.body.byteLength, 8);

  await agent.hear(clip, [], undefined);
  assert.equal(requests[1].path, '/api/voice/hear');

  const refusing = createBrowserAgent({ uuid: () => 'browser', fetch: async () => ({ ok: false, json: async () => ({ kind: 'rateLimited', message: 'Slow down.' }) }) });
  await assert.rejects(refusing.hear(clip, [], undefined), { kind: 'rateLimited', message: 'Slow down.' });
});
