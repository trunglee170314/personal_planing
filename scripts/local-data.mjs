import {
  backupConfig,
  loadLocalEnvironment,
  localDatabasePath,
} from '../local-server/local-paths.mjs';
import { stopLocalServer } from '../local-server/local-control.mjs';
import {
  backupDatabase,
  listBackups,
  restoreDatabase,
  verifyBackup,
} from '../local-server/backup.mjs';
import { assertPortAvailable } from './local-startup.mjs';

process.umask(0o077);
loadLocalEnvironment();
const [command = 'list', file, ...flags] = process.argv.slice(2);
try {
  if (
    !['backup', 'auto', 'list', 'verify', 'restore', 'stop'].includes(command)
  )
    throw new Error(
      'Usage: npm run data:local -- [list | backup | stop | verify FILE | restore FILE --confirm]',
    );
  if (command === 'stop') {
    if (file || flags.length)
      throw new Error('stop does not accept extra arguments.');
    const stopped = await stopLocalServer(localDatabasePath());
    console.log(
      stopped
        ? 'STOPPED: local server shut down normally; autostart will resume at your next Windows sign-in.'
        : 'Local database is not in use.',
    );
  } else if (command === 'verify') {
    if (!file || flags.length)
      throw new Error('Usage: npm run data:local -- verify FILE');
    verifyBackup(file);
    console.log(`VERIFIED: ${file}`);
  } else {
    const config = backupConfig();
    if (command === 'restore') {
      if (!file || flags.length !== 1 || flags[0] !== '--confirm')
        throw new Error(
          `Restore replaces ${config.databasePath}. Stop local mode, then run: npm run restore:local -- "BACKUP_FILE" --confirm`,
        );
      // Also catches older local servers that predate the database use lock.
      await assertPortAvailable(
        Number(process.env.MYPLAN_LOCAL_API_PORT || 4318),
        'Restore safety check',
      );
      const result = restoreDatabase(config, file, { confirmed: true });
      console.log(
        `RESTORED: ${result.databasePath}\nSafety backup: ${result.safetyBackup || '(new database)'}\nStart local mode again.`,
      );
    } else {
      if (file || flags.length)
        throw new Error(`${command} does not accept extra arguments.`);
      if (command === 'list') {
        console.log(
          `Database: ${config.databasePath}\nBackup folder: ${config.directory}`,
        );
        for (const item of listBackups(config))
          console.log(`${item.createdAt} [${item.kind}] ${item.file}`);
      } else {
        const result = backupDatabase(config, { daily: command === 'auto' });
        if (result) {
          console.log(
            `BACKUP OK: ${result.file} (verified; ${result.removed} old backups removed)`,
          );
          if (result.warning) console.error(result.warning);
        }
      }
    }
  }
} catch (error) {
  console.error(`LOCAL DATA ERROR: ${error.message}`);
  process.exitCode = 1;
}
