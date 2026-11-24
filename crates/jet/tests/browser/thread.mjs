// Drives the thread against the real host with the provider stand-in: a turn that records two objectives
// folds into one plain line, a send card draws no "null", a reply to a colleague waits for the user's tap and
// then shows what was sent, a check-in Jet wrote by itself wears its label, the message box has the focus on load
// and the skip link reaches it from a cold Tab, and on a 390 px touch phone the thread takes the whole width, the
// chats open from the head over a scrim, and the reaction chooser fits the screen. No element is wider than the
// window at any width. It takes the screenshots.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, signIn, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-thread-'));
const screens = process.env.SCREENSHOT_DIR ?? path.join(scratch, 'screens');
await mkdir(screens, { recursive: true });
const processes = createProcesses();
const OWNER = 'shaunsurfing@gmail.com', MANAGER = 'admin123@gmail.com', ZONE = 'Europe/London';
const REPLY = 'Got it. I will keep that in mind and look in on the plan tomorrow morning, to see how the frame is coming along and whether the weekend still works.';
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
  const text = 'mood: warm\\n' + ${JSON.stringify(REPLY)};
  for (const event of [
    { type: 'system', subtype: 'init', session_id: 'thread-fixture', model: 'claude-fake' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'thread-fixture', duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {} },
  ]) console.log(JSON.stringify(event));
}
`);
  await chmod(provider, 0o755);
  const origin = await processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  await saveOwnerSettings(origin, { model: 'sonnet', claudePath: provider, reducedMotion: true });

  const as = async (email) => {
    const signedIn = await fetch(origin + '/api/auth/signin', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: '000111' }) });
    assert.equal(signedIn.status, 200, `${email} could not sign in`);
    const cookie = signedIn.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    const call = async (method, route, body) => {
      const response = await fetch(origin + route, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      assert.ok(response.ok, `${method} ${route}: ${text}`);
      return text ? JSON.parse(text) : null;
    };
    return { get: (route) => call('GET', route), post: (route, body) => call('POST', route, body) };
  };
  const day = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: ZONE });
  const settled = async (who) => until(async () => !(await who.get('/api/snapshot')).active, 'the reply must finish');
  const turn = async (who, words, script) => {
    await rm(path.join(data, 'facade-results.json'), { force: true });
    await who.post('/api/chat/send', { requestId: 'r' + Math.random().toString(16).slice(2), clientId: 'seed', text: `${words}\nfacade:${JSON.stringify(script)}`, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First mate', notes: '' }, localTime: 'Tuesday', timeZone: ZONE, feeling: 'neutral' });
    await until(async () => {
      try { return JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8')).length === script.length; } catch { return false; }
    }, 'the scripted turn must finish: ' + words);
    const results = JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8'));
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    await settled(who);
    return results.map((result) => result.structuredContent);
  };
  const objectives = (command) => ({ tool: 'objectives_update', arguments: { command } });
  const tasks = (command) => ({ tool: 'tasks_update', arguments: { command } });

  // ---- Seed: two objectives in one turn, a colleague's question and the owner's reply card, a send card with no objective.
  const owner = await as(OWNER), manager = await as(MANAGER);
  const db = new DatabaseSync(path.join(data, 'jet.sqlite3'));
  db.exec('PRAGMA busy_timeout = 5000');
  const idOf = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  await turn(owner, 'I need to ship the kite page by the 3rd, and I am planning the launch party for Thursday.', [
    { tool: 'objectives_list', arguments: {} },
    objectives({ action: 'create', title: 'Ship the kite page', deliverable: 'A kite page that flies and takes orders', start: day(-7), due: day(9), steps: [{ title: 'Build the frame', due: day(2) }, { title: 'Fly it in the park', due: day(7) }, { title: 'Post the photos' }], sources: [{ kind: 'jet' }], check: { at: day(1) + 'T09:00', why: 'see whether the frame is built' }, chat: 'new' }),
    objectives({ action: 'create', title: 'Plan the launch party', deliverable: 'A venue, a guest list and a cake', start: day(-2), due: day(2), steps: [{ title: 'Book the venue' }, { title: 'Send the invites' }], sources: [{ kind: 'jet' }], check: { at: day(1) + 'T08:30', why: 'ask whether the venue is booked' }, chat: 'new' }),
    objectives({ action: 'step_tick', id: 1, step: 1 }),
    tasks({ action: 'schedule', objectiveId: 2, at: day(2) + 'T14:00', why: 'ask who has replied to the invite' }),
  ]);
  const [asked] = await turn(manager, 'Ask Shaun whether Friday works for the kite review.', [tasks({ action: 'send', to: idOf(OWNER), kind: 'question', text: 'Can you give me Friday for the kite review?' })]);
  const sentItem = await manager.post(`/api/inbox/cards/${asked.send.id}/send`, {});
  await settled(owner);
  const [proposed] = await turn(owner, 'Ask Admin 123 if the park needs a permit, and tell them Friday works.', [
    tasks({ action: 'send', to: idOf(MANAGER), kind: 'question', text: 'Does the park need a permit for a kite test flight?' }),
    tasks({ action: 'reply', item: sentItem.itemId, outcome: 'answered', text: 'Friday works, 10:00 in the park.' }),
  ]).then((results) => [results[1]]);
  assert.equal(proposed.reply.state, 'proposed', 'reply makes a card and sends nothing');
  assert.equal((await manager.get('/api/inbox/cards?ids=' + asked.send.id))[0].itemState !== 'answered', true, 'nothing reached the colleague before the tap');

  // A check-in Jet wrote by itself in the kite page's chat, as the scheduler leaves one.
  const kiteChat = (await owner.get('/api/chats')).find((chat) => chat.title === 'Ship the kite page').id;
  const last = db.prepare('SELECT id, entry FROM entries WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(kiteChat);
  const checkIn = { ...JSON.parse(last.entry), id: last.id + 1, role: 'jet', status: 'complete', mood: 'warm', text: 'Morning! I looked at the plan: the frame is ticked off. How did the first flight feel?', check: { task: 1, run: 1 }, at: Date.now() - 60000 };
  delete checkIn.tools;
  db.prepare('INSERT INTO entries (chat_id, id, entry) VALUES (?, ?, ?)').run(kiteChat, checkIn.id, JSON.stringify(checkIn));

  // ---- The browser, at 1440 px with a mouse.
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(15000);
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  const shoot = async (target, name) => { await delay(400); await target.screenshot({ path: path.join(screens, name), animations: 'disabled' }); };
  await signIn(page, origin);
  await page.locator('#loading').waitFor({ state: 'detached' });
  await until(async () => (await page.locator('.card-records').count()) === 1, 'the records calls must fold into one line');

  // The focus is in the message box, and from a cold Tab the skip link is the first stop and leads back to it.
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'field', 'the message box has the focus after load');
  // A cold Tab starts from the top of the document, as on a page nobody has touched yet.
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); });
  assert.equal(await page.evaluate(() => document.body.firstElementChild.id), 'skip', 'the skip link is the first thing in the page');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'skip', 'the first Tab stop is the skip link');
  await shoot(page, 'kbd-1440-01-skip-link.png');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'field', 'the skip link leads to the message box');

  // The reaction controls are out of the Tab order; from the thread an arrow key reaches a message, Tab its control,
  // the arrows move between the picks, and Escape gives the focus back to the control.
  assert.ok(await page.evaluate(() => document.querySelectorAll('.react-open:not([tabindex="-1"])').length <= 1), 'at most one reaction control is a Tab stop');
  await page.locator('#thread').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.matches('.row-jet .bubble')), true, 'an arrow key moves to a Jet message');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'react-open', 'Tab reaches that message\'s reaction control');
  await page.keyboard.press('Enter');
  await page.locator('.react-chooser').waitFor();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'React with ❤️', 'the arrows move between the picks');
  await shoot(page, 'kbd-1440-02-chooser-by-keyboard.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.react-chooser').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.className), 'react-open', 'Escape gives the focus back to the control');

  // Plain words, folded: no machine names, no JSON, no time under a second.
  const records = page.locator('.card-records');
  assert.equal((await records.locator('summary').first().innerText()).trim(), 'Jet updated your plan · 4 changes');
  await records.locator('summary').first().click();
  const lines = await records.locator('.records-list .card-name').allInnerTexts();
  assert.deepEqual(lines.slice(0, 4), ['Read your objectives', 'Recorded Ship the kite page', 'Recorded Plan the launch party', 'Ticked Build the frame']);
  assert.match(lines[4], /^(Set|Moved) the? ?check (for|to) \w{3} \d{1,2} \w{3}, 14:00$/);
  await records.locator('.records-list details').nth(1).locator('summary').click();
  const opened = await records.locator('.records-list details').nth(1).innerText();
  assert.doesNotMatch(opened, /[{}"]|objectives_update|\d{10}/, 'an opened card is fields, not JSON');
  assert.doesNotMatch((await page.locator('#rows .row-jet').allInnerTexts()).join('\n'), /jet · |objectives_update|\b0\.0 s\b/);
  await records.scrollIntoViewIfNeeded();
  await shoot(page, 'thread-1440-01-plain-records.png');

  // The send card draws nothing where an objective would be named, and the reply card shows the recipient and the words.
  const sendCard = page.locator('.card-send.card-send').filter({ hasText: 'Question for Admin 123' });
  assert.doesNotMatch(await sendCard.innerText(), /null/);
  const replyCard = page.locator('.card-reply');
  assert.match(await replyCard.innerText(), /Reply to Admin 123[\s\S]*Answers their question[\s\S]*Friday works, 10:00 in the park\.[\s\S]*Nothing goes until you tap Send/);
  await replyCard.scrollIntoViewIfNeeded();
  await shoot(page, 'thread-1440-02-reply-card-before.png');
  await replyCard.getByRole('button', { name: 'Send to Admin 123' }).click();
  await until(async () => (await replyCard.getAttribute('data-state')) === 'sent', 'the tap must send the reply');
  assert.match(await replyCard.innerText(), /Sent to Admin 123 · you answered it/);
  assert.equal((await manager.get('/api/inbox/cards?ids=' + asked.send.id))[0].itemState, 'answered', 'the tap reached the colleague');
  await shoot(page, 'thread-1440-03-reply-card-after.png');

  // The send card follows its item with no reload: the colleague's Jet brings it up once it is sent.
  await sendCard.getByRole('button', { name: 'Send to Admin 123' }).click();
  await until(async () => /Sent to Admin 123/.test(await sendCard.innerText()), 'the send card must show it went');
  await page.evaluate(() => { window.sameDocument = true; });
  await until(async () => /Admin 123's Jet has brought it up/.test(await sendCard.innerText()), 'the card follows the item when the colleague\'s Jet brings it up');
  assert.equal(await page.evaluate(() => window.sameDocument), true, 'with no reload');
  await sendCard.scrollIntoViewIfNeeded();
  await shoot(page, 'thread-1440-04-send-card-no-null.png');

  // A check-in in another chat: the tab title counts it, and its chat shows the label above the bubble.
  await until(async () => /^\(\d+\) Jet$/.test(await page.title()), 'the tab title must carry the unread count');
  await page.locator('.chat-row', { hasText: 'Ship the kite page' }).locator('.chat-open').click();
  const label = page.locator('.checkin-label:visible');
  await label.waitFor();
  assert.match(await label.innerText(), /^Check-in · Today, \d{2}:\d{2}$/);
  await shoot(page, 'thread-1440-05-check-in-label.png');

  // A short drop of the stream, with the server still up, shows the connection banner, and the banner goes once the
  // stream is back: the server resumes it with the missed events and sends no snapshot. A raw TCP proxy in front of
  // the host lets the script cut the page's sockets.
  const upstream = new URL(origin);
  const sockets = new Set();
  const proxy = net.createServer((client) => {
    const server = net.connect(Number(upstream.port), upstream.hostname);
    sockets.add(client); sockets.add(server);
    client.pipe(server); server.pipe(client);
    const end = () => { client.destroy(); server.destroy(); sockets.delete(client); sockets.delete(server); };
    for (const socket of [client, server]) { socket.on('error', end); socket.on('close', end); }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const front = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  front.setDefaultTimeout(15000);
  const dropped = await front.newPage();
  dropped.on('pageerror', (error) => errors.push(String(error)));
  await signIn(dropped, `http://127.0.0.1:${proxy.address().port}`);
  await dropped.locator('#loading').waitFor({ state: 'detached' });
  await dropped.evaluate(() => { window.sameDocument = true; });
  for (const socket of sockets) socket.destroy();
  await until(async () => /Waiting for the connection/.test(await dropped.locator('#banner').innerText()), 'a dropped stream shows the banner');
  await until(async () => (await dropped.locator('#banner').innerText()).trim() === '', 'the banner goes when the stream is back');
  assert.equal(await dropped.evaluate(() => window.sameDocument), true, 'with no reload');
  await front.close();
  proxy.close();

  // ---- No element is wider than the window at any width.
  for (const width of [320, 390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await delay(300);
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().width > innerWidth + 0.5).map((el) => el.tagName + '.' + el.className));
    assert.deepEqual(wide, [], `nothing is wider than the window at ${width} px`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `the page does not scroll sideways at ${width} px`);
  }

  // ---- A 390 px phone with touch.
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  touch.setDefaultTimeout(15000);
  const phone = await touch.newPage();
  phone.on('pageerror', (error) => errors.push(String(error)));
  await signIn(phone, origin);
  await phone.locator('#loading').waitFor({ state: 'detached' });
  await phone.locator('#rows .row-jet').last().waitFor();
  assert.equal(await phone.locator('#drawer').isVisible(), false, 'on a phone the thread has the whole width');
  const bubbles = await phone.locator('#rows .row-jet .bubble').evaluateAll((list) => list.map((el) => el.getBoundingClientRect().width));
  assert.ok(Math.max(...bubbles) >= 300, `a Jet bubble is at least 300 px wide: ${bubbles}`);
  await shoot(phone, 'phone-390-01-thread-full-width.png');
  const folded = phone.locator('.card-records');
  await folded.scrollIntoViewIfNeeded();
  await folded.locator('summary').first().tap();
  await shoot(phone, 'thread-390-01-plain-records.png');

  // The chats open from the head, over a scrim that closes them.
  const chatsButton = phone.locator('.chats-toggle');
  assert.match(await chatsButton.getAttribute('aria-label'), /^Chats/);
  await chatsButton.tap();
  await phone.locator('#drawer .chat-row').first().waitFor();
  await shoot(phone, 'phone-390-02-chats-open.png');
  await phone.locator('.drawer-scrim').tap({ position: { x: 370, y: 400 } });
  await until(async () => !(await phone.locator('#drawer').isVisible()), 'a tap on the scrim closes the chats');

  // A long press on a Jet bubble opens the chooser inside the screen, and its last control can be tapped.
  const bubble = phone.locator('#rows .row-jet .bubble').last();
  await bubble.scrollIntoViewIfNeeded();
  const box = await bubble.boundingBox();
  const cdp = await touch.newCDPSession(phone);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 30, y: box.y + box.height / 2 }] });
  await delay(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const chooser = phone.locator('.react-chooser');
  await chooser.waitFor();
  const edge = await chooser.evaluate((el) => ({ right: el.getBoundingClientRect().right, left: el.getBoundingClientRect().left, width: innerWidth }));
  assert.ok(edge.right <= edge.width && edge.left >= 0, `the chooser is inside the window: ${JSON.stringify(edge)}`);
  const more = phone.locator('.react-more');
  const reachable = await more.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.react-more') === el; });
  assert.ok(reachable, 'the last control of the chooser is on top where a finger lands');
  await shoot(phone, 'phone-390-03-react-chooser.png');
  await more.tap();
  assert.equal(await phone.locator('.react-field').isVisible(), true, 'the + opens the field for any emoji');
  await phone.keyboard.press('Escape');
  await chatsButton.tap();
  await phone.locator('.chat-row', { hasText: 'Ship the kite page' }).locator('.chat-open').tap();
  await phone.locator('.checkin-label:visible').waitFor();
  await shoot(phone, 'thread-390-05-check-in-label.png');
  await touch.close();

  assert.deepEqual(errors, []);
  console.log('PASS thread_plain_cards_reply_tap_check_in_keyboard_and_phone');
  console.log('Screenshots: ' + screens);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(screens, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  if (!process.env.SCREENSHOT_DIR) await rm(scratch, { recursive: true, force: true });
}
