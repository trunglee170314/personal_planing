import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assertCloudConfig,
  assertSupabaseAuthReachable,
  expectedSupabaseProjectRef,
  parseEnv,
  smokeCheckSite,
} from '../scripts/cloud-config.mjs';

describe('cloud deployment guard', () => {
  it('keeps legacy time blocks when permanently deleting Goals or Tasks', () => {
    const migration = readFileSync(
      new URL(
        '../supabase/migrations/0019_legacy_time_blocks_delete.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const repository = readFileSync(
      new URL('../lib/data/repository.ts', import.meta.url),
      'utf8',
    );
    expect(migration).toContain("detach_legacy_time_blocks('goal_id'");
    expect(migration).toContain("detach_legacy_time_blocks('task_id'");
    expect(migration).toContain('set %1$I=null');
    expect(repository).toContain("rpc('delete_myplan_goal'");
  });

  it('preserves child Goals when permanently deleting their parent', () => {
    const migration = readFileSync(
      new URL(
        '../supabase/migrations/0020_detach_child_goals_on_delete.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain("column_name='parent_goal_id'");
    expect(migration).toContain("column_name='parent_id'");
    expect(migration).toContain(
      "update public.goals set %1$I=null where %1$I=$1 and %2$I=$2",
    );
  });

  it('parses local environment values', () => {
    expect(parseEnv('A=1\n# comment\nB=value=with=equals\n')).toEqual({
      A: '1',
      B: 'value=with=equals',
    });
  });

  it('accepts only the intended production Supabase project', () => {
    expect(() =>
      assertCloudConfig({
        NEXT_PUBLIC_SUPABASE_URL: `https://${expectedSupabaseProjectRef}.supabase.co`,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      }),
    ).not.toThrow();
    expect(() =>
      assertCloudConfig({
        NEXT_PUBLIC_SUPABASE_URL: 'https://wrong.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      }),
    ).toThrow(/Refusing cloud build/);
  });

  it('checks both production entry points', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<!doctype html><html></html>', { status: 200 }),
    );
    await smokeCheckSite('https://example.test', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/',
      '/login',
    ]);
  });

  it('rejects an API key that Supabase Auth does not accept', async () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: `https://${expectedSupabaseProjectRef}.supabase.co`,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    };
    await expect(
      assertSupabaseAuthReachable(
        env,
        vi.fn(async () => new Response('invalid', { status: 401 })),
      ),
    ).rejects.toThrow(/Supabase Auth rejected/);
    await expect(
      assertSupabaseAuthReachable(
        env,
        vi.fn(async () => new Response('{}', { status: 200 })),
      ),
    ).resolves.toBeUndefined();
  });
});
