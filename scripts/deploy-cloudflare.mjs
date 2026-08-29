import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  assertCloudBuild,
  assertSupabaseAuthReachable,
  loadCloudEnv,
  smokeCheckSite,
} from './cloud-config.mjs';

const siteUrl = 'https://myplan.trungvanle.workers.dev';
const workerName = 'myplan';
const executableExtension = process.platform === 'win32' ? '.cmd' : '';
const localBinary = (name) => join('node_modules', '.bin', name);

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(`${command}${executableExtension}`, args, {
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} stopped (${signal || `exit ${code}`}).`));
    });
  });
}

const productionEnv = {
  ...(await loadCloudEnv()),
  NEXT_PUBLIC_APP_MODE: 'cloud',
  NEXT_PUBLIC_SITE_URL: siteUrl,
  // Production migrations 0021/0022 are installed; keep approval enabled on redeploys.
  NEXT_PUBLIC_ACCESS_APPROVALS_ENABLED: 'true',
};

await assertSupabaseAuthReachable(productionEnv);
await run(localBinary('vinext'), ['build'], productionEnv);
await assertCloudBuild();
await run(localBinary('wrangler'), [
  'deploy',
  '--config',
  'dist/server/wrangler.json',
  '--name',
  workerName,
  '--no-bundle',
]);
await smokeCheckSite(siteUrl);

console.log(`myplan deployed to ${siteUrl}`);
