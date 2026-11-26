// Drives the Task list page against the real host, with the provider stand-in making Jet's tool calls: every change a
// person makes by mouse, by keyboard and by touch shows at once and is still there after a reload, Jet's changes and
// the plan pane's show with no reload, an open edit survives a re-read, and each list and write has its empty, loading
// and error states. It takes the screenshots at four widths.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-tasks-'));
const screens = process.env.SCREENSHOT_DIR ?? path.join(scratch, 'screens');
await mkdir(screens, { recursive: true });
const processes = createProcesses();
const ZONE = 'Europe/London', OWNER = 'shaunsurfing@gmail.com', OTHER = 'admin123@gmail.com';
let browser, page;
try {
  const data = path.join(scratch, 'data');
  await mkdir(data);
  const origin = await processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', '127.0.0.1:0', '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  // Every message here carries a script, so the stand-in that runs scripts is the whole provider.
  await saveOwnerSettings(origin, { model: 'sonnet', claudePath: path.join(root, 'target/debug/fake-claude'), reducedMotion: true });

  const clock = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: ZONE });
  /** A person on another device: calls the page does not make. */
  const as = async (email) => {
    const signedIn = await fetch(origin + '/api/auth/signin', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: '000111' }) });
    assert.equal(signedIn.status, 200, `${email} could not sign in`);
    const cookie = signedIn.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    return async (method, route, body) => {
      const response = await fetch(origin + route, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, `${method} ${route}: ${await response.clone().text()}`);
      return response.json();
    };
  };
  const api = await as(OWNER);
  /** A turn of Jet in a chat, sent from elsewhere, whose script the stand-in runs as Jet's tool calls. */
  const jet = async (chat, script) => {
    const query = chat === null ? '' : `?chat=${chat}`;
    await api('POST', `/api/chat/send${query}`, { requestId: 'r' + Math.random().toString(16).slice(2), clientId: 'elsewhere', text: `Go.\nfacade:${JSON.stringify([...script, { say: 'mood: neutral\nDone.' }])}`, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First mate', notes: '' }, localTime: 'Friday', timeZone: ZONE, feeling: 'neutral' });
    await until(async () => !(await api('GET', `/api/snapshot${query}`)).active, 'the turn must end');
  };
  const objectives = (command) => ({ tool: 'objectives_update', arguments: { command } });

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const errors = [];
  const open = async (email, options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', timezoneId: ZONE, ...options });
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
  const owner = await open(OWNER);
  page = owner.page;
  await page.evaluate(() => { window.sameDocument = true; });
  const list = page.locator('#tasks-content');
  const day = (p, name) => p.locator(`#tasks-content [data-drop-day="${name}"] > ul > .tl-task`);
  const titles = async (p, name) => (await day(p, name).locator('.tl-title, .tl-field').evaluateAll((els) => els.map((el) => (el.matches('input') ? el.value : el.textContent))));
  const row = (p, title) => p.locator('#tasks-content .tl-task', { has: p.locator('.tl-title', { hasText: new RegExp(`^${title}$`) }) });
  const mark = (p, title) => p.locator(`#tasks-content [data-drop-day] .tl-mark[aria-label^="${title}, "]`);
  const focusKey = (p) => p.evaluate(() => document.activeElement?.dataset.key ?? document.activeElement?.className);
  const alertText = (p) => p.locator('#tasks-content .tl-alert').innerText();
  /** Where an element is drawn; a row drawn again by an answer is measured once it is back. */
  const boxOf = async (locator) => {
    let box = null;
    await until(async () => (box = await locator.boundingBox({ timeout: 1000 }).catch(() => null)) !== null, 'the element must be drawn');
    return box;
  };
  const reload = async (p) => {
    await p.reload();
    await p.locator('#loading').waitFor({ state: 'detached' });
    await p.locator('#tasks-content[aria-busy="false"]').waitFor();
  };

  // ---- The first read: loading in the shape of the list, then the empty list; the first read failing, then trying again.
  let letRead;
  const reading = new Promise((resolve) => { letRead = resolve; });
  await page.locator('.files-nav [data-place="tasks"]').click();
  assert.equal(new URL(page.url()).hash, '#tasks');
  await page.route('**/api/task-list', async (route) => { await reading; await route.continue(); });
  await page.reload();
  await page.locator('#tasks-content .tl-skeleton').first().waitFor();
  assert.equal(await list.getAttribute('aria-busy'), 'true', 'the list says it is loading');
  assert.equal(await page.locator('#tasks-content .tl-skeleton').count(), 3);
  letRead();
  await page.locator('#tasks-content[aria-busy="false"]').waitFor();
  await page.unroute('**/api/task-list');
  await page.locator('#tasks-content .tl-add-field').first().waitFor();
  assert.equal(await focusKey(page), 'add-today', 'an empty list on a desktop puts the focus on Today\'s add line');
  assert.equal(await page.locator('#tasks-content .tl-invite').isVisible(), true, 'with no goals the goals say how to get one');
  assert.equal(await page.locator('.tl-fold .heading-count').innerText(), '', 'an empty pile has no count');
  await page.locator('.tl-fold').click();
  assert.equal(await page.locator('#tl-pile').innerText(), 'Tasks you finish land here.');
  await page.locator('.tl-fold').click();

  await page.route('**/api/task-list', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"kind":"store","message":"The database failed"}' }));
  await reload(page).catch(() => {});
  await page.locator('#tasks-content .tl-state-head', { hasText: 'The task list could not be loaded.' }).waitFor();
  await page.unroute('**/api/task-list');
  await page.locator('#tasks-content [data-key="load-again"]').click();
  await page.locator('#tasks-content .tl-add-field').first().waitFor();

  // ---- Add by keyboard alone: the field stays focused and empty for the next one, and Esc clears it.
  const addTo = async (name, words) => {
    const field = page.locator(`#tasks-content [data-key="add-${name}"]`);
    await field.focus();
    for (const title of words) {
      await page.keyboard.type(title);
      await page.keyboard.press('Enter');
      await until(async () => (await titles(page, name)).includes(title), `${title} is added to ${name}`);
      assert.equal(await field.inputValue(), '');
    }
  };
  await addTo('today', ['Draft the spec', 'Call the bank', 'Order the banner']);
  await addTo('tomorrow', ['Book the venue']);
  await addTo('later', ['Write the launch post']);
  await page.keyboard.press('Enter');
  assert.equal((await titles(page, 'later')).length, 1, 'an empty add line adds nothing');
  await page.keyboard.type('Not this one');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tasks-content [data-key="add-later"]').inputValue(), '');
  assert.equal(await page.locator('.files-nav .nav-count').innerText(), '3', "the drawer counts today's open tasks");
  await reload(page);
  assert.deepEqual(await titles(page, 'today'), ['Draft the spec', 'Call the bank', 'Order the banner'], 'still there after a reload');
  assert.deepEqual(await titles(page, 'tomorrow'), ['Book the venue']);

  // ---- Jet records a goal with its tasks, and a task of no goal, in a turn: both show in the open page with no reload.
  await jet(null, [
    objectives({ action: 'create', title: 'Ship the kite page', deliverable: 'The kite page live', start: clock(0), due: clock(9), steps: [{ title: 'Sketch the layout', due: clock(0) }, { title: 'Post the photos', due: clock(6) }], sources: [{ kind: 'jet' }], check: { at: `${clock(3)}T09:00`, why: 'see how the page goes' } }),
    objectives({ action: 'step_add', title: 'Pay the invoice' }),
  ]);
  await until(async () => (await titles(page, 'today')).includes('Sketch the layout') && (await titles(page, 'later')).includes('Pay the invoice'), "Jet's tasks show with no reload");
  await page.locator('#tasks-content .tl-goal .tl-title', { hasText: 'Ship the kite page' }).waitFor();
  assert.equal(await row(page, 'Sketch the layout').locator('.tl-meta-goal').innerText(), 'Ship the kite page', 'a task carries its goal');
  assert.equal(await page.locator('#tasks-content .tl-invite').isVisible(), false);
  assert.match(await page.locator('#tasks-content .tl-goal .tl-facts').innerText(), /^0\/2 · 9 days left$/);

  // ---- Rename in place: a click opens the row with the caret at the end; Enter saves, Esc restores.
  await row(page, 'Call the bank').locator('.tl-title').click();
  const field = page.locator('#tasks-content .tl-field');
  assert.equal(await focusKey(page), 'field-task-2');
  assert.deepEqual(await field.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length]), [13, 13, 13], 'the caret is at the end and nothing is selected');
  await page.keyboard.type(' about rates');
  await page.keyboard.press('Enter');
  await row(page, 'Call the bank about rates').waitFor();
  assert.equal(await focusKey(page), 'title-2', 'the focus goes back to the title');
  await row(page, 'Order the banner').locator('.tl-title').click();
  await page.keyboard.type(' twice');
  await page.keyboard.press('Escape');
  await row(page, 'Order the banner').waitFor();

  // ---- Start, done, undo, and back to not started: gray, yellow, green, and the row stays in place until the boxes rest.
  await mark(page, 'Draft the spec').click();
  await until(async () => (await mark(page, 'Draft the spec').getAttribute('aria-checked')) === 'mixed', 'one tap starts it');
  assert.equal(await mark(page, 'Draft the spec').getAttribute('aria-label'), 'Draft the spec, in progress');
  await mark(page, 'Draft the spec').click();
  await until(async () => (await mark(page, 'Draft the spec').getAttribute('aria-checked')) === 'true', 'a second tap makes it done');
  assert.equal(await row(page, 'Draft the spec').getAttribute('data-lingering'), 'true', 'a done task stays in its place for a moment');
  assert.equal((await titles(page, 'today'))[0], 'Draft the spec');
  assert.equal(await page.locator('.tl-fold .heading-count').innerText(), '1', 'the done count goes up at once');
  await until(async () => !(await titles(page, 'today')).includes('Draft the spec'), 'then it leaves for the done pile');
  await page.locator('.tl-fold').click();
  const pileRow = page.locator('#tl-pile .tl-task', { hasText: 'Draft the spec' });
  assert.equal(await pileRow.locator('.tl-mark').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#tl-pile .tl-day-label').first().innerText(), 'Today');
  await pileRow.locator('.tl-title').click();
  assert.equal(await page.locator('#tasks-content .tl-field').count(), 0, 'a done task opens with no title field: a finished record is not edited');
  assert.deepEqual(await page.locator('#tl-pile .tl-strip button').allInnerTexts(), ['Delete'], 'its strip holds Delete only');
  await page.keyboard.press('Escape');
  await reload(page);
  await page.locator('.tl-fold').click();
  await pileRow.locator('.tl-mark').click();
  await until(async () => (await titles(page, 'today'))[0] === 'Draft the spec', 'put back, it is in its old place');
  assert.equal(await mark(page, 'Draft the spec').getAttribute('aria-checked'), 'mixed', 'and in progress again, as it was before it was done');
  await row(page, 'Draft the spec').locator('.tl-title').click();
  await page.locator('#tasks-content .tl-word', { hasText: 'Not started' }).click();
  await until(async () => (await mark(page, 'Draft the spec').getAttribute('aria-checked')) === 'false', 'the status words set any status');
  assert.equal(await page.locator('#tasks-content .tl-word[aria-pressed="true"]').innerText(), 'Not started');
  await page.keyboard.press('Escape');
  await reload(page);
  assert.equal(await mark(page, 'Draft the spec').getAttribute('aria-checked'), 'false', 'still not started after a reload');
  assert.equal(await page.locator('.tl-fold .heading-count').innerText(), '');

  // ---- Delete takes two taps in the open row.
  await row(page, 'Order the banner').locator('.tl-title').click();
  const remove = page.locator('#tasks-content .tl-delete');
  await remove.click();
  assert.equal(await remove.innerText(), 'Delete?');
  await remove.click();
  await until(async () => !(await titles(page, 'today')).includes('Order the banner'), 'the second tap deletes');
  await reload(page);
  assert.equal((await titles(page, 'today')).includes('Order the banner'), false, 'still gone after a reload');

  // ---- Drag by mouse: up within a day, then from one day into another. Each shows at once and holds after a reload.
  const dragTo = async (from, toY) => {
    const box = await boxOf(row(page, from).locator('.tl-title'));
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2 + 6, { steps: 2 });
    await page.mouse.move(box.x + 40, toY, { steps: 8 });
    await page.mouse.up();
  };
  const before = await titles(page, 'today');
  const top = await boxOf(day(page, 'today').first());
  await dragTo(before.at(-1), top.y + 4);
  const reordered = [before.at(-1), ...before.slice(0, -1)];
  assert.deepEqual(await titles(page, 'today'), reordered, 'the dragged task is first at once');
  assert.equal(await page.locator('#tasks-content .tl-field').count(), 0, 'the click after a drop does not open the row');
  const end = await boxOf(page.locator('#tasks-content [data-drop-day="today"] .tl-add'));
  await dragTo('Book the venue', end.y + end.height / 2);
  assert.deepEqual(await titles(page, 'today'), [...reordered, 'Book the venue'], 'a task dragged onto the add line lands last in that day');
  assert.deepEqual(await titles(page, 'tomorrow'), []);
  await until(async () => (await api('GET', '/api/task-list')).tasks.find((t) => t.title === 'Book the venue').day === 'today', 'the server has the move');
  await reload(page);
  assert.deepEqual(await titles(page, 'today'), [...reordered, 'Book the venue'], 'both moves hold after a reload');
  // A drop over the Done line puts the row back; a drag that starts while another row is open fades its own row.
  const fold = await boxOf(page.locator('.tl-fold'));
  await dragTo(reordered[0], fold.y + fold.height / 2);
  assert.deepEqual(await titles(page, 'today'), [...reordered, 'Book the venue'], 'a drop onto the Done line moves nothing');
  await row(page, 'Book the venue').locator('.tl-title').click();
  const lifted = await boxOf(row(page, reordered[0]).locator('.tl-title'));
  await page.mouse.move(lifted.x + 40, lifted.y + lifted.height / 2);
  await page.mouse.down();
  await page.mouse.move(lifted.x + 40, lifted.y + lifted.height / 2 + 30, { steps: 4 });
  assert.equal(await page.locator('#tasks-content .tl-task.is-lifted').count(), 1, 'the dragged row stays faded in its place');
  assert.equal(await page.locator('#tasks-content .tl-task.is-lifted').evaluate((el) => getComputedStyle(el).opacity), '0.35');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await until(async () => (await page.locator('#tasks-content .tl-field').count()) === 0, 'the open row closed when the drag began');
  assert.deepEqual(await titles(page, 'today'), [...reordered, 'Book the venue'], 'a cancelled drag moves nothing');

  // ---- Move to a goal, then open the task's chat.
  await row(page, 'Call the bank about rates').locator('.tl-title').click();
  await page.locator('#tasks-content .tl-goal-pick').selectOption({ label: 'Ship the kite page' });
  await until(async () => (await api('GET', '/api/task-list')).tasks.find((t) => t.title === 'Call the bank about rates').goalId !== null, 'the server has the goal');
  await page.locator('#tasks-content .tl-strip').getByRole('button', { name: 'Open chat' }).click();
  await until(async () => (await page.locator('#chat-title').innerText()) === 'Ship the kite page', "Open chat shows the task's chat");
  assert.equal(await list.isHidden(), true);
  await page.locator('.files-nav [data-place="tasks"]').click();
  assert.equal(await row(page, 'Call the bank about rates').locator('.tl-meta-goal').innerText(), 'Ship the kite page', 'the task is under its goal');
  await reload(page);
  assert.equal(await row(page, 'Call the bank about rates').locator('.tl-meta-goal').innerText(), 'Ship the kite page');

  const idOf = async (title) => (await api('GET', '/api/task-list')).tasks.find((t) => t.title === title)?.id;

  // ---- V3: done in the page shows ticked in the plan pane of the task's chat, and a tap in the pane shows in the page.
  const pane = (await owner.context.newPage());
  pane.on('pageerror', (error) => errors.push(String(error)));
  await pane.goto(origin);
  await pane.locator('#loading').waitFor({ state: 'detached' });
  await pane.locator('.chat-row .chat-title', { hasText: 'Ship the kite page' }).click();
  const sketch = await idOf('Sketch the layout');
  const step = pane.locator(`.step[data-key="step-${sketch}"]`);
  await step.waitFor();
  assert.equal(await step.getAttribute('aria-checked'), 'false');
  await mark(page, 'Sketch the layout').click();
  await until(async () => (await step.getAttribute('aria-checked')) === 'mixed', 'started in the page, the pane shows it yellow');
  await mark(page, 'Sketch the layout').click();
  await until(async () => (await step.getAttribute('aria-checked')) === 'true', 'done in the page, the pane shows it ticked');
  await step.click();
  await until(async () => (await mark(page, 'Sketch the layout').getAttribute('aria-checked')) === 'mixed', 'a tap on the green box in the pane puts it back to started, and the page follows');
  await step.click();
  await until(async () => !(await titles(page, 'today')).includes('Sketch the layout'), 'done in the pane, it leaves the list');

  // ---- A task Jet adds in a turn shows in the open page with no reload.
  await jet(null, [objectives({ action: 'step_add', title: 'Renew the domain' })]);
  await until(async () => (await titles(page, 'later')).includes('Renew the domain'), "Jet's new task shows with no reload");

  // ---- V8: two quick moves by keyboard land in the order made; the second is sent only once the first has answered.
  const timeline = [];
  const watch = (request) => { if (request.method() === 'PATCH') timeline.push(['sent', Date.now()]); };
  const answered = (request) => { if (request.method() === 'PATCH') timeline.push(['answered', Date.now()]); };
  page.on('request', watch);
  page.on('requestfinished', answered);
  const today = await titles(page, 'today');
  const last = today.at(-1);
  await row(page, last).locator('.tl-title').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  const expected = [...today.slice(0, -3), last, ...today.slice(-3, -1)];
  assert.deepEqual(await titles(page, 'today'), expected, 'both moves show at once');
  assert.equal(await focusKey(page), `title-${await idOf(last)}`, 'the focus moves with the task');
  await until(async () => timeline.filter(([kind]) => kind === 'answered').length === 2, 'both moves are answered');
  assert.deepEqual(timeline.map(([kind]) => kind), ['sent', 'answered', 'sent', 'answered'], 'the second move waits for the first');
  page.off('request', watch);
  page.off('requestfinished', answered);
  await reload(page);
  assert.deepEqual(await titles(page, 'today'), expected, 'and they hold after a reload');

  // ---- V10: an open row keeps its typed text, its caret and the focus while Jet changes another task.
  const draft = await idOf('Draft the spec'), other = await idOf(expected[0] === 'Draft the spec' ? expected[1] : expected[0]);
  const otherTitle = (await api('GET', '/api/task-list')).tasks.find((t) => t.id === other).title;
  await row(page, 'Draft the spec').locator('.tl-title').click();
  await page.keyboard.type(' about rates');
  await jet(null, [objectives({ action: 'step_tick', step: other })]);
  await delay(1500);
  assert.equal(await field.inputValue(), 'Draft the spec about rates', 'no character is lost');
  assert.equal(await focusKey(page), `field-task-${draft}`, 'the field keeps the focus');
  assert.deepEqual(await field.evaluate((el) => [el.selectionStart, el.value.length]), [26, 26], 'the caret is still at the end');
  assert.ok((await titles(page, 'today')).includes(otherTitle), 'the rest of the list waits until the row closes');
  await page.keyboard.press('Enter');
  await row(page, 'Draft the spec about rates').waitFor();
  await until(async () => !(await titles(page, 'today')).includes(otherTitle), 'once it closes, the change Jet made shows');
  assert.equal(await alertText(page), '');

  // ---- A refused change shows why, and the row is put back; a later change that works clears the words.
  let refuse;
  const refusing = new Promise((resolve) => { refuse = resolve; });
  await page.route('**/api/task-list/tasks/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await refusing;
    return route.fulfill({ status: 409, contentType: 'application/json', body: '{"kind":"goalClosed","message":"That goal is closed"}' });
  });
  await mark(page, 'Draft the spec about rates').click();
  assert.equal(await mark(page, 'Draft the spec about rates').getAttribute('aria-checked'), 'mixed', 'while the change is on its way it already shows');
  refuse();
  await until(async () => (await alertText(page)) === 'The task could not be changed. That goal is closed. Try again.', 'the alert says what failed and why');
  assert.equal(await mark(page, 'Draft the spec about rates').getAttribute('aria-checked'), 'false', 'the row is put back');
  await page.unroute('**/api/task-list/tasks/*');
  await mark(page, 'Draft the spec about rates').click();
  await until(async () => (await alertText(page)) === '', 'a change that works clears the alert');
  await until(async () => (await api('GET', '/api/task-list')).tasks.find((t) => t.id === draft).state === 'in_progress', 'and is kept');

  // ---- An add that fails puts the typed words back in the field and says why.
  await page.route('**/api/task-list/tasks', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"kind":"badTitle","message":"A title needs 1 to 300 characters"}' }));
  await page.locator('#tasks-content [data-key="add-tomorrow"]').fill('Water the plants');
  await page.locator('#tasks-content [data-key="add-tomorrow"]').press('Enter');
  await until(async () => (await alertText(page)) === 'The task could not be added. A title needs 1 to 300 characters. Try again.', 'the failed add says why');
  assert.equal(await page.locator('#tasks-content [data-key="add-tomorrow"]').inputValue(), 'Water the plants', 'and its words are back');
  await page.unroute('**/api/task-list/tasks');
  await page.locator('#tasks-content [data-key="add-tomorrow"]').fill('');

  // ---- A later read that fails keeps the list, with a quiet way to try again.
  await page.route('**/api/task-list', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"kind":"store","message":"The database failed"}' }));
  await api('PATCH', `/api/task-list/tasks/${await idOf('Renew the domain')}`, { state: 'in_progress' });
  await page.locator('#tasks-content .tl-notice', { hasText: 'The task list could not be refreshed.' }).waitFor();
  assert.ok((await titles(page, 'today')).length > 0, 'the last good list stays');
  await page.unroute('**/api/task-list');
  await page.locator('#tasks-content [data-key="refresh-again"]').click();
  await until(async () => (await page.locator('#tasks-content .tl-notice').innerText()) === '', 'trying again clears the notice');
  assert.equal(await mark(page, 'Renew the domain').getAttribute('aria-checked'), 'mixed');

  // ---- The keyboard alone: one Tab stop per list, arrows inside it, Space on the box, Enter to open, the strip's
  // buttons, Alt and the arrows to move, Delete on a closed row, and Esc to leave.
  await page.locator('#tasks-title').focus();
  await page.keyboard.press('Tab');
  const first = (await titles(page, 'today'))[0];
  assert.equal(await page.evaluate(() => document.activeElement.closest('ul')?.dataset.list), 'today', "the first Tab goes into Today's list, where its focus was last");
  await page.keyboard.press('Home');
  if ((await focusKey(page)).startsWith('title-')) await page.keyboard.press('ArrowLeft');
  assert.equal(await focusKey(page), `mark-${await idOf(first)}`, "Home and the side arrows reach the first task's box");
  await page.keyboard.press('ArrowDown');
  const second = (await titles(page, 'today'))[1];
  assert.equal(await focusKey(page), `mark-${await idOf(second)}`, 'down goes to the box of the next task');
  await page.keyboard.press('Tab');
  assert.equal(await focusKey(page), 'add-today', 'one Tab leaves the list for its add line');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focusKey(page), `mark-${await idOf(second)}`, 'and Shift+Tab comes back to where it was');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  assert.equal(await focusKey(page), `field-task-${await idOf(second)}`, 'Enter opens the row on its title field');
  await page.keyboard.press('Tab');
  assert.match(await focusKey(page), /^state-not_started-/, 'the strip follows the field');
  for (let i = 0; i < 4 && !(await focusKey(page)).startsWith('to-tomorrow-'); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await until(async () => (await titles(page, 'tomorrow')).includes(second), '"Move to Tomorrow" moves it');
  assert.equal(await focusKey(page), `title-${await idOf(second)}`, 'and the focus goes with it');
  await page.keyboard.press('Alt+ArrowUp');
  await until(async () => (await titles(page, 'today')).at(-1) === second, 'Alt+Up from the top of a day moves it to the end of the day before');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await until(async () => (await mark(page, second).getAttribute('aria-checked')) === 'mixed', 'Space starts it');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('#tasks-content .tl-delete').innerText(), 'Delete?', 'Delete on a closed row opens it with Delete armed');
  assert.equal(await focusKey(page), `delete-${await idOf(second)}`);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tasks-content .tl-field').count(), 0, 'Esc closes the row');
  assert.equal(await focusKey(page), `title-${await idOf(second)}`);
  // Up at the top of Today goes nowhere, and says so.
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#tasks-content .tl-strip [data-key^="up-"]').getAttribute('aria-disabled'), 'true', 'Up is off on the first task of Today');
  await page.keyboard.press('Escape');
  // A task of its own, by keyboard only: its goal by typing on the picker, its chat by Enter, done by Space twice, and the focus
  // goes on to the next box once it leaves.
  await page.locator('#tasks-content [data-key="add-today"]').focus();
  await page.keyboard.type('Feed the cat');
  await page.keyboard.press('Enter');
  await until(async () => (await titles(page, 'today')).includes('Feed the cat'), 'added by keyboard');
  const cat = await idOf('Feed the cat');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('End');
  if ((await focusKey(page)).startsWith('mark-')) await page.keyboard.press('ArrowRight');
  assert.equal(await focusKey(page), `title-${cat}`);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 6 && !(await focusKey(page)).startsWith('goal-pick-'); i++) await page.keyboard.press('Tab');
  assert.match(await focusKey(page), /^goal-pick-/, 'Tab reaches the goal picker');
  // A closed picker takes the first letters of a goal, as every native select does; arrows open the menu on a Mac.
  await page.keyboard.type('Ship');
  await until(async () => (await api('GET', '/api/task-list')).tasks.find((t) => t.id === cat).goalId !== null, 'typing on the goal picker puts the task under the goal');
  for (let i = 0; i < 8 && !(await focusKey(page)).startsWith('chat-'); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#chat-title').innerText()) === 'Ship the kite page', 'Enter on Open chat opens its chat');
  await page.locator('.files-nav [data-place="tasks"]').focus();
  await page.keyboard.press('Enter');
  await row(page, 'Feed the cat').locator('.tl-mark').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  await until(async () => (await mark(page, 'Feed the cat').getAttribute('aria-checked')) === 'true', 'Space twice makes it done');
  await until(async () => !(await titles(page, 'today')).includes('Feed the cat'), 'it leaves for the pile');
  assert.match(await focusKey(page), /^(mark-\d+|add-today)$/, 'and the focus goes on to the next box');
  // Delete twice deletes.
  await row(page, 'Pay the invoice').locator('.tl-title').focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Delete');
  await until(async () => !(await titles(page, 'later')).includes('Pay the invoice'), 'a second Delete deletes');
  assert.match(await focusKey(page), /^(mark-\d+|add-later)$/, 'the focus goes to the next task');
  // The goal is renamed by keyboard, and the new name shows on its tasks.
  const goalTitle = page.locator('#tasks-content .tl-goal .tl-title');
  await goalTitle.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Ship the kite site');
  await page.keyboard.press('Enter');
  await until(async () => (await goalTitle.innerText()) === 'Ship the kite site', 'the goal is renamed');
  assert.equal(await row(page, 'Call the bank about rates').locator('.tl-meta-goal').innerText(), 'Ship the kite site');
  await until(async () => (await api('GET', '/api/task-list')).goals[0].title === 'Ship the kite site', `the server has the new name: ${await alertText(page)}`);
  // The pile opens by keyboard.
  await page.locator('.tl-fold').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.tl-fold').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Enter');
  await reload(page);
  assert.equal(await goalTitle.innerText(), 'Ship the kite site', 'the rename holds after a reload');

  // ---- The screenshots, at four widths: the list with all three states, a drag in progress, the done pile, and the empty list.
  const empty = await as(OTHER);
  await empty('GET', '/api/task-list');
  for (const width of [1440, 1024, 800, 400]) {
    const touch = width === 400 ? { hasTouch: true, isMobile: true } : {};
    for (const [who, name] of [[OWNER, 'list'], [OTHER, 'empty']]) {
      const shot = await open(who, { viewport: { width, height: 900 }, ...touch });
      const p = shot.page;
      await p.goto(origin + '/#tasks');
      await p.locator('#loading').waitFor({ state: 'detached' });
      await p.locator('#tasks-content[aria-busy="false"]').waitFor();
      const file = (state) => path.join(screens, `tasks-${state}-${width}.png`);
      if (name === 'empty') { await p.screenshot({ path: file('empty') }); await shot.context.close(); continue; }
      // Done by a tap, a task stays green in its place for a moment, beside the gray and the yellow.
      const green = (await titles(p, 'today'))[0];
      await mark(p, green).click();
      await until(async () => (await mark(p, green).getAttribute('aria-checked')) === 'true', 'done for the picture');
      await p.screenshot({ path: file('states') });
      await mark(p, green).click();
      await until(async () => (await mark(p, green).getAttribute('aria-checked')) !== 'true', 'put back after the picture');
      await until(async () => (await api('GET', '/api/task-list')).tasks.some((t) => t.title === green), 'the server has it back');
      await delay(300);
      const box = await boxOf(row(p, green).locator('.tl-title'));
      await p.mouse.move(box.x + 30, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + 30, box.y + box.height / 2 + 70, { steps: 6 });
      await p.locator('.tl-ghost').waitFor();
      await p.screenshot({ path: file('drag') });
      await p.keyboard.press('Escape');
      await p.mouse.up();
      assert.equal(await p.locator('.tl-ghost').count(), 0, 'Esc cancels the drag');
      await p.locator('.tl-fold').click();
      await p.locator('#tl-pile .tl-quiet').last().scrollIntoViewIfNeeded();
      await delay(300);
      await p.screenshot({ path: file('pile') });
      await shot.context.close();
    }
  }

  // ---- At 400 px with touch: nothing is wider than the window, a tap on the box marks it, a tap on a row opens it
  // without raising the keyboard, and a long press then a drag moves a task while the list does not scroll.
  const phone = await open(OWNER, { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true });
  const tp = phone.page;
  await tp.goto(origin + '/#tasks');
  await tp.locator('#loading').waitFor({ state: 'detached' });
  await tp.locator('#tasks-content[aria-busy="false"]').waitFor();
  const overflow = () => tp.evaluate(() => [document.documentElement.scrollWidth, ...[...document.querySelectorAll('#tasks-content *')].filter((el) => el.getClientRects().length).map((el) => Math.ceil(el.getBoundingClientRect().right))].filter((right) => right > innerWidth));
  assert.deepEqual(await overflow(), [], 'nothing is wider than the window');
  const phoneToday = await titles(tp, 'today');
  await mark(tp, 'Write the launch post').tap();
  await until(async () => (await mark(tp, 'Write the launch post').getAttribute('aria-checked')) === 'mixed', 'a tap on the box starts the task');
  const markBox = await boxOf(mark(tp, 'Write the launch post'));
  assert.ok(markBox.width >= 44 && markBox.height >= 44, 'the box takes a whole finger');
  await row(tp, phoneToday[0]).locator('.tl-meta, .tl-title').first().tap();
  await tp.locator('#tasks-content .tl-strip').waitFor();
  assert.notEqual(await focusKey(tp), `field-task-${await idOf(phoneToday[0])}`, 'a tap opens the row without raising the keyboard');
  assert.deepEqual(await overflow(), [], 'the open row fits too');
  await tp.locator('#tasks-title').tap();
  await until(async () => (await tp.locator('#tasks-content .tl-field').count()) === 0, 'a tap outside closes it');
  // A row is open when the long press starts on another one: the drag still works, and the open row closes after it.
  const lastId = await idOf(phoneToday.at(-1));
  await row(tp, phoneToday.at(-1)).locator('.tl-meta, .tl-title').first().tap();
  await tp.locator(`#tasks-content .tl-task[data-id="${lastId}"][data-open="true"]`).waitFor();
  const cdp = await phone.context.newCDPSession(tp);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const from = await boxOf(row(tp, phoneToday[0]).locator('.tl-title'));
  const to = await boxOf(tp.locator(`#tasks-content .tl-task[data-id="${lastId}"]`));
  const scrolled = await tp.locator('#tasks-content').evaluate((el) => el.scrollTop);
  await touch('touchStart', from.x + 60, from.y + from.height / 2);
  await delay(500);
  for (let y = from.y + from.height / 2; y <= to.y + to.height - 4; y += 8) { await touch('touchMove', from.x + 60, y); await delay(16); }
  assert.equal(await tp.locator('#tasks-content .tl-task.is-lifted').count(), 1, 'the row being dragged stays faded in its place');
  await touch('touchEnd');
  await until(async () => (await titles(tp, 'today')).at(-1) === phoneToday[0], 'a long press and a drag moves the task down');
  assert.equal(await tp.locator('#tasks-content').evaluate((el) => el.scrollTop), scrolled, 'the list did not scroll under the finger');
  assert.equal(await tp.locator('#tasks-content .tl-field').count(), 0, 'and the drop opened nothing');
  await phone.context.close();

  // ---- The pile pages back: Show older loads the next hundred, with its loading and error states.
  for (let i = 0; i < 101; i++) {
    const added = await api('POST', '/api/task-list/tasks', { title: `Old task ${i}`, day: 'later' });
    await api('PATCH', `/api/task-list/tasks/${added.changed}`, { state: 'done' });
  }
  await reload(page);
  await page.locator('.tl-fold').click();
  const pileRows = page.locator('#tl-pile .tl-task');
  const total = (await api('GET', '/api/task-list')).doneCount;
  assert.equal(await pileRows.count(), 100, 'the read carries the newest hundred');
  assert.equal(await page.locator('.tl-fold .heading-count').innerText(), String(total));
  await page.route('**/api/task-list/done?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"kind":"store","message":"The database failed"}' }));
  await page.locator('#tasks-content [data-key="older"]').click();
  await until(async () => (await alertText(page)) === 'Older done tasks could not be loaded. The database failed. Try again.', 'a page that fails says so');
  assert.equal(await pileRows.count(), 100, 'and the pile keeps what it has');
  await page.unroute('**/api/task-list/done?*');
  let letOlder;
  const olderGate = new Promise((resolve) => { letOlder = resolve; });
  await page.route('**/api/task-list/done?*', async (route) => { await olderGate; await route.continue(); });
  await page.locator('#tasks-content [data-key="older"]').click();
  await until(async () => (await page.locator('#tasks-content [data-key="older"]').innerText()) === 'Loading older…', 'Show older says it is loading');
  letOlder();
  await until(async () => (await pileRows.count()) === total, 'Show older loads the rest');
  assert.equal(await page.locator('#tasks-content [data-key="older"]').count(), 0, 'and goes once nothing older is left');
  assert.equal(await alertText(page), '');
  await page.unroute('**/api/task-list/done?*');

  // ---- A goal is marked done from its open row by keyboard: its open tasks leave the list, and the pile keeps its done ones.
  await page.locator('#tasks-content .tl-goal .tl-title').focus();
  await page.keyboard.press('Enter');
  for (let i = 0; i < 3 && !(await focusKey(page)).startsWith('goal-done-'); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#tasks-content [data-key^="goal-done-"]').innerText(), /^Done\? Its \d open tasks? leaves? the list\.$/);
  await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#tasks-content .tl-goal').count()) === 0, 'the goal leaves the list');
  assert.equal((await titles(page, 'today')).includes('Call the bank about rates'), false, 'and so do its open tasks');
  assert.equal(await page.locator('#tasks-content .tl-invite').isVisible(), true);

  assert.deepEqual(errors, []);
  console.log('PASS the_task_list_works_by_mouse_keyboard_and_touch_and_follows_jet_and_the_plan_pane_live');
} catch (error) {
  if (page) console.error(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  await rm(scratch, { recursive: true, force: true });
}
