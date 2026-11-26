// Drives the settings window of the real page against the real server and the provider stand-in: a modal with a menu
// that shows each section, the banner's Settings action, a setting that saves and survives a reload, Escape and the
// backdrop, Tab kept inside, focus back on the opener, the list-then-section view at 400 px, and the MCP section
// adding, testing, turning off and on and removing servers against a local MCP stand-in. It saves the window in light
// and dark at 1280 and 400 px, and the MCP section's states at both widths.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProcesses, saveOwnerSettings, signIn, until } from './process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'jet-settings-'));
const screens = process.env.SCREENSHOT_DIR ?? path.join(scratch, 'screens');
await mkdir(screens, { recursive: true });
const processes = createProcesses();
// Each menu entry and the heading its section opens with; Voice holds the input and the output.
const SECTIONS = [
  ['Persona', 'Persona'], ['Model and thinking', 'Model and thinking'], ['Voice', 'Voice input'], ['Motion', 'Motion'],
  ['Memory', 'Memory'], ['GitHub', 'GitHub'], ['MCP', 'MCP servers'], ['Agent programs', 'Agent programs'],
  ['Forget this conversation', 'Forget this conversation'],
];
const MCP_KEY = 'drive-key-7731';

/** A small MCP server that answers only requests that carry its key, with three tools. */
async function startMcpStandIn() {
  const tools = ['search_pages', 'read_page', 'append_note'].map((name) => ({ name, description: 'Stand-in tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: name !== 'append_note' } }));
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ' + MCP_KEY) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' });
      return response.end();
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (!Object.hasOwn(message, 'id')) {
      response.writeHead(202);
      return response.end();
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', serverInfo: { name: 'stand-in', version: '1' }, capabilities: { tools: {} } }
      : { tools };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

let browser, page, mcpStandIn;
try {
  mcpStandIn = await startMcpStandIn();
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
  // The server starts with a program path that leads nowhere, so the page opens with the banner that points to Settings.
  await saveOwnerSettings(origin, { model: 'sonnet', claudePath: path.join(scratch, 'missing-claude'), reducedMotion: true });

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY, headless: true });
  const errors = [];

  async function openPage(viewport, colorScheme, phone) {
    const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce', ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    context.setDefaultTimeout(15000);
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${viewport.width}: ${error}`));
    await signIn(page, origin);
    await page.locator('#loading').waitFor({ state: 'detached' });
    return context;
  }
  const settingsDialog = () => page.getByRole('dialog', { name: 'Settings' });
  const entry = (label) => settingsDialog().getByRole('button', { name: label, exact: true });
  const shownHeadings = () => settingsDialog().locator('.settings-panel:not([hidden]) h3').allInnerTexts();
  const focusInside = () => page.evaluate(() => document.querySelector('#settings').contains(document.activeElement));
  const gearFocused = () => page.evaluate(() => document.activeElement === document.querySelector('#gear'));
  // The label of a counted field also holds its counter, so the field is found by the words of its label alone.
  const nameField = () => settingsDialog().locator('#settings-persona label.field', { has: page.locator('.field-label', { hasText: /^Name$/ }) }).locator('input');
  const shoot = (name) => page.screenshot({ path: path.join(screens, name), animations: 'disabled' });
  const openFromGear = async (phone) => {
    if (phone && (await page.locator('.workspace-shell').getAttribute('data-expanded')) !== 'true') await page.locator('.chats-toggle').click();
    await page.locator('#gear').click();
    await settingsDialog().waitFor();
  };
  const staysInside = async (where) => {
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let step = 0; step < 24; step += 1) {
        await page.keyboard.press(key);
        assert.ok(await focusInside(), `${where}: ${key} number ${step + 1} keeps the focus inside the window`);
      }
    }
  };
  const closed = async () => {
    await settingsDialog().waitFor({ state: 'hidden' });
    assert.ok(await gearFocused(), 'closing gives the focus back to the gear');
  };

  // ---- 1280 px, dark.
  let context = await openPage({ width: 1280, height: 800 }, 'dark', false);

  // The banner's Settings action opens the window on Agent programs; a right path there saves and clears the banner.
  const bannerAction = page.locator('#banner button', { hasText: 'Settings' });
  await bannerAction.click();
  await settingsDialog().waitFor();
  assert.equal(await entry('Agent programs').getAttribute('aria-current'), 'true', 'the banner opens on Agent programs');
  assert.deepEqual(await shownHeadings(), ['Agent programs']);
  await settingsDialog().getByLabel('Path to claude').fill(provider);
  await settingsDialog().locator('.settings-saved', { hasText: 'Saved' }).waitFor();
  await settingsDialog().locator('.status[data-found="true"]').waitFor();
  await until(async () => !(await bannerAction.isVisible()), 'the banner goes once the program is found');
  console.log('PASS banner_settings_opens_agent_programs');
  // The banner and its button are gone, so the rest opens from the gear.
  await page.keyboard.press('Escape');
  await settingsDialog().waitFor({ state: 'hidden' });
  await openFromGear(false);

  // The window is a modal dialog: the page behind it is inert.
  assert.ok(await settingsDialog().evaluate((el) => el.matches(':modal')), 'the settings open as a modal dialog');
  for (const [label, heading] of SECTIONS) {
    await entry(label).click();
    assert.equal(await entry(label).getAttribute('aria-current'), 'true', `${label} is the chosen entry`);
    assert.equal((await shownHeadings())[0], heading, `${label} shows its own section alone`);
  }
  await entry('Persona').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await entry('Model and thinking').getAttribute('aria-current'), 'true', 'the arrow keys move along the menu');
  await page.keyboard.press('ArrowUp');
  console.log('PASS each_menu_entry_shows_its_section');

  // Tab and Shift+Tab go round the window and never leave it: on a section with fields, and on Motion, whose one
  // switch the emulated system setting locks, so the menu holds the last stop.
  await staysInside('Persona');
  await entry('Motion').click();
  assert.ok(await settingsDialog().getByRole('switch').isDisabled(), 'the system setting locks the motion switch');
  await staysInside('Motion');
  await entry('Persona').click();
  await page.mouse.move(0, 0);
  await shoot('settings-1280-dark.png');
  await page.keyboard.press('Escape');
  await closed();
  console.log('PASS escape_closes_and_focus_returns_to_the_gear');

  // A press on the backdrop closes the window; a drag that starts in a field and ends outside does not.
  await openFromGear(false);
  assert.equal(await entry('Persona').getAttribute('aria-current'), 'true', 'the window opens on the section chosen last');
  const name = nameField();
  const box = await name.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(8, 8);
  await page.mouse.up();
  assert.ok(await settingsDialog().isVisible(), 'a drag out of a field keeps the window open');
  await page.mouse.click(8, 8);
  await closed();
  console.log('PASS backdrop_click_closes');

  // A changed setting saves itself, renames Jet on the page, and survives a reload.
  await openFromGear(false);
  await name.fill('Kestrel');
  await settingsDialog().locator('.settings-saved', { hasText: 'Saved' }).waitFor();
  assert.equal(await page.locator('#drawer-name').innerText(), 'Kestrel', 'the page takes the new name at once');
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'detached' });
  await openFromGear(false);
  assert.equal(await nameField().inputValue(), 'Kestrel', 'the name survives a reload');
  assert.equal((await (await context.request.get(origin + '/api/settings')).json()).persona.name, 'Kestrel');
  console.log('PASS changed_setting_survives_reload');
  await page.keyboard.press('Escape');
  await closed();

  // ---- The MCP section, wide: empty, then a server with its key, one with a wrong key and one with none.
  const mcp = (selector) => settingsDialog().locator('#settings-mcp ' + selector);
  const serverRow = (name) => mcp('.mcp-server').filter({ has: page.locator('.mcp-name', { hasText: name }) });
  const keysSent = [];
  // The stand-in answers on any path, so each server gets its own address.
  const addServer = async (name, key, path = 'mcp') => {
    if (await mcp('form').isHidden()) await mcp('button:text-is("Add a server")').click();
    await mcp('form label:has(> .field-label:text-is("Provider")) select').selectOption('custom');
    await mcp('form label:has(> .field-label:text-is("Name")) input').fill(name);
    await mcp('form label:has(> .field-label:text-is("Address")) input').fill(mcpStandIn.url + path);
    await mcp('form label:has(> .field-label:text-is("Key")) select').selectOption(key === null ? 'none' : 'bearer');
    if (key !== null) await mcp('form label:has(> .field-label:text-is("Token")) input').fill(key);
    await mcp('button:text-is("Add and test")').click();
    await serverRow(name).waitFor();
  };
  const stateOf = (name) => serverRow(name).locator('.mcp-state').innerText();
  const driveMcp = async (width) => {
    page.on('response', async (response) => {
      if (response.url().includes('/api/mcp/')) keysSent.push(await response.text().catch(() => ''));
    });
    await entry('MCP').click();
    await mcp('.note').filter({ hasText: 'No servers yet' }).waitFor();
    assert.ok(await settingsDialog().locator('.settings-saved').isHidden(), `${width}: the MCP section does not say changes save as you type`);
    assert.ok(await mcp('form').isVisible(), `${width}: with no servers the add form is open`);
    const oauth = mcp('.note').filter({ hasText: 'Signing in with OAuth is not built yet' });
    assert.ok(await oauth.isVisible(), `${width}: the form says plainly that OAuth sign-in is not built`);
    await mcp('form label:has(> .field-label:text-is("Provider")) select').selectOption('notion');
    assert.equal(await mcp('form label:has(> .field-label:text-is("Address")) input').inputValue(), 'https://mcp.notion.com/mcp', 'Notion fills in its address');
    await page.mouse.move(0, 0);
    await shoot(`settings-mcp-empty-${width}.png`);
    // Slack accepts only an OAuth sign-in, and both its note and the form say that Jet cannot do one yet.
    await mcp('form label:has(> .field-label:text-is("Provider")) select').selectOption('slack');
    await mcp('.note').filter({ hasText: 'Slack accepts only an OAuth sign-in' }).waitFor();
    await shoot(`settings-mcp-oauth-${width}.png`);

    await addServer('Team wiki', MCP_KEY);
    await until(async () => (await stateOf('Team wiki')) === 'Connected', `${width}: the server with its key connects`);
    assert.equal(await serverRow('Team wiki').locator('summary').innerText(), '3 tools');
    await serverRow('Team wiki').getByRole('button', { name: 'Test connection' }).click();
    await until(async () => (await stateOf('Team wiki')) === 'Connected', `${width}: the test connects again`);
    console.log(`PASS mcp_add_and_test_${width}`);

    await serverRow('Team wiki').getByRole('switch').click();
    await until(async () => (await stateOf('Team wiki')) === 'Off', `${width}: the server turns off`);
    assert.ok(await serverRow('Team wiki').getByRole('switch').evaluate((el) => el === document.activeElement), `${width}: the focus stays on the switch`);
    assert.ok(await serverRow('Team wiki').getByRole('button', { name: 'Test connection' }).isHidden(), 'an off server has no test');
    await serverRow('Team wiki').getByRole('switch').click();
    await until(async () => (await stateOf('Team wiki')) === 'Connected', `${width}: the server turns on and connects`);
    console.log(`PASS mcp_turn_off_and_on_${width}`);

    if (width === 1280) {
      // The other states, side by side: a key the server refuses, and no key at all.
      await addServer('Wrong key', 'not-the-key', 'wrong/mcp');
      await until(async () => (await stateOf('Wrong key')) === 'Failed', 'a wrong key fails');
      assert.match(await serverRow('Wrong key').locator('.mcp-detail').innerText(), /refused the key/);
      await addServer('No key', null, 'open/mcp');
      await until(async () => (await stateOf('No key')) === 'Needs a sign-in or key', 'no key needs a sign-in or key');
      await page.mouse.move(0, 0);
      await shoot('settings-mcp-states-1280.png');
      for (const name of ['Wrong key', 'No key']) {
        await serverRow(name).getByRole('button', { name: 'Remove', exact: true }).click();
        await serverRow(name).getByRole('group').getByRole('button', { name: 'Remove', exact: true }).click();
        await serverRow(name).waitFor({ state: 'detached' });
      }
    } else {
      await shoot('settings-mcp-400.png');
      assert.ok(await page.evaluate(() => document.querySelector('.settings-pane').scrollWidth <= innerWidth), 'the MCP section fits the width');
    }
    await serverRow('Team wiki').getByRole('button', { name: 'Remove', exact: true }).click();
    await serverRow('Team wiki').getByRole('group').getByRole('button', { name: 'Remove', exact: true }).click();
    await serverRow('Team wiki').waitFor({ state: 'detached' });
    await mcp('.note').filter({ hasText: 'No servers yet' }).waitFor();
    console.log(`PASS mcp_remove_${width}`);
    assert.ok(keysSent.length > 0 && keysSent.every((text) => !text.includes(MCP_KEY)), 'no answer to the page holds the key');
  };
  await openFromGear(false);
  await driveMcp(1280);
  await page.keyboard.press('Escape');
  await closed();
  await context.close();

  // ---- 1280 px, light.
  context = await openPage({ width: 1280, height: 800 }, 'light', false);
  await openFromGear(false);
  await entry('Model and thinking').click();
  await page.mouse.move(0, 0);
  await shoot('settings-1280-light.png');
  await context.close();

  // ---- 400 px: the window fills the screen, and the menu and the section take turns.
  for (const colorScheme of ['dark', 'light']) {
    context = await openPage({ width: 400, height: 800 }, colorScheme, true);
    await openFromGear(true);
    const frame = await settingsDialog().boundingBox();
    assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [0, 0, 400, 800], 'the window fills a narrow screen');
    assert.ok(await settingsDialog().locator('.settings-nav').isVisible() && !(await settingsDialog().locator('.settings-pane').isVisible()), 'a narrow window opens on the menu');
    for (const [label] of SECTIONS) assert.ok((await entry(label).boundingBox()).height >= 44, `${label} is big enough for a finger`);
    if (colorScheme === 'dark') await shoot('settings-400-dark.png');
    await staysInside('the narrow menu');
    await entry('Voice').tap();
    assert.deepEqual((await shownHeadings()).slice(0, 2), ['Voice input', 'Voice output']);
    assert.ok(!(await settingsDialog().locator('.settings-nav').isVisible()), 'the section takes the whole window');
    assert.ok(await page.evaluate(() => document.querySelector('.settings-pane').scrollWidth <= innerWidth), 'the section fits the width');
    if (colorScheme === 'light') await shoot('settings-400-light.png');
    await settingsDialog().getByRole('button', { name: 'All settings' }).tap();
    assert.ok(await entry('Voice').evaluate((el) => el === document.activeElement), 'back returns to the entry it left');
    if (colorScheme === 'dark') {
      await driveMcp(400);
      await settingsDialog().getByRole('button', { name: 'All settings' }).tap();
    }
    await page.keyboard.press('Escape');
    await closed();
    await context.close();
  }
  console.log('PASS narrow_window_lists_then_shows_a_section');

  assert.deepEqual(errors, []);
  console.log('Screenshots: ' + screens);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(screens, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  mcpStandIn?.server.close();
  await processes.close();
  if (!process.env.SCREENSHOT_DIR) await rm(scratch, { recursive: true, force: true });
}
