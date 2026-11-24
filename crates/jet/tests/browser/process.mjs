import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export function createProcesses() {
  const children = [];
  return {
    async launch(program, args, pattern, env = process.env) {
      const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      return new Promise((resolve, reject) => {
        let log = '';
        const timer = setTimeout(() => reject(new Error('Startup timed out: ' + log)), 30000);
        const collect = chunk => { log += chunk; const match = log.match(pattern); if (match) { clearTimeout(timer); child.address = match[1]; resolve(match[1]); } };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        child.on('error', reject);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${log}`)); });
      });
    },
    async stop(address) {
      const child = children.findLast(child => child.address === address);
      assert.ok(child, `Unknown temporary server: ${address}`);
      await stop(child);
    },
    async close() {
      const failures = [];
      for (const child of children.reverse()) {
        try { await stop(child); } catch (error) { failures.push(error.message); }
      }
      assert.deepEqual(failures, [], 'Temporary servers must shut down gracefully');
    },
  };
}

export async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (!(await check())) { assert.ok(Date.now() < deadline, message); await delay(40); }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  let timedOut = false;
  child.kill('SIGTERM');
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
  try { await exited; } finally { clearTimeout(timeout); }
  assert.equal(timedOut, false, `Child ${child.pid} did not stop within 10 seconds: ${child.spawnargs.join(' ')}`);
}

/**
 * Signs the owner, an admin, in from Node and saves these settings for them. A `claudePath`
 * among them sets the provider program the whole server runs.
 */
export async function saveOwnerSettings(origin, settings) {
  const signedIn = await fetch(origin + '/api/auth/signin', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'shaunsurfing@gmail.com', password: '000111' }) });
  assert.equal(signedIn.status, 200, 'the owner could not sign in');
  const cookie = signedIn.headers.getSetCookie().map(line => line.split(';')[0]).join('; ');
  const saved = await fetch(origin + '/api/settings', { method: 'PUT', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200, `the owner's settings were not saved: ${await saved.text()}`);
}

/** Opens Jet in a Playwright page and signs the owner in through the sign-in form, as a person does. */
export async function signIn(page, origin) {
  await page.goto(origin);
  await page.locator('#signin[data-state="ready"]').waitFor();
  await page.fill('#email', 'shaunsurfing@gmail.com');
  await page.fill('#password', '000111');
  await page.press('#password', 'Enter');
  await page.waitForURL(url => url.pathname === '/');
}
