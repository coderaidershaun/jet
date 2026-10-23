import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-workspace-'));
const output = process.env.ARTIFACT_DIR ?? scratch;
await mkdir(output, { recursive: true });
const children = [];
let browser, page;
async function launch(program, args, pattern, env = process.env) {
  const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Startup timed out: ' + log)), 30000);
    const collect = chunk => { log += chunk; const match = log.match(pattern); if (match) { clearTimeout(timer); resolve(match[1]); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${log}`)); });
  });
}
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (!(await check())) { assert.ok(Date.now() < deadline, message); await delay(40); }
}
try {
  const data = path.join(scratch, 'data');
  await mkdir(data);
  const settings = JSON.parse(await readFile(path.join(root, 'crates/jet/ui/bridge/default-settings.json')));
  const provider = path.join(scratch, 'provider.cjs');
  const markdown = '## Compact content\n\n| Long heading alpha | Long heading beta | Long heading gamma |\n|---|---|---|\n| A complete table cell | Another complete cell | A third complete cell |\n\n$$x^2 + y^2 = z^2$$\n\n```js\nconst longLine = "A deliberately long code line stays inside the conversation bubble";\n```';
  await writeFile(provider, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(scratch, 'provider-input.jsonl'))}, JSON.stringify({ input, args: process.argv.slice(2) }) + '\\n');
if (input.split('\\n').includes('hang')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'workspace-hang', model: 'claude-fake' }));
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mood: neutral\\nPartial' } } }));
  setTimeout(() => {}, 30000);
} else if (input.includes('layout-fixture')) {
  const text = ${JSON.stringify(markdown)};
  for (const event of [
    { type: 'system', subtype: 'init', session_id: 'workspace-fixture', model: 'claude-fake' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mood: neutral\\n' + text } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'mood: neutral\\n' + text, session_id: 'workspace-fixture', duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }
  ]) console.log(JSON.stringify(event));
} else {
  const child = spawn(${JSON.stringify(path.join(root, 'target/debug/fake-claude'))}, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(input); child.on('exit', code => process.exit(code || 0));
}
`);
  await chmod(provider, 0o755);
  Object.assign(settings, { model: 'sonnet', claudePath: provider, reducedMotion: true });
  await writeFile(path.join(data, 'settings.json'), JSON.stringify(settings));
  const origin = await launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings'], /Jet listening on (http:\/\/\S+)/);
  const fixture = name => launch('node', [path.join(root, 'crates/jet/tests/fixtures/proxy.mjs')], /"url":"([^"]+)"/, { ...process.env, FIXTURE_NAME: name });
  const first = await fixture('First notebook'), second = await fixture('Second notebook');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  context.setDefaultTimeout(15000);
  page = await context.newPage();
  const errors = [], sends = [], stops = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
  page.on('request', request => { if (request.url().endsWith('/api/chat/send')) sends.push(request.postDataJSON()); if (request.url().endsWith('/api/chat/stop')) stops.push(request.postDataJSON()); });
  await page.goto(origin);
  await page.locator('.workspace-shell').waitFor();
  await delay(250);
  await page.screenshot({ path: path.join(output, 'workspace-empty.png') });
  const api = async body => { const response = await context.request.post(origin + '/api/apps', { data: body }); assert.ok(response.ok(), await response.text()); return response.json(); };
  const apps = async () => (await context.request.get(origin + '/api/apps')).json();
  const focusRefresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const nav = id => page.locator(`.app-list [data-app-id="${id}"]`);
  const frame = id => page.frameLocator(`.app-frame[data-app-id="${id}"] iframe`);
  async function add(address, label, advanced = false) {
    await page.locator('.app-navigation').getByRole('button', { name: 'Add app', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add app' });
    await dialog.getByLabel('Address', { exact: true }).fill(address);
    await dialog.getByLabel('Label override').fill(label);
    if (advanced) {
      await dialog.getByText('Advanced endpoints').click();
      await dialog.getByLabel('UI URL', { exact: true }).fill('./');
      await dialog.getByLabel('MCP tools').selectOption('disabled');
      await dialog.getByLabel('Embedding').selectOption('relative-paths');
    }
    await dialog.getByRole('button', { name: 'Save app' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await until(async () => (await apps()).some(app => app.label === label), 'Form must save the app');
    return (await apps()).find(app => app.label === label);
  }
  const a = await add(first, 'Notebook A', true), b = await add(second, 'Notebook B');
  assert.equal(sends.length, 0);
  await nav(a.id).click();
  await frame(a.id).getByLabel('Unsaved note').fill('Unsent note A');
  await page.evaluate(() => { window.firstFrame = document.querySelector('.app-frame:not([hidden]) iframe'); window.chatPage = document.querySelector('#page'); });
  await page.locator('#field').fill('Unsent chat draft');
  await nav(b.id).click();
  await frame(b.id).getByLabel('Unsaved note').fill('Unsent note B');
  await page.evaluate(() => { window.secondFrame = document.querySelector('.app-frame:not([hidden]) iframe'); });
  assert.equal(await page.locator('#workspace-dock').evaluate(el => Math.round(el.getBoundingClientRect().width)), 360);
  await page.getByRole('separator', { name: 'Chat dock width' }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#workspace-dock').evaluate(el => Math.round(el.getBoundingClientRect().width)), 380);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  assert.equal(await page.locator('#page').isVisible(), false);
  await page.getByRole('button', { name: 'Hide dock', exact: true }).click();
  await page.getByRole('button', { name: 'Hide apps', exact: true }).click();
  assert.equal(await page.locator('.app-workspace').evaluate(el => Math.round(el.getBoundingClientRect().width)), 1440);
  await page.screenshot({ path: path.join(output, 'workspace-maximized.png') });
  await page.locator('.app-workspace').getByRole('button', { name: 'Chat', exact: true }).click();
  assert.equal(await page.locator('#field').inputValue(), 'Unsent chat draft');
  assert.ok(await page.evaluate(() => chatPage === document.querySelector('#page')));
  await page.reload();
  await page.locator('.workspace-shell').waitFor();
  assert.equal(await page.locator('#workspace-dock').evaluate(el => Math.round(el.getBoundingClientRect().width)), 380);
  assert.equal(await page.locator('.app-navigation').isVisible(), false);
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await nav(a.id).click();
  await frame(a.id).getByLabel('Unsaved note').fill('Kept after rename');
  await page.evaluate(() => { window.firstFrame = document.querySelector('.app-frame:not([hidden]) iframe'); });
  await nav(b.id).click();
  await frame(b.id).getByLabel('Unsaved note').fill('Second unchanged');
  await page.evaluate(() => { window.secondFrame = document.querySelector('.app-frame:not([hidden]) iframe'); });
  await nav(a.id).click();
  await page.getByRole('button', { name: 'Edit app', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Label override').fill('Renamed notebook');
  await page.getByRole('dialog').getByRole('button', { name: 'Save app' }).click();
  await until(async () => (await apps()).find(app => app.id === a.id).label === 'Renamed notebook', 'Relabel saves stable ID');
  assert.deepEqual((await apps()).find(app => app.id === a.id).overrides, { ...a.overrides, label: 'Renamed notebook' });
  assert.equal(await frame(a.id).getByLabel('Unsaved note').inputValue(), 'Kept after rename');
  assert.ok(await page.evaluate(() => firstFrame === document.querySelector('.app-frame:not([hidden]) iframe')));
  await page.getByRole('button', { name: 'Reload app', exact: true }).click();
  await until(() => page.evaluate(() => firstFrame !== document.querySelector('.app-frame:not([hidden]) iframe')), 'Explicit reload replaces selected frame');
  await nav(b.id).click();
  assert.ok(await page.evaluate(() => secondFrame === document.querySelector('.app-frame:not([hidden]) iframe')));
  assert.equal(await frame(b.id).getByLabel('Unsaved note').inputValue(), 'Second unchanged');
  assert.equal(sends.length, 0);

  let releaseFeeling, feelingStarted = false;
  const feelingGate = new Promise(resolve => { releaseFeeling = resolve; });
  await page.route('**/api/feel', async route => { feelingStarted = true; await feelingGate; await route.continue(); });
  await page.locator('#field').fill('hang');
  await page.locator('#send').click();
  await until(() => feelingStarted, 'Feeling preparation must begin');
  await nav(a.id).click();
  releaseFeeling();
  await until(async () => Boolean((await (await context.request.get(origin + '/api/snapshot')).json()).active?.text), 'Free provider must start real reply');
  assert.equal(sends.at(-1).activeAppId, b.id);
  await page.unroute('**/api/feel');
  if (process.env.JOINT_FACADE === '1') {
    const observed = JSON.parse((await readFile(path.join(scratch, 'provider-input.jsonl'), 'utf8')).split('\n')[0]);
    assert.ok(observed.input.includes('[Active app ID: ' + b.id + '; all enabled apps remain available]'), 'Host must pass captured selected context to provider');
  }
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await nav(a.id).click();
  await page.getByRole('button', { name: 'Hide dock', exact: true }).click();
  assert.ok((await (await context.request.get(origin + '/api/snapshot')).json()).active);
  assert.equal(stops.length, 0);
  await page.locator('.app-workspace').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('#send').click();
  await until(async () => !(await (await context.request.get(origin + '/api/snapshot')).json()).active, 'Explicit Stop ends reply');
  assert.equal(stops.length, 1);
  await page.locator('#field').fill('fixture:quanty-search-reply');
  await page.locator('#send').click();
  await until(async () => (await page.locator('.cards').count()) > 0 && !(await (await context.request.get(origin + '/api/snapshot')).json()).active, 'Recorded free fixture must render tool cards');
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Reply reveal must finish');
  await page.locator('.cards').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'workspace-cards.png') });
  await page.locator('#field').fill('layout-fixture');
  await page.locator('#send').click();
  await page.locator('.body table').waitFor();
  await page.locator('.math-display').waitFor();
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Markdown reply must finish');
  await page.locator('#field').fill('Draft survives overlays');
  await page.screenshot({ path: path.join(output, 'workspace-desktop.png') });
  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 420 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.locator('#field').inputValue(), 'Draft survives overlays');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const box = await page.locator('#send').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, 'Send must fit viewport');
    await page.locator('#field').focus();
    await page.locator('.body table').last().scrollIntoViewIfNeeded();
    await delay(250);
    await page.screenshot({ path: path.join(output, `workspace-${viewport.width}x${viewport.height}.png`), animations: 'disabled' });
    await writeFile(path.join(output, `geometry-${viewport.height}.json`), JSON.stringify(await page.evaluate(() => Object.fromEntries(['.workspace-dock', '#page', '#composer', '#field', '#send'].map(sel => [sel, document.querySelector(sel).getBoundingClientRect().toJSON()])))));
    if (viewport.height === 844) {
      await page.getByText('Usage and diagnostics', { exact: true }).click();
      assert.ok(await page.locator('#usage-title').isVisible());
      const usage = await page.locator('#usage-title').boundingBox();
      assert.ok(usage.x >= 0 && usage.x + usage.width <= viewport.width);
      await page.screenshot({ path: path.join(output, 'workspace-diagnostics.png'), animations: 'disabled' });
      await page.getByText('Usage and diagnostics', { exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await delay(250);
      await page.screenshot({ path: path.join(output, 'workspace-settings-narrow.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#workspace-dock').isVisible(), true);
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#workspace-dock').isVisible(), false);
    assert.equal(stops.length, 1);
    assert.equal(await page.locator('.app-workspace').getByRole('button', { name: 'Chat', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await until(async () => await page.locator('#workspace-dock').evaluate(el => Math.round(el.getBoundingClientRect().width)) === 380, 'Desktop width preference must survive viewport clamping');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await delay(250);
  await page.screenshot({ path: path.join(output, 'workspace-settings.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  if (!(await page.locator('.app-navigation').isVisible())) await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.locator('.app-navigation').getByRole('button', { name: 'Add app', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Address', { exact: true }).fill('file:///invalid');
  await dialog.getByRole('button', { name: 'Save app' }).click();
  await until(async () => (await dialog.getByRole('alert').textContent()).length > 0, 'Invalid address must explain failure');
  await dialog.getByLabel('Address', { exact: true }).fill(first);
  await dialog.getByRole('button', { name: 'Save app' }).click();
  await until(async () => /already|duplicate|registered/i.test(await dialog.getByRole('alert').textContent()), 'Duplicate must explain conflict');
  await page.keyboard.press('Escape');
  await nav(a.id).click();
  await page.getByRole('button', { name: 'Edit app', exact: true }).click();
  let releaseSave, saveStarted = false;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  await page.route('**/api/apps', async route => {
    if (route.request().method() === 'POST') { saveStarted = true; await saveGate; }
    await route.continue();
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Save app' }).click();
  await until(() => saveStarted, 'Edit request must be pending');
  await page.keyboard.press('Escape');
  await page.locator('.app-navigation').getByRole('button', { name: 'Add app', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Address', { exact: true }).fill('9090');
  const savedResponse = page.waitForResponse(response => response.url() === origin + '/api/apps' && response.request().method() === 'POST');
  releaseSave();
  await (await savedResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(await page.getByRole('dialog', { name: 'Add app' }).isVisible(), 'An earlier save must not close a reopened form');
  assert.equal(await page.getByRole('dialog').getByLabel('Address', { exact: true }).inputValue(), '9090');
  await page.keyboard.press('Escape');
  await page.unroute('**/api/apps');
  const offline = await add('http://127.0.0.1:1/', 'Offline app');
  assert.ok(offline.id);
  assert.match(await page.locator('.workspace-notice').textContent(), /saved.*(unavailable|connect|request)/i);
  assert.equal(sends.length, 3);
  const changed = await api({ action: 'edit', id: b.id, overrides: { ...b.overrides, label: 'Renamed notebook' } });
  if (process.env.JOINT_FACADE !== '1') await focusRefresh();
  await until(async () => (await nav(b.id).textContent()) === changed.app.label, 'Independent registry update must refresh browser without focus when facade is integrated');
  assert.equal(await page.locator('.app-list').getByRole('button', { name: 'Renamed notebook', exact: true }).count(), 2);
  if (process.env.JOINT_FACADE === '1') {
    const observed = (await readFile(path.join(scratch, 'provider-input.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(observed[1].args.includes('--resume'), 'App switch must preserve provider session');
  }
  assert.equal(await page.locator('.app-list button').count(), 3);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'workspace-evidence.json'), JSON.stringify({ jointFacade: process.env.JOINT_FACADE === '1', scenarios: ['workspace_layout_preserves_chat_and_frames', 'workspace_registry_forms_use_server_results'], sends, stops, errors, registry: await apps() }, null, 2));
  console.log('PASS workspace_layout_preserves_chat_and_frames');
  console.log('PASS workspace_registry_forms_use_server_results');
  console.log('Artifacts: ' + output);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  if (output !== scratch) await rm(scratch, { recursive: true, force: true });
}
