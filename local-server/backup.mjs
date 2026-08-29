import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalPath } from './local-paths.mjs';

const snapshotName =
  /^myplan-(daily|manual|pre-restore)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}\.db$/;

function regularFile(path) {
  if (!lstatSync(path).isFile())
    throw new Error(
      `Expected a regular file, not a symlink or directory: ${path}`,
    );
}

function syncFile(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// SQLite's OS lock is released even after a crash/reboot; no stale PID lockfiles.
// The server and restore share the use lock. Backup jobs share the backup lock.
export function acquireDatabaseLock(databasePath, kind = 'use') {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const path = `${databasePath}.myplan-${kind}.db`;
  if (existsSync(path)) regularFile(path);
  const lock = new DatabaseSync(path);
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch {
    lock.close();
    throw new Error(
      kind === 'use'
        ? 'Database is in use. Stop the local server before restoring (or another restore is in progress).'
        : 'Another backup/restore is in progress. Try again after it finishes.',
    );
  }
  return () => lock.close();
}

export function verifyDatabase(path) {
  regularFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || Object.values(result[0])[0] !== 'ok')
      throw new Error('SQLite integrity check failed.');
    // Reject an arbitrary SQLite file; do not bootstrap/migrate a candidate.
    for (const [table, columns] of Object.entries({
      goals: ['id', 'title'],
      tasks: ['id', 'title', 'workflow_status_id'],
      workflows: ['id'],
      workflow_statuses: ['id', 'workflow_id'],
      calendar_sessions: ['id', 'title', 'starts_at', 'ends_at'],
      app_settings: ['id', 'theme'],
    })) {
      const actual = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      if (!columns.every((column) => actual.includes(column)))
        throw new Error(
          `Not a supported myplan backup: missing ${table} columns.`,
        );
    }
    return true;
  } finally {
    db.close();
  }
}

function createSnapshot(source, destination) {
  regularFile(source); // Never silently create an empty source database.
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
    db.prepare('VACUUM INTO ?').run(destination);
  } finally {
    db.close();
  }
  verifyDatabase(destination);
  syncFile(destination);
}

