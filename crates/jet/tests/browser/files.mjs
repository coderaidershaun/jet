// Drives the files of the real page against the real server and the provider stand-in: the library with its search,
// its choice and zip, the file dialog with rename, add to a chat, remove, restore and the two-tap delete, a second tab
// that sees a delete while its dialog is open, the delete that disarms after four seconds, a keyboard delete that keeps the
// focus, and an upload left in the tray that goes with a reload. It saves the screens of
// the design at 1440 and 390 px. A few states that need a server in trouble (loading, a failed read, a nearly full or
// empty store) are drawn from a changed answer of GET /api/files, since the page alone decides how they look.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, signIn, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-files-'));
const screens = process.env.SCREENSHOT_DIR ?? path.join(scratch, 'screens');
await mkdir(screens, { recursive: true });
const processes = createProcesses();
const OWNER = 'shaunsurfing@gmail.com';
const NOTE = 'Planning notes for the kite budget.';
const LONG = 'quarterly-review-of-the-kite-flying-budget-with-every-spar-fabric-and-reel-cost-for-the-coastal-club-2026.md';
const PAGE = (version) => `<!doctype html><html><head><meta charset="utf-8"><title>Kite budget summary</title>
<style>body { margin: 0; padding: 28px 24px; font: 16px/1.5 system-ui, sans-serif; color: #1b2733; } h1 { margin: 0 0 8px; font-size: 26px; }
table { width: 100%; border-collapse: collapse; } th, td { padding: 8px 10px; border-bottom: 1px solid #d9e0e6; text-align: left; } th { background: #eef2f5; }</style></head>
<body><h1>Kite budget summary</h1><p>Draft ${version}: what the kite will cost.</p>
<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Ripstop cloth</td><td>$24</td></tr><tr><td>Spars and string</td><td>$18</td></tr><tr><td>Reel</td><td>$9</td></tr></table></body></html>`;

