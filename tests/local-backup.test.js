import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDatabase } from '../local-server/database.mjs';
import {
  acquireDatabaseLock,
  backupDatabase,
  backupDue,
  listBackups,
  restoreDatabase,
  verifyBackup,
} from '../local-server/backup.mjs';
import {
  backupConfig,
  defaultBackupRoot,
  projectRoot,
} from '../local-server/local-paths.mjs';

describe('local database backup and restore', () => {
  let directory, config, database;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'myplan-backup-'));
    config = backupConfig({
      MYPLAN_LOCAL_DB_PATH: join(directory, 'myplan.db'),
      MYPLAN_BACKUP_DIR: join(directory, 'backups'),
    });
    database = new LocalDatabase(config.databasePath);
    database.db
      .prepare(
        "INSERT INTO goals (id,title,horizon,created_at,updated_at) VALUES ('test','Before backup','year','2026-01-01','2026-01-01')",
      )
      .run();
  });
  afterEach(() => {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function close() {
    database.close();
    database = null;
  }
  function title(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare("SELECT title FROM goals WHERE id='test'").get().title;
    } finally {
      db.close();
    }
  }
  it('captures committed WAL data while the server connection remains open', () => {
    expect(existsSync(`${config.databasePath}-wal`)).toBe(true);
    const result = backupDatabase(config);
    expect(verifyBackup(result.file)).toBe(true);
    expect(title(result.file)).toBe('Before backup');
    database.db.exec("UPDATE goals SET title='After backup' WHERE id='test'");
    expect(title(result.file)).toBe('Before backup');
    expect(title(config.databasePath)).toBe('After backup');
  });
  it('backs up once per day and catches up after missed days', () => {
    const day = new Date('2026-09-02T08:00:00Z');
    expect(backupDue(config, day)).toBe(true);
    expect(backupDatabase(config, { daily: true, date: day })).not.toBeNull();
    expect(backupDatabase(config, { daily: true, date: day })).toBeNull();
    expect(backupDue(config, new Date('2026-09-04T08:00:00Z'))).toBe(true);
    expect(
      backupDatabase(config, {
        daily: true,
        date: new Date('2026-09-04T08:00:00Z'),
      }),
    ).not.toBeNull();
  });
  it('a manual backup satisfies the daily schedule', () => {
    backupDatabase(config);
    expect(backupDue(config)).toBe(false);
  });
  it('retries a same-day backup that has been damaged', () => {
    const result = backupDatabase(config, { daily: true });
    writeFileSync(result.file, 'broken');
    expect(backupDue(config)).toBe(true);
    expect(backupDatabase(config, { daily: true })).not.toBeNull();
  });
  it('keeps the newest 30 snapshots and leaves unrelated files alone', () => {
    for (let day = 1; day <= 32; day++)
      backupDatabase(config, { date: new Date(Date.UTC(2026, 0, day)) });
    writeFileSync(join(config.directory, 'personal.db'), 'unrelated');
    const result = backupDatabase(config, { date: new Date('2026-04-01') });
    expect(result.removed).toBe(1);
    expect(listBackups(config)).toHaveLength(30);
    expect(readFileSync(join(config.directory, 'personal.db'), 'utf8')).toBe(
      'unrelated',
    );
  });
  it('failed backup does not prune any existing snapshots', () => {
    const result = backupDatabase(config);
    close();
    writeFileSync(config.databasePath, 'broken');
    expect(() => backupDatabase({ ...config, keep: 0 })).toThrow();
    expect(verifyBackup(result.file)).toBe(true);
    expect(
      readdirSync(config.directory).some((name) => name.includes('.partial')),
    ).toBe(false);
  });
  it('does not create an empty DB when the source is missing', () => {
    const missing = { ...config, databasePath: join(directory, 'missing.db') };
    expect(() => backupDatabase(missing)).toThrow();
    expect(existsSync(missing.databasePath)).toBe(false);
  });
  it('refuses overlapping backup/restore work', () => {
    const release = acquireDatabaseLock(config.databasePath, 'backup');
    try {
      expect(() => backupDatabase(config)).toThrow(/in progress/);
    } finally {
      release();
    }
    expect(backupDatabase(config)).not.toBeNull();
  });
  it('refuses restore while a local server holds the DB use lock', () => {
    const result = backupDatabase(config);
    const release = acquireDatabaseLock(config.databasePath);
    try {
      expect(() =>
        restoreDatabase(config, result.file, { confirmed: true }),
      ).toThrow(/in use/);
    } finally {
      release();
    }
    expect(title(config.databasePath)).toBe('Before backup');
  });
  it('requires explicit confirmation and rejects corrupt or unrelated files', () => {
    const result = backupDatabase(config);
    expect(() => restoreDatabase(config, result.file)).toThrow(/confirm/);
    const corrupt = join(directory, 'corrupt.db');
    writeFileSync(corrupt, 'not SQLite');
    expect(() =>
      restoreDatabase(config, corrupt, { confirmed: true }),
    ).toThrow();
    const empty = join(directory, 'unrelated.db');
    new DatabaseSync(empty).close();
    expect(() => restoreDatabase(config, empty, { confirmed: true })).toThrow(
      /supported myplan/,
    );
    expect(title(config.databasePath)).toBe('Before backup');
  });
  it('restores data, saves the previous data separately and preserves it from retention', () => {
    const result = backupDatabase(config);
    database.db.exec("UPDATE goals SET title='Newer data' WHERE id='test'");
    close();
    const restored = restoreDatabase(config, result.file, { confirmed: true });
    expect(title(config.databasePath)).toBe('Before backup');
    expect(title(restored.safetyBackup)).toBe('Newer data');
    backupDatabase({ ...config, keep: 1 });
    expect(verifyBackup(restored.safetyBackup)).toBe(true);
    const reopened = new LocalDatabase(config.databasePath);
    expect(
      reopened.listGoals().some((goal) => goal.title === 'Before backup'),
    ).toBe(true);
    reopened.close();
  });
  it('rejects a modified snapshot whose checksum no longer matches', () => {
    const result = backupDatabase(config);
    const db = new DatabaseSync(result.file);
    db.exec("UPDATE goals SET title='Tampered' WHERE id='test'");
    db.close();
    expect(() => verifyBackup(result.file)).toThrow(/checksum/);
  });

  it('rejects WAL-modified snapshots and never prunes them as unchanged files', () => {
    const result = backupDatabase(config, { date: new Date('2026-01-01') });
    const db = new DatabaseSync(result.file);
    try {
      db.exec(
        "PRAGMA journal_mode = WAL; UPDATE goals SET title='Changed in WAL' WHERE id='test'",
      );
      expect(() => verifyBackup(result.file)).toThrow(/sidecars/);
      backupDatabase({ ...config, keep: 1 });
      expect(existsSync(result.file)).toBe(true);
    } finally {
      db.close();
    }
  });
  it('a failed safety backup leaves the target intact', () => {
    const result = backupDatabase(config);
    database.db.exec("UPDATE goals SET title='Keep me' WHERE id='test'");
    close();
    const occupied = join(directory, 'not-a-directory');
    writeFileSync(occupied, 'block writes');
    expect(() =>
      restoreDatabase({ ...config, directory: occupied }, result.file, {
        confirmed: true,
      }),
    ).toThrow();
    expect(title(config.databasePath)).toBe('Keep me');
  });
  it('supports restoring a backup into a new local database', () => {
    const result = backupDatabase(config);
    const next = backupConfig({
      MYPLAN_LOCAL_DB_PATH: join(directory, 'new', 'myplan.db'),
      MYPLAN_BACKUP_DIR: join(directory, 'backups'),
    });
    expect(next.sourceId).not.toBe(config.sourceId);
    const restored = restoreDatabase(next, result.file, { confirmed: true });
    expect(restored.safetyBackup).toBeUndefined();
    expect(title(next.databasePath)).toBe('Before backup');
  });
  it('rejects backup directories inside the source, including symlink aliases', () => {
    expect(() =>
      backupConfig({ MYPLAN_BACKUP_DIR: join(projectRoot, 'backups') }),
    ).toThrow(/outside/);
    const link = join(directory, 'source-link');
    symlinkSync(projectRoot, link, 'junction');
    expect(() =>
      backupConfig({ MYPLAN_BACKUP_DIR: join(link, 'backups') }),
    ).toThrow(/outside/);
  });
  it('handles apostrophes/spaces in filenames via bound SQLite parameters', () => {
    config.directory = join(directory, "backup user's folder");
    const result = backupDatabase(config);
    expect(verifyBackup(result.file)).toBe(true);
  });
});

describe('backup path configuration', () => {
  it('uses a Windows folder from WSL, with argv-safe paths', () => {
    const calls = [];
    const root = defaultBackupRoot({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      run: (program, args) => {
        calls.push([program, args]);
        return calls.length === 1 ? 'C:\\Users\\A B\r\n' : '/mnt/c/Users/A B\n';
      },
    });
    expect(root).toBe(join('/mnt/c/Users/A B', 'myplan-backups'));
    expect(calls[1][1]).toEqual(['-a', '-u', 'C:\\Users\\A B']);
  });
  it('fails clearly rather than silently putting WSL backups inside Linux', () => {
    expect(() =>
      defaultBackupRoot({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        run: () => {
          throw new Error('interop unavailable');
        },
      }),
    ).toThrow(/MYPLAN_BACKUP_DIR/);
  });
  it('rejects relative configured paths', () => {
    expect(() => backupConfig({ MYPLAN_BACKUP_DIR: 'backups' })).toThrow(
      /absolute/,
    );
  });
  it('uses native home on Windows', () => {
    expect(
      defaultBackupRoot({ platform: 'win32', env: {}, home: '/home/test' }),
    ).toBe(join('/home/test', 'myplan-backups'));
  });
});
