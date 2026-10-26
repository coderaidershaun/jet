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
let browser, page, origin;
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
if (input.includes('fail-before-init')) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Fixture failed before init' }));
} else if (input.split('\\n').includes('hang')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'workspace-hang', model: 'claude-fake' }));
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mood: neutral\\nPartial' } } }));
  setTimeout(() => {}, 30000);
} else if (input.includes('layout-fixture')) {
  const text = ${JSON.stringify(markdown)};
  for (const event of [
    { type: 'system', subtype: 'init', session_id: 'workspace-fixture', model: 'claude-fake' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mood: neutral\\n' + text } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'mood: neutral\\n' + text, session_id: 'workspace-fixture', duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 9999, output_tokens: 9999, iterations: [{ input_tokens: 200, cache_read_input_tokens: 250, cache_creation_input_tokens: 50, output_tokens: 100 }] }, modelUsage: { 'claude-fake': { contextWindow: 1000 }, 'auxiliary': { contextWindow: 5000, outputTokens: 99999 } } }
  ]) console.log(JSON.stringify(event));
} else {
  const child = spawn(${JSON.stringify(path.join(root, 'target/debug/fake-claude'))}, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(input); child.on('exit', code => process.exit(code || 0));
}
`);
  await chmod(provider, 0o755);
  Object.assign(settings, { model: 'sonnet', claudePath: provider, reducedMotion: true });
  await writeFile(path.join(data, 'settings.json'), JSON.stringify(settings));
  origin = await launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings'], /Jet listening on (http:\/\/\S+)/);
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
  const nav = id => page.locator(`.app-list [data-app-id="${id}"]`);
  const frame = id => page.frameLocator(`.app-frame[data-app-id="${id}"] iframe`);
  const chat = async () => { await page.locator('#sheet').waitFor({ state: 'hidden' }); if (await page.locator('.workspace-shell').getAttribute('data-mode') !== 'chat') await page.locator('#jet-toggle').click(); };
  const slash = async text => { await chat(); await page.locator('#field').fill(text); await page.locator('#field').press('Enter'); };
  async function add(address, label) {
    await slash(`/app add ${address} ${JSON.stringify(label)}`);
    await until(async () => (await apps()).some(app => app.label === label), 'Command must save app');
    await until(async () => (await page.locator('.command-result').textContent()).includes('App saved: ' + label), 'Saved command result must arrive');
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
  assert.ok(await page.locator('#drawer-name').evaluate(el => el.getBoundingClientRect().left > document.querySelector('#drawer-jet').getBoundingClientRect().right));
  for (const name of ['Add app', 'Apps', 'Hide apps', 'Chat', 'Tools', 'Hide dock']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  }
  await page.setViewportSize({ width: 390, height: 420 });
  await delay(300);
  await page.screenshot({ path: path.join(output, 'workspace-empty-short.png'), animations: 'disabled' });
  const initialSend = await page.locator('#send').boundingBox();
  assert.ok(initialSend.y >= 0 && initialSend.y + initialSend.height <= 420, 'Empty chat send fits short viewport');
  assert.equal(await page.locator('#composer select, .header, .usage, .log, #cache-chip').count(), 0);
  assert.equal(await page.locator('#drawer-jet').count(), 1);
  assert.equal(await page.locator('#drawer-name').textContent(), 'Jet');
  assert.equal(await page.locator('#drawer-title').textContent(), 'First-mate');
  await slash('/unknown');
  await until(async () => /Command help/.test(await page.locator('.command-result').textContent()), 'Command help appears in empty chat');
  assert.equal(await page.locator('.empty').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'The greeting leaves room for command guidance');
  await page.screenshot({ path: path.join(output, 'workspace-empty-help.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  const a = await add(first, 'Notebook A'), b = await add(second, 'Notebook B');
  assert.equal(sends.length, 0);
  assert.equal(await page.locator('.app-list .nav-label').count(), 2);
  assert.equal(await page.locator('#context').isVisible(), false, 'Context stays hidden until toggled');
  const kiteBox = await page.locator('#jet-toggle').boundingBox();
  const appButtons = await page.locator('.app-list button').evaluateAll(elements => elements.map(el => ({ text: el.querySelector('.nav-label').textContent, title: el.title, label: el.getAttribute('aria-label'), box: el.getBoundingClientRect().toJSON(), icon: el.querySelector('.nav-icon').getBoundingClientRect().toJSON() })));
  const settingsTop = (await page.locator('#gear').boundingBox()).y;
  for (const item of appButtons) { assert.equal(item.text, item.label); assert.equal(item.title, item.label); assert.equal(item.icon.x + item.icon.width / 2, kiteBox.x + kiteBox.width / 2, 'App icons line up with the kite'); assert.ok(item.box.height >= 44 && item.box.y > kiteBox.y && item.box.y + item.box.height <= settingsTop); }
  assert.ok(appButtons[0].box.y < kiteBox.y + kiteBox.height + 40, 'Apps sit directly under the kite');
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
  const shortList = await page.locator('.app-list').evaluate(el => ({
    width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight,
    buttonsFit: [...el.children].every(button => {
      const list = el.getBoundingClientRect(), box = button.getBoundingClientRect();
      return box.left >= list.left && box.right <= list.left + el.clientWidth && box.width >= 44 && box.height >= 44;
    }),
  }));
  assert.equal(shortList.scrollWidth, shortList.width, 'Collapsed app list has no horizontal overflow');
  assert.equal(shortList.scrollHeight, shortList.height, 'Short app list has no vertical overflow');
  assert.ok(shortList.buttonsFit, 'Collapsed app buttons fit with usable targets');
  const extraApps = [];
  try {
    for (let index = 0; index < 8; index++) {
      const address = await fixture(`Scrollable notebook ${index}`);
      const result = await api({ action: 'add', address, overrides: { label: `Scrollable notebook ${index}` } });
      extraApps.push(result.app);
    }
    await page.setViewportSize({ width: 1440, height: 480 });
    await until(async () => await page.locator('.app-list button').count() === 10, 'Long app list reaches navigation');
    assert.ok(await page.locator('.app-list').evaluate(el => el.scrollHeight > el.clientHeight), 'Long app list can scroll vertically');
    assert.ok(await page.locator('.app-list').evaluate(el => el.scrollWidth === el.clientWidth), 'Long app list has no horizontal overflow');
    const last = nav(extraApps.at(-1).id);
    await last.click();
    assert.equal(await last.getAttribute('aria-current'), 'true', 'Last app remains selectable after scrolling');
    assert.ok(await last.evaluate(button => {
      const el = button.parentElement, list = el.getBoundingClientRect(), box = button.getBoundingClientRect();
      return el.scrollTop > 0 && box.top >= list.top && box.bottom <= list.top + el.clientHeight
        && box.left >= list.left && box.right <= list.left + el.clientWidth && box.height >= 44;
    }), 'Last app button scrolls fully into view');
    await page.screenshot({ path: path.join(output, 'workspace-scrollable-apps.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await nav(a.id).click();
  } finally {
    for (const app of extraApps) await api({ action: 'remove', id: app.id });
    await until(async () => await page.locator('.app-list button').count() === 2, 'Long-list fixture apps are removed');
  }
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
  await until(async () => (await page.locator('#context-tokens').textContent()) === '600 / 1,000 tokens', 'Latest context is used instead of aggregate billing');
  assert.equal(await page.locator('#context-percent').textContent(), '60% capacity');
  assert.equal(await page.locator('#context-note').textContent(), 'Last measured context');
  await slash('/thinking low');
  await until(async () => (await (await context.request.get(origin + '/api/settings')).json()).effort === 'low', 'Thinking slash command persists');
  await page.locator('#field').fill('/model op');
  assert.ok(await page.locator('#command-menu button').first().evaluate(el => {
    const menu = el.getBoundingClientRect(), jump = document.querySelector('#jump').getBoundingClientRect();
    const left = Math.max(menu.left, jump.left), right = Math.min(menu.right, jump.right);
    const top = Math.max(menu.top, jump.top), bottom = Math.min(menu.bottom, jump.bottom);
    return right <= left || bottom <= top || Boolean(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)?.closest('#command-menu'));
  }), 'Completion remains clickable above Jump to latest');
  await page.screenshot({ path: path.join(output, 'workspace-slash-completion.png'), animations: 'disabled' });
  await page.locator('#field').press('Tab');
  assert.equal(await page.locator('#field').inputValue(), '/model opus ');
  await page.locator('#field').press('Enter');
  await until(async () => (await page.locator('#context-model').textContent()) === 'Opus', 'Model completion saves without provider dispatch');
  assert.equal(await page.locator('#context-tokens').textContent(), '— / — tokens');
  await slash('/model sonnet');
  await until(async () => (await page.locator('#context-tokens').textContent()) === '600 / 1,000 tokens', 'Returning to measured selection restores its context');
  await page.route('**/api/settings', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture save failed' }) }) : route.continue());
  await slash('/model opus');
  await until(async () => /failed/i.test(await page.locator('.command-result').textContent()), 'Save failure is visible');
  assert.equal(await page.locator('#context-model').textContent(), 'Sonnet');
  assert.equal(await page.locator('#context-tokens').textContent(), '600 / 1,000 tokens');
  await page.unroute('**/api/settings');
  await page.reload();
  await page.locator('.workspace-shell').waitFor();
  await until(async () => (await page.locator('#context-tokens').textContent()) === '600 / 1,000 tokens', 'Persisted context survives browser reload');
  assert.equal((await (await context.request.get(origin + '/api/settings')).json()).effort, 'low');
  await slash('/thinking');
  await until(async () => /Current thinking: low/.test(await page.locator('.command-result').textContent()), 'No argument reports current thinking');
  await page.locator('#field').fill('Draft survives overlays');
  await until(() => page.locator('.empty').evaluate(el => getComputedStyle(el).visibility === 'hidden'), 'Restored history finishes hiding greeting');
  await delay(250);
  await page.screenshot({ path: path.join(output, 'workspace-desktop.png') });
  await page.getByRole('button', { name: 'Context', exact: true }).click();
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
    assert.ok(await page.locator('#context-title').isVisible());
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
  const lastRow = await page.locator('#rows > :last-child').boundingBox();
  assert.ok(commandBox.y >= lastRow.y + lastRow.height, 'Command guidance sits below the newest message');
  await slash('/app add file:///invalid');
  await until(async () => /http|address|scheme/i.test(await page.locator('.command-result').textContent()), 'Invalid address explains failure');
  await slash('/app add ' + first);
  await until(async () => /already|duplicate|registered/i.test(await page.locator('.command-result').textContent()), 'Duplicate reports conflict');
  const offline = await add('http://127.0.0.1:1/', 'Offline app');
  assert.ok(offline.id);
  assert.match(await page.locator('.command-result').textContent(), /saved.*(unavailable|connect|request)/i);
  assert.equal(sends.length, 3);
  const changed = await api({ action: 'edit', id: b.id, overrides: { ...b.overrides, label: 'Renamed notebook' } });
  await until(async () => (await nav(b.id).getAttribute('aria-label')) === changed.app.label, 'Independent registry update must refresh browser without focus');
  assert.equal(await page.locator('.app-list').getByRole('button', { name: 'Renamed notebook', exact: true }).count(), 2);
  if (process.env.JOINT_FACADE === '1') {
    const observed = (await readFile(path.join(scratch, 'provider-input.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(observed[1].args.includes('--resume'), 'App switch must preserve provider session');
  }
  assert.equal(await page.locator('.app-list button').count(), 3);
  await nav(b.id).click();
  await api({ action: 'remove', id: b.id });
  await until(() => page.locator('#page').isVisible(), 'Removing the visible app returns to chat');
  await slash('/app reload');
  await until(async () => /Choose an app/.test(await page.locator('.command-result').textContent()), 'Removing selected app clears context');
  await slash('/thinking high');
  await until(async () => (await (await context.request.get(origin + '/api/settings')).json()).effort === 'high', 'New effort is saved before next reply');
  await page.locator('#field').fill('hang');
  await page.locator('#send').click();
  await until(async () => (await page.locator('#context-tokens').textContent()) === '— / — tokens', 'Fresh started reply clears previous context');
  await until(async () => Boolean((await (await context.request.get(origin + '/api/snapshot')).json()).active?.text), 'Fresh hanging reply starts');
  assert.equal(sends.at(-1).model, 'sonnet');
  assert.equal(sends.at(-1).effort, 'high');
  await page.locator('#send').click();
  await until(async () => !(await (await context.request.get(origin + '/api/snapshot')).json()).active, 'Fresh reply stops');
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Stopped reveal ends');
  assert.equal(await page.locator('#context-tokens').textContent(), '— / — tokens', 'Stopped fresh reply never revives old measurement');
  await page.locator('#field').fill('layout-fixture');
  await page.locator('#send').click();
  await until(async () => (await page.locator('#context-tokens').textContent()) === '600 / 1,000 tokens', 'Next fixture measures new context');
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Fixture reveal finishes');
  await slash('/thinking medium');
  await until(async () => (await (await context.request.get(origin + '/api/settings')).json()).effort === 'medium', 'Fresh failure selection is saved');
  await page.locator('#field').fill('fail-before-init');
  await page.locator('#send').click();
  await until(async () => /Fixture failed before init/.test(await page.locator('#rows').innerText()), 'Free provider fails before init');
  await until(async () => (await page.locator('#context-tokens').textContent()) === '— / — tokens', 'Failed fresh reply clears prior context even without Started');
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Failed reveal ends');
  await page.locator('#field').fill('layout-fixture');
  await page.locator('#send').click();
  await until(async () => (await page.locator('#context-tokens').textContent()) === '600 / 1,000 tokens', 'Fixture measures before Forget');
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Fixture reveal ends before Forget');
  await page.locator('#gear').click();
  await page.getByRole('button', { name: 'Forget this conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Forget', exact: true }).click();
  await page.locator('#sheet').waitFor({ state: 'hidden' });
  await until(async () => (await page.locator('#context-tokens').textContent()) === '— / — tokens', 'Forget clears measured context');
  await page.reload();
  await page.locator('.workspace-shell').waitFor();
  assert.equal(await page.locator('#context-tokens').textContent(), '— / — tokens');
  await nav(a.id).click();
  await chat();
  let releaseSave, enteredSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const saveEntered = new Promise(resolve => { enteredSave = resolve; });
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') { enteredSave(); await saveGate; }
    await route.continue();
  });
  const sendsBeforeSave = sends.length;
  await slash('/thinking low');
  await saveEntered;
  await page.locator('#field').fill('hang');
  await page.locator('#field').press('Enter');
  await nav(offline.id).click();
  await chat();
  await page.locator('#field').fill('layout-fixture');
  await page.locator('#field').press('Enter');
  assert.equal(sends.length, sendsBeforeSave, 'Messages wait for the preceding setting save');
  releaseSave();
  await until(async () => Boolean((await (await context.request.get(origin + '/api/snapshot')).json()).active?.text), 'First queued message starts');
  assert.equal(sends.length, sendsBeforeSave + 1, 'Second queued message is held while the first replies');
  assert.equal(sends.at(-1).effort, 'low');
  assert.equal(sends.at(-1).activeAppId, a.id, 'Delayed dispatch retains the submitted app');
  await page.locator('#send').click();
  await until(async () => sends.length === sendsBeforeSave + 2 && await page.locator('#send').getAttribute('aria-label') === 'Send', 'Held message runs after Stop');
  assert.equal(sends.at(-1).activeAppId, offline.id, 'Held message retains its own submitted app');
  await page.unroute('**/api/settings');
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
  if (origin) await processes.stop(origin);
  await processes.close();
  if (output !== scratch) await rm(scratch, { recursive: true, force: true });
}
