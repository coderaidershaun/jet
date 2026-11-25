// What Jet changes shows in the open page at once, with no reload: in an objective's own chat a turn that moves the due
// date moves it in the pane while the reply still runs; in the main chat a new task and a ticked step show; the chat Jet
// opens for an objective joins the list; a second window of the same user follows; the page catches up when the
// event stream starts again, with or without an error, and when the server itself starts again; and a chat deleted
// elsewhere leaves the pane.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, signIn, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-live-'));
const processes = createProcesses();
const ZONE = 'Europe/London', OWNER = { email: 'shaunsurfing@gmail.com', password: '000111' };
let browser, page;
try {
  const data = path.join(scratch, 'data');
  await mkdir(data);
  const start = (listen) => processes.launch(process.env.JET_BINARY ?? path.join(root, 'target/debug/jet'), ['--listen', listen, '--data-dir', data, '--ui-dir', path.join(root, 'crates/jet/ui'), '--disable-feelings', '--disable-voice'], /Jet listening on (http:\/\/\S+)/);
  const origin = await start('127.0.0.1:0');
  // Every message here carries a script, so the stand-in that runs scripts is the whole provider.
  await saveOwnerSettings(origin, { model: 'sonnet', claudePath: path.join(root, 'target/debug/fake-claude'), reducedMotion: true });

  const clock = (days, time) => {
    const day = new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: ZONE });
    return time ? `${day}T${time}` : day;
  };
  /** A date as the server writes it in a note, 'Fri 4 Dec 2026', and as the pane writes it, with no year while it is this one. */
  const inWords = (iso) => new Date(iso + 'T00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(',', '');
  const short = (iso) => inWords(iso).replace(' ' + new Date().getFullYear(), '');
  const objectives = (command) => ({ tool: 'objectives_update', arguments: { command } });
  const tasks = (command) => ({ tool: 'tasks_update', arguments: { command } });

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', timezoneId: ZONE });
  context.setDefaultTimeout(15000);
  const errors = [];
  /** A window of the owner; the second one finds the first one's sign-in. */
  const open = async (enter) => {
    const next = await context.newPage();
    next.on('pageerror', (error) => errors.push(String(error)));
    await enter(next, origin);
    await next.locator('#loading').waitFor({ state: 'detached' });
    await next.evaluate(() => { window.sameDocument = true; });
    return next;
  };
  const replying = (p) => p.locator('#send').getAttribute('aria-label').then((label) => label !== 'Send');
  /** Types a message whose script the stand-in runs as Jet's tool calls. With a gate, the reply stays open after them until `release`. */
  let gates = 0;
  const say = async (p, text, script, gated = false) => {
    const gate = path.join(scratch, `gate-${gates += 1}`);
    await p.locator('#field').fill(`${text}\nfacade:${JSON.stringify([...script, ...(gated ? [{ wait: gate }] : []), { say: 'mood: neutral\nDone.' }])}`);
    await p.locator('#send').click();
    return async () => { await writeFile(gate, ''); await until(async () => !(await replying(p)), 'the reply must end'); };
  };
  /** The owner on another device: calls the page does not make, and messages it only hears of. */
  const signedIn = await fetch(origin + '/api/auth/signin', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
  const cookie = signedIn.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  const api = async (method, route, body) => {
    const response = await fetch(origin + route, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${route}: ${await response.clone().text()}`);
    return response.json();
  };
  const elsewhere = async (chat, text) => {
    await api('POST', `/api/chat/send?chat=${chat}`, { requestId: 'r' + Math.random().toString(16).slice(2), clientId: 'elsewhere', text, model: 'sonnet', effort: 'medium', budgetUsd: 1, persona: { name: 'Jet', jobTitle: 'First mate', notes: '' }, localTime: 'Friday', timeZone: ZONE, feeling: 'neutral' });
    await until(async () => !(await api('GET', `/api/snapshot?chat=${chat}`)).active, 'the reply sent from elsewhere must end');
  };
  const chatRow = (p, title) => p.locator('.chat-row', { has: p.locator('.chat-title', { hasText: title }) });
  const openChat = async (p, title) => { await chatRow(p, title).locator('.chat-open').click(); await until(async () => (await p.locator('#chat-title').innerText()) === title, `the chat ${title} must open`); };
  const badge = (p, title) => chatRow(p, title).locator('.badge').allInnerTexts().then((texts) => texts.join(''));
  const progress = (p) => p.locator('.objective[data-id="1"] .progress').innerText();

  page = await open(signIn);
  const second = await open((next) => next.goto(origin));
  const both = async (check) => { for (const p of [page, second]) await check(p); };

  // Jet records an objective in the main chat, so it gets a chat of its own: the chat joins the list with its unread entry, and the objective joins the pane.
  const due = clock(3), later = clock(10);
  await (await say(page, 'I am building a trading engine.', [objectives({ action: 'create', title: 'Build the trading engine', deliverable: 'An engine that places orders', start: clock(0), due, steps: [{ title: 'Write the order book', due }], sources: [{ kind: 'jet' }], check: { at: clock(5, '09:00'), why: 'see how the order book goes' } })]))();
  await both(async (p) => {
    await until(async () => (await badge(p, 'Build the trading engine')) === '1', "the objective's chat joins the list, unread, with no reload");
    await until(async () => (await p.locator('.objective[data-id="1"]').count()) === 1, 'the new objective joins the pane with no reload');
  });

  // In the objective's own chat the pane holds that objective. Jet moves the due date, and the pane follows while the reply still runs.
  await openChat(page, 'Build the trading engine');
  const focus = page.locator('.focus[data-id="1"]');
  await until(async () => (await focus.locator('.focus-due').count()) === 1 && (await focus.locator('.focus-due').innerText()) === `Due ${short(due)}`, 'the pane leads with the day the objective is due');
  let release = await say(page, 'It will finish a week later.', [{ tool: 'objectives_list', arguments: {} }, objectives({ action: 'dates', id: 1, due: later, reason: 'the exchange API changed' })], true);
  await until(async () => (await focus.locator('.focus-due').innerText()) === `Due ${short(later)}`, 'the new due date shows in the pane as soon as the tool call succeeds');
  assert.equal(await replying(page), true, 'the date moved while the reply was still running');
  assert.equal(await focus.locator('.note-dates').innerText(), `New dates due ${inWords(later)} (was ${inWords(due)}). Reason: the exchange API changed`, 'the note says in words what moved, and only that');
  assert.equal(await focus.locator('.row-warn').innerText(), `Steps end ${short(due).replace(/^\S+ /, '')}, before the new due date.`, 'a step the move left behind is not taken for the due date');
  await until(async () => (await second.locator('.objective[data-id="1"] .row-facts').innerText()).includes('10 days left'), 'the second window, on the main chat, follows');
  await release();
  assert.equal(await focus.locator('.focus-due').innerText(), `Due ${short(later)}`, 'the date is still right when the reply ends');

  // The step Jet moves, the step it adds and the check it moves show in the objective's chat too.
  release = await say(page, 'Move the step too, add the risk limits, and look in sooner.', [objectives({ action: 'step_edit', id: 1, step: 1, due: later }), objectives({ action: 'step_add', id: 1, title: 'Add the risk limits' }), tasks({ action: 'schedule', objectiveId: 1, at: clock(2, '08:00'), why: 'see whether the limits hold' })], true);
  await until(async () => (await focus.locator('.step').count()) === 2 && (await focus.locator('.row-warn').count()) === 0, 'the added step shows, and the moved step ends on the due date');
  await until(async () => (await page.locator('.scoped-task .task-why').innerText()) === 'see whether the limits hold', 'the moved check shows');
  await release();

  // In the main chat the pane is the overview: a new task and a ticked step show while the reply still runs.
  await openChat(page, 'Main chat');
  await page.locator('.objective[data-id="1"]').waitFor();
  assert.equal(await progress(page), '0/2');
  release = await say(page, 'The order book is written.', [tasks({ action: 'schedule', at: clock(1, '10:00'), why: 'ask how the first order went' }), objectives({ action: 'step_tick', id: 1, step: 1 })], true);
  await both(async (p) => {
    await until(async () => (await p.locator('.task .task-why', { hasText: 'ask how the first order went' }).count()) === 1, 'the new task shows in the overview');
    await until(async () => (await progress(p)) === '1/2', 'the ticked step shows in the overview');
  });
  assert.equal(await replying(page), true, 'both showed while the reply was still running');
  await release();
  assert.equal(await progress(page), '1/2', 'still right when the reply ends');

  // The stream starts again with no error, as after it fell behind or the chat was forgotten, and a step is ticked before it is open: the pane is read again.
  const chats = await api('GET', '/api/chats');
  const main = chats.find((chat) => chat.kind === 'main').id, engine = chats.find((chat) => chat.kind === 'objective').id;
  let reached, letThrough;
  const asked = new Promise((resolve) => { reached = resolve; }), gate = new Promise((resolve) => { letThrough = resolve; });
  await page.route('**/api/events**', async (route) => { reached(); await gate; await route.continue(); });
  await api('POST', `/api/chat/forget?chat=${main}`, {});
  await asked;
  await api('PUT', '/api/objectives/1/steps/2', { done: true });
  letThrough();
  await both((p) => until(async () => (await progress(p)) === '2/2', 'a change made while the stream was starting again shows'));
  await page.unroute('**/api/events**');

  // The server starts again with both windows open. What Jet did meanwhile shows when they are back, and the unread count of a chat the page had open before still rises.
  await openChat(page, 'Build the trading engine');
  await openChat(page, 'Main chat');
  await context.route('**/api/events**', (route) => route.abort());
  await processes.stop(origin);
  await page.locator('#banner', { hasText: 'Waiting for the connection' }).waitFor();
  assert.equal(await start(new URL(origin).host), origin);
  await elsewhere(engine, `It is done.\nfacade:${JSON.stringify([tasks({ action: 'cancel', id: 2 }), objectives({ action: 'close', id: 1, outcome: 'done' })])}`);
  await context.unroute('**/api/events**');
  await both(async (p) => {
    await until(async () => (await p.locator('.objective[data-id="1"]').count()) === 0 && (await p.locator('.task .task-why', { hasText: 'ask how the first order went' }).count()) === 0, 'the closed objective and the cancelled task are gone once the stream is back');
    await until(async () => (await badge(p, 'Build the trading engine')) === '1', 'the reply of the other chat is counted');
  });
  await elsewhere(engine, 'say:{"parts":["mood: neutral\\nNoted."]}');
  await both((p) => until(async () => (await badge(p, 'Build the trading engine')) === '2', 'after a restart the unread count of another chat still rises'));

  // The objective's chat is deleted on another device, so the objective lives in the main chat: its row offers no chat any more.
  const toChat = (p) => p.locator('.closed-row').getByRole('button', { name: /^Open the chat/ });
  await both(async (p) => { await p.locator('[data-key="fold-closed"]').click(); await toChat(p).waitFor(); });
  await api('DELETE', `/api/chats/${engine}`);
  await both(async (p) => {
    await until(async () => (await toChat(p).count()) === 0, 'a deleted chat leaves the pane at once');
    assert.equal(await p.evaluate(() => window.sameDocument), true, 'the page was never reloaded');
  });
  assert.deepEqual(errors, []);
  console.log('PASS what_jet_changes_shows_live_in_both_views_a_second_window_and_after_the_stream_or_the_server_starts_again');
} catch (error) {
  if (page) console.error(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  await rm(scratch, { recursive: true, force: true });
}
