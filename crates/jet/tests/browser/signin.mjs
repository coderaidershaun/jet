// Checks in headless Chrome, over its debugging protocol, that a person signs in through the form,
// stays signed in while short-lived access tokens are renewed with no reload, and that the event
// stream opened before the renewals still delivers a reply after them. It also takes the four
// screenshots of the sign-in page and the signed-in page, at desktop and phone widths.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createProcesses, until } from './process.mjs';

const ACCESS_SECONDS = 5;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const jetBinary = process.env.JET_BINARY ?? path.join(root, 'target/debug/jet');
const chromeBinary = process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const screens = process.env.SCREENSHOT_DIR ?? path.join(root, 'target/signin-screens');
const scratch = await mkdtemp(path.join(tmpdir(), 'jet-signin-'));
const processes = createProcesses();
const home = process.cwd();
let chrome;

async function devtools(profile) {
  await until(async () => (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).includes('\n'), 'Chrome did not open its debugging port');
  const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const waiting = new Map(), listeners = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    for (const listener of listeners) if (listener.method === message.method) listener.run(message.params);
    const answer = waiting.get(message.id);
    if (!answer) return;
    waiting.delete(message.id);
    if (message.error) answer.reject(new Error(JSON.stringify(message.error))); else answer.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return { send, evaluate, on: (method, run) => listeners.push({ method, run }), close: () => socket.close() };
}

