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
        const collect = chunk => { log += chunk; const match = log.match(pattern); if (match) { clearTimeout(timer); resolve(match[1]); } };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        child.on('error', reject);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${log}`)); });
      });
    },
    async close() {
      const failures = [];
      for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timeout = setTimeout(() => { failures.push(`Child ${child.pid} did not stop within 10 seconds: ${child.spawnargs.join(' ')}`); child.kill('SIGKILL'); }, 10000);
        try { await exited; } finally { clearTimeout(timeout); }
      }
      assert.deepEqual(failures, [], 'Temporary servers must shut down gracefully');
    },
  };
}

export async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (!(await check())) { assert.ok(Date.now() < deadline, message); await delay(40); }
}