/** A small picture: a sky gradient with a kite-coloured band, so the dialog has a real image to fit. */
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) {
      const band = Math.abs(y - height * 0.6 + x * 0.25) < 14;
      row.push(...(band ? [242, 177, 84] : [60 + y / 3, 120 + y / 4, 200]));
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

let browser, page;
try {
  const data = path.join(scratch, 'data');
  await mkdir(data);
  const provider = path.join(scratch, 'provider.cjs');
  await writeFile(provider, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
const child = spawn(${JSON.stringify(path.join(root, 'target/debug/fake-claude'))}, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(input); child.on('exit', code => process.exit(code || 0));
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
    await until(async () => { try { return JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8')).length === script.length; } catch { return false; } }, 'the scripted turn must finish: ' + words).catch(async (error) => { console.error(await readFile(path.join(data, 'facade-results.json'), 'utf8').catch(() => 'no results')); throw error; });
    for (const result of JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8'))) assert.equal(result.isError, false, JSON.stringify(result));
    await delay(300);
  };
  const update = (command) => ({ tool: 'files_update', arguments: { command } });
  const library = async () => (await call('GET', '/api/files')).files;
  const named = async (name) => (await library()).find((file) => file.name === name);
  const upload = (name, bytes, type) => call('POST', '/api/files?name=' + encodeURIComponent(name), bytes, type);
  const addChat = async (title) => { const chat = await call('POST', '/api/chats', {}); await call('PATCH', `/api/chats/${chat.id}`, { title }); return chat.id; };

  const mainChat = (await call('GET', '/api/chats'))[0].id;
  await turn(mainChat, 'I am planning a kite budget.', [{ tool: 'objectives_update', arguments: { command: { action: 'create', title: 'Kite budget', deliverable: 'A budget the kite fits inside', start: '2099-06-01', due: '2099-07-01', steps: [], sources: [{ kind: 'jet' }], check: { at: '2099-06-08T09:00', why: 'see whether the budget is settled' } } } }]);
  const kite = (await call('GET', '/api/pane')).objectives[0].chatId;
  const spars = await addChat('Spars'), fabric = await addChat('Fabric'), reel = await addChat('Reel');
  const text = await upload('kite-budget.txt', 'Kite budget\ncloth 24\nspars 18\nreel 9\n', 'text/plain');
  const sheet = await upload('kite-costs.xlsx', await readFile(path.join(root, 'crates/jet/tests/fixtures/uploads/sheet.xlsx')), 'application/octet-stream');
  const picture = await upload('kite-sketch.png', png(480, 320), 'application/octet-stream');
  await turn(kite, 'Here is my budget, the costs and a sketch.', [
    update({ action: 'describe', id: text.id, context: NOTE }),
    update({ action: 'create', name: 'kite-summary.html', content: PAGE(1), context: 'One-page summary of the kite budget.' }),
    update({ action: 'create', name: LONG, content: '# Review\n\nEvery cost of the season.', context: 'The long review.' }),
    { tool: 'files_export', arguments: { format: 'pdf', title: 'Kite safety', markdown: '# Kite safety\n\nFly away from power lines.\n\n| Wind | Kite |\n| --- | --- |\n| Light | Delta |\n| Strong | Sled |' } },
  ], [text.id, sheet.id, picture.id]);
  const summary = await named('kite-summary.html');
  await turn(kite, 'Make two more drafts and share it.', [
    update({ action: 'write', id: summary.id, content: PAGE(2) }),
    update({ action: 'write', id: summary.id, content: PAGE(3) }),
    update({ action: 'share', id: summary.id, chat: mainChat }),
    update({ action: 'share', id: summary.id, chat: spars }),
    update({ action: 'share', id: summary.id, chat: fabric }),
  ]);
  assert.deepEqual((await named('kite-summary.html')).earlier, [2, 1], 'the page keeps two earlier versions');

  /** Two files for one width to delete: one shared with three chats for the dialog, two for the bulk delete. */
  async function disposable(tag) {
    await turn(kite, 'Some scratch notes.', [
      update({ action: 'create', name: `scratch-${tag}.md`, content: '# Scratch', context: 'Scratch notes to throw away.' }),
      update({ action: 'create', name: `draft-${tag}-a.txt`, content: 'a', context: 'A first draft.' }),
      update({ action: 'create', name: `draft-${tag}-b.txt`, content: 'b', context: 'A second draft.' }),
    ]);
    const scratchFile = await named(`scratch-${tag}.md`);
    await turn(kite, 'Share the scratch notes.', [update({ action: 'share', id: scratchFile.id, chat: spars }), update({ action: 'share', id: scratchFile.id, chat: reel })]);
    return scratchFile;
  }

  // ---- The browser.
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const errors = [];

  async function exercise(width, viewport, phone) {
    const scratchFile = await disposable(width);
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', acceptDownloads: true, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    context.setDefaultTimeout(15000);
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${width}: ${error}`));
    await signIn(page, origin);
    await page.locator('#loading').waitFor({ state: 'detached' });
    let shot = 0;
    const shoot = async (slug) => { shot += 1; await delay(300); await page.screenshot({ path: path.join(screens, `${width}-${String(shot).padStart(2, '0')}-${slug}.png`), animations: 'disabled' }); };
    const fits = async (note) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${note}: the page is wider than the window`);
    // Inside the dialog's own scroll a tap can land before Playwright's scroll settles, so the phone scrolls first.
    const tap = async (locator) => { if (!phone) return locator.click(); await locator.scrollIntoViewIfNeeded(); return locator.tap(); };
    const drawerOpen = async () => { if ((await page.locator('.workspace-shell').getAttribute('data-expanded')) !== 'true') await tap(page.locator('.chats-toggle')); };
    const lib = page.locator('.library');
    const rows = lib.locator('.library-list .file-row');
    const row = (name) => rows.filter({ has: page.locator('.file-row-name', { hasText: name }) });
    const dialog = page.locator('dialog.file-view[open]');
    const side = dialog.locator('.file-view-side');
    const showLibrary = async () => {
      if (phone) await drawerOpen();
      await tap(page.locator('.files-nav [data-place="files"]'));
      await lib.waitFor({ state: 'visible' });
      await until(async () => (await rows.count()) > 0, 'the library lists the files');
    };
    const openFile = async (name) => { await tap(row(name).locator('.file-row-open')); await dialog.waitFor(); await until(async () => (await dialog.locator('.file-view-name').innerText()) === name, `the dialog shows ${name}`); };
    const closeDialog = async () => { await dialog.locator('.file-view-close').click(); await dialog.waitFor({ state: 'detached' }); };

    // 1. The drawer leads to the library.
    if (phone) await drawerOpen();
    else {
      await page.locator('.files-nav').waitFor();
      await shoot('drawer-files');
      await page.locator('#jet-toggle').click();
      await until(async () => (await page.locator('.workspace-shell').getAttribute('data-expanded')) === 'false', 'the drawer folds to its rail');
      await page.locator('.files-nav [data-place="files"]').hover();
    }
    await shoot(phone ? 'drawer-files' : 'drawer-files-rail');
    if (!phone) { await page.locator('#jet-toggle').click(); await page.mouse.move(700, 450); }

    // 2. The library: every file across the chats, newest change first, a shared one with its chats in words.
    await showLibrary();
    assert.equal(new URL(page.url()).hash, '#files', 'the library has its own address');
    assert.equal(await page.locator('.files-nav [data-place="files"]').getAttribute('aria-current'), 'page');
    const names = (await library()).map((file) => file.name);
    await until(async () => (await rows.locator('.file-row-name').allInnerTexts()).join('|') === names.join('|'), 'the rows are the server\'s files in its order');
    assert.match(await row('kite-summary.html').innerText(), /HTML page · \d+ K?B · .* · Kite budget and 3 more/, 'a shared file names its keeper and counts the rest');
    assert.equal(await row(LONG).getAttribute('title'), LONG, 'a long name keeps its full text in the title');
    assert.match(await lib.locator('.library-usage').innerText(), /^\d+ KB of 256 MB used$/);
    await fits(`${width} library`);
    await page.mouse.move(0, 0);
    await shoot('library');

    // 3, 4. Search narrows as the user types; a search with no file says so and offers the way out.
    const search = lib.locator('.library-search');
    await search.fill('kite plan');
    await search.fill('SUMMARY');
    await until(async () => (await rows.count()) === 1, 'search finds the summary by name');
    await search.fill('spars');
    await until(async () => (await rows.locator('.file-row-name').allInnerTexts()).join() === `scratch-${width}.md,kite-summary.html`, 'search finds the files a chat holds by its title');
    await search.fill('budget');
    await until(async () => (await rows.count()) >= 3, 'search finds by name, note and chat title');
    await shoot('search');
    await search.fill('budgt');
    await lib.locator('.library-state', { hasText: 'No file matches “budgt”.' }).waitFor();
    await shoot('search-none');
    await search.press('Escape');
    await until(async () => (await rows.count()) === names.length, 'Escape clears the search');

    // 9. Choosing: two files, a zip of them, and the bulk delete that asks with its count.
    const tools = lib.locator('.library-tools');
    await tap(tools.getByRole('button', { name: 'Select', exact: true }));
    await tap(row(`draft-${width}-a.txt`).locator('.file-row-open'));
    await tap(row(`draft-${width}-b.txt`).locator('.file-row-open'));
    assert.equal(await tools.locator('.library-count').innerText(), '2 selected');
    assert.equal(await rows.locator('.file-row-download').count(), 0, 'a row offers no download while files are chosen');
    const [zip] = await Promise.all([page.waitForEvent('download'), tap(tools.getByRole('button', { name: 'Download as zip' }))]);
    assert.match(zip.suggestedFilename(), /^Jet files \d{4}-\d{2}-\d{2}\.zip$/);
    const zipped = await readFile(await zip.path());
    assert.ok(zipped.includes(Buffer.from(`draft-${width}-a.txt`)) && zipped.includes(Buffer.from(`draft-${width}-b.txt`)), 'the zip holds the two chosen files');
    await tap(tools.getByRole('button', { name: 'Delete', exact: true }));
    assert.equal(await tools.locator('.library-delete').innerText(), 'Delete 2 for good?');
    await shoot('choose-delete-armed');
    await tap(tools.locator('.library-delete'));
    await until(async () => (await row(`draft-${width}-a.txt`).count()) === 0 && (await row(`draft-${width}-b.txt`).count()) === 0, 'both chosen files are deleted');
    assert.equal(await tools.locator('.library-search').isVisible(), true, 'the toolbar is back once the delete is done');

    // 10. One dialog for every kind: a page in its sandboxed frame, a picture, a PDF in its frame, a workbook in words.
    await openFile('kite-summary.html');
    const outer = page.frameLocator('dialog.file-view iframe');
    await outer.frameLocator('iframe').getByRole('heading', { name: 'Kite budget summary' }).waitFor();
    assert.equal(await outer.locator('iframe').getAttribute('sandbox'), 'allow-scripts', 'the page keeps its sandbox');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close', 'the focus lands on Close');
    assert.match((await side.locator('.file-view-facts p').allInnerTexts()).join(' | '), /^HTML page · \d+ K?B \| Changed just now · version \d+ \| Written by Jet$/);
    await fits(`${width} dialog`);
    await shoot('dialog-html');
    if (!phone) {
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await shoot('focus-close');
    }
    await closeDialog();
    await openFile('kite-sketch.png');
    await until(async () => (await dialog.locator('.file-view-image').evaluate((img) => img.complete && img.naturalWidth)) === 480, 'the picture loads');
    await shoot('dialog-image');
    await closeDialog();
    await openFile('Kite safety.pdf');
    await delay(1500);
    await shoot('dialog-pdf');
    await closeDialog();
    await openFile('kite-costs.xlsx');
    assert.equal(await dialog.locator('.file-view-preview').innerText(), "Excel workbooks can't be shown here. Download it to open it.");
    await shoot('dialog-xlsx');
    await closeDialog();

    // 11. Rename: the stem is the field, the kind stays as text, Enter saves.
    const textName = (await library()).find((file) => file.id === text.id).name;
    await openFile(textName);
    await dialog.locator('.file-view-text pre', { hasText: 'cloth 24' }).waitFor();
    assert.equal(await dialog.locator('.file-view-preview iframe').count(), 0, 'text shows in the dialog itself, not in a frame');
    await shoot('dialog-text');
    await tap(dialog.getByRole('button', { name: `Rename ${textName}` }));
    const field = dialog.locator('.file-view-rename-input');
    assert.equal(await field.inputValue(), textName.replace(/\.txt$/, ''));
    await field.fill(`kite-budget-${width}`);
    await shoot('rename');
    await field.press('Enter');
    await until(async () => (await dialog.locator('.file-view-name').innerText()) === `kite-budget-${width}.txt`, 'the new name shows');
    assert.ok(await named(`kite-budget-${width}.txt`), 'the server keeps the new name');

    // 12. Add to a chat with the picker, then take it out again with Remove.
    await tap(side.getByRole('button', { name: 'Add to a chat' }));
    await side.locator('h3', { hasText: 'Add to a chat' }).waitFor();
    await shoot('picker');
    await tap(side.locator('.file-view-pick', { hasText: 'Reel' }));
    await side.getByRole('button', { name: 'Remove from Reel' }).waitFor();
    assert.deepEqual((await named(`kite-budget-${width}.txt`)).chats.toSorted(), [kite, reel].toSorted());
    await tap(side.getByRole('button', { name: 'Remove from Reel' }));
    await until(async () => (await side.getByRole('button', { name: /^Remove from/ }).count()) === 0, 'the file is back in one chat, which cannot be removed');
    assert.deepEqual((await named(`kite-budget-${width}.txt`)).chats, [kite]);
    await closeDialog();
    await openFile('kite-summary.html');
    await until(async () => / · /.test(await side.locator('.file-view-version').first().innerText()), 'the versions carry their times');
    await tap(side.getByRole('button', { name: 'Add to a chat' }));
    await tap(side.locator('.file-view-pick', { hasText: 'Reel' }));
    await side.getByRole('button', { name: 'Remove from Reel' }).waitFor();
    await tap(side.getByRole('button', { name: 'Add to a chat' }));
    await side.getByText('Every chat already holds this file.').waitFor();
    await shoot('picker-empty');
    await page.keyboard.press('Escape');
    await side.getByRole('button', { name: 'Add to a chat' }).waitFor();
    assert.equal(await dialog.count(), 1, 'Escape leaves the picker before the dialog');
    await tap(side.getByRole('button', { name: 'Remove from Reel' }));
    await until(async () => (await side.getByRole('button', { name: 'Remove from Reel' }).count()) === 0, 'the page leaves Reel again');

    // 13. Versions: restoring an earlier one writes a new version, so nothing is lost.
    const before = (await named('kite-summary.html')).version;
    await side.locator('.file-view-version', { hasText: 'Current' }).waitFor();
    await until(async () => / · /.test(await side.locator('.file-view-version').first().innerText()), 'the versions carry their times');
    await shoot('versions');
    await tap(side.getByRole('button', { name: 'Restore version 1' }));
    await until(async () => (await named('kite-summary.html')).version === before + 1, 'the restore made a new version');
    await until(async () => (await side.locator('.file-view-facts').innerText()).includes(`version ${before + 1}`), 'the dialog shows the new version');
    await outer.frameLocator('iframe').getByText('Draft 1: what the kite will cost.').waitFor();
    await closeDialog();

    // V2 delete_disarms_after_four_seconds: one tap arms, four seconds pass, nothing is deleted.
    await openFile(scratchFile.name);
    const deletes = [];
    page.on('request', (request) => { if (request.method() === 'DELETE') deletes.push(request.url()); });
    const remove = side.locator('.file-view-delete');
    await tap(remove);
    assert.equal(await remove.innerText(), 'Delete from 3 chats?');
    await shoot('delete-armed');
    await delay(4300);
    assert.equal(await remove.innerText(), 'Delete', 'the ask goes after four seconds');
    assert.deepEqual(deletes, [], 'one tap sends nothing');
    console.log(`PASS ${width} delete_disarms_after_four_seconds`);

    // V3 open_dialog_shows_removed_state: a second tab deletes the open file; this tab shows it gone within a second.
    const other = await context.newPage();
    await other.goto(origin + '/#files');
    await other.locator('#loading').waitFor({ state: 'detached' });
    const asked = [];
    page.on('request', (request) => { if (request.url().includes(scratchFile.id)) asked.push(request.url()); });
    await other.locator('.library .file-row', { hasText: scratchFile.name }).locator('.file-row-open').click();
    const otherRemove = other.locator('dialog.file-view[open] .file-view-delete');
    await otherRemove.click();
    await otherRemove.click();
    const deletedAt = Date.now();
    await dialog.locator('.file-view-preview', { hasText: 'This file was deleted.' }).waitFor();
    const took = Date.now() - deletedAt;
    assert.ok(took < 1000, `the open dialog learnt of the delete in ${took} ms`);
    assert.equal(await side.locator('.file-view-download').getAttribute('aria-disabled'), 'true', 'Download is off');
    assert.equal(await remove.isDisabled(), true, 'Delete is off');
    assert.equal(await dialog.locator('.file-view-rename').isDisabled(), true, 'Rename is off');
    assert.deepEqual(asked, [], 'this tab asked nothing of the deleted file');
    console.log(`PASS ${width} open_dialog_shows_removed_state in ${took} ms`);
    await shoot('deleted-while-open');
    await other.close();
    await closeDialog();
    await until(async () => (await row(scratchFile.name).count()) === 0, 'the library drops the deleted file');

    // 14 on the record: the ask names the chats the delete takes the file out of; it was shot above as delete-armed.
    // 16. The plan pane's Files: the same rows, and the way to all files. Back leaves the library first.
    await page.goBack();
    await lib.waitFor({ state: 'hidden' });
    assert.equal(new URL(page.url()).hash, '', 'back returns to the chat');
    if (phone) await drawerOpen();
    await tap(page.locator('.chat-row', { hasText: 'Kite budget' }).locator('.chat-open'));
    await until(async () => (await page.locator('.chat-head').innerText()).includes('Kite budget'), 'the kite chat opens');
    if (phone && (await page.locator('#side-pane').isHidden())) await tap(page.locator('.pane-toggle'));
    const paneFiles = page.locator('#side-pane .pane-section', { has: page.locator('.pane-heading', { hasText: 'Files' }) });
    await paneFiles.waitFor();
    assert.match(await paneFiles.locator('.pane-heading').innerText(), /Files\s*\d+/);
    assert.match(await paneFiles.locator('.file-row', { hasText: 'kite-summary.html' }).textContent(), /Kite budget and 3 more/);
    await paneFiles.scrollIntoViewIfNeeded();
    await shoot('pane-files');
    await tap(paneFiles.getByRole('button', { name: 'All files' }));
    await lib.waitFor({ state: 'visible' });
    await page.goBack();
    await lib.waitFor({ state: 'hidden' });

    // 17. The thread card opens the same dialog; a card whose file is deleted says so and offers nothing.
    if (phone && (await page.locator('#side-pane').isVisible())) await tap(page.locator('#side-pane .pane-close'));
    const card = page.locator('.card-file', { hasText: 'kite-summary.html' }).first();
    await card.scrollIntoViewIfNeeded();
    await shoot('card');
    await tap(card.getByRole('link', { name: 'Open kite-summary.html' }));
    await dialog.waitFor();
    await shoot('card-dialog');
    await closeDialog();
    const goneCard = page.locator('.card-file', { hasText: `draft-${width}-a.txt` });
    await goneCard.scrollIntoViewIfNeeded();
    assert.equal(await goneCard.locator('.file-meta').innerText(), 'This file was deleted.');
    assert.equal(await goneCard.locator('a').count(), 0, 'a deleted file offers no Open or Download');

    // A file sent through the message field and a file Jet writes in that turn never read as deleted, from the moment
    // they are drawn until the reply ends.
    const sentName = `sent-${width}.txt`, writtenName = `written-${width}.md`;
    await page.evaluate((names) => {
      window.shownGone = [];
      const look = () => {
        for (const el of document.querySelectorAll('.attach-chip, .attach-thumb, .card-file')) {
          const words = el.textContent;
          if (names.some((name) => words.includes(name)) && (words.includes('This file was deleted.') || el.dataset.gone === 'true')) window.shownGone.push(words);
        }
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    }, [sentName, writtenName]);
    await page.locator('#attach-input').setInputFiles({ name: sentName, mimeType: 'text/plain', buffer: Buffer.from('Sent through the message field.\n') });
    await page.locator('#tray [data-state="ready"]').waitFor();
    await rm(path.join(data, 'facade-results.json'), { force: true });
    await page.locator('#field').fill(`Keep this note.\nfacade:${JSON.stringify([update({ action: 'create', name: writtenName, content: '# Written', context: 'Written in the turn.' })])}`);
    await tap(page.locator('#send'));
    const sentChip = page.locator('#rows a.attach-chip', { hasText: sentName });
    await sentChip.waitFor();
    const writtenCard = page.locator('.card-file', { hasText: writtenName });
    await writtenCard.getByRole('link', { name: `Open ${writtenName}` }).waitFor();
    await until(async () => { try { return JSON.parse(await readFile(path.join(data, 'facade-results.json'), 'utf8')).length === 1; } catch { return false; } }, 'the turn with the sent file ends');
    await until(async () => !(await page.locator('#send[aria-label="Stop"]').count()), 'the reply ends');
    await delay(1500);
    assert.deepEqual(await page.evaluate(() => window.shownGone), [], 'a file just sent or just written never read as deleted');
    assert.ok(await sentChip.getAttribute('href'), 'the sent file opens');
    await writtenCard.scrollIntoViewIfNeeded();
    await shoot('sent-card');

    // An upload left in the tray goes when the page does, so it never takes room that the library cannot show.
    const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/files');
    await page.locator('#attach-input').setInputFiles({ name: `unsent-${width}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Never sent.\n') });
    const unsent = await (await uploaded).json();
    await page.locator('#tray [data-state="ready"]').waitFor();
    await page.reload();
    await page.locator('#loading').waitFor({ state: 'detached' });
    await until(async () => (await fetch(`${origin}/api/files/${unsent.id}`, { headers: { cookie } })).status === 404, 'the unsent upload is gone after a reload');

    // 18. The focus ring on a row (desktop).
    if (!phone) {
      await showLibrary();
      await lib.locator('.library-search').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await shoot('focus-row');

      // A file deleted from its dialog by keyboard leaves the focus on Close, and then on the next row.
      await turn(kite, 'One more note.', [update({ action: 'create', name: `keyed-${width}.md`, content: '# Keyed', context: 'A note to delete by keyboard.' })]);
      await until(async () => (await row(`keyed-${width}.md`).count()) === 1, 'the library lists the new note');
      await row(`keyed-${width}.md`).locator('.file-row-open').focus();
      await page.keyboard.press('Enter');
      await dialog.waitFor();
      await side.locator('.file-view-delete').focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await until(async () => (await row(`keyed-${width}.md`).count()) === 0, 'the note is deleted');
      await until(async () => page.evaluate(() => document.activeElement?.classList.contains('file-view-close')), 'the focus is on Close after the delete');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await until(async () => page.evaluate(() => Boolean(document.activeElement?.closest('.library'))), 'the focus returns into the library');
      console.log(`PASS ${width} keyboard_delete_keeps_the_focus`);
    }

    // 5-8. States of a server in trouble, drawn from a changed answer.
    const answer = await call('GET', '/api/files');
    let loads = 0;
    // A new query makes a full load; a change of the hash alone would keep the page.
    const reopen = async () => { loads += 1; await page.goto(`${origin}/?load=${loads}#files`); await page.locator('#loading').waitFor({ state: 'detached' }); await lib.waitFor({ state: 'visible' }); };
    const answering = async (body, status = 200) => page.route(/\/api\/files$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }) : route.continue()));
    await answering({ files: [], usedBytes: 0, limitBytes: answer.limitBytes });
    await reopen();
    await lib.locator('.library-state', { hasText: 'No files yet' }).waitFor();
    assert.equal(await lib.getByRole('button', { name: 'Select', exact: true }).isDisabled(), true);
    await shoot('empty');
    await page.unroute(/\/api\/files$/);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(/\/api\/files$/, async (route) => { await held; await route.continue().catch(() => {}); });
    await reopen();
    await lib.locator('.file-row.is-skeleton').first().waitFor();
    assert.equal(await lib.locator('.library-list').getAttribute('aria-busy'), 'true');
    await shoot('loading');
    release();
    await page.unroute(/\/api\/files$/);
    await answering({ kind: 'io', message: 'the store could not be read' }, 500);
    await reopen();
    await lib.locator('.library-state', { hasText: 'Files could not be loaded.' }).waitFor();
    await shoot('failed');
    await page.unroute(/\/api\/files$/);
    await tap(lib.getByRole('button', { name: 'Try again' }));
    await until(async () => (await rows.count()) > 0, 'Try again reads the files');
    for (const [share, slug] of [[0.92, 'usage-92'], [1, 'usage-full']]) {
      await page.unroute(/\/api\/files$/);
      await answering({ ...answer, usedBytes: Math.round(answer.limitBytes * share) });
      await reopen();
      await until(async () => (await rows.count()) > 0, 'the files show');
      await shoot(slug);
    }
    assert.match(await lib.locator('.library-usage').innerText(), /^No room left for files\. Delete files to make room\.$/);
    await page.unroute(/\/api\/files$/);
    await fits(`${width} states`);

    // After a reload no list has held the deleted drafts, so the page asks the server, and their cards read deleted.
    await reopen();
    if (phone) await drawerOpen();
    await tap(page.locator('.chat-row', { hasText: 'Kite budget' }).locator('.chat-open'));
    const reloadedGone = page.locator('.card-file', { hasText: `draft-${width}-a.txt` });
    await reloadedGone.locator('.file-meta', { hasText: 'This file was deleted.' }).waitFor();
    assert.equal(await page.locator('.card-file', { hasText: writtenName }).locator('a').count(), 2, 'a file that is there keeps Open and Download after a reload');
    await context.close();
  }

  await exercise('1440', { width: 1440, height: 900 }, false);
  await exercise('390', { width: 390, height: 844 }, true);
  assert.deepEqual(errors, []);
  console.log('PASS files_library_dialog_and_states_at_1440_and_390');
  console.log('Screenshots: ' + screens);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(screens, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close();
  await processes.close();
  if (!process.env.SCREENSHOT_DIR) await rm(scratch, { recursive: true, force: true });
}
