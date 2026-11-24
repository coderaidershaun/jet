// Drives the plan pane against the real host: it seeds a user's objectives, Jet's checks and a colleague's
// shared objective through the provider stand-in and rows in the database, then taps a step, a snooze and a
// cancel, closes and reopens the desktop column across a reload, reads the phone button's count, and checks
// that a done objective sits collapsed and that nothing is wider than the window at 390 px. It takes the screenshots.
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
  ]);
  const managerId = new DatabaseSync(path.join(data, 'jet.sqlite3')).prepare('SELECT id FROM users WHERE email = ?').get(MANAGER).id;
  const ownerId = new DatabaseSync(path.join(data, 'jet.sqlite3')).prepare('SELECT id FROM users WHERE email = ?').get(OWNER).id;
  await turn(manager, 'I am hiring.', [create({ title: 'Hire a designer', deliverable: 'A signed offer', start: clock(-3), due: clock(21), steps: [{ title: 'Write the brief' }, { title: 'Interview three people' }], check: { at: clock(1, '10:00'), why: 'ask how the brief is going' } }), objectives({ action: 'note', id: 5, status: 'on track', moved: 'Brief is with HR', blockers: '', private: false })]);
  for (const [who, objective, to] of [[owner, 1, managerId], [manager, 5, ownerId]]) {
    const card = await who.post(`/api/objectives/${objective}/share-proposals`, { people: [to], teams: [] });
    await who.post(`/api/shares/proposals/${card.id}/apply`, { people: [to], teams: [] });
  }
  // Runs that Jet's scheduler will leave (inserted oldest first, as the newest has the highest id) once it runs checks: one wrote, one stayed quiet, one could not read a source, and older ones.
  const db = new DatabaseSync(path.join(data, 'jet.sqlite3'));
  db.exec('PRAGMA busy_timeout = 5000');
  // Nothing sets a default time yet, so the second task is marked as one the server chose.
  db.exec("UPDATE agent_tasks SET set_by = 'default', kind = 'follow_up' WHERE id = 2");
  const now = Math.floor(Date.now() / 1000);
  const run = db.prepare('INSERT INTO task_runs (task_id, started_at, ended_at, outcome, found, sources_read, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const runs = [
    [1, now - 2 * 3600, 'spoke', 'The frame is built but the glue has not set; asked how the weekend looks', '["github octo/kite","jet notes"]', 1840],
    [2, now - 26 * 3600, 'silent', 'Nothing new since the last note; the invites were sent yesterday', '["jet notes"]', 620],
    [1, now - 50 * 3600, 'held', 'held: source unavailable', '["github octo/kite"]', 310],
    [2, now - 3 * 86400, 'preempted', '', '[]', 90],
    [1, now - 4 * 86400, 'stale', '', '[]', 0],
    [2, now - 5 * 86400, 'failed', 'The provider stopped answering', '[]', 40],
  ];
  for (const [task, started, outcome, found, sources, tokens] of runs.toReversed()) run.run(task, started, started + 60, outcome, found, sources, tokens);
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
  const shoot = async (p, name) => { await delay(400); await p.screenshot({ path: path.join(screens, name), animations: 'disabled' }); };
  const toSection = async (p, title) => { await p.locator('.pane-heading', { hasText: title }).evaluate((el) => el.scrollIntoView({ block: 'start' })); await p.locator('#side-pane').evaluate((el) => { el.scrollTop -= 60; }); };

  // Desktop, 1280 px.
  const desk = await open(OWNER, { width: 1280, height: 900 });
  page = desk.page;
  const pane = page.locator('#side-pane');
  await pane.waitFor({ state: 'visible' });
  await page.locator('.objective').first().waitFor();
  const columns = await page.locator('.workspace-shell').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' '));
  assert.ok(parseFloat(columns[2]) >= 320, 'the pane has its own column on a desktop window');
  assert.equal(await page.locator('.objective').count(), 2, 'two active objectives');
  assert.equal(await page.locator('.objective[data-id="1"] .step').count(), 3);
  assert.equal(await page.locator('.objective[data-id="1"] .step[data-done="true"]').count(), 1);
  assert.match(await page.locator('.objective[data-id="1"] .objective-shared').innerText(), /Admin 123/, 'who the objective is shared with');
  assert.equal(await page.locator('.objective[data-id="1"] .note-flip[data-private="true"]').count(), 1, 'the newest note is private and shows its lock');
  assert.ok(await page.locator('.task .chip', { hasText: 'Default time' }).count() >= 1, 'a default time carries its mark');
  const outcomes = await page.locator('.run .chip').allInnerTexts();
  for (const words of ['Wrote to you', 'Stayed quiet', 'Could not read a source']) assert.ok(outcomes.includes(words), `a run reads "${words}"`);
  assert.match(await page.locator('.run[data-outcome="held"] .run-found').innerText(), /Source unavailable/);
  assert.equal(await page.locator('.shared').count(), 1, 'the manager shared an objective with the owner');
  assert.equal(await page.locator('.closed').getAttribute('open'), null, 'done and dropped start collapsed');
  assert.equal(await page.locator('.closed-row').first().isVisible(), false);
  const below = await page.evaluate(() => ({ last: [...document.querySelectorAll('.objective')].at(-1).getBoundingClientRect().bottom, closed: document.querySelector('.closed').getBoundingClientRect().top }));
  assert.ok(below.closed >= below.last, 'the collapsed list sits below the active objectives');
  await shoot(page, '1280-1-objectives.png');
  await page.locator('.closed > summary').click();
  assert.equal(await page.locator('.closed-row').count(), 2);
  assert.equal(await page.locator('.closed-row').first().isVisible(), true, 'one tap shows the done and dropped ones');
  await shoot(page, '1280-1b-closed-open.png');
  await page.locator('.closed > summary').click();
  await toSection(page, "Jet's plan");
  await shoot(page, '1280-2-plan.png');
  await page.getByRole('button', { name: /Show all/ }).click();
  assert.equal(await page.locator('.run').count(), 6);
  await toSection(page, 'Recent checks');
  await shoot(page, '1280-3-checks.png');
  await page.getByRole('button', { name: 'Show fewer' }).click();
  await toSection(page, 'Shared with you');
  await shoot(page, '1280-4-shared-with-you.png');
  await noOverflow(page, '1280');

  // Taps: a step, a note flip, a snooze and a cancel, each seen in the page and on the server.
  const step = page.locator('.objective[data-id="2"] .step').first();
  await step.scrollIntoViewIfNeeded();
  assert.equal(await step.getAttribute('aria-checked'), 'false');
  await step.click();
  await until(async () => (await page.locator('.objective[data-id="2"] .step').first().getAttribute('aria-checked')) === 'true', 'the tick must show');
  assert.equal((await owner.get('/api/pane')).objectives[1].steps[0].doneAt !== null, true, 'the server has the tick');
  await page.locator('.objective[data-id="2"] .step').first().click();
  await until(async () => (await page.locator('.objective[data-id="2"] .step').first().getAttribute('aria-checked')) === 'false', 'the untick must show');
  const flip = page.locator('.objective[data-id="1"] .note-flip');
  await flip.click();
  await until(async () => (await page.locator('.objective[data-id="1"] .note-flip').getAttribute('data-private')) === 'false', 'the note flips to shared');
  const task = page.locator('.task[data-id="1"]');
  const before = await task.locator('.task-time').innerText();
  await task.getByRole('button', { name: 'Snooze' }).click();
  await until(async () => (await page.locator('.task[data-id="1"] .task-time').innerText()) !== before, 'the snooze must move the time');
  assert.match(await page.locator('.task[data-id="1"] .task-time').innerText(), /08:00$/, 'a snooze lands on 08:00');
  const tasksBefore = await page.locator('.task').count();
  await page.locator('.task[data-id="2"]').getByRole('button', { name: 'Cancel' }).click();
  await until(async () => (await page.locator('.task').count()) === tasksBefore - 1, 'the cancelled check leaves the plan');
  // A tap from another window of the same user shows here with no reload.
  await owner.put('/api/objectives/1/steps/2', { done: true });
  await until(async () => (await page.locator('.objective[data-id="1"] .step[data-done="true"]').count()) === 2, 'the pane must follow a tap made elsewhere');
  // A share card opens inside the pane on one tap.
  assert.equal(await page.locator('.objective[data-id="2"]').getByRole('button', { name: 'Ask Jet to share' }).count(), 1, 'a private objective is shared by asking Jet');
  await page.locator('.objective[data-id="1"]').getByRole('button', { name: 'Change who sees it' }).click();
  await page.locator('.objective[data-id="1"] .card-share').waitFor();
  await page.locator('.objective[data-id="1"] .card-share').scrollIntoViewIfNeeded();
  await shoot(page, '1280-5-share-card.png');
  await page.locator('.objective[data-id="1"]').getByRole('button', { name: 'Close' }).click();
  // Open the objective's own chat.
  await page.locator('.objective[data-id="1"]').getByRole('button', { name: 'Open chat' }).click();
  await until(async () => (await page.locator('.chat-row[data-chat-id] [aria-current="true"]').count()) === 1 && (await page.locator('.chat-head').innerText()).includes('Ship the kite'), 'the objective chat opens');

  // Close the column, reload, and it stays closed; open it, reload, and it stays open.
  await page.locator('.pane-close').click();
  assert.equal(await pane.isHidden(), true);
  assert.equal(parseFloat((await page.locator('.workspace-shell').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' '))).at(2)), 0, 'the column is gone');
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'detached' });
  assert.equal(await pane.isHidden(), true, 'a closed pane stays closed after a reload');
  await page.locator('.pane-toggle').click();
  await pane.waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'detached' });
  assert.equal(await pane.isVisible(), true, 'an open pane stays open after a reload');
  await desk.context.close();

  // Phone, 390 px.
  const phone = await open(OWNER, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  page = phone.page;
  const count = page.locator('.pane-count');
  await count.waitFor();
  const fresh = Number(await count.innerText());
  assert.ok(fresh > 0, 'the button counts what is new');
  assert.equal(await page.locator('#side-pane').isHidden(), true, 'the pane is closed on a phone');
  await shoot(page, '390-0-button-count.png');
  await page.locator('.pane-toggle').tap();
  await page.locator('#side-pane').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#side-pane').evaluate((el) => el.getBoundingClientRect().width), 390, 'the pane lies over the whole chat');
  assert.equal(await count.isHidden(), true, 'opening clears the count');
  await page.locator('.objective').first().waitFor();
  await shoot(page, '390-1-objectives.png');
  await toSection(page, "Jet's plan"); await shoot(page, '390-2-plan.png');
  await toSection(page, 'Recent checks'); await shoot(page, '390-3-checks.png');
  await toSection(page, 'Shared with you'); await shoot(page, '390-4-shared-with-you.png');
  await noOverflow(page, '390 open');
  const phoneStep = page.locator('.objective[data-id="2"] .step').first();
  await phoneStep.tap();
  await until(async () => (await page.locator('.objective[data-id="2"] .step').first().getAttribute('aria-checked')) === 'true', 'the tick must show on the phone');
  const phoneTask = page.locator('.task[data-id="1"]');
  // The 1280 px run already moved this check to 08:00, so the snooze shows as a raised version on the server.
  const versionOf = async () => (await owner.get('/api/pane')).tasks.find((task) => task.id === 1).version;
  const phoneVersion = await versionOf();
  await phoneTask.getByRole('button', { name: 'Snooze' }).tap();
  await until(async () => (await versionOf()) === phoneVersion + 1, 'the snooze must reach the server from the phone');
  await page.locator('.task[data-id="1"]').getByRole('button', { name: 'Cancel' }).tap();
  await until(async () => (await page.locator('.task[data-id="1"]').count()) === 0, 'the cancelled check leaves the plan on the phone');
  await noOverflow(page, '390 after taps');
  await page.locator('.objective').first().getByRole('button', { name: 'Change who sees it' }).tap();
  await page.locator('.pane-share .card-share').waitFor();
  await noOverflow(page, '390 share card');
  await page.locator('.pane-close').tap();
  assert.equal(await page.locator('#side-pane').isHidden(), true, 'the button on the pane closes it again');
  await noOverflow(page, '390 closed');
  await phone.context.close();

  await owner.put('/api/objectives/1/notes/2', { private: true });
  // The manager reads what the owner shared; the outsider has an empty pane.
  for (const [view, name] of [[{ width: 1280, height: 900 }, '1280'], [{ width: 390, height: 844 }, '390']]) {
    const mgr = await open(MANAGER, view, name === '390' ? { hasTouch: true, isMobile: true } : {});
    if (name === '390') await mgr.page.locator('.pane-toggle').tap();
    await mgr.page.locator('.shared').waitFor();
    assert.equal(await mgr.page.locator('.shared').count(), 1);
    assert.match(await mgr.page.locator('.shared').innerText(), /Ship the kite page/);
    assert.doesNotMatch(await mgr.page.locator('#side-pane').innerText(), /Doubt I can fly|wind/, 'a private note never reaches a colleague');
    await toSection(mgr.page, 'Shared with you');
    await shoot(mgr.page, `${name}-6-manager-shared.png`);
    await noOverflow(mgr.page, `${name} manager`);
    await mgr.context.close();
    const out = await open(OUTSIDER, view, name === '390' ? { hasTouch: true, isMobile: true } : {});
    if (name === '390') await out.page.locator('.pane-toggle').tap();
    await out.page.locator('.invite').waitFor();
    assert.equal(await out.page.locator('.pane-body input, .pane-body textarea, .pane-body form').count(), 0, 'the empty pane has no form');
    await shoot(out.page, `${name}-7-empty.png`);
    await noOverflow(out.page, `${name} empty`);
    await out.context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS plan_pane_taps_collapse_reload_phone_count_and_fit');
  console.log('Screenshots: ' + screens);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(screens, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  if (!process.env.SCREENSHOT_DIR) await rm(scratch, { recursive: true, force: true });
}
