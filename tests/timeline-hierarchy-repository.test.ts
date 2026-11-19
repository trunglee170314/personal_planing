import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineHierarchyMove } from '../lib/data/repository';

const transport = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => transport.client,
}));

const plan = {
  version: 'opaque-server-version',
  tree: [
    { id: 'source', parent_task_id: null, goal_id: 'g1', sort_order: 1024 },
  ],
};
const move: TimelineHierarchyMove = {
  task_id: 'source',
  target_kind: 'task',
  target_id: 'target',
  placement: 'inside',
  expected_version: plan.version,
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://isolated.invalid');
  vi.stubEnv(
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'test-only-publishable-key',
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function cloud() {
  vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'cloud');
  const undo = await import('../lib/undo-manager');
  const calls: Array<{
    name: string;
    input: unknown;
    headers: Record<string, string>;
  }> = [];
  let error = '';
  let previewError = '';
  transport.client = {
    async rpc(name: string, input: unknown) {
      calls.push({
        name,
        input: structuredClone(input),
        headers: undo.undoHeaders(),
      });
      if (name === 'myplan_preview_timeline_hierarchy' && previewError)
        return { data: null, error: { message: previewError } };
      if (name === 'myplan_restructure_timeline' && error)
        return { data: null, error: { message: error } };
      return {
        data:
          name === 'myplan_preview_timeline_hierarchy'
            ? structuredClone(plan)
            : name === 'myplan_undo_ready'
              ? !error
              : null,
        error: null,
      };
    },
  };
  const { getPlanningRepository } = await import('../lib/data/repository');
  const repository = getPlanningRepository();
  if (!repository) throw new Error('Missing isolated cloud repository');
  undo.resetUndo(crypto.randomUUID());
  return {
    repository,
    calls,
    undo,
    fail: (message: string) => {
      error = message;
    },
    failPreview: (message: string) => {
      previewError = message;
    },
  };
}

describe('Timeline hierarchy Cloud repository and Undo contract', () => {
  it('previews the raw server tree without creating or invalidating an Undo command', async () => {
    const { repository, calls, undo } = await cloud();
    expect(await repository.previewTimelineHierarchy('source')).toEqual(plan);
    expect(calls).toEqual([
      {
        name: 'myplan_preview_timeline_hierarchy',
        input: { target_task: 'source' },
        headers: {},
      },
    ]);
    expect(undo.undoSnapshot()).toMatchObject({
      available: false,
      busy: false,
      error: '',
    });
  });
  it.each(['inside', 'before', 'after'] as const)(
    'sends the exact %s atomic RPC and prepares one Undo receipt',
    async (placement) => {
      const { repository, calls, undo } = await cloud();
      await repository.restructureTimeline({ ...move, placement });
      expect(calls.map((call) => call.name)).toEqual([
        'myplan_restructure_timeline',
        'myplan_undo_ready',
      ]);
      expect(calls[0].input).toEqual({ ...move, placement });
      expect(calls[0].headers).toEqual({
        'x-myplan-undo-operation': expect.any(String),
        'x-myplan-undo-session': expect.any(String),
      });
      expect(calls[1].input).toEqual({
        target_operation: calls[0].headers['x-myplan-undo-operation'],
        target_session: calls[0].headers['x-myplan-undo-session'],
      });
      expect(undo.undoSnapshot()).toMatchObject({
        available: true,
        busy: false,
        label: 'restructure timeline',
        error: '',
      });
      const receipt = undo.undoSnapshot();
      await repository.previewTimelineHierarchy('source');
      expect(undo.undoSnapshot()).toEqual(receipt);
      expect(calls.at(-1)?.headers).toEqual({});
    },
  );
  it('preserves null Inbox target and the opaque expected version without fallback fields', async () => {
    const { repository, calls } = await cloud();
    await repository.restructureTimeline({
      ...move,
      target_kind: 'goal',
      target_id: null,
    });
    expect(calls[0].input).toEqual({
      ...move,
      target_kind: 'goal',
      target_id: null,
    });
  });
  it('surfaces stale-version failure and preserves an earlier Undo receipt when no partial write exists', async () => {
    const { repository, calls, undo, fail } = await cloud();
    await repository.restructureTimeline(move);
    const before = undo.undoSnapshot();
    fail('This outline changed. Reload it before moving this Task.');
    await expect(repository.restructureTimeline(move)).rejects.toThrow(
      'This outline changed.',
    );
    expect(undo.undoSnapshot()).toEqual(before);
    expect(calls.filter((call) => call.name === 'myplan_undo_apply')).toEqual(
      [],
    );
    expect(undo.undoHeaders()).toEqual({});
  });
  it('propagates preview failure without generating a mutation or Undo receipt', async () => {
    const { repository, calls, undo, failPreview } = await cloud();
    failPreview('Task not found.');
    await expect(repository.previewTimelineHierarchy('source')).rejects.toThrow(
      'Task not found.',
    );
    expect(calls.map((call) => call.name)).toEqual([
      'myplan_preview_timeline_hierarchy',
    ]);
    expect(undo.undoSnapshot()).toMatchObject({
      available: false,
      busy: false,
      error: '',
    });
  });
});

async function local() {
  vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'local');
  vi.stubEnv('NEXT_PUBLIC_LOCAL_API_URL', 'http://isolated.invalid:4318');
  vi.stubEnv('NEXT_PUBLIC_LOCAL_API_TOKEN', 'isolated-test-token');
  const calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
  }> = [];
  let error = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (url.endsWith('/api/timeline/hierarchy') && error)
        return new Response(JSON.stringify({ error }), { status: 409 });
      const data = url.includes('/api/undo/ready')
        ? !error
        : url.includes('/api/timeline/hierarchy/')
          ? plan
          : null;
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
  const undo = await import('../lib/undo-manager');
  const { getPlanningRepository } = await import('../lib/data/repository');
  const repository = getPlanningRepository();
  if (!repository) throw new Error('Missing isolated Local repository');
  undo.resetUndo(crypto.randomUUID());
  return {
    repository,
    calls,
    undo,
    fail: (message: string) => {
      error = message;
    },
  };
}

