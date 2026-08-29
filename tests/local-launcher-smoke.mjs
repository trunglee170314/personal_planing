// Opt-in real-server smoke test. Uses an isolated SQLite database, not user data.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPortAvailable, waitForHttp } from '../scripts/local-startup.mjs';

await assertPortAvailable(3000, 'Smoke test web');
await assertPortAvailable(4318, 'Smoke test API');
const directory = mkdtempSync(join(tmpdir(), 'myplan-launcher-smoke-'));
const children = [];
function launch() {
  const child = spawn(process.execPath, ['scripts/local-dev.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      MYPLAN_LOCAL_API_PORT: '4318',
      MYPLAN_LOCAL_DB_PATH: join(directory, 'myplan.db'),
      MYPLAN_BACKUP_DIR: join(directory, 'backups'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const stopped = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
  return { child, stopped };
}

async function exitWithin(stopped, timeoutMs) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      stopped,
      delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error('Child did not exit in time');
      }),
    ]);
  } finally {
    controller.abort();
  }
}

try {
  const first = launch();
  let startupTimer;
  await new Promise((resolveReady, reject) => {
    let output = '';
    startupTimer = setTimeout(
      () => reject(new Error('No READY log after six minutes')),
      360_000,
    );
    first.child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-4_000);
      if (output.includes('READY: http://localhost:3000/ returned HTTP 200'))
        resolveReady();
    });
    first.stopped.then(
      (code) => reject(new Error(`Launcher exited before readiness (${code})`)),
      reject,
    );
  }).finally(() => clearTimeout(startupTimer));
  await waitForHttp('http://127.0.0.1:3000/', { timeoutMs: 15_000 });

  const duplicate = launch();
  if ((await exitWithin(duplicate.stopped, 15_000)) !== 1)
    throw new Error('Duplicate launcher did not fail cleanly');
  await waitForHttp('http://127.0.0.1:3000/', { timeoutMs: 15_000 });

  const stopCommand = spawn(
    process.execPath,
    ['scripts/local-data.mjs', 'stop'],
    {
      cwd: resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        MYPLAN_LOCAL_DB_PATH: join(directory, 'myplan.db'),
        MYPLAN_BACKUP_DIR: join(directory, 'backups'),
        MYPLAN_LOCAL_API_PORT: '4318',
      },
      stdio: 'inherit',
    },
  );
  children.push(stopCommand);
  const stopResult = await exitWithin(
    new Promise((resolveExit, reject) => {
      stopCommand.once('error', reject);
      stopCommand.once('exit', resolveExit);
    }),
    15_000,
  );
  if (stopResult !== 0) throw new Error('Graceful local stop command failed');
  if ((await exitWithin(first.stopped, 15_000)) !== 0)
    throw new Error('Launcher did not stop cleanly');
  await assertPortAvailable(3000, 'Stopped web');
  await assertPortAvailable(4318, 'Stopped API');
  console.log(
    'PASS: real web READY, duplicate rejected without harming first server, user-requested stop exits successfully and both ports released.',
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exitWithin(
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        15_000,
      );
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
