// Checks in headless Chrome, over its debugging protocol, that a signed-in app frame still loads
// and fetches its own paths, while its script can neither call Jet's API with the sign-in nor read
// Jet's page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcesses, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const jetBinary = process.env.JET_BINARY ?? path.join(root, 'target/debug/jet');
const chromeBinary = process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scratch = await mkdtemp(path.join(tmpdir(), 'jet-isolation-'));
const processes = createProcesses();
let chrome;

async function devtools(profile) {
  await until(async () => (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).includes('\n'), 'Chrome did not open its debugging port');
  const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const waiting = new Map(), contexts = [], sessions = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.executionContextCreated') contexts.push({ ...message.params.context, sessionId: message.sessionId });
    if (message.method === 'Target.attachedToTarget') sessions.push(message.params);
    const answer = waiting.get(message.id);
    if (!answer) return;
    waiting.delete(message.id);
    if (message.error) answer.reject(new Error(JSON.stringify(message.error))); else answer.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  const evaluate = async (expression, where = {}) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, contextId: where.contextId, awaitPromise: true, returnByValue: true }, where.sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return { send, evaluate, contexts, sessions, close: () => socket.close() };
}

try {
  const data = path.join(scratch, 'data');
  const jet = await processes.launch(jetBinary, ['--listen', '127.0.0.1:0', '--data-dir', data, '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  const fixture = JSON.parse(await processes.launch('node', [path.join(root, 'crates/jet/tests/fixtures/proxy.mjs')], /^(\{.*\})$/m)).url;
  const profile = path.join(scratch, 'chrome');
  chrome = spawn(chromeBinary, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const cdp = await devtools(profile);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const open = async (url, message) => {
    await cdp.send('Page.navigate', { url });
    await until(async () => (await cdp.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)), message);
  };
  await open(`${jet}/signin/`, 'the sign-in page did not load');
  const signedIn = await cdp.evaluate(`fetch('/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'shaunsurfing@gmail.com', password: '000111' }) }).then(response => response.status)`);
  assert.equal(signedIn, 200);
  const app = await cdp.evaluate(`fetch('/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', address: ${JSON.stringify(fixture)} }) }).then(response => response.json()).then(answer => answer.app.id)`);

  await open(`${jet}/`, "Jet's page did not load");
  const page = await cdp.evaluate(`fetch('/api/snapshot').then(response => response.status)`);
  assert.equal(page, 200, "Jet's own page must reach its API");
  await cdp.evaluate(`new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = '/apps/${app}/'; frame.onload = resolve; document.body.append(frame); })`);
  // Chrome may run the sandboxed frame in a process of its own; then it is a target of its own.
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const local = (frameTree.childFrames ?? []).find(child => child.frame.url.includes(`/apps/${app}/`))?.frame;
  const remote = cdp.sessions.find(session => session.targetInfo.type === 'iframe');
  let where, frameUrl;
  if (local) {
    where = { contextId: cdp.contexts.find(context => context.auxData?.frameId === local.id && context.auxData?.isDefault).id };
    frameUrl = local.url;
  } else {
    where = { sessionId: remote.sessionId };
    frameUrl = await cdp.evaluate('location.href', where);
  }
  await until(async () => (await cdp.evaluate(`document.querySelector('#socket').textContent`, where)) === 'browser echo', "the app's script did not open its socket");

  const seen = await cdp.evaluate(`(async () => {
    const attempt = async call => { try { return await call(); } catch (error) { return 'refused: ' + error.name; } };
    return {
      origin: self.origin,
      ownFetch: await attempt(async () => (await (await fetch('headers')).json()).name),
      jetApi: await attempt(async () => (await fetch('/api/snapshot', { credentials: 'include' })).status),
      jetPage: await attempt(async () => parent.document.title),
      cookie: await attempt(async () => document.cookie),
    };
  })()`, where);
  console.log(JSON.stringify({ frame: frameUrl.replace(/~[^/]+/, '~<proof>'), ...seen }, null, 2));
  assert.equal(seen.origin, 'null');
  assert.equal(seen.ownFetch, 'Notebook');
  assert.match(String(seen.jetApi), /^refused/);
  assert.match(seen.jetPage, /^refused: SecurityError/);
  assert.match(seen.cookie, /^refused: SecurityError/);
  cdp.close();
  console.log('Signed-in app frame loads and fetches its own paths; its script cannot use the sign-in or read Jet');
} finally {
  if (chrome) { chrome.kill(); await once(chrome, 'exit'); }
  await processes.close();
  await rm(scratch, { recursive: true, force: true });
}