function digest(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

export function listBackups(config) {
  if (!existsSync(config.directory)) return [];
  return readdirSync(config.directory)
    .filter((name) => snapshotName.test(name))
    .flatMap((name) => {
      const file = join(config.directory, name);
      try {
        regularFile(file);
        regularFile(`${file}.json`);
        const meta = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
        if (
          meta.format !== 1 ||
          meta.sourceId !== config.sourceId ||
          meta.filename !== name ||
          !['daily', 'manual', 'pre-restore'].includes(meta.kind) ||
          !name.startsWith(`myplan-${meta.kind}-`) ||
          !Number.isFinite(Date.parse(meta.createdAt)) ||
          !/^[a-f0-9]{64}$/.test(meta.sha256)
        )
          return [];
        return [{ ...meta, file }];
      } catch {
        return [];
      }
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.filename.localeCompare(a.filename),
    );
}

export function verifyBackup(file) {
  // The checksum covers a standalone snapshot, not later writes in sidecars.
  if (
    ['-wal', '-shm', '-journal'].some((suffix) =>
      existsSync(`${file}${suffix}`),
    )
  )
    throw new Error(
      'Backup has SQLite sidecars. Close database clients and create a fresh standalone snapshot.',
    );
  verifyDatabase(file);
  if (existsSync(`${file}.json`)) {
    regularFile(`${file}.json`);
    const meta = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
    if (meta.format !== 1 || digest(file) !== meta.sha256)
      throw new Error('Backup checksum does not match. Restore refused.');
  }
  return true;
}

function saveSnapshot(config, kind, date) {
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const stamp = date.toISOString().replaceAll(':', '-').replace('.', '-');
  const name = `myplan-${kind}-${stamp}-${randomUUID()}.db`;
  const file = join(config.directory, name);
  const partial = `${file}.partial`;
  try {
    createSnapshot(config.databasePath, partial);
    const meta = {
      format: 1,
      sourceId: config.sourceId,
      sourcePath: config.databasePath,
      filename: name,
      kind,
      createdAt: date.toISOString(),
      sha256: digest(partial),
    };
    writeFileSync(`${partial}.json`, JSON.stringify(meta, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    syncFile(`${partial}.json`);
    renameSync(partial, file);
    renameSync(`${partial}.json`, `${file}.json`);
    syncDirectory(config.directory);
    return { ...meta, file };
  } finally {
    // Only this attempt's unique unpublished files; never sweep arbitrary files.
    for (const path of [partial, `${partial}.json`])
      if (existsSync(path)) unlinkSync(path);
  }
}

function pruneBackups(config) {
  const snapshots = listBackups(config).filter(
    (item) => item.kind !== 'pre-restore',
  );
  let removed = 0;
  for (const old of snapshots.slice(config.keep)) {
    // A modified/corrupt file is left alone rather than deleting unrecognized data.
    try {
      verifyBackup(old.file);
    } catch {
      continue;
    }
    unlinkSync(old.file);
    unlinkSync(`${old.file}.json`);
    removed++;
  }
  return removed;
}

export function backupDue(config, date = new Date()) {
  const today = date.toDateString();
  for (const item of listBackups(config)) {
    if (
      item.kind === 'pre-restore' ||
      new Date(item.createdAt).toDateString() !== today
    )
      continue;
    try {
      verifyBackup(item.file);
      return false;
    } catch {
      /* retry a damaged snapshot */
    }
  }
  return true;
}

export function backupDatabase(
  config,
  { daily = false, date = new Date() } = {},
) {
  const release = acquireDatabaseLock(config.databasePath, 'backup');
  try {
    if (daily && !backupDue(config, date)) return null;
    const snapshot = saveSnapshot(config, daily ? 'daily' : 'manual', date);
    // A pruning failure must not obscure that a valid backup was already saved.
    try {
      snapshot.removed = pruneBackups(config);
    } catch (error) {
      snapshot.warning = `Backup saved, but old backups could not be pruned: ${error.message}`;
    }
    return snapshot;
  } finally {
    release();
  }
}

export function restoreDatabase(config, source, { confirmed = false } = {}) {
  if (!confirmed)
    throw new Error(
      'Restore replaces current data. Re-run with --confirm after stopping local mode.',
    );
  const candidate = canonicalPath(source);
  if (candidate === config.databasePath)
    throw new Error('Cannot restore a database onto itself.');
  verifyBackup(candidate);
  const releaseUse = acquireDatabaseLock(config.databasePath);
  let releaseBackup;
  const stage = join(
    dirname(config.databasePath),
    `.myplan-restore-${randomUUID()}.db`,
  );
  let safety;
  try {
    releaseBackup = acquireDatabaseLock(config.databasePath, 'backup');
    createSnapshot(candidate, stage);
    if (existsSync(config.databasePath)) {
      // Must succeed before modifying the current DB. Kept outside retention.
      safety = saveSnapshot(config, 'pre-restore', new Date());
      const current = new DatabaseSync(config.databasePath);
      try {
        current.exec('PRAGMA busy_timeout = 5000;');
        const checkpoint = current
          .prepare('PRAGMA wal_checkpoint(TRUNCATE)')
          .get();
        if (checkpoint.busy !== 0)
          throw new Error(
            'Database has another reader/writer; restore refused.',
          );
      } finally {
        current.close();
      }
    }
    if (
      [
        `${config.databasePath}-wal`,
        `${config.databasePath}-shm`,
        `${config.databasePath}-journal`,
      ].some(existsSync)
    )
      throw new Error(
        'Database sidecars still exist. Stop all database clients before restoring. Do not delete WAL files manually.',
      );
    // The stage is verified and fsynced on the same filesystem as the target.
    renameSync(stage, config.databasePath);
    syncDirectory(dirname(config.databasePath));
    return { databasePath: config.databasePath, safetyBackup: safety?.file };
  } catch (error) {
    if (safety) error.message += ` Safety backup: ${safety.file}`;
    throw error;
  } finally {
    if (existsSync(stage)) unlinkSync(stage);
    releaseBackup?.();
    releaseUse();
  }
}
