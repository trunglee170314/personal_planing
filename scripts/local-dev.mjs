import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { assertPortAvailable, waitForHttp } from './local-startup.mjs';
import { loadLocalEnvironment } from '../local-server/local-paths.mjs';
// The API reserves this code for the authenticated, user-requested stop command.
const intentionalStopCode = 78;

loadLocalEnvironment();

const apiPort = process.env.MYPLAN_LOCAL_API_PORT || '4318';
const apiUrl = `http://127.0.0.1:${apiPort}`;
const localToken = randomBytes(32).toString('hex');
const children = new Set();
const startupController = new AbortController();
let shuttingDown = false;
const webUrl = 'http://127.0.0.1:3000/';

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function start(command, args, env = process.env) {
  const isWindowsCommandScript =
    process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  const executable = isWindowsCommandScript
    ? process.env.ComSpec || 'cmd.exe'
    : command;
  const executableArgs = isWindowsCommandScript
    ? ['/d', '/s', '/c', command, ...args]
    : args;
  const child = spawn(executable, executableArgs, {
    cwd: resolve(import.meta.dirname, '..'),
    env,
    stdio: 'inherit',
    windowsHide: true,
    // Keep each npm/Vite tree in a group so a failed attempt leaves no orphan server.
    detached: process.platform !== 'win32',
  });
  children.add(child);
  child.once('error', (error) => {
    console.error(`Could not start ${command}: ${error.message}`);
    shutdown(1);
  });
  child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      if (code === intentionalStopCode)
        log('Local server stopped by the user.');
      else
        console.error(
          `myplan process stopped unexpectedly (${signal || code}).`,
        );
      // Even exit 0 is unexpected for a long-running server; let the task retry.
      shutdown(code === intentionalStopCode ? 0 : 1);
    }
  });
  return child;
}

function stopChild(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => child.kill());
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(error.message);
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  startupController.abort();
  log(`Stopping local services (exit code ${code}).`);
  for (const child of children) stopChild(child, 'SIGTERM');
  setTimeout(() => {
    for (const child of children) stopChild(child, 'SIGKILL');
    process.exit(code);
  }, 3_000);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

const nodeArgs = [
  '--no-warnings=ExperimentalWarning',
  'local-server/server.mjs',
];
try {
  log('START local services; checking ports before starting.');
  await assertPortAvailable(Number(apiPort), 'Local database API');
  await assertPortAvailable(3000, 'Local web server');
  start(process.execPath, nodeArgs, {
    ...process.env,
    MYPLAN_LOCAL_API_PORT: apiPort,
    MYPLAN_LOCAL_TOKEN: localToken,
  });
  await waitForHttp(`${apiUrl}/health`, {
    label: 'Local database API',
    timeoutMs: 30_000,
    requestTimeoutMs: 2_000,
    signal: startupController.signal,
  });
  log('Database API ready. Starting web server and compiling the first page.');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  start(npmCommand, ['run', 'dev'], {
    ...process.env,
    NEXT_PUBLIC_APP_MODE: 'local',
    NEXT_PUBLIC_LOCAL_API_URL: apiUrl,
    NEXT_PUBLIC_LOCAL_API_TOKEN: localToken,
  });
  await waitForHttp(webUrl, {
    label: 'Local web server',
    signal: startupController.signal,
    onProgress: (seconds) => log(`Waiting for web readiness (${seconds}s).`),
  });
  log(
    'READY: http://localhost:3000/ returned HTTP 200; local database API is available.',
  );
} catch (error) {
  if (!shuttingDown) {
    console.error(error instanceof Error ? error.message : error);
    shutdown(1);
  }
}
