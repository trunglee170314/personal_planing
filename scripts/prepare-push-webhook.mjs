// Run from the project root. The SQL file is a local, ignored, one-time secret.
// The operator must paste/run it in Supabase; never print its contents to logs.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const path = resolve('outputs/push-webhook-setup.sql');
await mkdir(resolve('outputs'), { recursive: true });
let secret;
try {
  const existing = await readFile(path, 'utf8');
  secret = existing.match(/configure_myplan_push_webhook\('([A-Za-z0-9_-]{43})'\)/)?.[1];
  if (!secret) throw new Error('Existing setup file is not recognized; refusing to rotate the key.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secret = randomBytes(32).toString('base64url');
  await writeFile(path,
    '-- PRIVATE: paste into Supabase SQL Editor and run yourself. Do not share or commit.\n' +
    `select public.configure_myplan_push_webhook('${secret}');\n`,
    { mode: 0o600, flag: 'wx' });
}

const executable = resolve('node_modules/.bin/wrangler' + (process.platform === 'win32' ? '.cmd' : ''));
await new Promise((resolveRun, reject) => {
  const child = spawn(executable, ['secret', 'put', 'PUSH_WEBHOOK_SECRET', '--name', 'myplan-push', '--config', 'push-worker/wrangler.alarms.jsonc'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first`.trim() },
    shell: process.platform === 'win32',
  });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`Secret upload failed (${code}); rerun reuses the same key.`)));
  child.stdin.on('error', reject);
  child.stdin.end(secret);
});
console.log(`Cloudflare secret saved. Operator SQL file: ${path}`);
