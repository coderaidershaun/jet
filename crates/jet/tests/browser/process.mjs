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
