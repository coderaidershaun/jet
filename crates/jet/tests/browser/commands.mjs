import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, until } from './process.mjs';
import { catalogueAndSafeDiscovery } from './discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-commands-'));
const output = process.env.ARTIFACT_DIR ?? scratch;
await mkdir(output, { recursive: true });
const processes = createProcesses();
let browser, page;
try {
  const fixture = async () => JSON.parse(await processes.launch('node', [path.join(root, 'crates/agent/tests/fixtures/app/server.mjs')], /(\{"ui":.*\})/, { ...process.env, DISCOVERY_TEST: '1' }));
  const first = await fixture(), second = await fixture();
  const data = path.join(scratch, 'data'); await mkdir(data);
  const settings = JSON.parse(await readFile(path.join(root, 'crates/jet/ui/bridge/default-settings.json')));
  const provider = path.join(scratch, 'provider.sh');
  const processor = path.join(scratch, 'prompt.cjs'), promptFile = path.join(scratch, 'prompt.txt');
  await writeFile(processor, `
const fs = require('node:fs');
let input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(output, 'provider-input.jsonl'))}, JSON.stringify({input})+'\\n');
if (input.split('\\n').includes('Please add the notebook as Equivalent.')) {
  input = 'facade:' + JSON.stringify([{tool:'apps_update', arguments:{command:{action:'add',address:${JSON.stringify(first.ui)},overrides:{label:'Equivalent'}}}}]);
}
fs.writeFileSync(${JSON.stringify(promptFile)},input);
`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(provider, '#!/bin/sh\n' + quote(process.execPath) + ' ' + quote(processor) + '\nexec ' + quote(path.join(root, 'target/debug/fake-claude')) + ' "$@" < ' + quote(promptFile) + '\n');
  await chmod(provider, 0o755);
  Object.assign(settings, { model: 'sonnet', claudePath: provider, reducedMotion: true });
  await writeFile(path.join(data, 'settings.json'), JSON.stringify(settings));
  const base = await processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    const RealSource = window.EventSource;
    window.actionEvents = [];
    window.EventSource = class extends RealSource {
      constructor(url) { super(url); window.actionSource = this; this.addEventListener('message', event => window.actionEvents.push(JSON.parse(event.data))); }
    };
  });
  page = await context.newPage();
  const errors = [], sends = [], feels = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (request.url().endsWith('/api/chat/send')) sends.push(request.postDataJSON()); if (request.url().endsWith('/api/feel')) feels.push(request.postDataJSON()); });
  await page.goto(base); await page.locator('.workspace-shell').waitFor();
  const apps = async () => (await context.request.get(base + '/api/apps')).json();
  const snapshot = async () => (await context.request.get(base + '/api/snapshot')).json();
  const nav = (tab, id) => tab.locator(`.app-list [data-app-id="${id}"]`);
  async function chat(tab = page) { if (!(await tab.locator('#field').isVisible())) await tab.locator('#jet-toggle').click(); }
  async function slash(text) { await chat(); await page.locator('#field').fill(text); await page.locator('#field').press('Enter'); }
  async function finish() { await until(async () => !(await snapshot()).active, 'Provider must finish'); await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Reply reveal must finish'); }
  await slash(`/app add ${first.ui} "Equivalent"`);
  await until(async () => (await apps()).length === 1, 'Initial slash add persists');
  const initialApp = (await apps())[0];
  await slash('/app remove ' + initialApp.id);
  await until(async () => (await apps()).length === 0, 'Slash remove persists');
  await slash(`/app add ${first.ui} "Equivalent"`);
  await until(async () => (await apps()).length === 1, 'Slash add persists');
  const slashApp = (await apps())[0];
  const configuration = ({ id, ...rest }) => rest;
  assert.deepEqual(configuration(initialApp), configuration(slashApp));
  await slash(`/app add ${first.ui}`);
  await until(async () => /already|duplicate|registered/i.test(await page.locator('.command-result').textContent()), 'Duplicate reports registry conflict');
  assert.equal((await apps()).length, 1);
  await slash('/app add http://127.0.0.1:1/ "Offline app"');
  await until(async () => /saved.*(unavailable|connect|request)/i.test(await page.locator('.command-result').textContent()), 'Offline registration remains saved');
  const offline = (await apps()).find(item => item.label === 'Offline app');
  assert.ok(offline);
  await slash('/app remove ' + offline.id);
  await until(async () => (await apps()).length === 1, 'Offline registration removed');
  await slash('/app remove ' + slashApp.id);
  await until(async () => (await apps()).length === 0, 'Second remove persists');
  assert.equal(sends.length, 0); assert.equal(feels.length, 0);
  await page.locator('#field').fill('Please add the notebook as Equivalent.');
  await page.locator('#send').click();
  await until(async () => (await apps()).length === 1, 'Conversational fake provider must persist real registry operation');
  await finish();
  const app = (await apps())[0];
  assert.deepEqual(configuration(initialApp), configuration(app));
  assert.equal(sends.length, 1);
  assert.match(await page.locator('#rows').innerText(), /apps_update.*added.*Equivalent/i);
  await slash(`/app add ${second.ui} "Equivalent"`);
  await until(async () => (await apps()).length === 2, 'Second app registers');
  const other = (await apps()).find(item => item.id !== app.id);
  await slash('/app open "Equivalent"');
  await until(async () => /ambiguous/.test(await page.locator('.command-result').textContent()), 'Duplicate label requires an ID');
  await slash('/app open ' + app.id);
  await until(() => page.locator(`.app-frame[data-app-id="${app.id}"]`).isVisible(), 'Exact ID opens app');
  await slash('/tools ' + other.id);
  await page.locator('#tools-content').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.workspace-frames').isVisible(), false, 'Tools occupies the main content');
  await chat();
  await slash('/app disable ' + other.id);
  await until(async () => !(await apps()).find(item => item.id === other.id).enabled, 'Disable persists');
  await slash('/app enable ' + other.id);
  await until(async () => (await apps()).find(item => item.id === other.id).enabled, 'Enable persists');
  await slash('/app edit ' + other.id);
  await until(async () => /Ask Jet/.test(await page.locator('.command-result').textContent()), 'Edit reports conversational guidance');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await slash('/unknown'); await until(async () => /Command help/.test(await page.locator('.command-result').textContent()), 'Unknown command shows help');
  assert.equal(sends.length, 1); assert.equal(feels.length, 1);
  await page.locator('#field').fill('/app li'); await page.locator('#field').press('Tab');
  assert.equal(await page.locator('#field').inputValue(), '/app list ');
  await page.locator('#field').press('Enter');
  await until(async () => (await page.locator('.command-result').textContent()).includes(app.id), 'Completion routes list');
  await page.setViewportSize({ width: 390, height: 844 });
  await chat();
  await page.locator('#field').fill('/app');
  await page.locator('#field').press('Escape');
  assert.equal(await page.locator('#command-menu').isVisible(), false);
  assert.equal(await page.locator('#field').isVisible(), true, 'Completion Escape preserves chat');
  await page.locator('#field').fill('');
  await page.setViewportSize({ width: 1440, height: 900 });
  const tab = await context.newPage(); await tab.goto(base); await tab.locator('.workspace-shell').waitFor();
  await nav(tab, app.id).click(); await nav(page, app.id).click();
  const script = [{ tool: 'apps_open', arguments: { appId: other.id } }, { pause: true }];
  await chat();
  await page.locator('#field').fill('facade:' + JSON.stringify(script)); await page.locator('#send').click();
  await until(() => page.locator(`.app-frame[data-app-id="${other.id}"]`).isVisible(), 'Provider apps_open reaches initiating tab');
  assert.ok(await tab.locator(`.app-frame[data-app-id="${app.id}"]`).isVisible(), 'Other tab must not open app');
  const old = await page.evaluate(() => ({ accepted: actionEvents.findLast(item => item.kind === 'event' && item.data.event.kind === 'accepted'), action: actionEvents.findLast(item => item.kind === 'event' && item.data.event.kind === 'appOpened') }));
  assert.ok(old.action);
  const before = { sends: sends.length, feels: feels.length };
  await slash('/app list'); await slash('/unknown');
  assert.equal(sends.length, before.sends); assert.equal(feels.length, before.feels);
  assert.equal(await page.locator('#held').isVisible(), false);
  await page.locator('#send').click(); await finish();
  await page.reload(); await page.locator('.workspace-shell').waitFor();
  await nav(page, app.id).click();
  await chat();
  await page.locator('#field').fill('facade:' + JSON.stringify([{ pause: true }])); await page.locator('#send').click();
  await until(async () => Boolean((await snapshot()).active), 'Later turn starts');
  const laterIdentity = (await snapshot()).active.identity;
  const actionCheck = page.waitForResponse(response => response.url() === base + '/api/snapshot');
  await page.evaluate(old => {
    let cursor = Math.max(...actionEvents.filter(item => item.kind === 'event').map(item => item.data.cursor));
    for (const value of [old.accepted, old.action]) { const replay = structuredClone(value); replay.data.cursor = ++cursor; actionSource.onmessage({ data: JSON.stringify(replay) }); }
  }, old);
  await actionCheck;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#page').isVisible(), true, 'Old replay cannot open an app in a later turn');
  await context.request.post(base + '/api/chat/stop', { data: { requestId: laterIdentity.requestId } });
  await until(async () => !(await snapshot()).active, 'Stop ends later turn');
  await page.reload(); await page.locator('.workspace-shell').waitFor();
  await tab.close();
  assert.deepEqual(errors, []);
  await until(() => page.locator('.empty').evaluate(element => getComputedStyle(element).visibility === 'hidden'), 'Restored history hides the empty greeting after its transition');
  await page.screenshot({ path: path.join(output, 'commands-desktop.png') });
  await catalogueAndSafeDiscovery({ page, base, app, fixtureUrl: first.ui, artifacts: output });
  await writeFile(path.join(output, 'commands-evidence.json'), JSON.stringify({ scenarios: ['commands_and_turn_bound_actions', 'catalogue_and_safe_discovery'], registry: await apps(), sends, feels, errors }, null, 2));
  console.log('PASS commands_and_turn_bound_actions');
  console.log('PASS catalogue_and_safe_discovery');
  console.log('Artifacts: ' + output);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  await browser?.close(); await processes.close();
  if (output !== scratch) await rm(scratch, { recursive: true, force: true });
}
