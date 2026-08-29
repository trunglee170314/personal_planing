import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDatabaseLock } from './backup.mjs';

export const intentionalStopCode = 78;

export function registerLocalControl(databasePath, port) {
  const file = `${databasePath}.myplan-runtime.json`;
  const token = randomBytes(32).toString('hex');
  const temporary = `${file}.${token.slice(0, 16)}.tmp`;
  writeFileSync(temporary, JSON.stringify({ databasePath, port, token }), {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporary, file);
  return {
    token,
    close() {
      // Never remove a newer instance's control file.
      if (
        existsSync(file) &&
        JSON.parse(readFileSync(file, 'utf8')).token === token
      )
        unlinkSync(file);
    },
  };
}

export async function stopLocalServer(databasePath) {
  const file = `${databasePath}.myplan-runtime.json`;
  let release;
  try {
    release = acquireDatabaseLock(databasePath);
  } catch {
    /* server is running */
  }
  if (release) {
    release();
    return false;
  }
  const info = JSON.parse(readFileSync(file, 'utf8'));
  if (
    info.databasePath !== databasePath ||
    !Number.isInteger(info.port) ||
    info.port < 1 ||
    info.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(info.token)
  )
    throw new Error(
      'Invalid local server control file. Stop the server manually.',
    );
  const response = await fetch(
    `http://127.0.0.1:${info.port}/local-control/stop`,
    {
      method: 'POST',
      headers: { 'x-myplan-control': info.token },
      signal: AbortSignal.timeout(5_000),
      redirect: 'manual',
    },
  );
  await response.body?.cancel();
  if (response.status !== 200)
    throw new Error(`Local stop request failed (HTTP ${response.status}).`);
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100);
    try {
      release = acquireDatabaseLock(databasePath);
    } catch {
      continue;
    }
    release();
    // Allow the parent launcher to terminate Vite and exit successfully too.
    await delay(3_500);
    return true;
  }
  throw new Error(
    'The local database is still in use. Restore was not started.',
  );
}
