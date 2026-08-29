import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { backupConfig } from '../local-server/local-paths.mjs';
import {
  acquireDatabaseLock,
  listBackups,
  verifyBackup,
} from '../local-server/backup.mjs';

describe('local backup CLI and automatic lifecycle', () => {
  let directory, backupTestDirectory, env, config, port, children;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'myplan-backup-integration-'));
    backupTestDirectory = process.env.MYPLAN_BACKUP_TEST_ROOT
      ? mkdtempSync(
          join(process.env.MYPLAN_BACKUP_TEST_ROOT, 'myplan-backup-test-'),
        )
      : directory;
    const listener = createServer();
    await new Promise((done) => listener.listen(0, '127.0.0.1', done));
    port = listener.address().port;
    await new Promise((done) => listener.close(done));
    env = {
      ...process.env,
      MYPLAN_LOCAL_DB_PATH: join(directory, 'myplan.db'),
      MYPLAN_BACKUP_DIR: join(backupTestDirectory, 'backups'),
      MYPLAN_LOCAL_API_PORT: String(port),
      MYPLAN_LOCAL_TOKEN: 'integration-test-only',
    };
    config = backupConfig(env);
    children = [];
  });
  function start(script, args = []) {
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', resolve(script), ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    const result = { child, output: '' };
    child.stdout.on('data', (data) => {
      result.output += data;
    });
    child.stderr.on('data', (data) => {
      result.output += data;
    });
    result.done = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code) => done(code));
    });
    return result;
  }
  async function until(predicate) {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await delay(50);
    }
    throw new Error('Condition not met within 10 seconds');
  }
  async function healthy() {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
    } catch {
      return false;
    }
  }
  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise((done) => child.once('close', done));
        child.kill('SIGTERM');
        await stopped;
      }
    }
    rmSync(directory, { recursive: true, force: true });
    if (backupTestDirectory !== directory)
      rmSync(backupTestDirectory, { recursive: true, force: true });
  });
  it('creates automatic snapshots, supports live manual backup and safe stop/restore/restart', async () => {
    const server = start('local-server/server.mjs');
    await until(healthy);
    await until(() => listBackups(config).length === 1);
    expect(verifyBackup(listBackups(config)[0].file)).toBe(true);
    const manual = start('scripts/local-data.mjs', ['backup']);
    expect(await manual.done).toBe(0);
    expect(listBackups(config)).toHaveLength(2);
    const candidate = listBackups(config)[0].file;
    const verify = start('scripts/local-data.mjs', ['verify', candidate]);
    expect(await verify.done).toBe(0);
    const blocked = start('scripts/local-data.mjs', [
      'restore',
      candidate,
      '--confirm',
    ]);
    expect(await blocked.done).toBe(1);
    expect(blocked.output).toMatch(/EADDRINUSE/);
    // Browser credentials and unknown tokens must not stop the server.
    for (const headers of [
      { 'x-myplan-control': 'wrong' },
      {
        origin: 'http://localhost:3000',
        'x-myplan-local-token': env.MYPLAN_LOCAL_TOKEN,
      },
    ]) {
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/local-control/stop`, {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(403);
    }
    const stop = start('scripts/local-data.mjs', ['stop']);
    expect(await stop.done).toBe(0);
    expect(await server.done).toBe(78);
    expect(existsSync(`${config.databasePath}.myplan-runtime.json`)).toBe(
      false,
    );
    const restored = start('scripts/local-data.mjs', [
      'restore',
      candidate,
      '--confirm',
    ]);
    expect(await restored.done).toBe(0);
    expect(restored.output).toContain('Safety backup:');
    expect(
      listBackups(config).filter((item) => item.kind === 'pre-restore'),
    ).toHaveLength(1);
    const restarted = start('local-server/server.mjs');
    await until(healthy);
    await delay(500);
    expect(listBackups(config)).toHaveLength(3); // Restart does not duplicate today's backup.
    restarted.child.kill('SIGTERM');
    expect(await restarted.done).toBe(0);
  }, 20_000);
  it('backup storage failure is logged without taking down the local API', async () => {
    writeFileSync(env.MYPLAN_BACKUP_DIR, 'not a directory');
    const server = start('local-server/server.mjs');
    await until(healthy);
    await until(() => server.output.includes('BACKUP FAILED'));
    expect(await healthy()).toBe(true);
  });
  it('the database use lock releases after an abrupt process crash', async () => {
    const server = start('local-server/server.mjs');
    await until(healthy);
    await until(() => listBackups(config).length === 1);
    server.child.kill('SIGKILL');
    await server.done;
    const release = acquireDatabaseLock(config.databasePath);
    release();
    const restarted = start('local-server/server.mjs');
    await until(healthy);
    restarted.child.kill('SIGTERM');
    expect(await restarted.done).toBe(0);
    const db = new DatabaseSync(config.databasePath, { readOnly: true });
    expect(Object.values(db.prepare('PRAGMA integrity_check').get())[0]).toBe(
      'ok',
    );
    db.close();
  });
});
