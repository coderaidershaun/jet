// Drives the Task list page against the real host, with the provider stand-in making Jet's tool calls: every change a
// person makes by mouse, by keyboard and by touch shows at once and is still there after a reload, the counts filter,
// Overdue moves to Today, Jet's changes and the plan pane's show with no reload, an open edit survives a re-read, and
// each list and write has its empty, loading and error states. It takes the screenshots at 1280 and 400 px.
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
  const jet = async (chat, script, caller = api) => {
    const query = chat === null ? '' : `?chat=${chat}`;
    await caller('POST', `/api/chat/send${query}`, { requestId: 'r' + Math.random().toString(16).slice(2), clientId: 'elsewhere', text: `Go.\nfacade:${JSON.stringify([...script, { say: 'mood: neutral\nDone.' }])}`, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First mate', notes: '' }, localTime: 'Friday', timeZone: ZONE, feeling: 'neutral' });
    await until(async () => !(await caller('GET', `/api/snapshot${query}`)).active, 'the turn must end');
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
  const day = (p, name) => p.locator(`#tasks-content ul[data-list="${name}"] > .tl-task`);
  const titles = async (p, name) => (await day(p, name).locator('.tl-title, .tl-field').evaluateAll((els) => els.map((el) => (el.matches('textarea') ? el.value : el.textContent))));
  const row = (p, title) => p.locator('#tasks-content .tl-task', { has: p.locator('.tl-title', { hasText: new RegExp(`^${title}$`) }) });
  const mark = (p, title) => p.locator(`#tasks-content [data-drop-day] > ul[data-list] > .tl-task .tl-mark[aria-label^="${title}, "]`);
  const foldCount = (p) => p.locator('.tl-fold .tl-count').innerText();
  const focusKey = (p) => p.evaluate(() => document.activeElement?.dataset.key ?? document.activeElement?.className);
  const alertText = (p) => p.locator('#tasks-content .tl-alert').innerText();
  /** Where an element is drawn; a row drawn again by an answer is measured once it is back. */
  const boxOf = async (locator) => {
    let box = null;
    await until(async () => (box = await locator.boundingBox({ timeout: 1000 }).catch(() => null)) !== null, 'the element must be drawn');
    return box;
  };
  /** The right edges past the window: none means nothing scrolls sideways. */
  const overflow = (p) => p.evaluate(() => [document.documentElement.scrollWidth, ...[...document.querySelectorAll('#tasks-content *')].filter((el) => el.getClientRects().length).map((el) => Math.ceil(el.getBoundingClientRect().right))].filter((right) => right > innerWidth));
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
  assert.equal(await page.locator('#tasks-content .tl-skeleton').count(), 4);
  assert.equal(await page.locator('#tasks-content .tl-add-field').getAttribute('placeholder'), 'Loading the list…');
  assert.equal(await page.locator('#tasks-content .tl-add-field').isDisabled(), true, 'nothing can be added before the list is there');
  letRead();
  await page.locator('#tasks-content[aria-busy="false"]').waitFor();
  await page.unroute('**/api/task-list');
  await page.locator('#tasks-content .tl-add-field:not([disabled])').waitFor();
  assert.equal(await focusKey(page), 'add', 'an empty list on a desktop puts the focus on the add field');
  assert.equal(await page.locator('#tasks-content .tl-empty-head').innerText(), 'Nothing on your list yet.');
  assert.equal(await page.locator('#tasks-content .tl-summary').isVisible(), false, 'an empty list has no counts');
  assert.equal(await page.locator('#tasks-content .tl-goal-invite').isVisible(), true, 'with no goals the goals say how to get one');
  assert.equal(await foldCount(page), '', 'an empty pile has no count');
  await page.locator('.tl-fold').click();
  assert.equal(await page.locator('#tl-pile').innerText(), 'Tasks you finish land here.');
  await page.locator('.tl-fold').click();

  await page.route('**/api/task-list', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"kind":"store","message":"The database failed"}' }));
  await reload(page).catch(() => {});
  await page.locator('#tasks-content .tl-state p', { hasText: 'The task list could not be loaded.' }).waitFor();
  await page.unroute('**/api/task-list');
  await page.locator('#tasks-content [data-key="load-again"]').click();
  await page.locator('#tasks-content .tl-add-field:not([disabled])').waitFor();

  // ---- Add by keyboard alone: the one bar takes a day, the field stays focused and empty for the next one, and Esc clears it.
  const addField = page.locator('#tasks-content [data-key="add"]');
  const addTo = async (name, words) => {
    const field = addField;
    await page.locator('#tasks-content [data-key="add-day"]').selectOption(name);
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
  assert.equal(await addField.inputValue(), '');
  assert.equal(await page.locator('#tasks-content [data-key="add-day"]').inputValue(), 'later', 'the day is kept for the next add');
  assert.equal(await page.locator('.files-nav .nav-count').innerText(), '3', "the drawer counts today's open tasks");
  assert.equal(await page.locator('.files-nav [data-place="tasks"]').getAttribute('aria-label'), 'Task list, 3 due today');
  assert.deepEqual(await page.locator('#tasks-content .tl-sum').allInnerTexts(), ['0\nOverdue', '3\nDue today', '0\nIn progress', '0\nDone today']);
  await reload(page);
  assert.deepEqual(await titles(page, 'today'), ['Draft the spec', 'Call the bank', 'Order the banner'], 'still there after a reload');
  assert.deepEqual(await titles(page, 'tomorrow'), ['Book the venue']);

  // ---- Jet records a goal with its tasks, and a task of no goal, in a turn: both show in the open page with no reload.
  await jet(null, [
    objectives({ action: 'create', title: 'Ship the kite page', deliverable: 'The kite page live', start: clock(0), due: clock(9), steps: [{ title: 'Sketch the layout', due: clock(0) }, { title: 'Post the photos', due: clock(6) }], sources: [{ kind: 'jet' }], check: { at: `${clock(3)}T09:00`, why: 'see how the page goes' } }),
    objectives({ action: 'step_add', title: 'Pay the invoice' }),
  ]);
  await until(async () => (await titles(page, 'today')).includes('Sketch the layout') && (await titles(page, 'later')).includes('Pay the invoice'), "Jet's tasks show with no reload");
  await page.locator('#tasks-content .tl-goal .tl-goal-name', { hasText: 'Ship the kite page' }).waitFor();
  assert.equal(await row(page, 'Sketch the layout').locator('.tl-meta-goal').innerText(), 'Ship the kite page', 'a task carries its goal');
  assert.equal(await page.locator('#tasks-content .tl-goal-invite').isVisible(), false);
  assert.equal(await page.locator('#tasks-content .tl-goal .tl-goal-facts').innerText(), '0 of 2 done · 0 in progress');
  assert.match(await page.locator('#tasks-content .tl-goal .tl-goal-due').innerText(), / · 9 days left$/);
  assert.equal(await page.locator('#tasks-content .tl-goal .tl-next-title').innerText(), 'Sketch the layout', "the card names the goal's next task");

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
  assert.equal(await foldCount(page), '1', 'the done count goes up at once');
  assert.equal(await page.locator('#tasks-content .tl-sum[data-kind="done"] .tl-sum-n').innerText(), '1', 'and so does Done today');
  await until(async () => !(await titles(page, 'today')).includes('Draft the spec'), 'then it leaves its place');
  assert.deepEqual(await titles(page, 'done-today'), ['Draft the spec'], 'for Done today, under Today');
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
  await page.locator('#tasks-content .tl-seg button', { hasText: 'Not started' }).click();
  await until(async () => (await mark(page, 'Draft the spec').getAttribute('aria-checked')) === 'false', 'the status words set any status');
  assert.equal(await page.locator('#tasks-content [data-key^="state-"][aria-pressed="true"]').innerText(), 'Not started');
  await page.keyboard.press('Escape');
  await reload(page);
  assert.equal(await mark(page, 'Draft the spec').getAttribute('aria-checked'), 'false', 'still not started after a reload');
  assert.equal(await foldCount(page), '');

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
  const end = await boxOf(day(page, 'today').last());
  await dragTo('Book the venue', end.y + end.height - 2);
  assert.deepEqual(await titles(page, 'today'), [...reordered, 'Book the venue'], 'a task dragged below the last row lands last in that day');
  assert.deepEqual(await titles(page, 'tomorrow'), []);
  assert.equal(await page.locator('#tasks-content ul[data-list="tomorrow"] .tl-quiet').innerText(), 'Nothing due tomorrow.', 'an empty day says so');
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
  await page.locator('#tasks-content [data-key^="goal-pick-"]').selectOption({ label: 'Ship the kite page' });
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

  // ---- An add that fails puts the typed words back in the field and says why under the bar.
  await page.route('**/api/task-list/tasks', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"kind":"badTitle","message":"A title needs 1 to 300 characters"}' }));
  await addField.fill('Water the plants');
  await addField.press('Enter');
  const addError = page.locator('#tasks-content .tl-add-error');
  await until(async () => (await addError.isVisible()) && (await addError.innerText()) === 'The task could not be added. A title needs 1 to 300 characters. Press Add to try again.', 'the failed add says why');
  assert.equal(await addField.inputValue(), 'Water the plants', 'and its words are back');
  assert.equal(await addField.getAttribute('aria-describedby'), 'tl-add-error');
  assert.equal(await alertText(page), '', 'beside its field, not in the alert');
  await page.unroute('**/api/task-list/tasks');
  await addField.fill('');

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
  assert.equal(await focusKey(page), 'sum-late', 'the first Tab reaches the counts, one stop');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focusKey(page), 'sum-progress', 'the arrows move between the counts');
  await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#tasks-content .tl-filter-line').isVisible()), 'a count filters the list');
  assert.match(await page.locator('#tasks-content .tl-filter-line').innerText(), /^Showing 2 in progress\.\sShow all$/);
  assert.deepEqual(await titles(page, 'today'), ['Draft the spec about rates'], 'only the tasks in progress show');
  assert.equal(await page.locator('#tasks-content [data-day="tomorrow"]').isVisible(), false, 'a part with none is left out');
  assert.equal(await page.locator('#tasks-content [data-day="today"] .tl-count').innerText(), '1 shown');
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('#tasks-content .tl-filter-line').isVisible()), 'Esc clears the filter');
  for (let i = 0; i < 6 && (await page.evaluate(() => document.activeElement.closest('ul')?.dataset.list)) !== 'today'; i++) await page.keyboard.press('Tab');
  const first = (await titles(page, 'today'))[0];
  assert.equal(await page.evaluate(() => document.activeElement.closest('ul')?.dataset.list), 'today', "past the add bar, Tab goes into Today's list, where its focus was last");
  await page.keyboard.press('Home');
  if ((await focusKey(page)).startsWith('title-')) await page.keyboard.press('ArrowLeft');
  assert.equal(await focusKey(page), `mark-${await idOf(first)}`, "Home and the side arrows reach the first task's box");
  await page.keyboard.press('ArrowDown');
  const second = (await titles(page, 'today'))[1];
  assert.equal(await focusKey(page), `mark-${await idOf(second)}`, 'down goes to the box of the next task');
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.closest('ul')?.dataset.list), 'today', 'one Tab leaves the list');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focusKey(page), `mark-${await idOf(second)}`, 'and Shift+Tab comes back to where it was');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  assert.equal(await focusKey(page), `field-task-${await idOf(second)}`, 'Enter opens the row on its title field');
  await page.keyboard.press('Tab');
  assert.match(await focusKey(page), /^state-not_started-/, 'the strip follows the field');
  for (let i = 0; i < 6 && !(await focusKey(page)).startsWith('day-tomorrow-'); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await until(async () => (await titles(page, 'tomorrow')).includes(second), 'Day: Tomorrow moves it');
  assert.equal(await focusKey(page), `title-${await idOf(second)}`, 'and the focus goes with it');
  await page.keyboard.press('Alt+ArrowUp');
  await until(async () => (await titles(page, 'today')).at(-1) === second, 'Alt+Up from the top of a day moves it to the end of the day before');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await until(async () => (await mark(page, second).getAttribute('aria-checked')) === 'mixed', 'Space starts it');
  await page.keyboard.press('1');
  await until(async () => (await mark(page, second).getAttribute('aria-checked')) === 'false', '1 sets it back to not started');
  await page.keyboard.press('2');
  await until(async () => (await mark(page, second).getAttribute('aria-checked')) === 'mixed', '2 sets it in progress');
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
  // A task of its own, by keyboard only: N reaches the add field, its goal by typing on the picker, its chat by Enter,
  // done by Space twice, and the focus goes on to the next box once it leaves.
  await page.keyboard.press('n');
  assert.equal(await focusKey(page), 'add', 'N in the list puts the focus in the add field');
  await page.locator('#tasks-content [data-key="add-day"]').selectOption('today');
  await addField.focus();
  await page.keyboard.type('Feed the cat');
  await page.keyboard.press('Enter');
  await until(async () => (await titles(page, 'today')).includes('Feed the cat'), 'added by keyboard');
  const cat = await idOf('Feed the cat');
  await day(page, 'today').first().locator('.tl-title').focus();
  await page.keyboard.press('End');
  if ((await focusKey(page)).startsWith('mark-')) await page.keyboard.press('ArrowRight');
  assert.equal(await focusKey(page), `title-${cat}`);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 9 && !(await focusKey(page)).startsWith('goal-pick-'); i++) await page.keyboard.press('Tab');
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
  assert.match(await focusKey(page), /^(mark-\d+|add)$/, 'and the focus goes on to the next box');
  // Delete twice deletes.
  await row(page, 'Pay the invoice').locator('.tl-title').focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Delete');
  await until(async () => !(await titles(page, 'later')).includes('Pay the invoice'), 'a second Delete deletes');
  assert.match(await focusKey(page), /^(mark-\d+|add)$/, 'the focus goes to the next task');
  // The goal is renamed by keyboard in the details behind its "⋯", and the new name shows on its tasks.
  const goalTitle = page.locator('#tasks-content .tl-goal .tl-goal-name');
  await page.locator('#tasks-content .tl-goal .tl-goal-more').focus();
  await page.keyboard.press('Enter');
  assert.match(await focusKey(page), /^field-goal-/, 'the keyboard opens the details on the title field');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Ship the kite site');
  await page.keyboard.press('Enter');
  await until(async () => (await goalTitle.innerText()) === 'Ship the kite site', 'the goal is renamed');
  assert.match(await focusKey(page), /^goal-more-/, 'and the focus goes back to its "⋯"');
  assert.equal(await row(page, 'Call the bank about rates').locator('.tl-meta-goal').innerText(), 'Ship the kite site');
  await until(async () => (await api('GET', '/api/task-list')).goals[0].title === 'Ship the kite site', `the server has the new name: ${await alertText(page)}`);
  // The pile opens by keyboard.
  await page.locator('.tl-fold').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.tl-fold').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Enter');
  await reload(page);
  assert.equal(await goalTitle.innerText(), 'Ship the kite site', 'the rename holds after a reload');

  // ---- A second person's list, made by Jet, for the screenshots at 1280 and 400 px beside the mockups: empty first, then a
  // normal day with five late tasks, two goals and done tasks. On the way it checks the counts, a status filter, a goal
  // filter, the move menu and Move all to Today.
  const guest = await as(OTHER);
  const shotOf = async (width) => {
    const shot = await open(OTHER, { viewport: { width, height: 1700 }, ...(width === 400 ? { hasTouch: true, isMobile: true } : {}) });
    await shot.page.goto(origin + '/#tasks');
    await shot.page.locator('#loading').waitFor({ state: 'detached' });
    await shot.page.locator('#tasks-content[aria-busy="false"]').waitFor();
    return shot;
  };
  const file = (state, width) => path.join(screens, `tasks-${state}-${width}.png`);
  for (const width of [1280, 400]) {
    const shot = await shotOf(width);
    await shot.page.screenshot({ path: file('empty', width) });
    await shot.context.close();
  }
  await jet(null, [
    objectives({ action: 'create', title: 'Q4 report for the board', deliverable: 'A ten-page report on the fourth quarter for the board meeting, with revenue by region and the plan for next year', start: clock(-10), due: clock(-2), steps: [{ title: 'Review the board deck numbers with finance', due: clock(-3) }, { title: 'Send the report outline to Sam', due: clock(1) }, { title: 'Chart the Q4 revenue by region', due: clock(6) }, { title: 'Write the summary page' }], sources: [{ kind: 'jet' }], check: { at: `${clock(3)}T09:00`, why: 'see how the report goes' } }),
    objectives({ action: 'create', title: 'Ship the kite page', deliverable: 'The kite page live with the new animations', start: clock(0), due: clock(4), steps: [{ title: 'Draft the kite page copy', due: clock(0) }, { title: 'Test the kite page on a phone', due: clock(1) }, { title: 'Record the launch video', due: clock(4) }], sources: [{ kind: 'jet' }], check: { at: `${clock(2)}T09:00`, why: 'see how the page goes' } }),
    ...[['Return the library books', -4], ['Reply to the landlord about the boiler', -2], ['Pay the parking fine', -1], ['Call the bank about the business account', -1], ['Pick up the dry cleaning', 0], ['Book the venue for the team dinner', 1], ['Renew the domain', null]]
      .map(([title, due]) => objectives({ action: 'step_add', title, ...(due === null ? {} : { due: clock(due) }) })),
  ], guest);
  const sample = await guest('GET', '/api/task-list');
  const sampleId = (title) => sample.tasks.find((t) => t.title === title).id;
  for (const title of ['Draft the kite page copy', 'Chart the Q4 revenue by region']) await guest('PATCH', `/api/task-list/tasks/${sampleId(title)}`, { state: 'in_progress' });
  for (const title of ['Email the accountant', 'Sketch the kite poses']) {
    const added = await guest('POST', '/api/task-list/tasks', { title, day: 'today', goalId: title.startsWith('Sketch') ? sample.goals.find((g) => g.title === 'Ship the kite page').id : null });
    await guest('PATCH', `/api/task-list/tasks/${added.changed}`, { state: 'done' });
  }
  for (const width of [1280, 400]) {
    const shot = await shotOf(width);
    const p = shot.page;
    const overdue = p.locator('#tasks-content ul[data-list="late"] > .tl-task');
    assert.equal(await overdue.count(), 3, 'Overdue shows at most three');
    assert.equal(await p.locator('#tasks-content [data-key="more-late"]').innerText(), 'Show 2 more overdue');
    assert.deepEqual(await p.locator('#tasks-content .tl-sum .tl-sum-n').allInnerTexts(), ['5', '2', '2', '2']);
    assert.equal(await overdue.first().locator('.tl-chip').innerText(), '3 days late', 'the first late task in the one order says how late');
    assert.match(await row(p, 'Draft the kite page copy').locator('.tl-since').innerText(), /^In progress since \d\d:\d\d$/);
    if (width === 1280) {
      assert.equal(await p.locator('.files-nav .nav-count').textContent(), '5 · 2', 'the drawer shows overdue and due today apart');
      assert.equal(await p.locator('.files-nav [data-place="tasks"]').getAttribute('aria-label'), 'Task list, 5 overdue, 2 due today');
      assert.equal(await p.locator('#tasks-content .tl-rail .tl-goal').count(), 2, 'the goals are cards in the rail');
    } else {
      assert.equal(await p.locator('#tasks-content .tl-column > .tl-goals .tl-meter').count(), 2, 'the goals are meters in the band under the add bar');
    }
    assert.deepEqual(await overflow(p), [], `nothing is wider than the window at ${width} px`);
    await p.screenshot({ path: file('full', width) });

    // The move menu opens from a chip with the keyboard on the current day.
    await row(p, 'Pick up the dry cleaning').locator('.tl-chip').click();
    assert.equal(await focusKey(p), `menu-today-${sampleId('Pick up the dry cleaning')}`);
    await p.screenshot({ path: file('menu', width) });
    await p.keyboard.press('Escape');
    assert.equal(await focusKey(p), `chip-${sampleId('Pick up the dry cleaning')}`, 'Esc puts the focus back on the chip');

    await p.locator('#tasks-content .tl-sum[data-kind="progress"]').click();
    assert.deepEqual([...await titles(p, 'today'), ...await titles(p, 'later')], ['Draft the kite page copy', 'Chart the Q4 revenue by region'], 'only the tasks in progress show');
    await p.screenshot({ path: file('filter', width) });
    await p.locator('#tasks-content [data-key="show-all"]').click();

    // Overdue over its limit with Move all armed, and a late row open: no day pressed, Up and Down off with the reason.
    await p.locator('#tasks-content [data-key="move-all"]').click();
    assert.equal(await p.locator('#tasks-content [data-key="move-all"]').innerText(), 'Move 5 to Today?');
    await overdue.first().locator('.tl-title').click();
    assert.equal(await p.locator('#tasks-content .tl-strip [data-key^="day-"][aria-pressed="true"]').count(), 0, 'a late task has no day pressed');
    assert.equal(await p.locator('#tasks-content .tl-strip [data-key^="up-"]').getAttribute('aria-disabled'), 'true', 'a late task is not moved one place');
    await p.screenshot({ path: file('overdue', width) });
    await p.keyboard.press('Escape');
    await p.locator('#tasks-title').click();

    await row(p, 'Draft the kite page copy').locator('.tl-title').click();
    await p.locator('#tasks-content .tl-strip').waitFor();
    await p.screenshot({ path: file('open-row', width) });
    await p.locator('#tasks-title').click();

    // A goal filters the list and sets the add bar's goal; its "⋯" opens its details with Mark done to arm.
    await p.locator('#tasks-content :is(.tl-goal-name, .tl-pick)', { hasText: 'Ship the kite page' }).click();
    assert.match(await p.locator('#tasks-content .tl-filter-line').innerText(), /^Showing Ship the kite page: 3 open, 1 done\.\sShow all$/);
    assert.equal(await p.locator('#tasks-content [data-key="add-goal"] option:checked').innerText(), 'Ship the kite page', "the add bar takes the goal");
    await p.screenshot({ path: file('goal-filter', width) });
    await p.locator('#tasks-content [data-key="show-all"]').click();
    await p.locator('#tasks-content [aria-label="More about Q4 report for the board"]').click();
    await p.locator('#tasks-content [data-key^="goal-done-"]').click();
    assert.equal(await p.locator('#tasks-content [data-key^="goal-done-"]').innerText(), 'Done? Its 4 open tasks leave the list.');
    await p.screenshot({ path: file('goal-details', width) });
    await p.locator('#tasks-title').click();
    await shot.context.close();
  }
  // A choice in the move menu by keyboard moves a task, and Move all to Today clears Overdue in two taps, in order.
  {
    const shot = await shotOf(1280);
    const p = shot.page;
    await row(p, 'Pick up the dry cleaning').locator('.tl-chip').focus();
    await p.keyboard.press('Enter');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Enter');
    await until(async () => (await titles(p, 'tomorrow')).includes('Pick up the dry cleaning'), 'Tomorrow in the menu moves the task');
    assert.equal(await focusKey(p), `chip-${sampleId('Pick up the dry cleaning')}`, 'and the focus stays on its chip');
    const lateOrder = (await guest('GET', '/api/task-list')).tasks.filter((t) => t.late).map((t) => t.title);
    await p.locator('#tasks-content [data-key="move-all"]').click();
    await p.locator('#tasks-content [data-key="move-all"]').click();
    await until(async () => (await p.locator('#tasks-content [data-day="late"]').isHidden()), 'Overdue is gone');
    assert.deepEqual((await titles(p, 'today')).filter((t) => lateOrder.includes(t)), lateOrder, 'the moved tasks keep their order in Today');
    await until(async () => (await guest('GET', '/api/task-list')).tasks.every((t) => !t.late), 'the server gave each one today\'s date');
    await shot.context.close();
  }

  // ---- At 400 px with touch: nothing is wider than the window, a tap on the box marks it, a tap on a row opens it
  // without raising the keyboard, and a long press then a drag moves a task while the list does not scroll.
  const phone = await open(OWNER, { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true });
  const tp = phone.page;
  await tp.goto(origin + '/#tasks');
  await tp.locator('#loading').waitFor({ state: 'detached' });
  await tp.locator('#tasks-content[aria-busy="false"]').waitFor();
  assert.deepEqual(await overflow(tp), [], 'nothing is wider than the window');
  const phoneToday = await titles(tp, 'today');
  await mark(tp, 'Write the launch post').tap();
  await until(async () => (await mark(tp, 'Write the launch post').getAttribute('aria-checked')) === 'mixed', 'a tap on the box starts the task');
  const markBox = await boxOf(mark(tp, 'Write the launch post'));
  assert.ok(markBox.width >= 44 && markBox.height >= 44, 'the box takes a whole finger');
  await row(tp, phoneToday[0]).locator('.tl-meta, .tl-title').first().tap();
  await tp.locator('#tasks-content .tl-strip').waitFor();
  assert.notEqual(await focusKey(tp), `field-task-${await idOf(phoneToday[0])}`, 'a tap opens the row without raising the keyboard');
  assert.deepEqual(await overflow(tp), [], 'the open row fits too');
  await tp.locator('#tasks-title').tap();
  await until(async () => (await tp.locator('#tasks-content .tl-field').count()) === 0, 'a tap outside closes it');
  // A row is open when the long press starts on another one: the drag still works, and the open row closes after it.
  const lastId = await idOf(phoneToday.at(-1));
  await row(tp, phoneToday.at(-1)).locator('.tl-meta, .tl-title').first().tap();
  await tp.locator(`#tasks-content .tl-task[data-id="${lastId}"][data-open="true"]`).waitFor();
  const cdp = await phone.context.newCDPSession(tp);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // Today sits in the middle of the window, so the drag stays clear of the edges that scroll the list on purpose.
  await tp.locator('#tasks-content [data-day="today"]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
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
  // A list long enough to scroll: a swipe on a row scrolls it and moves no task, a hold and a drag moves one with no scroll
  // (above), and a second finger touching and lifting during a drag does not end it.
  const fillers = [];
  for (let i = 0; i < 40; i++) fillers.push((await api('POST', '/api/task-list/tasks', { title: `Filler ${i}`, day: 'later' })).changed);
  await tp.reload();
  await tp.locator('#loading').waitFor({ state: 'detached' });
  await tp.locator('#tasks-content[aria-busy="false"]').waitFor();
  const scroller = tp.locator('#tasks-content');
  const sizes = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  assert.ok(sizes.scrollHeight > sizes.clientHeight, 'the list must overflow so a scroll can be seen');
  const touchAt = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const swipeOrder = await titles(tp, 'today');
  const swipeFrom = await boxOf(row(tp, swipeOrder.at(-1)).locator('.tl-title'));
  const swipeStart = await scroller.evaluate((el) => el.scrollTop);
  let swipeY = swipeFrom.y + swipeFrom.height / 2;
  await touchAt('touchStart', [{ x: swipeFrom.x + 60, y: swipeY, id: 1 }]);
  for (let step = 0; step < 25; step++) { swipeY -= 10; await touchAt('touchMove', [{ x: swipeFrom.x + 60, y: swipeY, id: 1 }]); await delay(16); }
  await touchAt('touchEnd', []);
  await until(async () => (await scroller.evaluate((el) => el.scrollTop)) > swipeStart, 'a swipe on a row scrolls the list');
  assert.deepEqual(await titles(tp, 'today'), swipeOrder, 'and moves no task');
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await delay(300);
  const heldRow = await boxOf(row(tp, swipeOrder[0]).locator('.tl-title'));
  let heldY = heldRow.y + heldRow.height / 2;
  const heldX = heldRow.x + 60;
  await touchAt('touchStart', [{ x: heldX, y: heldY, id: 1 }]);
  await delay(500);
  for (let step = 0; step < 6; step++) { heldY += 8; await touchAt('touchMove', [{ x: heldX, y: heldY, id: 1 }]); await delay(16); }
  assert.equal(await tp.locator('#tasks-content .tl-task.is-lifted').count(), 1, 'the row is lifted');
  await touchAt('touchStart', [{ x: heldX, y: heldY, id: 1 }, { x: heldX + 120, y: heldY + 200, id: 2 }]);
  await touchAt('touchEnd', [{ x: heldX + 120, y: heldY + 200, id: 2 }]);
  await delay(300);
  assert.equal(await tp.locator('#tasks-content .tl-task.is-lifted').count(), 1, 'a second finger lifted during a drag does not end it');
  await touchAt('touchEnd', [{ x: heldX, y: heldY, id: 1 }]);
  await until(async () => (await tp.locator('#tasks-content .tl-task.is-lifted').count()) === 0, 'the first finger lifting ends the drag');
  for (const id of fillers) await api('DELETE', `/api/task-list/tasks/${id}`);
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
  assert.equal(await foldCount(page), String(total));
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
  await page.locator('#tasks-content .tl-goal .tl-goal-more').focus();
  await page.keyboard.press('Enter');
  for (let i = 0; i < 3 && !(await focusKey(page)).startsWith('goal-done-'); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#tasks-content [data-key^="goal-done-"]').innerText(), /^Done\? Its \d open tasks? leaves? the list\.$/);
  await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#tasks-content .tl-goal').count()) === 0, 'the goal leaves the list');
  assert.equal((await titles(page, 'today')).includes('Call the bank about rates'), false, 'and so do its open tasks');
  assert.equal(await page.locator('#tasks-content .tl-goal-invite').isVisible(), true);

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
