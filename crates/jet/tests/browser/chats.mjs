// Drives the left pane against the real host: a reply in a chat that is not open raises its badge with
// no reload, opening a chat clears it, a new chat needs no form, a title is renamed in place, a chat is
// deleted by a second tap, an objective's chat shows its summary first, every call carries the open
// chat, and at 390 px a long unbroken message and a long title overflow nothing. It takes the screenshots.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, signIn, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-chats-'));
const screens = process.env.SCREENSHOT_DIR ?? path.join(scratch, 'screens');
await mkdir(screens, { recursive: true });
const processes = createProcesses();
let browser, page;
try {
  const data = path.join(scratch, 'data');
  await mkdir(data);
  const provider = path.join(scratch, 'provider.cjs');
  const reply = 'mood: warm\\nGot it. I will keep that in mind and bring it up when it matters.';
  await writeFile(provider, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
if (/^facade:/m.test(input)) {
  const child = spawn(${JSON.stringify(path.join(root, 'target/debug/fake-claude'))}, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(input); child.on('exit', code => process.exit(code || 0));
} else {
  const text = "${reply}";
  for (const event of [
    { type: 'system', subtype: 'init', session_id: 'chats-fixture', model: 'claude-fake' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'chats-fixture', duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {} },
  ]) console.log(JSON.stringify(event));
}
`);
  await chmod(provider, 0o755);
  const origin = await processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  await saveOwnerSettings(origin, { model: 'sonnet', claudePath: provider, reducedMotion: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(15000);
  page = await context.newPage();
  const errors = [], chatCalls = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^\/api\/(chat\/|snapshot|status)/.test(url.pathname)) chatCalls.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  const write = { headers: { origin } };
  const get = async route => (await context.request.get(origin + route)).json();
  const post = async (route, body) => { const response = await context.request.post(origin + route, { ...write, data: body }); assert.ok(response.ok(), await response.text()); return response.json(); };
  const send = (chat, text) => post(`/api/chat/send${chat ? '?chat=' + chat : ''}`, { requestId: 'r' + Math.random().toString(16).slice(2), clientId: 'seed', text, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First mate', notes: '' }, localTime: 'Friday', timeZone: 'Europe/London', feeling: 'neutral' });
  const settled = async chat => until(async () => !(await get(`/api/snapshot${chat ? '?chat=' + chat : ''}`)).active, 'the reply must finish');
  const row = title => page.locator('.chat-row', { has: page.locator('.chat-title', { hasText: title }) });
  const shoot = async name => { await delay(500); await page.screenshot({ path: path.join(screens, name), animations: 'disabled' }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const open = async () => { if (await page.locator('.workspace-shell').getAttribute('data-expanded') !== 'true') await page.locator('#jet-toggle').click(); };

  await signIn(page, origin);
  await page.locator('#loading').waitFor({ state: 'detached' });
  const main = (await get('/api/chats'))[0];
  assert.equal(main.kind, 'main');
  assert.equal(await page.locator('.chat-row').count(), 1, 'a new account has only its main chat');
  assert.equal(await page.locator('.chat-row .chat-delete').count(), 0, 'the main chat has no delete');

  // A reply in a chat that is not on screen raises its badge with no reload, and lifts the chat.
  const boats = await post('/api/chats', { title: 'Boat trip' });
  const taxes = await post('/api/chats', { title: 'Taxes' });
  await page.evaluate(() => { window.sameDocument = true; });
  await send(boats.id, 'Plan the boat trip for the weekend');
  await send(taxes.id, 'What do I need for my tax return');
  await until(async () => (await row('Boat trip').locator('.badge').count()) === 1 && (await row('Taxes').locator('.badge').count()) === 1, 'the badges must rise without a reload');
  await settled(boats.id);
  await send(boats.id, 'And remind me to book the marina');
  await until(async () => (await row('Boat trip').locator('.badge').textContent()) === '2', 'a second reply raises the badge again');
  await settled(boats.id);
  assert.equal(await page.evaluate(() => window.sameDocument), true);
  assert.deepEqual(await page.locator('.chat-title').allTextContents().then(titles => titles[0]), 'Main chat', 'the main chat stays first');
  assert.equal((await get('/api/chats')).find(chat => chat.id === boats.id).unread, 2);

  // An objective made with its own chat appears with its summary as the first entry.
  const objective = [{ tool: 'objectives_update', arguments: { command: { action: 'create', title: 'Sail the Solent', deliverable: 'A weekend sail with the crew booked', start: '2099-06-01', due: '2099-07-01', steps: [], sources: [], check: { at: '2099-06-08T09:00', why: 'see the crew' }, chat: 'new' } } }];
  await send(main.id, 'facade:' + JSON.stringify(objective));
  await settled(main.id);
  await until(async () => (await row('Sail the Solent').count()) === 1, 'the objective chat must appear in the list');
  const objectiveChat = (await get('/api/chats')).find(chat => chat.kind === 'objective');
  // The script that made the objective leaves the main chat, so the page shows a plain talk there.
  await post(`/api/chat/forget?chat=${main.id}`, {});
  await until(async () => (await page.locator('#rows .row').count()) === 0, 'forgetting must empty the open chat');
  await page.locator('#field').fill('What is on my plate this weekend?');
  await page.locator('#send').click();
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send' && (await page.locator('#rows .row-jet').count()) > 0, 'the main chat must answer');
  await shoot('1280-1-list-with-unread.png');

  // Opening a chat shows its history, clears its badge, and every call after it carries its id.
  await row('Boat trip').locator('.chat-open').click();
  await until(async () => (await page.locator('#rows').innerText()).includes('Plan the boat trip'), 'the chat must show its own history');
  assert.equal(await row('Boat trip').locator('.badge').count(), 0);
  await until(async () => (await get('/api/chats')).find(chat => chat.id === boats.id).unread === 0, 'opening must move the read mark');
  await page.locator('#field').fill('And book the marina');
  await page.locator('#send').click();
  await until(() => chatCalls.some(call => call === `POST /api/chat/send?chat=${boats.id}`), 'a message must carry the open chat');
  await until(async () => (await page.locator('#rows').innerText()).includes('keep that in mind'), 'the reply must show');
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'the reply must end');
  assert.equal(await row('Boat trip').locator('.badge').count(), 0, 'a reply in the open chat raises no badge');
  assert.equal((await get('/api/chats')).find(chat => chat.id === boats.id).unread, 0, 'a reply in the open chat is read');
  assert.ok(!(await page.locator('#rows').innerText()).includes('Sail the Solent'), 'another chat shows nowhere in this one');

  // The objective's chat: its summary comes first.
  await row('Sail the Solent').locator('.chat-open').click();
  await until(async () => (await page.locator('#rows .row').first().innerText()).includes('Sail the Solent'), "the objective's summary must be its first entry");
  await shoot('1280-5-objective-chat.png');

  // New chat: opens at once, empty, with no form.
  await page.locator('#new-chat').click();
  await until(async () => (await row('New chat').count()) === 1 && await row('New chat').locator('.chat-open').getAttribute('aria-current') === 'true', 'a new chat must open at once');
  assert.equal(await page.locator('.empty').evaluate(element => getComputedStyle(element).visibility), 'visible', 'an empty chat shows the greeting');
  assert.equal(await page.locator('dialog[open], form').count(), 0, 'a new chat asks for nothing');
  await shoot('1280-2-new-chat.png');
  await page.locator('#field').fill('Which sails do I need for a gusty day');
  await page.locator('#send').click();
  await until(async () => (await row('Which sails do I need').count()) === 1, 'the chat must take its title from the first message');
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send', 'the reply must end');

  // Rename in place.
  const target = page.locator(`.chat-row[data-chat-id="${taxes.id}"]`);
  await target.hover();
  await target.getByRole('button', { name: 'Rename Taxes' }).click();
  await target.locator('.chat-rename').fill('Tax return 2026');
  await shoot('1280-3-rename.png');
  await target.locator('.chat-rename').press('Enter');
  await until(async () => (await get('/api/chats')).some(chat => chat.title === 'Tax return 2026'), 'the new title must be saved');
  await until(async () => (await row('Tax return 2026').count()) === 1, 'the row must show the new title');

  // Delete asks a second tap on the same row.
  const doomed = page.locator(`.chat-row[data-chat-id="${taxes.id}"]`);
  await doomed.hover();
  await doomed.getByRole('button', { name: 'Delete Tax return 2026', exact: true }).click();
  assert.equal((await get('/api/chats')).length, 5, 'one tap deletes nothing');
  await shoot('1280-4-delete-confirm.png');
  await doomed.getByRole('button', { name: /for good/ }).click();
  await until(async () => (await row('Tax return 2026').count()) === 0, 'the second tap must delete the chat');
  assert.equal((await get('/api/chats')).length, 4);

  // Deleting the open chat shows the main chat.
  await row('Which sails do I need').locator('.chat-delete').click();
  await row('Which sails do I need').locator('.chat-delete').click();
  await until(async () => await row('Main chat').locator('.chat-open').getAttribute('aria-current') === 'true', 'the main chat must show when the open chat is gone');

  // The phone: nothing overflows, with a long message that has no break and a long title.
  await page.setViewportSize({ width: 390, height: 844 });
  await send(objectiveChat.id, 'Which crew members have confirmed?');
  await until(async () => (await row('Sail the Solent').locator('.badge').count()) === 1, 'a reply raises the badge on the phone');
  const longTitle = 'T'.repeat(80);
  const long = (await get('/api/chats')).find(chat => chat.title === 'Boat trip');
  assert.ok((await context.request.patch(origin + '/api/chats/' + long.id, { ...write, data: { title: longTitle } })).ok());
  await until(async () => (await row(longTitle).count()) === 1, 'the long title must reach the list');
  await row(longTitle).locator('.chat-open').click();
  await until(async () => (await page.locator('#rows').innerText()).includes('book the marina'), 'the chat must open');
  await page.locator('#field').fill('U'.repeat(300));
  await page.locator('#send').click();
  await until(async () => await page.locator('#send').getAttribute('aria-label') === 'Send' && (await page.locator('#rows .row-user').count()) >= 2, 'the long message must be sent and answered');
  assert.ok(await overflow() <= 0, 'the page must not scroll sideways at 390 px');
  const widths = await page.evaluate(() => {
    const thread = document.querySelector('#thread').getBoundingClientRect();
    return [...document.querySelectorAll('#rows .row-user .bubble')].map(bubble => ({ right: bubble.getBoundingClientRect().right, width: bubble.getBoundingClientRect().width, thread: thread.width, threadRight: thread.right }));
  });
  assert.ok(widths.length > 0 && widths.every(item => item.width <= item.thread && item.right <= item.threadRight), `the user's bubble must fit the thread: ${JSON.stringify(widths)}`);
  await open();
  assert.ok(await overflow() <= 0, 'the open drawer must not scroll the page sideways');
  assert.equal(await page.locator('#chat-title').textContent(), longTitle, 'the open chat is named above its thread');
  const rowBox = await row(longTitle).boundingBox(), drawerBox = await page.locator('#drawer').boundingBox();
  assert.ok(rowBox.x + rowBox.width <= drawerBox.x + drawerBox.width, 'a long title stays inside its row');
  await shoot('390-1-list-with-unread.png');

  await row('Sail the Solent').locator('.chat-open').click();
  await until(async () => (await page.locator('#rows .row').first().innerText()).includes('Sail the Solent'), 'the objective chat must open on the phone');
  await shoot('390-5-objective-chat.png');
  await open();
  await page.locator('#new-chat').click();
  await until(async () => (await page.locator('.chat-row[data-kind="topic"]').first().locator('.chat-open').getAttribute('aria-current')) === 'true', 'a new chat opens on the phone');
  await shoot('390-2-new-chat.png');
  await open();
  const here = page.locator(`.chat-row[data-chat-id="${(await get('/api/chats')).find(chat => chat.title === 'New chat').id}"]`);
  await here.getByRole('button', { name: /^Rename/ }).click();
  await here.locator('.chat-rename').fill('Weekend plans');
  await shoot('390-3-rename.png');
  await here.locator('.chat-rename').press('Enter');
  await until(async () => (await get('/api/chats')).some(chat => chat.title === 'Weekend plans'), 'the rename must save on the phone');
  assert.ok(await overflow() <= 0);

  // On a touch screen nothing hovers, so rename and delete must be on every row, beside a readable badge.
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  touch.setDefaultTimeout(15000);
  const phone = await touch.newPage();
  await send(objectiveChat.id, 'Any news on the crew?');
  await send(long.id, 'Anything else for the trip?');
  await signIn(phone, origin);
  await phone.locator('#loading').waitFor({ state: 'detached' });
  await phone.locator('#jet-toggle').tap();
  await until(async () => (await phone.locator('.chat-row .badge').count()) === 2, 'the badges must show on the touch phone');
  const rows = await phone.locator('.chat-row').count();
  assert.equal(await phone.locator('.chat-row .chat-action:visible').count(), 2 * rows - 1, 'every row has rename, every row but main has delete');
  const sail = phone.locator(`.chat-row[data-chat-id="${objectiveChat.id}"]`);
  await sail.getByRole('button', { name: /^Delete/ }).tap();
  assert.equal(await sail.getByRole('button', { name: /for good/ }).isVisible(), true);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the touch drawer fits 390 px');
  await delay(500);
  await phone.screenshot({ path: path.join(screens, '390-4-delete-confirm.png'), animations: 'disabled' });
  await touch.close();
  assert.deepEqual(errors, []);
  for (const call of chatCalls.filter(call => /\/api\/chat\/(send|stop|react|forget)/.test(call))) assert.match(call, /\?chat=\d+$/, 'every call of a chat carries its id');
  console.log('PASS chats_badges_open_rename_delete_and_phone_fit');
  console.log('Screenshots: ' + screens);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(screens, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  if (!process.env.SCREENSHOT_DIR) await rm(scratch, { recursive: true, force: true });
}
