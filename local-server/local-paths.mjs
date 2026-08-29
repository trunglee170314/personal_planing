import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const projectRoot = resolve(import.meta.dirname, '..');

export function loadLocalEnvironment() {
  const file = join(projectRoot, '.env.local');
  if (existsSync(file)) process.loadEnvFile(file);
}

// Resolve existing ancestors too, so aliases/symlinks cannot evade path checks.
export function canonicalPath(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(
    canonicalPath(dirname(absolute)),
    relative(dirname(absolute), absolute),
  );
}

export function localDatabasePath(env = process.env) {
  return canonicalPath(
    env.MYPLAN_LOCAL_DB_PATH ||
      join(homedir(), '.local', 'share', 'myplan', 'myplan.db'),
  );
}

export function isWithin(parent, child) {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
}

export function defaultBackupRoot({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  run = execFileSync,
} = {}) {
  const wsl =
    platform === 'linux' &&
    (env.WSL_DISTRO_NAME ||
      env.WSL_INTEROP ||
      /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8')));
  if (wsl) {
    try {
      const windowsHome = run(
        '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          '$env:USERPROFILE',
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      ).trim();
      if (!/^[A-Za-z]:\\/.test(windowsHome))
        throw new Error('Windows profile was not found');
      const mountedHome = run('wslpath', ['-a', '-u', windowsHome], {
        encoding: 'utf8',
        timeout: 5_000,
      }).trim();
      if (!isAbsolute(mountedHome))
        throw new Error('Windows profile path is not absolute');
      return join(mountedHome, 'myplan-backups');
    } catch (error) {
      throw new Error(
        `Cannot locate the Windows backup folder. Set MYPLAN_BACKUP_DIR to an absolute WSL path outside the source checkout. ${error.message}`,
      );
    }
  }
  return join(home, 'myplan-backups');
}

export function backupConfig(env = process.env) {
  const databasePath = localDatabasePath(env);
  if (env.MYPLAN_BACKUP_DIR && !isAbsolute(env.MYPLAN_BACKUP_DIR))
    throw new Error(
      'MYPLAN_BACKUP_DIR must be an absolute path (use /mnt/c/... inside WSL).',
    );
  const root = canonicalPath(
    env.MYPLAN_BACKUP_DIR || defaultBackupRoot({ env }),
  );
  if (isWithin(canonicalPath(projectRoot), root))
    throw new Error('Backups must be outside the source checkout.');
  const identity = `${process.platform}:${env.WSL_DISTRO_NAME || ''}:${databasePath}`;
  const sourceId = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 16);
  return {
    databasePath,
    sourceId,
    directory: join(root, `myplan-${sourceId}`),
    keep: 30,
  };
}
