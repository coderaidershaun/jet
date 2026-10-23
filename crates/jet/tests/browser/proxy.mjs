import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-proxy-browser-'));
const output = process.env.ARTIFACT_DIR ?? scratch;
await mkdir(output, { recursive: true });
const children = [];
let browser, tls;
async function launch(program, args, pattern, env = process.env) {
  const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${log}`)), 30000);
    child.stderr.on('data', chunk => { log += chunk; });
    child.stdout.on('data', chunk => {
      log += chunk;
      const match = log.match(pattern);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${log}`)); });
  });
  return { child, url };
}
async function fixture(name, port = 0) {
  return launch('node', [path.join(root, 'crates/jet/tests/fixtures/proxy.mjs')], /"url":"([^"]+)"/, { ...process.env, FIXTURE_NAME: name, FIXTURE_PORT: String(port) });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  let timedOut = false;
  child.kill('SIGTERM');
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
  try { await exited; } finally { clearTimeout(deadline); }
  assert.equal(timedOut, false, `Temporary server ${child.pid} did not stop within 10 seconds`);
}
async function until(condition, message) {
  const deadline = Date.now() + 20000;
  while (!(await condition())) { assert.ok(Date.now() < deadline, message); await delay(25); }
}
async function register(page, address) {
  return page.evaluate(async address => {
    const response = await fetch('/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', address }) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    if (result.app.embedding !== 'relative-paths') throw new Error(`Fixture descriptor unavailable: ${JSON.stringify(result)}`);
    return result.app;
  }, address);
}
async function tlsFront() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', path.join(scratch, 'key.pem'), '-out', path.join(scratch, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  let upstream;
  tls = https.createServer({ key: await readFile(path.join(scratch, 'key.pem')), cert: await readFile(path.join(scratch, 'cert.pem')) }, (request, response) => {
    const forward = http.request(new URL(request.url, upstream), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    forward.on('error', error => response.destroy(error)); request.pipe(forward);
  });
  tls.on('upgrade', (request, socket, head) => {
    const forward = http.request(new URL(request.url, upstream), { headers: request.headers });
    forward.on('upgrade', (response, remote, remoteHead) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy());
    });
    forward.on('error', () => socket.destroy()); forward.end();
  });
  tls.listen(0, '127.0.0.1'); await once(tls, 'listening');
  const origin = `https://127.0.0.1:${tls.address().port}`;
  const jet = await launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', path.join(scratch, 'jet'), '--disable-feelings', '--public-origin', origin], /Jet listening on (http:\/\/\S+)/);
  upstream = jet.url;
  return origin;
}

