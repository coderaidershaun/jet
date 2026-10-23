import { createProcesses, until } from './process.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-workspace-'));
const output = process.env.ARTIFACT_DIR ?? scratch;
await mkdir(output, { recursive: true });
const processes = createProcesses();
const launch = processes.launch;
let browser, page;
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
  const chat = () => page.getByRole('button', { name: 'Jet', exact: true }).click();
  const slash = async text => { await chat(); await page.locator('#field').fill(text); await page.locator('#field').press('Enter'); };
  async function add(address, label) {
    await slash(`/app add ${address} ${JSON.stringify(label)}`);
    await until(async () => (await apps()).some(app => app.label === label), 'Command must save app');
    return (await apps()).find(app => app.label === label);
  }
  assert.ok(await page.locator('#page').isVisible());
  assert.equal(await page.locator('.workspace-frames').isVisible(), false);
  assert.equal(await page.locator('.workspace-shell').getAttribute('data-expanded'), 'true');
  assert.equal(await page.locator('#gear').evaluate(el => el.closest('#drawer') !== null), true);
  const chatBox = await page.locator('#page').boundingBox();
  const drawerBox = await page.locator('#drawer').boundingBox();
  assert.equal(chatBox.x, drawerBox.width);
  assert.equal(chatBox.width + drawerBox.width, 1440, 'Chat occupies the content beside its drawer');
  for (const name of ['Add app', 'Apps', 'Hide apps', 'Chat', 'Tools', 'Hide dock']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  }
  await page.setViewportSize({ width: 390, height: 420 });
  await page.screenshot({ path: path.join(output, 'workspace-empty-short.png') });
  const initialSend = await page.locator('#send').boundingBox();
  assert.ok(initialSend.y >= 0 && initialSend.y + initialSend.height <= 420, 'Empty chat send fits short viewport');
  const initialModel = await page.locator('#composer .model-picker').boundingBox();
  assert.ok(initialModel.y + initialModel.height <= 420, 'Empty chat model controls fit short viewport');
  await slash('/unknown');
  await until(async () => /Command help/.test(await page.locator('.command-result').textContent()), 'Command help appears in empty chat');
  assert.equal(await page.locator('.empty').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'The greeting leaves room for command guidance');
  await page.screenshot({ path: path.join(output, 'workspace-empty-help.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  const a = await add(first, 'Notebook A'), b = await add(second, 'Notebook B');
  assert.equal(sends.length, 0);
  await page.locator('#field').fill('Unsent chat draft');
  await nav(a.id).click();
  await frame(a.id).getByLabel('Unsaved note').fill('Unsent note A');
  await page.evaluate(() => { window.firstFrame = document.querySelector('.app-frame:not([hidden]) iframe'); window.chatPage = document.querySelector('#page'); });
  assert.equal(await page.locator('#page').isVisible(), false);
  assert.equal(await page.locator('.workspace-shell').getAttribute('data-expanded'), 'false');
  const railBox = await page.locator('#drawer').boundingBox();
  const appBox = await page.locator('.workspace-frames').boundingBox();
  const gearBox = await page.locator('#gear').boundingBox();
  assert.ok(railBox.width < 80 && appBox.width + railBox.width === 1440, 'App fills the space beside an icon rail');
  assert.ok(gearBox.x < railBox.width && gearBox.y + gearBox.height >= 880, 'Settings stays at the bottom left');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.ok(await page.locator('.workspace-frames').isVisible(), 'Closing settings retains the app view');
  await page.screenshot({ path: path.join(output, 'workspace-maximized.png') });
  await nav(b.id).click();
  await frame(b.id).getByLabel('Unsaved note').fill('Second unchanged');
  await page.evaluate(() => { window.secondFrame = document.querySelector('.app-frame:not([hidden]) iframe'); });
  await chat();
  assert.equal(await page.locator('#field').inputValue(), 'Unsent chat draft');
  assert.ok(await page.evaluate(() => chatPage === document.querySelector('#page')));
  assert.equal(await page.locator('.workspace-shell').getAttribute('data-expanded'), 'true');
  await page.screenshot({ path: path.join(output, 'workspace-returned-chat.png') });
  await page.getByRole('button', { name: 'Collapse drawer', exact: true }).click();
  await page.getByRole('button', { name: 'Expand drawer', exact: true }).click();
  await api({ action: 'edit', id: a.id, overrides: { ...a.overrides, label: 'Renamed notebook', ui: first + '?reloaded=1' } });
  if (process.env.JOINT_FACADE !== '1') await focusRefresh();
  await until(async () => (await nav(a.id).getAttribute('aria-label')) === 'Renamed notebook', 'Metadata refresh updates navigation');
  assert.ok(await page.evaluate(() => firstFrame === document.querySelectorAll('.app-frame iframe')[0]), 'Metadata refresh preserves the visited frame');
  assert.equal(await frame(a.id).getByLabel('Unsaved note').inputValue(), 'Unsent note A');
  await slash('/app reload ' + a.id);
  await until(() => page.evaluate(() => firstFrame !== document.querySelectorAll('.app-frame iframe')[0]), 'Explicit reload replaces only targeted frame');
  assert.equal(await page.locator('#page').isVisible(), true, 'Reload must retain chat view');
  assert.ok(await page.locator(`.app-frame[data-app-id="${a.id}"] iframe`).getAttribute('src').then(src => src.includes('reloaded=1')));
  await nav(b.id).click();
  assert.ok(await page.evaluate(() => secondFrame === document.querySelector('.app-frame:not([hidden]) iframe')));
  assert.equal(await frame(b.id).getByLabel('Unsaved note').inputValue(), 'Second unchanged');
  assert.equal(sends.length, 0);
  await chat();

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
  await slash('/tools');
  await nav(a.id).click();
  assert.ok((await (await context.request.get(origin + '/api/snapshot')).json()).active);
  assert.equal(stops.length, 0);
  await chat();
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
    await page.getByRole('button', { name: 'Expand drawer', exact: true }).click();
    assert.ok(await page.locator('#usage-title').isVisible());
    assert.ok(await page.locator('.workspace-content').evaluate(el => el.inert));
    await page.screenshot({ path: path.join(output, `workspace-drawer-${viewport.height}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await delay(250);
    await page.screenshot({ path: path.join(output, `workspace-settings-${viewport.height}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.workspace-shell').getAttribute('data-expanded'), 'false');
    assert.equal(stops.length, 1);
    assert.equal(await page.getByRole('button', { name: 'Expand drawer', exact: true }).evaluate(el => el === document.activeElement), true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await chat();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: path.join(output, 'workspace-settings.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await slash('/app add');
  await until(async () => /app add <address>/.test(await page.locator('.command-result').textContent()), 'Incomplete add stays inline');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  const commandBox = await page.locator('.command-result').boundingBox();
  const threadBox = await page.locator('#thread').boundingBox();
  assert.ok(commandBox.y >= threadBox.y && commandBox.y + commandBox.height <= threadBox.y + threadBox.height, 'Command guidance stays visible after a long conversation');
  await slash('/app add file:///invalid');
  await until(async () => /http|address|scheme/i.test(await page.locator('.command-result').textContent()), 'Invalid address explains failure');
  await slash('/app add ' + first);
  await until(async () => /already|duplicate|registered/i.test(await page.locator('.command-result').textContent()), 'Duplicate reports conflict');
  const offline = await add('http://127.0.0.1:1/', 'Offline app');
  assert.ok(offline.id);
  assert.match(await page.locator('.command-result').textContent(), /saved.*(unavailable|connect|request)/i);
  assert.equal(sends.length, 3);
  const changed = await api({ action: 'edit', id: b.id, overrides: { ...b.overrides, label: 'Renamed notebook' } });
  if (process.env.JOINT_FACADE !== '1') await focusRefresh();
  await until(async () => (await nav(b.id).getAttribute('aria-label')) === changed.app.label, 'Independent registry update must refresh browser without focus when facade is integrated');
  assert.equal(await page.locator('.app-list').getByRole('button', { name: 'Renamed notebook', exact: true }).count(), 2);
  if (process.env.JOINT_FACADE === '1') {
    const observed = (await readFile(path.join(scratch, 'provider-input.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(observed[1].args.includes('--resume'), 'App switch must preserve provider session');
  }
  assert.equal(await page.locator('.app-list button').count(), 3);
  await nav(b.id).click();
  await api({ action: 'remove', id: b.id });
  if (process.env.JOINT_FACADE !== '1') await focusRefresh();
  await until(() => page.locator('#page').isVisible(), 'Removing the visible app returns to chat');
  await slash('/app reload');
  await until(async () => /Choose an app/.test(await page.locator('.command-result').textContent()), 'Removing selected app clears context');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'workspace-evidence.json'), JSON.stringify({ jointFacade: process.env.JOINT_FACADE === '1', scenarios: ['workspace_layout_preserves_chat_and_frames', 'workspace_registry_commands_use_server_results'], sends, stops, errors, registry: await apps() }, null, 2));
  console.log('PASS workspace_layout_preserves_chat_and_frames');
  console.log('PASS workspace_registry_commands_use_server_results');
  console.log('Artifacts: ' + output);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  if (output !== scratch) await rm(scratch, { recursive: true, force: true });
}