try {
  // The provider stand-in writes a file in its working directory, so Jet runs in the scratch folder.
  process.chdir(scratch);
  const data = path.join(scratch, 'data');
  await mkdir(data);
  const provider = path.join(scratch, 'provider.py');
  await copyFile(path.join(root, 'crates/jet/tests/integration/provider.py'), provider);
  await chmod(provider, 0o700);
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({ model: 'sonnet', claudePath: provider }));
  const jet = await processes.launch(jetBinary, ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice', '--access-seconds', String(ACCESS_SECONDS)], /Jet listening on (http:\/\/\S+)/);
  const profile = path.join(scratch, 'chrome');
  chrome = spawn(chromeBinary, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const cdp = await devtools(profile);
  await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable'].map(method => cdp.send(method)));
  const requests = [];
  cdp.on('Network.responseReceived', ({ response }) => requests.push({ path: new URL(response.url).pathname, status: response.status, at: Date.now() }));
  cdp.on('Network.requestWillBeSent', ({ request }) => { if (new URL(request.url).pathname === '/api/events') requests.push({ path: '/api/events', opened: true, at: Date.now() }); });

  const width = (pixels) => cdp.send('Emulation.setDeviceMetricsOverride', pixels === 390 ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const shoot = async (name) => {
    const { data: png } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(screens, { recursive: true });
    await writeFile(path.join(screens, name), Buffer.from(png, 'base64'));
  };
  const open = async (url) => { await cdp.send('Page.navigate', { url }); await until(() => cdp.evaluate(`document.readyState === 'complete'`), `${url} did not load`); };
  const signInPage = async () => {
    await until(() => cdp.evaluate(`document.getElementById('signin')?.dataset.state === 'ready'`), 'the sign-in form did not show');
    await delay(2500); // The kite waves hello once the form shows.
  };
  const jetPage = () => until(() => cdp.evaluate(`location.pathname === '/' && !document.getElementById('loading')`), "Jet's page did not finish loading");
  const type = async (selector, text) => { await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await cdp.send('Input.insertText', { text }); };
  const enter = async () => { for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); };
  const overflow = () => cdp.evaluate(`document.documentElement.scrollWidth - innerWidth`);

  await width(1440);
  await open(`${jet}/`);
  assert.equal(await cdp.evaluate('location.pathname'), '/signin/', 'a person who is not signed in is sent to sign in');
  await signInPage();
  await shoot('signin-desktop.png');

  await width(390);
  await open(`${jet}/signin/`);
  await signInPage();
  assert.equal(await overflow(), 0, 'the sign-in page fits a phone');
  await shoot('signin-390.png');

  await type('#email', 'shaunsurfing@gmail.com');
  await type('#password', 'not-the-password');
  await enter();
  await until(async () => /don’t match/.test(await cdp.evaluate(`document.getElementById('error').textContent`)), 'a wrong password showed no error');
  assert.equal(await cdp.evaluate('document.activeElement.id'), 'password', 'the cursor goes back to the password');
  await cdp.evaluate(`document.getElementById('password').value = ''`);
  await type('#password', '000111');
  await enter();
  await jetPage();
  assert.equal(await cdp.evaluate(`document.getElementById('account-name').textContent`), 'Shaun');
  assert.equal(await overflow(), 0, 'the signed-in page fits a phone');
  const clipped = await cdp.evaluate(`[...document.querySelectorAll('button:not([hidden])')].filter(button => { const box = button.getBoundingClientRect(); return box.width > 0 && (box.left < 0 || box.right > innerWidth); }).map(button => button.id || button.className)`);
  assert.deepEqual(clipped, [], 'no control is cut off at the edge of a phone');
  await shoot('signed-in-390-rail.png');
  // On a phone the drawer is a rail with the person's initial; opened, it says whose Jet this is.
  await cdp.evaluate(`document.getElementById('jet-toggle').click()`);
  await delay(400);
  await shoot('signed-in-390.png');
  await cdp.evaluate(`document.getElementById('jet-toggle').click()`);

  // The page stays signed in past several expiries, without a reload, on the stream it opened first.
  await cdp.evaluate('window.stillTheSamePage = true');
  const streamsBefore = requests.filter(request => request.opened).length;
  const watchFrom = Date.now();
  await delay((ACCESS_SECONDS * 2 + 3) * 1000);
  const renewals = requests.filter(request => request.path === '/api/auth/refresh' && request.at > watchFrom);
  assert.ok(renewals.length >= 2, `expected two renewals or more, saw ${renewals.length}`);
  assert.ok(renewals.every(request => request.status === 200), 'every renewal worked');
  assert.deepEqual(requests.filter(request => request.status === 401 && request.at > watchFrom), [], 'no request was refused');
  assert.equal(await cdp.evaluate('window.stillTheSamePage'), true, 'the page was not reloaded');

  const lastRenewal = renewals.at(-1).at;
  await type('#field', 'hello after the renewals');
  await enter();
  await until(async () => (await cdp.evaluate(`document.getElementById('rows').textContent`)).includes('Partial browser reply'), 'the reply did not reach the page');
  const streamsAfter = requests.filter(request => request.opened).length;
  assert.equal(streamsAfter, streamsBefore, 'the reply came over the stream that was open before the renewals');
  const answeredAfter = Date.now() - lastRenewal;

  await width(1440);
  await open(`${jet}/`);
  await jetPage();
  await delay(800);
  await shoot('signed-in-desktop.png');

  await cdp.evaluate(`document.getElementById('signout').click()`);
  await until(() => cdp.evaluate(`location.pathname === '/signin/'`), 'signing out did not open the sign-in page');
  await open(`${jet}/`);
  await signInPage();
  assert.equal(await cdp.evaluate('location.pathname'), '/signin/', 'after signing out the page asks to sign in again');
  cdp.close();
  console.log(JSON.stringify({ accessSeconds: ACCESS_SECONDS, renewals: renewals.map(request => request.status), refused: 0, streamsOpened: streamsAfter, replyMsAfterLastRenewal: answeredAfter, screenshots: screens }, null, 2));
  console.log('Signed in through the form, stayed signed in past two expiries with no reload, and the first stream delivered a reply after the renewals');
} finally {
  if (chrome) { chrome.kill(); await once(chrome, 'exit'); }
  await processes.close();
  process.chdir(home);
  await rm(scratch, { recursive: true, force: true });
}