try {
  const namespace = process.env.NAMESPACE === '1';
  const origin = namespace ? process.env.JET_URL : await tlsFront();
  const first = namespace ? { url: process.env.FIXTURE_URL } : await fixture('First notebook');
  const second = namespace ? { url: process.env.SECOND_FIXTURE_URL } : await fixture('Second notebook');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 850 } });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const failures = [], network = [], sockets = [];
  page.on('pageerror', error => failures.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('Mixed Content')) failures.push(message.text()); });
  page.on('response', response => network.push({ url: response.url(), status: response.status() }));
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto(origin);
  const apps = [await register(page, first.url), await register(page, second.url)];
  await page.evaluate(async apps => {
    document.body.replaceChildren();
    const container = document.createElement('main'); container.style.height = '800px'; document.body.append(container);
    const { createFrameContainer } = await import('/workspace/frames.js');
    window.framesUnderTest = createFrameContainer(container); window.testApps = apps;
    window.framesUnderTest.open(apps[0]);
  }, apps);
  const firstFrame = page.frameLocator(`[data-app-id="${apps[0].id}"] iframe`);
  await firstFrame.getByLabel('Unsaved note').fill('Keep this unsaved note');
  await until(async () => (await firstFrame.locator('#socket').textContent()) === 'browser echo', 'WSS echo must reach the browser');
  await page.evaluate(() => { window.originalFrame = document.querySelector('iframe'); framesUnderTest.open(testApps[1]); });
  const secondFrame = page.frameLocator(`[data-app-id="${apps[1].id}"] iframe`);
  await secondFrame.getByLabel('Unsaved note').fill('Second stays unchanged');
  await page.evaluate(() => {
    framesUnderTest.open({ ...testApps[0], label: 'Renamed notebook' });
    document.querySelector('main').hidden = true; document.querySelector('main').hidden = false;
  });
  assert.equal(await firstFrame.getByLabel('Unsaved note').inputValue(), 'Keep this unsaved note');
  assert.equal(await page.evaluate(() => originalFrame === document.querySelector(`[data-app-id="${testApps[0].id}"] iframe`)), true);
  await page.evaluate(() => framesUnderTest.reload(testApps[0].id));
  await until(async () => (await firstFrame.getByLabel('Unsaved note').inputValue()) === '', 'explicit reload must reset only first frame');
  await page.evaluate(() => framesUnderTest.open(testApps[1]));
  assert.equal(await secondFrame.getByLabel('Unsaved note').inputValue(), 'Second stays unchanged');
  if (!namespace) {
    await stop(first.child);
    await page.evaluate(() => framesUnderTest.open(testApps[0]));
    await page.locator(`[data-app-id="${apps[0].id}"][data-state="offline"]`).waitFor();
    await page.screenshot({ path: path.join(output, 'offline.png') });
    await fixture('First notebook', Number(new URL(first.url).port));
    await page.locator(`[data-app-id="${apps[0].id}"]`).getByRole('button', { name: 'Retry' }).click();
    await until(async () => (await firstFrame.locator('#socket').textContent()) === 'browser echo', 'restarted app must recover on Retry');
    await page.evaluate(() => framesUnderTest.open(testApps[1]));
    assert.equal(await secondFrame.getByLabel('Unsaved note').inputValue(), 'Second stays unchanged');
  }
  assert.ok(sockets.some(url => url.startsWith(namespace ? 'ws:' : 'wss:')));
  assert.deepEqual(failures, []);
  await page.screenshot({ path: path.join(output, namespace ? 'namespace.png' : 'retained.png') });
  await writeFile(path.join(output, namespace ? 'namespace-network.json' : 'frames-network.json'), JSON.stringify({ network, sockets, failures }, null, 2));

  if (!namespace && process.env.SKIP_QUANTY !== '1') {
    const home = path.join(scratch, 'quanty');
    await mkdir(home, { recursive: true });
    const quanty = await launch(process.env.QUANTY_BINARY, ['--home', home, '--listen', '127.0.0.1:0', '--fixture', 'black-scholes', '--trusted-integration'], /listening on (http:\/\/\S+)/, { PATH: process.env.PATH });
    const app = await register(page, quanty.url);
    const mounted = `${origin}/apps/${app.id}/`;
    const quantyPage = await context.newPage();
    const responses = [], frames = [], urls = [], errors = [];
    quantyPage.on('response', response => responses.push({ url: response.url(), status: response.status() }));
    quantyPage.on('pageerror', error => errors.push(String(error)));
    quantyPage.on('websocket', socket => { urls.push(socket.url()); socket.on('framereceived', frame => frames.push(frame.payload)); });
    await quantyPage.goto(mounted);
    await quantyPage.locator('#loading_text').waitFor({ state: 'detached', timeout: 45000 });
    await until(() => frames.length > 0, 'Quanty startup must receive real socket frames');
    assert.ok(responses.some(row => row.url.endsWith('/api/facts') && row.status === 200));
    assert.ok(urls.some(url => url.startsWith('wss:') && url.endsWith('/api/ws')));
    const previous = frames.length;
    const painted = () => quantyPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await painted();
    await quantyPage.mouse.click(300, 90); await painted();
    await quantyPage.keyboard.type('Explain Black-Scholes'); await painted();
    await quantyPage.mouse.click(1195, 90);
    await until(() => frames.slice(previous).some(frame => JSON.parse(String(frame)).payload?.Answer?.result?.Ok), 'Quanty fixture must answer');
    await painted();
    await quantyPage.mouse.click(284, 198);
    await until(() => responses.some(row => row.url.includes('/content/') && row.status === 200), 'Quanty figure image must load');
    const id = randomUUID();
    await mkdir(path.join(home, 'data/exports', id), { recursive: true });
    await writeFile(path.join(home, 'data/exports', id, 'sample.bin'), Buffer.from([0, 1, 254, 255]));
    const resources = await quantyPage.evaluate(async id => {
      const picture = await fetch('content/option-volatility-and-pricing/chapter-1/page-num-1/page.png');
      const upload = await fetch('api/upload', { method: 'POST', headers: { 'x-file-name': 'sample.pdf' }, body: '%PDF-1.7\n' });
      const download = await fetch(`api/download/${id}/sample.bin`);
      return { picture: picture.status, upload: upload.status, download: download.status, bytes: [...new Uint8Array(await download.arrayBuffer())] };
    }, id);
    assert.deepEqual(resources, { picture: 200, upload: 200, download: 200, bytes: [0, 1, 254, 255] });
    assert.ok(await quantyPage.locator('canvas').evaluate(canvas => canvas.width > 100 && canvas.height > 100));
    assert.deepEqual(errors, []);
    assert.ok(responses.every(row => row.url.startsWith(mounted)), JSON.stringify(responses));
    await quantyPage.screenshot({ path: path.join(output, 'quanty.png') });
    await writeFile(path.join(output, 'quanty-network.json'), JSON.stringify({ responses, urls, frameCount: frames.length, errors, resources }, null, 2));
  }
  console.log(namespace ? 'Separate namespace HTTP/WS and retained frames passed' : (process.env.SKIP_QUANTY === '1' ? 'HTTPS/WSS, retained frames and restart/retry passed; Quanty explicitly skipped' : 'HTTPS/WSS, retained frames, restart/retry and actual Quanty WASM passed'));
  console.log(`Artifacts: ${output}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  tls?.closeAllConnections(); tls?.close();
  const failures = [];
  for (const child of children.reverse()) { try { await stop(child); } catch (error) { failures.push(error.message); } }
  assert.deepEqual(failures, [], 'Temporary servers must shut down gracefully');
  if (output !== scratch) await rm(scratch, { recursive: true, force: true });
}
