// The sign-in renewal: before the token runs out, after a refusal, with a wrong clock, and one tab at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './session.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const answer = (status, body = {}, headers = {}) => ({ ok: status < 300, status, headers: new Headers(headers), json: async () => body });

// A server whose access tokens live `life` seconds on a clock the test moves by hand. The browser's clock runs `fastMs` ahead of it.
function host({ life = 900, fastMs = 0 } = {}) {
  const clock = { ms: 1_000_000_000_000 + fastMs };
  const serverMs = () => clock.ms - fastMs;
  const calls = [];
  const server = { refreshAnswer: null, refused: new Set() };
  const fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET' });
    if (path === '/api/auth/refresh') return server.refreshAnswer ?? answer(200, { user: { displayName: 'Shaun' }, accessExpiresAt: serverMs() / 1000 + life }, { Date: new Date(serverMs()).toUTCString() });
    if (server.refused.delete(path)) return answer(401, { kind: 'signedOut' });
    return answer(200, { path });
  };
  const signedOut = [];
  const locks = [];
  const lock = (task) => { locks.push('held'); return task(); };
  return { clock, calls, server, fetch, signedOut, lock, locks, now: () => clock.ms };
}

test('the access token is renewed a little before it runs out, again and again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const jet = host({ life: 900 });
  const session = createSession({ fetch: jet.fetch, now: jet.now, lock: jet.lock, signedOut: () => jet.signedOut.push(true) });
  session.renewBefore(jet.clock.ms / 1000 + 900);
  const renewals = () => jet.calls.filter((call) => call.path === '/api/auth/refresh').length;

  const tick = async (ms) => { jet.clock.ms += ms; t.mock.timers.tick(ms); await flush(); };
  await tick(839_000);
  assert.equal(renewals(), 0, 'nothing is renewed while more than a minute is left');
  await tick(1_000);
  assert.equal(renewals(), 1, 'a minute before the end the token is renewed');
  await tick(840_000);
  assert.equal(renewals(), 2, 'the new token is renewed on the same schedule');
  assert.equal(jet.locks.length, 2, 'each renewal holds the lock that tabs share');
});

test('a request refused for want of a sign-in renews it once and is asked again, and requests refused together share one renewal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const jet = host();
  const session = createSession({ fetch: jet.fetch, now: jet.now, lock: jet.lock, signedOut: () => jet.signedOut.push(true) });
  jet.server.refused.add('/api/snapshot');
  jet.server.refused.add('/api/settings');

  const [snapshot, settings] = await Promise.all([session.fetch('/api/snapshot'), session.fetch('/api/settings')]);

  assert.deepEqual([snapshot.status, settings.status], [200, 200]);
  assert.deepEqual(jet.calls.map((call) => call.path), ['/api/snapshot', '/api/settings', '/api/auth/refresh', '/api/snapshot', '/api/settings']);
  assert.deepEqual(jet.signedOut, []);
});

test('a refused renewal means the sign-in has ended, so the page is sent to sign in and the request is not asked again', async () => {
  const jet = host();
  const session = createSession({ fetch: jet.fetch, now: jet.now, lock: jet.lock, signedOut: () => jet.signedOut.push(true) });
  jet.server.refused.add('/api/snapshot');
  jet.server.refreshAnswer = answer(401, { kind: 'signedOut' });

  await assert.rejects(session.fetch('/api/snapshot'), (error) => error.kind === 'signedOut');

  assert.deepEqual(jet.signedOut, [true]);
  assert.deepEqual(jet.calls.map((call) => call.path), ['/api/snapshot', '/api/auth/refresh']);
});

test('a browser clock twenty minutes fast still renews a minute before the end, not over and over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const jet = host({ life: 900, fastMs: 20 * 60_000 });
  const session = createSession({ fetch: jet.fetch, now: jet.now, lock: jet.lock, signedOut: () => jet.signedOut.push(true) });
  await session.renew();
  const renewals = () => jet.calls.filter((call) => call.path === '/api/auth/refresh').length;

  const tick = async (ms) => { jet.clock.ms += ms; t.mock.timers.tick(ms); await flush(); };
  await tick(839_000);
  assert.equal(renewals(), 1, 'the server gave 900 seconds, whatever the browser clock says');
  await tick(1_000);
  assert.equal(renewals(), 2);
});

test('two tabs that renew together with no Web Locks keep the sign-in', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(globalThis.navigator?.locks, undefined, 'this run has no Web Locks, as an http page off localhost has none');
  // One browser: each tab sends the refresh cookie that the jar holds when its request leaves, and the tabs share storage.
  const jar = { refresh: 'R0' };
  const replaced = new Set();
  let revoked = false;
  const fetch = async (path) => {
    if (path !== '/api/auth/refresh') return answer(200);
    const sent = jar.refresh;
    await flush();
    if (revoked || replaced.has(sent)) {
      revoked = true;
      return answer(401, { kind: 'signedOut' });
    }
    replaced.add(sent);
    jar.refresh = sent + '+';
    return answer(200, { accessExpiresAt: Date.now() / 1000 + 900 });
  };
  const items = new Map();
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: (key) => items.delete(key) };
  const signedOut = [];
  const tab = (name) => createSession({ fetch, storage, signedOut: () => signedOut.push(name) });
  await Promise.allSettled([tab('a').renew(), tab('b').renew()]);
  assert.deepEqual(signedOut, [], 'a tab was sent to the sign-in page, and the sign-in was revoked for both');
  assert.equal(jar.refresh, 'R0++', 'each tab renewed once, one after the other');
});