describe('Timeline hierarchy Local repository transport and Undo contract', () => {
  it('encodes preview IDs and retains Local authentication headers without Undo headers', async () => {
    const { repository, calls, undo } = await local();
    expect(await repository.previewTimelineHierarchy('task /?#')).toEqual(plan);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'http://isolated.invalid:4318/api/timeline/hierarchy/task%20%2F%3F%23',
      method: 'GET',
      body: null,
    });
    expect(calls[0].headers.get('x-myplan-local')).toBe('1');
    expect(calls[0].headers.get('x-myplan-local-token')).toBe(
      'isolated-test-token',
    );
    expect(calls[0].headers.has('x-myplan-undo-operation')).toBe(false);
    expect(undo.undoSnapshot().available).toBe(false);
  });
  it('sends one exact PUT with the Undo operation, then checks the same receipt', async () => {
    const { repository, calls, undo } = await local();
    await repository.restructureTimeline({
      ...move,
      target_kind: 'goal',
      target_id: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: 'http://isolated.invalid:4318/api/timeline/hierarchy',
      method: 'PUT',
      body: { ...move, target_kind: 'goal', target_id: null },
    });
    const operation = calls[0].headers.get('x-myplan-undo-operation');
    const session = calls[0].headers.get('x-myplan-undo-session');
    expect(operation).toBeTruthy();
    expect(session).toBeTruthy();
    expect(calls[1].url).toBe(
      `http://isolated.invalid:4318/api/undo/ready?operation=${operation}&session=${session}`,
    );
    expect(undo.undoSnapshot()).toMatchObject({
      available: true,
      busy: false,
      label: 'restructure timeline',
      error: '',
    });
    expect(undo.undoHeaders()).toEqual({});
  });
  it('surfaces Local stale-version errors without replacing an earlier Undo command', async () => {
    const { repository, calls, undo, fail } = await local();
    await repository.restructureTimeline(move);
    const before = undo.undoSnapshot();
    fail('This Timeline changed. Refresh and drag the Task again.');
    await expect(repository.restructureTimeline(move)).rejects.toThrow(
      'This Timeline changed.',
    );
    expect(undo.undoSnapshot()).toEqual(before);
    expect(calls.filter((call) => call.url.endsWith('/api/undo'))).toEqual([]);
  });
});
