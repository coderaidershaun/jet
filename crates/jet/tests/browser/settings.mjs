// Drives the settings window of the real page against the real server and the provider stand-in: a modal with a menu
// that shows each section, the banner's Settings action, a setting that saves and survives a reload, Escape and the
// backdrop, Tab kept inside, focus back on the opener, the list-then-section view at 400 px, and the MCP section
// adding, testing, turning off and on, signing in and out with OAuth and removing servers against a local MCP stand-in
// that is also its own sign-in server. It saves the window in light and dark at 1280 and 400 px, and the MCP section's
// states at both widths.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

const CONSOLE_CLIENT = 'console-client-4410';
const CONSOLE_SECRET = 'console-secret-9182';

/**
 * A small MCP server with three tools. Below /oauth/ and /console/ it is guarded by OAuth and is its own sign-in
 * server, which approves each sign-in at once; /console/ lets no client register, so it takes only a client made in
 * its "console". Anywhere else it answers only requests that carry its key.
 */
async function startMcpStandIn() {
  const tools = ['search_pages', 'read_page', 'append_note'].map((name) => ({ name, description: 'Stand-in tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: name !== 'append_note' } }));
  const live = new Set();
  const codes = new Map();
  const secrets = [CONSOLE_SECRET];
  let origin = '';
  const send = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };
  const mint = (kind) => {
    const made = kind + '-' + Math.random().toString(36).slice(2);
    secrets.push(made);
    return made;
  };
  /** The sign-in server's part: metadata, registration, the sign-in page and the token endpoint. */
  const signIn = (request, response, url, body) => {
    const known = /^\/(?:\.well-known\/oauth-(?:protected-resource|authorization-server)\/)?(oauth|console)\//.exec(url.pathname);
    if (known === null) return false;
    const realm = known[1];
    const issuer = `${origin}/${realm}/auth`;
    const form = Object.fromEntries(new URLSearchParams(body));
    switch (url.pathname.replace(`/${realm}/`, '/~/')) {
      case '/.well-known/oauth-protected-resource/~/mcp':
        send(response, 200, { resource: `${origin}/${realm}/mcp`, authorization_servers: [issuer], scopes_supported: ['docs.read'] });
        return true;
      case '/.well-known/oauth-authorization-server/~/auth': {
        const document = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', code_challenge_methods_supported: ['S256'] };
        send(response, 200, realm === 'oauth' ? { ...document, registration_endpoint: issuer + '/register' } : document);
        return true;
      }
      case '/~/auth/register':
        send(response, 201, { client_id: 'client-' + Math.random().toString(36).slice(2) });
        return true;
      case '/~/auth/authorize': {
        const query = Object.fromEntries(url.searchParams);
        if (query.resource !== `${origin}/${realm}/mcp` || query.code_challenge_method !== 'S256' || !query.state) return send(response, 400, { error: 'invalid_request' }), true;
        const code = mint('code');
        codes.set(code, query.code_challenge);
        const back = new URL(query.redirect_uri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', query.state);
        response.writeHead(302, { Location: back.toString() });
        response.end();
        return true;
      }
      case '/~/auth/token': {
        const challenge = codes.get(form.code);
        codes.delete(form.code);
        const verified = challenge !== undefined && createHash('sha256').update(form.code_verifier ?? '').digest('base64url') === challenge;
        const consoleClient = request.headers.authorization === 'Basic ' + Buffer.from(`${CONSOLE_CLIENT}:${CONSOLE_SECRET}`).toString('base64');
        if (!verified || !form.resource || (realm === 'console' && !consoleClient)) return send(response, 400, { error: 'invalid_grant' }), true;
        if (form.code_verifier) secrets.push(form.code_verifier);
        const access = mint('access');
        live.add(access);
        send(response, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: mint('refresh') });
        return true;
      }
      default:
        return false;
    }
  };
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, origin);
    if (signIn(request, response, url, body)) return;
    const guarded = /^\/(oauth|console)\/mcp$/.exec(url.pathname);
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const allowed = guarded ? live.has(token) : request.headers.authorization === 'Bearer ' + MCP_KEY;
    if (!allowed) {
      const metadata = guarded ? `${origin}/.well-known/oauth-protected-resource/${guarded[1]}/mcp` : 'http://127.0.0.1/.well-known/oauth-protected-resource';
      response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${metadata}"` });
      return response.end();
    }
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
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin + '/', secrets };
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

  // A model saved elsewhere, by another tab or the /model command, is not put back by this page's next save.
  const savedSettings = async () => (await context.request.get(origin + '/api/settings')).json();
  const elsewhere = await context.request.put(origin + '/api/settings', { headers: { origin }, data: { ...(await savedSettings()), model: 'opus' } });
  assert.equal(elsewhere.status(), 200, 'the other tab saved the model');
  await openFromGear(false);
  await nameField().fill('Merlin');
  await settingsDialog().locator('.settings-saved', { hasText: 'Saved' }).waitFor();
  const afterSave = await savedSettings();
  assert.deepEqual([afterSave.model, afterSave.persona.name], ['opus', 'Merlin'], 'the save kept the model saved elsewhere');
  console.log('PASS a_save_keeps_a_setting_saved_elsewhere');

  // An edit made a moment before the page reloads is saved all the same.
  await nameField().fill('Osprey');
  await page.waitForTimeout(100);
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'detached' });
  await until(async () => (await savedSettings()).persona.name === 'Osprey', 'the edit made 100 ms before the reload was saved');
  console.log('PASS an_edit_just_before_a_reload_is_saved');

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
    await mcp('form label:has(> .field-label:text-is("How Jet signs in")) select').selectOption(key === null ? 'signin' : 'bearer');
    if (key !== null) await mcp('form label:has(> .field-label:text-is("Token")) input').fill(key);
    await mcp(key === null ? 'button:text-is("Add")' : 'button:text-is("Add and test")').click();
    await serverRow(name).waitFor();
  };
  /** Taps Sign in, or the Sign in of the client fields, and waits for the sign-in tab to come back and close itself. */
  const signInThrough = async (button, whileWaiting = async () => {}) => {
    // The provider's page is held until `whileWaiting` is done, so the row can be seen waiting.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const hold = async (route) => {
      await held;
      await route.continue();
    };
    await page.context().route('**/auth/authorize?**', hold);
    const opened = page.context().waitForEvent('page');
    await button.click();
    const tab = await opened;
    await whileWaiting();
    release();
    await until(async () => tab.isClosed(), 'the sign-in tab closes itself once Jet has the tokens');
    await page.context().unroute('**/auth/authorize?**', hold);
  };
  const stateOf = (name) => serverRow(name).locator('.mcp-state').innerText();
  const driveMcp = async (width) => {
    page.context().on('response', async (response) => {
      if (!/\/api\/mcp\/|\/mcp-signin\//.test(response.url())) return;
      try {
        keysSent.push(await response.text());
      } catch (error) {
        // The sign-in tab closes itself as soon as its page loads, so that page is often gone before it is read; the
        // integration tests read it instead.
        if (!response.url().includes('/mcp-signin/')) throw error;
      }
    });
    await entry('MCP').click();
    await mcp('.note').filter({ hasText: 'No servers yet' }).waitFor();
    assert.ok(await settingsDialog().locator('.settings-saved').isHidden(), `${width}: the MCP section does not say changes save as you type`);
    assert.ok(await mcp('form').isVisible(), `${width}: with no servers the add form is open`);
    assert.equal(await mcp('form label:has(> .field-label:text-is("How Jet signs in")) select').inputValue(), 'signin', `${width}: signing in is offered first`);
    assert.match(await mcp('form .mcp-redirect-address').innerText(), /^http:\/\/127\.0\.0\.1:\d+\/mcp-signin\/return$/, `${width}: the form shows the redirect address`);
    await mcp('form label:has(> .field-label:text-is("Provider")) select').selectOption('notion');
    assert.equal(await mcp('form label:has(> .field-label:text-is("Address")) input').inputValue(), 'https://mcp.notion.com/mcp', 'Notion fills in its address');
    await page.mouse.move(0, 0);
    await shoot(`settings-mcp-empty-${width}.png`);
    // Slack lets no client register itself, and its note says what to make in its console.
    await mcp('form label:has(> .field-label:text-is("Provider")) select').selectOption('slack');
    await mcp('.note').filter({ hasText: 'Slack does not let Jet register itself' }).waitFor();
    await shoot(`settings-mcp-oauth-${width}.png`);

    // A server that offers only an OAuth sign-in: added, signed in from its own button, then signed out.
    await addServer('Docs', null, 'oauth/mcp');
    await until(async () => (await stateOf('Docs')) === 'Needs sign-in', `${width}: the OAuth server waits for a sign-in`);
    const signInButton = serverRow('Docs').getByRole('button', { name: 'Sign in', exact: true });
    assert.ok(await signInButton.evaluate((el) => el === document.activeElement), `${width}: the focus is on Sign in after adding`);
    await page.mouse.move(0, 0);
    await shoot(`settings-mcp-needs-signin-${width}.png`);
    await signInThrough(signInButton, async () => {
      await until(async () => (await stateOf('Docs')) === 'Waiting for you to sign in…', `${width}: the row waits for the sign-in tab`);
      await page.bringToFront();
      await page.mouse.move(0, 0);
      await shoot(`settings-mcp-waiting-${width}.png`);
    });
    await until(async () => (await stateOf('Docs')) === 'Connected', `${width}: the server connects once signed in`);
    assert.equal(await serverRow('Docs').locator('.mcp-key-words').innerText(), 'Signed in');
    assert.equal(await serverRow('Docs').locator('summary').innerText(), '3 tools');
    await page.mouse.move(0, 0);
    await shoot(`settings-mcp-signed-in-${width}.png`);
    await serverRow('Docs').getByRole('button', { name: 'Sign out' }).click();
    await until(async () => (await stateOf('Docs')) === 'Needs sign-in', `${width}: signing out forgets the sign-in`);
    console.log(`PASS mcp_sign_in_and_out_${width}`);
    await serverRow('Docs').getByRole('button', { name: 'Remove', exact: true }).click();
    await serverRow('Docs').getByRole('group').getByRole('button', { name: 'Remove', exact: true }).click();
    await serverRow('Docs').waitFor({ state: 'detached' });

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

    // A provider that lets no client register: Jet asks for a client made in its console, then signs in with it.
    await addServer('Mail', null, 'console/mcp');
    await until(async () => (await stateOf('Mail')) === 'Needs sign-in', `${width}: the console server waits for a sign-in`);
    await serverRow('Mail').getByRole('button', { name: 'Sign in', exact: true }).click();
    const client = serverRow('Mail').getByRole('group', { name: 'Client for Mail' });
    await client.waitFor();
    assert.match(await client.innerText(), /does not let Jet register itself/);
    await until(async () => page.context().pages().length === 1, `${width}: the tab opened for the sign-in closes when there is no page to show`);
    await client.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await shoot(`settings-mcp-client-${width}.png`);
    await client.getByLabel('Client id').fill(CONSOLE_CLIENT);
    await client.getByLabel('Client secret, if it has one').fill(CONSOLE_SECRET);
    await signInThrough(client.getByRole('button', { name: 'Sign in', exact: true }));
    await until(async () => (await stateOf('Mail')) === 'Connected', `${width}: the console client signs in`);
    console.log(`PASS mcp_sign_in_with_a_console_client_${width}`);
    await serverRow('Mail').getByRole('button', { name: 'Remove', exact: true }).click();
    await serverRow('Mail').getByRole('group').getByRole('button', { name: 'Remove', exact: true }).click();
    await serverRow('Mail').waitFor({ state: 'detached' });

    if (width === 1280) {
      // The other states, side by side: a key the server refuses, and no key at all.
      await addServer('Wrong key', 'not-the-key', 'wrong/mcp');
      await until(async () => (await stateOf('Wrong key')) === 'Failed', 'a wrong key fails');
      assert.match(await serverRow('Wrong key').locator('.mcp-detail').innerText(), /refused the key/);
      await addServer('No key', null, 'open/mcp');
      await until(async () => (await stateOf('No key')) === 'Needs sign-in', 'no key needs a sign-in');
      await serverRow('Wrong key').scrollIntoViewIfNeeded();
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
    const hidden = [MCP_KEY, ...mcpStandIn.secrets];
    const leaked = hidden.filter((secret) => keysSent.some((text) => text.includes(secret)));
    assert.ok(keysSent.length > 0, 'the page heard answers about its servers');
    assert.deepEqual(leaked, [], 'no answer to the page holds a key, token, code, verifier or client secret');
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
