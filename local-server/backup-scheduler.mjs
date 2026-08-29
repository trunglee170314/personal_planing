import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { projectRoot } from './local-paths.mjs';

// Run SQLite work in a separate process so large backups do not block API/UI.
// Checking at startup catches missed days; checking every 15m also covers sleep.
export function startBackupScheduler({
  env = process.env,
  intervalMs = 15 * 60_000,
  log = console.log,
  report = console.error,
} = {}) {
  let child;
  let stopped = false;
  function tick() {
    if (stopped || child) return;
    child = spawn(
      process.execPath,
      [
        '--no-warnings=ExperimentalWarning',
        join(projectRoot, 'scripts/local-data.mjs'),
        'auto',
      ],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const timeout = setTimeout(() => child?.kill('SIGTERM'), 5 * 60_000);
    child.stdout.on('data', (data) =>
      log(`[${new Date().toISOString()}] ${data.toString().trim()}`),
    );
    child.stderr.on('data', (data) =>
      report(`[${new Date().toISOString()}] ${data.toString().trim()}`),
    );
    child.on('error', (error) => report(`BACKUP FAILED: ${error.message}`));
    child.once('close', (code) => {
      clearTimeout(timeout);
      child = undefined;
      if (!stopped && code !== 0)
        report(
          'BACKUP FAILED: local mode remains available; retry in 15 minutes.',
        );
    });
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (!child) return;
    const running = child;
    const closed = new Promise((resolve) => running.once('close', resolve));
    const force = setTimeout(() => running.kill('SIGKILL'), 2_000);
    running.kill('SIGTERM');
    await closed;
    clearTimeout(force);
  };
}
