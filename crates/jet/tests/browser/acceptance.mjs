import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-acceptance-'));
const output = process.env.ARTIFACT_DIR ?? scratch;
await mkdir(output, { recursive: true });
const processes = createProcesses();
let browser, page;
try {
  const data = path.join(scratch, 'jet'), home = path.join(scratch, 'quanty');
  await mkdir(data); await mkdir(home);
  const provider = path.join(scratch, 'provider.cjs'), invocations = path.join(scratch, 'invocations.jsonl');
  await writeFile(provider, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({input,args:process.argv.slice(2)})+'\\n');
if (input.split('\\n').includes('hang')) {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'acceptance-hang',model:'claude-fake'}));
  console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'mood: neutral\\nPartial'}}}));
  setTimeout(() => {}, 30000);
} else {
const child = spawn(${JSON.stringify(path.join(root, 'target/debug/fake-claude'))}, process.argv.slice(2), {stdio:['pipe','pipe','inherit']});
readline.createInterface({input:child.stdout}).on('line', line => {
  const event = JSON.parse(line);
  if (input.includes('free citation') && event.type === 'result' && event.subtype === 'success') event.result = 'mood: neutral\\nThe free sample provides a figure [1].';
  console.log(JSON.stringify(event));
});
child.stdin.end(input); child.on('exit', code => process.exit(code || 0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
}
`);
  await chmod(provider, 0o755);
  const settings = JSON.parse(await readFile(path.join(root, 'crates/jet/ui/bridge/default-settings.json')));
  Object.assign(settings, { model: 'sonnet', claudePath: provider, reducedMotion: true });
  settings.persona.name = 'Acceptance Jet';
  await writeFile(path.join(data, 'settings.json'), JSON.stringify(settings));
  const jet = listen => processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', listen, '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  const quanty = listen => processes.launch(process.env.QUANTY_BINARY, ['--home', home, '--listen', listen, '--fixture', 'black-scholes', '--trusted-integration'], /listening on (http:\/\/\S+)/, { PATH: process.env.PATH });
  const origin = await jet('127.0.0.1:0'), quantyUrl = await quanty('127.0.0.1:0');
  const generic = await processes.launch('node', [path.join(root, 'crates/jet/tests/fixtures/proxy.mjs')], /"url":"([^"]+)"/, { ...process.env, FIXTURE_NAME: 'Generic notebook' });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  context.setDefaultTimeout(15000);
  page = await context.newPage();
  const network = [], sockets = [], errors = [], sends = [];
  page.on('response', response => network.push({ url: response.url(), status: response.status() }));
  page.on('websocket', socket => socket.on('framereceived', () => sockets.push(socket.url())));
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (request.url().endsWith('/api/chat/send')) sends.push(request.postDataJSON()); });
  const get = async route => (await context.request.get(origin + route)).json();
  const apps = () => get('/api/apps'), snapshot = () => get('/api/snapshot');
  const nav = id => page.locator(`.app-list [data-app-id="${id}"]`);
  const chat = async () => { if (await page.locator('.workspace-shell').getAttribute('data-mode') !== 'chat') await page.locator('#jet-toggle').click(); };
  const finish = async () => { await until(async () => !(await snapshot()).active, 'Reply must finish'); await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'Reply reveal must finish'); };
  const send = async text => { await chat(); await page.locator('#field').fill(text); await page.locator('#send').click(); };
  async function add(address, label) {
    await send(`/app add ${address} ${JSON.stringify(label)}`);
    await until(async () => (await apps()).some(app => app.label === label), 'App must register');
    return (await apps()).find(app => app.label === label);
  }
  const call = id => [{ tool: 'tools_search', arguments: { query: 'search' } }, { tool: 'tools_describe', arguments: { appId: id, tool: 'search' } }, { tool: 'tools_call', arguments: { appId: id, tool: 'search', arguments: { question: 'free citation' } } }];
  await page.goto(origin); await page.locator('.workspace-shell').waitFor();
  const a = await add(new URL(quantyUrl).port, 'Research library');
  await nav(a.id).click();
  const mounted = `${origin}/apps/${a.id}/`;
  const frame = page.frameLocator(`.app-frame[data-app-id="${a.id}"] iframe`);
  await frame.locator('#loading_text').waitFor({ state: 'detached', timeout: 45000 });
  await until(() => sockets.some(url => url.includes(`/apps/${a.id}/api/ws`)), 'Actual Quanty startup socket must answer');
  assert.ok(await frame.locator('canvas').evaluate(canvas => canvas.width > 100 && canvas.height > 100));
  assert.ok(network.some(row => row.url === mounted + 'api/facts' && row.status === 200));
  assert.ok(network.some(row => row.url.includes(mounted) && row.url.endsWith('.wasm') && row.status === 200));
  await send('/tools');
  await page.getByLabel('Tool app', { exact: true }).selectOption(a.id);
  await page.locator('[data-tool="search"] summary').click();
  assert.match(await page.locator('[data-tool="search"]').innerText(), /question/);
  assert.match(await page.locator('[data-tool="search"]').innerText(), /free/i);
  const b = await add(generic, 'Other workspace');
  assert.notEqual(a.id, b.id);
  await nav(b.id).click();
  await page.frameLocator(`.app-frame[data-app-id="${b.id}"] iframe`).getByLabel('Unsaved note').fill('Other workspace remains active');
  await send('facade:' + JSON.stringify(call(a.id))); await finish();
  await page.locator('.cite').last().click();
  const picture = page.locator('img.picture').last();
  await until(() => picture.evaluate(img => img.complete && img.naturalWidth > 0), 'Citation must load its actual mounted image');
  assert.ok((await picture.getAttribute('src')).startsWith(`/apps/${a.id}/content/`));
  assert.ok(network.some(row => row.url.startsWith(mounted + 'content/') && row.status === 200));
  assert.match(await page.locator('.cards').last().innerText(), new RegExp(a.id));
  assert.equal(await page.locator('#page').isVisible(), true);
  assert.equal(sends.at(-1).activeAppId, b.id);
  const rejected = await page.evaluate(async appId => {
    const { createBrowserAgent } = await import('/bridge/browser-agent.js');
    const agent = createBrowserAgent();
    const references = ['/etc/passwd', '../escape.png', 'content/%252e%252e/x.png', 'content/a%2fb.png', 'content/%ZZ.png', '//foreign.invalid/a.png', 'https://foreign.invalid/a.png', '/apps/another/a.png'];
    const rejected = [];
    for (const reference of references) {
      try { await agent.readAppImage(appId, reference); } catch (error) { rejected.push(error.message); }
    }
    return { rejected, count: references.length };
  }, a.id);
  assert.equal(rejected.rejected.length, rejected.count);
  assert.ok(rejected.rejected.every(message => message.startsWith('Picture unavailable')));
  assert.ok(!network.some(row => /foreign.invalid|escape.png|%252e|passwd|another/.test(row.url)));
  await writeFile(path.join(output, 'citation-history.json'), JSON.stringify(await snapshot(), null, 2));
  await page.screenshot({ path: path.join(output, 'acceptance-desktop.png'), animations: 'disabled' });
  const notes = { memory: 'Retain acceptance memory', user: 'Retain user note', recent: 'Retain recent note' };
  assert.ok((await context.request.put(origin + '/api/memory', { data: notes })).ok());
  await send('hang');
  await until(async () => Boolean((await snapshot()).active?.text), 'Hanging reply must be accepted');
  const accepted = (await snapshot()).active.identity;
  const count = (await readFile(invocations, 'utf8')).trim().split('\n').length;
  await nav(b.id).click();
  await nav(a.id).click(); await nav(b.id).click();
  await page.reload(); await page.locator('.workspace-shell').waitFor();
  await chat();
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Stop', 'Recovered reply must offer Stop');
  assert.deepEqual((await snapshot()).active.identity, accepted);
  assert.equal((await readFile(invocations, 'utf8')).trim().split('\n').length, count);
  await page.locator('#send').click(); await finish();
  await processes.stop(origin);
  assert.equal(await jet(new URL(origin).host), origin);
  await page.reload(); await page.locator('.workspace-shell').waitFor();
  assert.deepEqual((await apps()).map(app => [app.id, app.label]), [[a.id, a.label], [b.id, b.label]]);
  assert.equal((await get('/api/settings')).persona.name, settings.persona.name);
  for (const [key, value] of Object.entries(notes)) assert.equal((await get('/api/memory'))[key], value);
  assert.ok(JSON.stringify(await snapshot()).includes('free citation'));
  await nav(b.id).click();
  await send('facade:' + JSON.stringify(call(a.id))); await finish();
  await page.locator('.cite').last().click();
  await until(() => page.locator('img.picture').last().evaluate(img => img.naturalWidth > 0), 'Restarted host retains source ownership');
  await nav(a.id).click();
  await send('/tools');
  await page.getByLabel('Tool app', { exact: true }).selectOption(a.id);
  await page.locator('[data-tool="search"]').waitFor();
  await processes.stop(quantyUrl);
  await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
  await until(async () => /Stale metadata/.test(await page.locator('.tools-status').innerText()), 'Offline app retains visibly stale metadata');
  assert.ok(await page.locator('[data-tool="search"]').isVisible());
  assert.equal(await quanty(new URL(quantyUrl).host), quantyUrl);
  await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
  await until(async () => /5 tools available/.test(await page.locator('.tools-status').innerText()), 'Restarted app refresh recovers');
  await send(`/app disable ${a.id}`);
  await until(async () => !(await apps()).find(app => app.id === a.id).enabled, 'Disable command saves');
  await send('facade:' + JSON.stringify(call(a.id))); await finish();
  assert.match(await page.locator('.cards').last().innerText(), /unavailable/i);
  await send(`/app remove ${a.id}`);
  await until(async () => !(await apps()).some(app => app.id === a.id), 'Remove command saves');
  await send('facade:' + JSON.stringify(call(a.id))); await finish();
  assert.match(await page.locator('.cards').last().innerText(), /unavailable/i);
  await page.reload(); await page.locator('.workspace-shell').waitFor(); await chat();
  await page.locator('.cite').first().click();
  await page.locator('.picture-missing').first().waitFor();
  await nav(b.id).click();
  await page.frameLocator(`.app-frame[data-app-id="${b.id}"] iframe`).getByLabel('Unsaved note').fill('Still works');
  await send('facade:' + JSON.stringify([{ tool: 'apps_list' }])); await finish();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('#send').isVisible());
  await page.screenshot({ path: path.join(output, 'acceptance-narrow.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'acceptance-evidence.json'), JSON.stringify({ scenario: 'registered_apps_survive_recovery_and_show_contained_sources', network, sockets, errors, sends, accepted, registry: await apps() }, null, 2));
  console.log('PASS registered_apps_survive_recovery_and_show_contained_sources');
  console.log('Artifacts: ' + output);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  if (output !== scratch) await rm(scratch, { recursive: true, force: true });
}
