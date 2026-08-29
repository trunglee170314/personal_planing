import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const expectedSupabaseProjectRef = 'hoilnhlipdzfylkzqnvw';
export const retiredSupabaseProjectRefs = ['kohyazvtqysoybrlgwec'];

export function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function assertCloudConfig(env) {
  const expectedUrl = `https://${expectedSupabaseProjectRef}.supabase.co`;
  if (env.NEXT_PUBLIC_SUPABASE_URL !== expectedUrl) {
    throw new Error(
      `Refusing cloud build: NEXT_PUBLIC_SUPABASE_URL must be ${expectedUrl}.`,
    );
  }
  if (
    !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')
  ) {
    throw new Error(
      'Refusing cloud build: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing or is not a publishable browser key.',
    );
  }
}

export async function loadCloudEnv(baseEnv = process.env) {
  let fileEnv = {};
  try {
    fileEnv = parseEnv(await readFile('.env.local', 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const env = { ...fileEnv, ...baseEnv };
  assertCloudConfig(env);
  return env;
}

export async function assertSupabaseAuthReachable(env, fetchImpl = fetch) {
  assertCloudConfig(env);
  const response = await fetchImpl(
    new URL('/auth/v1/settings', env.NEXT_PUBLIC_SUPABASE_URL),
    { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } },
  );
  if (!response.ok) {
    throw new Error(
      `Refusing cloud build: Supabase Auth rejected the publishable key (HTTP ${response.status}).`,
    );
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

export async function assertCloudBuild(directory = 'dist') {
  const files = await listFiles(directory);
  let expectedRefFound = false;
  for (const file of files) {
    const content = await readFile(file);
    if (content.includes(Buffer.from(expectedSupabaseProjectRef))) {
      expectedRefFound = true;
    }
    for (const retiredRef of retiredSupabaseProjectRefs) {
      if (content.includes(Buffer.from(retiredRef))) {
        throw new Error(
          `Refusing deploy: generated file ${file} still contains retired Supabase project ${retiredRef}.`,
        );
      }
    }
  }
  if (!expectedRefFound) {
    throw new Error(
      `Refusing deploy: generated build does not contain expected Supabase project ${expectedSupabaseProjectRef}.`,
    );
  }
}

export async function smokeCheckSite(siteUrl, fetchImpl = fetch) {
  for (const path of ['/', '/login']) {
    const response = await fetchImpl(new URL(path, siteUrl));
    if (!response.ok) {
      throw new Error(
        `Production smoke check failed for ${path}: HTTP ${response.status}.`,
      );
    }
    const html = await response.text();
    if (!html.toLowerCase().includes('<!doctype html')) {
      throw new Error(`Production smoke check failed for ${path}: not HTML.`);
    }
  }
}
