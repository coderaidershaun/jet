// Drives the plan pane against the real host: it seeds a user's objectives, Jet's checks and a colleague's
// shared objective through the provider stand-in and rows in the database, then reads the pane at a glance, opens
// a check-in from its run, taps steps, a snooze, a failed tap and a two-tap cancel by pointer and by keyboard, adds
// a person to a share, works the pane as a dialog below 1024 px, and checks that nothing is wider than the window.
// It takes the screenshots.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-plan-'));
const screens = process.env.SCREENSHOT_DIR ?? path.join(scratch, 'screens');
await mkdir(screens, { recursive: true });
const processes = createProcesses();
const OWNER = 'shaunsurfing@gmail.com', MANAGER = 'admin123@gmail.com', OUTSIDER = 'admin3@gmail.com', ZONE = 'Europe/London';
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
    { type: 'system', subtype: 'init', session_id: 'plan-fixture', model: 'claude-fake' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'plan-fixture', duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {} },
  ]) console.log(JSON.stringify(event));
}
`);
  await chmod(provider, 0o755);
  const origin = await processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  await saveOwnerSettings(origin, { model: 'sonnet', claudePath: provider, reducedMotion: true });

  // ---- Seed, through the real routes, as each person.
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
    return { get: (route) => call('GET', route), post: (route, body) => call('POST', route, body), put: (route, body) => call('PUT', route, body) };
  };
  const clock = (days, time) => {
    const day = new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: ZONE });
    return time ? `${day}T${time}` : day;
  };
  const turn = async (who, words, script) => {
    await rm(path.join(data, 'facade-results.json'), { force: true });
    await who.post('/api/chat/send', { requestId: 'r' + Math.random().toString(16).slice(2), clientId: 'seed', text: `${words}\nfacade:${JSON.stringify(script)}`, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First mate', notes: '' }, localTime: 'Friday', timeZone: ZONE, feeling: 'neutral' });
    await until(async () => {
      try { return JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8')).length === script.length; } catch { return false; }
    }, 'the scripted turn must finish: ' + words);
    const results = JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8'));
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    await delay(300);
  };
  const objectives = (command) => ({ tool: 'objectives_update', arguments: { command } });
  const tasks = (command) => ({ tool: 'tasks_update', arguments: { command } });
  const create = (command) => objectives({ action: 'create', sources: [{ kind: 'jet' }], chat: 'new', ...command });

  const owner = await as(OWNER), manager = await as(MANAGER);
  await turn(owner, 'I am building a kite and planning a party.', [
    create({ title: 'Ship the kite page', deliverable: 'A kite page that flies and takes orders', start: clock(-7), due: clock(9), steps: [{ title: 'Build the frame', due: clock(2) }, { title: 'Fly it in the park', due: clock(7) }, { title: 'Post the photos' }], check: { at: clock(1, '09:00'), why: 'see whether the frame is built' } }),
    create({ title: 'Plan the launch party', deliverable: 'A venue, a guest list and a cake', start: clock(-2), due: clock(2), steps: [{ title: 'Book the venue' }, { title: 'Send the invites' }], check: { at: clock(1, '08:30'), why: 'ask whether the venue is booked' } }),
    create({ chat: 'this', title: 'Tidy the old website', deliverable: 'Old pages removed', start: clock(-1), due: clock(5), steps: [{ title: 'Delete the old pages' }], check: { at: clock(2, '09:00'), why: 'see whether the old pages are gone' } }),
    create({ chat: 'this', title: 'Move flat', deliverable: 'Keys handed back', start: clock(-1), due: clock(6), steps: [], check: { at: clock(3, '09:00'), why: 'see whether the keys are back' } }),
    objectives({ action: 'close', id: 3, outcome: 'done' }),
    objectives({ action: 'close', id: 4, outcome: 'dropped' }),
    objectives({ action: 'step_tick', id: 1, step: 1 }),
    objectives({ action: 'note', id: 1, status: 'on track', moved: 'Frame is built', blockers: '', private: false }),
    objectives({ action: 'note', id: 1, status: 'at risk', moved: 'Doubt I can fly it before the weekend', blockers: 'wind', private: true }),
    objectives({ action: 'note', id: 2, status: 'on track', moved: 'Invites are drafted', blockers: '', private: false }),
    tasks({ action: 'schedule', objectiveId: 2, at: clock(2, '14:00'), why: 'ask who has replied to the invite' }),
    create({ chat: 'this', title: 'Write the newsletter', deliverable: 'November issue sent', start: clock(-4), due: clock(12), steps: [{ title: 'Pick three stories', due: clock(-1) }, { title: 'Send it', due: clock(10) }], check: { at: clock(4, '09:00'), why: 'see whether the stories are picked' } }),
    create({ chat: 'this', title: 'Renew the passport', deliverable: 'New passport in hand', start: clock(-1), due: clock(20), steps: [{ title: 'Book the photo', due: clock(0) }], check: { at: clock(5, '09:00'), why: 'ask whether the photo is booked' } }),
    tasks({ action: 'schedule', at: clock(3, '11:00'), why: 'ask how the move went' }),
  ]);
  const managerId = new DatabaseSync(path.join(data, 'jet.sqlite3')).prepare('SELECT id FROM users WHERE email = ?').get(MANAGER).id;
  const ownerId = new DatabaseSync(path.join(data, 'jet.sqlite3')).prepare('SELECT id FROM users WHERE email = ?').get(OWNER).id;
  await turn(manager, 'I am hiring.', [create({ title: 'Hire a designer', deliverable: 'A signed offer', start: clock(-3), due: clock(21), steps: [{ title: 'Write the brief' }, { title: 'Interview three people' }], check: { at: clock(1, '10:00'), why: 'ask how the brief is going' } }), objectives({ action: 'note', id: 7, status: 'on track', moved: 'Brief is with HR', blockers: '', private: false })]);
  for (const [who, objective, to] of [[owner, 1, managerId], [manager, 7, ownerId]]) {
    const card = await who.post(`/api/objectives/${objective}/share-proposals`, { people: [to], teams: [] });
    await who.post(`/api/shares/proposals/${card.id}/apply`, { people: [to], teams: [] });
  }
  // Runs that Jet's scheduler will leave (inserted oldest first, as the newest has the highest id) once it runs checks: one wrote, one stayed quiet, one could not read a source, and older ones.
  const db = new DatabaseSync(path.join(data, 'jet.sqlite3'));
  db.exec('PRAGMA busy_timeout = 5000');
  // Nothing sets a default time yet, so the second task is marked as one the server chose.
  db.exec("UPDATE agent_tasks SET set_by = 'default', kind = 'follow_up' WHERE id = 2");
  const now = Math.floor(Date.now() / 1000);
  // The check that wrote posted into the kite page's chat, and the user put a reaction on it.
  const checkIn = db.prepare("SELECT e.chat_id AS chat, e.id AS entry FROM entries e JOIN objectives o ON o.chat_id = e.chat_id WHERE o.id = 1 AND json_extract(e.entry, '$.role') = 'jet' ORDER BY e.id LIMIT 1").get();
  db.prepare(`UPDATE entries SET entry = json_set(entry, '$.reactions', json('[{"emoji":"👍","by":"user","at":${now * 1000}}]')) WHERE chat_id = ? AND id = ?`).run(checkIn.chat, checkIn.entry);
  const run = db.prepare('INSERT INTO task_runs (task_id, started_at, ended_at, outcome, found, sources_read, tokens, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const runs = [
    [1, now - 2 * 3600, 'spoke', 'The frame is built but the glue has not set; asked how the weekend looks', '["github octo/kite","jet notes"]', 1840, checkIn.entry],
    [7, now - 26 * 3600, 'silent', 'Nothing new since the last note; the invites were sent yesterday', '["jet notes"]', 620],
    [1, now - 50 * 3600, 'held', 'held: source unavailable', '["github octo/kite"]', 310],
    [2, now - 3 * 86400, 'preempted', '', '[]', 90],
    [1, now - 4 * 86400, 'stale', '', '[]', 0],
    [2, now - 5 * 86400, 'failed', 'The provider stopped answering', '[]', 40],
  ];
  for (const [task, started, outcome, found, sources, tokens, entry = null] of runs.toReversed()) run.run(task, started, started + 60, outcome, found, sources, tokens, entry);
  db.close();

  // ---- The browser.
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const errors = [];
  const open = async (email, viewport, extra = {}) => {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...extra });
    context.setDefaultTimeout(15000);
    const next = await context.newPage();
    next.on('pageerror', (error) => errors.push(String(error)));
    await next.goto(origin);
    await next.locator('#signin[data-state="ready"]').waitFor();
    await next.fill('#email', email);
    await next.fill('#password', '000111');
    await next.press('#password', 'Enter');
    await next.waitForURL((url) => url.pathname === '/');
    await next.locator('#loading').waitFor({ state: 'detached' });
    return { context, page: next };
  };
  const wide = (p) => p.evaluate(() => {
    const out = [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && el.offsetParent !== null && !el.classList.contains('sr-only') && getComputedStyle(el).position !== 'fixed' && (r.right > innerWidth + 0.5 || r.left < -0.5); });
    return { scroll: document.documentElement.scrollWidth - innerWidth, wide: out.slice(0, 5).map((el) => el.className || el.tagName) };
  });
  const noOverflow = async (p, note) => { const { scroll, wide: found } = await wide(p); assert.equal(scroll, 0, `${note}: the page scrolls sideways`); assert.deepEqual(found, [], `${note}: elements wider than the window`); };
  const shoot = async (p, name) => { await delay(400); await p.screenshot({ path: path.join(screens, `pane-${name}.png`), animations: 'disabled' }); };
  /** Whether the element lies wholly inside the pane's visible part. */
  const inPane = (locator) => locator.evaluate((el) => { const pane = document.getElementById('side-pane').getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top >= pane.top && r.bottom <= pane.bottom; });
  const focusKey = (p) => p.evaluate(() => document.activeElement?.dataset.key ?? document.activeElement?.tagName);
  const unfold = async (p, id) => {
    const summary = p.locator(`.objective[data-id="${id}"] .objective-summary`);
    if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click();
    await p.locator(`.objective[data-id="${id}"] .objective-body`).waitFor();
  };
  const taskTime = (p, id) => p.locator(`.task[data-id="${id}"] .task-time`).innerText();

  /** The checks both widths share: the glance, a run's check-in, taps by pointer and keyboard, a failed tap, a two-tap cancel and a share. */
  async function exercise(p, width) {
    const pane = p.locator('#side-pane');
    await p.locator('.objective').first().waitFor();
    assert.equal(await p.locator('.objective').count(), 4, 'four active objectives');
    assert.equal(await p.locator('.objective[data-open="true"]').count(), 1, 'one objective starts open, the others are folded to their summary');
    for (const summary of await p.locator('.objective-summary').all()) assert.match(await summary.innerText(), /Next check|No check is set/, 'each summary says when Jet looks in next');
    assert.match(await p.locator('.objective[data-id="1"] .objective-summary').innerText(), /at risk[\s\S]*1 of 3 steps/, 'the summary has the latest status and the progress');
    assert.ok(await inPane(p.locator('.pane-heading', { hasText: 'Objectives' })), 'the objectives start in the first screen');
    await shoot(p, `${width}-01-top`);
    await p.locator('.tile', { hasText: 'Next check' }).click();
    assert.ok(await inPane(p.locator('.pane-heading', { hasText: "Jet's plan" })), "one tap on a tile shows Jet's plan");
    await p.locator('.tile', { hasText: 'Last check' }).click();
    const firstRun = p.locator('.run').first();
    assert.ok(await inPane(firstRun), 'one tap on a tile shows the first recent check');
    assert.equal(await firstRun.locator('.run-title').innerText(), 'Ship the kite page', 'a run names its objective');
    assert.match(await firstRun.innerText(), /Seen 👍/, 'the reaction on the check-in shows');
    assert.match(await p.locator('.run[data-outcome="silent"] .run-title').innerText(), /^Follow-up: /, 'a follow-up says why');
    assert.equal(await p.locator('.run[data-outcome="stale"] .run-cost').count(), 0, 'a free check says nothing about cost');
    await shoot(p, `${width}-02-recent-checks`);

    // Jet's plan: the snooze button says where the check lands, a failed tap leaves its notice, Cancel takes two taps.
    const snooze = p.locator('.task[data-id="1"]').getByRole('button', { name: /^Snooze to / });
    const landing = (await snooze.innerText()).replace('Snooze to ', '');
    assert.match(landing, /08:00$/);
    await snooze.focus();
    await p.keyboard.press('Enter');
    await until(async () => (await taskTime(p, 1)) === landing, 'the check lands where the button said');
    assert.equal(await focusKey(p), 'snooze-1', 'after Enter on Snooze the focus stays on it');
    await p.route('**/api/tasks/*/snooze', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ kind: 'internal', message: 'the store is busy' }) }), { times: 1 });
    await p.locator('.task[data-id="5"]').getByRole('button', { name: /^Snooze/ }).click();
    const alert = p.locator('.pane-alert');
    await until(async () => (await alert.innerText()) === 'The check could not be snoozed. The store is busy. Try again.', 'a failed tap says so in plain words');
    await owner.put('/api/objectives/2/steps/5', { done: width === 1440 });
    await until(async () => (await p.locator('.objective[data-id="2"] .progress-words').innerText()) === `${width === 1440 ? 1 : 0} of 2 steps`, 'the pane is read again');
    assert.equal(await alert.isVisible(), true, 'the notice stays through the re-read');
    await p.locator('.task[data-id="5"]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shoot(p, `${width}-03-tap-failed`);
    // The passport's check at 1440 px, the newsletter's at 390 px.
    const doomed = p.locator(`.task[data-id="${width === 1440 ? 6 : 5}"]`);
    await doomed.getByRole('button', { name: 'Cancel' }).click();
    await doomed.getByRole('button', { name: 'Tap again to cancel' }).waitFor();
    assert.equal(await doomed.count(), 1, 'the first tap cancels nothing');
    await shoot(p, `${width}-04-cancel-armed`);
    await doomed.getByRole('button', { name: 'Tap again to cancel' }).click();
    await until(async () => (await doomed.count()) === 0, 'the second tap cancels the check');
    assert.equal(await alert.isVisible(), false, 'a tap that worked clears the notice');
    assert.match(await focusKey(p), /^(snooze-\d+|heading-plan)$/, 'after Cancel the focus goes to the next check');
    await p.locator('.objective[data-id="6"]').scrollIntoViewIfNeeded();
    assert.match(await p.locator('.objective[data-id="6"] .objective-check').innerText(), /No check is set/, 'an objective with no check says so');
    await shoot(p, `${width}-05-no-check`);

    // Steps: a late step and today's step say so; Space ticks and keeps the focus.
    await unfold(p, 5);
    assert.match(await p.locator('.objective[data-id="5"] .step-due[data-tone="bad"]').innerText(), /late$/, 'a passed step is late');
    await unfold(p, 6);
    assert.equal(await p.locator('.objective[data-id="6"] .step-due[data-tone="warn"]').innerText(), 'Today');
    const step = p.locator('.objective[data-id="6"] .step').first();
    const stepKey = await step.getAttribute('data-key');
    await step.focus();
    await p.keyboard.press('Space');
    await until(async () => (await p.locator(`[data-key="${stepKey}"]`).getAttribute('aria-checked')) === 'true', 'Space ticks the step');
    await delay(300);
    assert.equal(await focusKey(p), stepKey, 'after Space the focus is still on the step');
    await shoot(p, `${width}-06-step-focus`);
    await p.keyboard.press('Space');
    await until(async () => (await p.locator(`[data-key="${stepKey}"]`).getAttribute('aria-checked')) === 'false', 'Space unticks it');

    // Sharing: the card lists the directory, and the owner's tap adds a person.
    await unfold(p, 1);
    await p.locator('.objective[data-id="1"]').getByRole('button', { name: 'Change who sees it' }).click();
    const card = p.locator('.objective[data-id="1"] .card-share');
    await card.waitFor();
    assert.ok(await card.locator('.share-row').count() >= 4, 'the card lists the people and teams of the directory');
    assert.equal(await card.locator('.share-go').isDisabled(), true, 'with nothing changed the button does nothing');
    const person = width === 1440 ? 'Admin 1' : 'Admin 2';
    await card.locator('.share-row', { hasText: new RegExp(`^${person}$`, 'm') }).first().locator('.share-box').focus();
    await p.keyboard.press('Space');
    await owner.put('/api/objectives/2/steps/5', { done: width !== 1440 });
    await until(async () => (await p.locator('.objective[data-id="2"] .progress-words').innerText()) === `${width === 1440 ? 0 : 1} of 2 steps`, 'the pane is drawn again');
    assert.equal(await p.evaluate(() => document.activeElement.classList.contains('share-box')), true, 'the focus stays on the tick through a redraw');
    assert.equal(await card.locator('.share-go').innerText(), 'Share');
    await card.scrollIntoViewIfNeeded();
    await shoot(p, `${width}-07-share-directory`);
    await card.locator('.share-go').click();
    await card.locator('.share-done').waitFor();
    await until(async () => (await owner.get('/api/pane')).objectives.find((o) => o.id === 1).sharedWith.people.some((who) => who.name === person), 'the tap shares with the added person');
    await p.locator('.objective[data-id="1"]').getByRole('button', { name: 'Close' }).click();

    // The run's control opens its chat at the check-in.
    await p.locator('.tile', { hasText: 'Last check' }).click();
    await p.locator('.run').first().getByRole('button', { name: 'Open check-in' }).click();
    await until(async () => (await p.locator('.chat-head').innerText()).includes('Ship the kite page'), 'the check-in opens its chat');
    await p.locator('.row.is-marked').waitFor();
    await shoot(p, `${width}-08-check-in-opened`);
    if (width !== 1440) assert.equal(await pane.isHidden(), true, 'below 1024 px the pane steps aside for the chat');
    await noOverflow(p, `${width}`);
  }

  // Desktop, 1440 x 900: the pane is a column.
  const desk = await open(OWNER, { width: 1440, height: 900 });
  page = desk.page;
  const pane = page.locator('#side-pane');
  await pane.waitFor({ state: 'visible' });
  const columns = await page.locator('.workspace-shell').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' '));
  assert.ok(parseFloat(columns[2]) >= 320, 'the pane has its own column on a desktop window');
  assert.equal(await pane.getAttribute('role'), null, 'a column is not a dialog');
  await exercise(page, 1440);
  await page.locator('.closed > summary').click();
  assert.match(await page.locator('.closed-row[data-status="done"] .closed-due').innerText(), /^Closed /, 'a done objective shows the day it closed');
  // Close the column, reload, and it stays closed; open it, reload, and it stays open.
  await page.locator('.pane-close').click();
  assert.equal(await pane.isHidden(), true);
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'detached' });
  assert.equal(await pane.isHidden(), true, 'a closed pane stays closed after a reload');
  await page.locator('.pane-toggle').click();
  await pane.waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'detached' });
  assert.equal(await pane.isVisible(), true, 'an open pane stays open after a reload');
  await desk.context.close();

  // Tablet, 768 px: the pane is a dialog beside the drawer's rail, the page behind is inert, the scrim closes it.
  const tablet = await open(OWNER, { width: 768, height: 900 });
  page = tablet.page;
  await page.locator('.pane-toggle').click();
  await page.locator('#side-pane').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#side-pane').getAttribute('role'), 'dialog');
  assert.equal(await page.locator('#side-pane').getAttribute('aria-modal'), 'true');
  assert.equal(parseFloat((await page.locator('.workspace-shell').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ')))[0]), 64, 'the drawer folds to its rail');
  assert.equal(await page.locator('#drawer').evaluate((el) => el.inert), true, 'the page behind is inert');
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => document.getElementById('side-pane').contains(document.activeElement)), true, `Tab ${i + 1} stays in the pane`);
  }
  await shoot(page, '768-01-dialog');
  await page.mouse.click(200, 450);
  await until(async () => page.locator('#side-pane').isHidden(), 'a tap on the scrim closes the pane');
  assert.equal(await page.locator('#drawer').evaluate((el) => el.inert), false, 'the page behind works again');
  assert.equal(await focusKey(page), 'BUTTON', 'the focus goes back to the Plan button');
  await tablet.context.close();

  // Phone, 390 px: the pane is a dialog over the whole chat.
  const phone = await open(OWNER, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  page = phone.page;
  assert.equal(await page.locator('.pane-toggle').innerText(), 'Plan', 'the control says Plan; nothing new since the last look');
  await page.locator('.pane-toggle').tap();
  await page.locator('#side-pane').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#side-pane').evaluate((el) => el.getBoundingClientRect().width), 390, 'the pane lies over the whole chat');
  assert.equal(await page.locator('#side-pane').getAttribute('role'), 'dialog');
  await exercise(page, 390);
  await phone.context.close();

  await owner.put('/api/objectives/1/notes/2', { private: true });
  // The manager reads what the owner shared; the outsider has an empty pane whose example starts a message.
  for (const [view, name] of [[{ width: 1440, height: 900 }, '1440'], [{ width: 390, height: 844 }, '390']]) {
    const mgr = await open(MANAGER, view, name === '390' ? { hasTouch: true, isMobile: true } : {});
    if (name === '390') await mgr.page.locator('.pane-toggle').tap();
    await mgr.page.locator('.shared').waitFor();
    assert.equal(await mgr.page.locator('.shared').count(), 1);
    assert.match(await mgr.page.locator('.shared').innerText(), /Ship the kite page/);
    assert.equal(await mgr.page.locator('.shared .step-box').count(), 0, "a colleague's steps are not tick boxes");
    assert.doesNotMatch(await mgr.page.locator('#side-pane').innerText(), /Doubt I can fly|wind/, 'a private note never reaches a colleague');
    await mgr.page.locator('.pane-heading', { hasText: 'Shared with you' }).scrollIntoViewIfNeeded();
    await shoot(mgr.page, `${name}-09-manager-shared`);
    await noOverflow(mgr.page, `${name} manager`);
    await mgr.context.close();
    const out = await open(OUTSIDER, view, name === '390' ? { hasTouch: true, isMobile: true } : {});
    if (name === '390') await out.page.locator('.pane-toggle').tap();
    await out.page.locator('.invite').waitFor();
    assert.equal(await out.page.locator('.pane-body input, .pane-body textarea, .pane-body form').count(), 0, 'the empty pane has no form');
    await shoot(out.page, `${name}-10-empty`);
    await out.page.locator('.invite-example').click();
    await until(async () => (await out.page.locator('#field').inputValue()) === 'I need to ship the kite page by Friday.', 'the example goes into the message box');
    assert.equal(await out.page.evaluate(() => document.activeElement.id), 'field');
    await noOverflow(out.page, `${name} empty`);
    await out.context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS plan_pane_glance_checkins_taps_dialog_share_and_fit');
  console.log('Screenshots: ' + screens);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(screens, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  if (!process.env.SCREENSHOT_DIR) await rm(scratch, { recursive: true, force: true });
}
