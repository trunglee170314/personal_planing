import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ client: null as unknown }));
// Exercise the real repository, rule parser and recurrence projection. Only the
// external SDK transport is replaced; no network request or real account exists.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => transport.client,
}));

type RecordRow = Record<string, unknown>;
type Page = { table: string; from: number; to: number };
function fakeSupabase(
  data: Record<string, RecordRow[]>,
  errors: Record<string, string> = {},
) {
  const tables: string[] = [];
  const pages: Page[] = [];
  const operations: { table: string; method: string; args: unknown[] }[] = [];
  return {
    tables,
    pages,
    operations,
    from(table: string) {
      tables.push(table);
      let rows = [...(data[table] ?? [])];
      const query = {
        select(...args: unknown[]) {
          operations.push({ table, method: 'select', args });
          return query;
        },
        is(field: string, value: unknown) {
          rows = rows.filter((row) => row[field] === value);
          return query;
        },
        neq(field: string, value: unknown) {
          rows = rows.filter((row) => row[field] !== value);
          return query;
        },
        eq(field: string, value: unknown) {
          rows = rows.filter((row) => row[field] === value);
          return query;
        },
        order(...args: unknown[]) {
          operations.push({ table, method: 'order', args });
          return query;
        },
        range(from: number, to: number) {
          pages.push({ table, from, to });
          return Promise.resolve({
            data: errors[table] ? null : rows.slice(from, to + 1),
            error: errors[table] ? { message: errors[table] } : null,
          });
        },
      };
      return query;
    },
    rpc: vi.fn(async () => ({ data: true, error: null })),
  };
}

function task(id: string, changes: RecordRow = {}): RecordRow {
  return {
    id,
    title: id,
    priority: 'medium',
    status: 'in_progress',
    previous_status: 'planned',
    due_at: '2026-11-30T16:59:00.000Z',
    completed_at: null,
    planned_start: '2026-11-01',
    planned_end: null,
    progress: 67,
    parent_task_id: null,
    dependency_task_id: null,
    is_milestone: false,
    goal_id: 'g1',
    archived_at: null,
    deleted_at: null,
    link_url: 'https://example.com/task',
    link_label: 'Source',
    sort_order: 1024,
    ...changes,
  };
}
function fixture(): Record<string, RecordRow[]> {
  return {
    goals: [
      {
        id: 'g1',
        title: 'Goal',
        description: null,
        progress: 67,
        status: 'active',
        starts_at: '2026-11-01',
        ends_at: '2026-11-30',
        archived_at: null,
        deleted_at: null,
        color_key: 'jade',
        sort_order: 1024,
      },
    ],
    tasks: [
      task('parent'),
      task('child', { parent_task_id: 'parent', progress: 15 }),
      task('inbox', { goal_id: null, progress: 5 }),
    ],
    timeline_milestones: [
      {
        id: 'mark',
        goal_id: null,
        task_id: 'parent',
        title: 'Ship',
        milestone_on: '2026-11-10',
        color_key: null,
        is_important: true,
      },
    ],
    calendar_entries: [
      {
        id: 'repeat',
        task_id: 'parent',
        title: 'Practice',
        starts_at: '2026-11-01T01:00:00.000Z',
        ends_at: '2026-11-01T02:00:00.000Z',
        all_day: false,
        timezone: 'Asia/Ho_Chi_Minh',
        item_type: 'checklist',
        completed_at: null,
        not_needed_at: null,
        notification_offsets: [],
        is_pinned: false,
        occurrence_mode: false,
      },
    ],
    recurrence_rules: [
      {
        id: 'rule',
        calendar_entry_id: 'repeat',
        rrule: 'FREQ=DAILY;UNTIL=20261103',
      },
    ],
    calendar_occurrence_states: [
      {
        id: 's1',
        calendar_entry_id: 'repeat',
        occurrence_start: '2026-11-01T01:00:00.000Z',
        completed_at: '2026-11-01T02:00:00.000Z',
        not_needed_at: null,
        override_starts_at: null,
        override_ends_at: null,
      },
      {
        id: 's2',
        calendar_entry_id: 'repeat',
        occurrence_start: '2026-11-02T01:00:00.000Z',
        completed_at: null,
        not_needed_at: '2026-11-02T02:00:00.000Z',
        override_starts_at: null,
        override_ends_at: null,
      },
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'cloud');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.invalid');
  vi.stubEnv(
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'sb_publishable_test_only',
  );
});
afterEach(() => vi.unstubAllEnvs());

async function repositoryFor(client: ReturnType<typeof fakeSupabase>) {
  transport.client = client;
  const { getPlanningRepository } = await import('../lib/data/repository');
  const repository = getPlanningRepository();
  if (!repository) throw new Error('Mock cloud repository is missing.');
  return repository;
}

describe('Cloud Timeline read contract', () => {
  it('skips Calendar, recurrence and occurrence-state transport entirely in lightweight mode', async () => {
    const client = fakeSupabase(fixture());
    const repository = await repositoryFor(client);
    const result = await repository.getTimelineWorkspace({
      includeChecklistCounts: false,
    });
    expect(client.tables).toEqual(['goals', 'tasks', 'timeline_milestones']);
    expect(result.tasks.find((item) => item.id === 'parent')).toMatchObject({
      progress: 67,
      workflow_status_id: 'in_progress',
      previous_status_id: 'planned',
      planned_start: '2026-11-01',
      due_at: '2026-11-30T16:59:00.000Z',
      link_url: 'https://example.com/task',
      active_checklist_count: 0,
    });
    expect(
      result.tasks.find((item) => item.id === 'child')?.parent_task_id,
    ).toBe('parent');
    expect(result.links).toEqual([
      { task_id: 'parent', goal_id: 'g1' },
      { task_id: 'child', goal_id: 'g1' },
    ]);
    expect(result.goals[0]).toMatchObject({
      task_count: 1,
      completed_task_count: 0,
    });
    expect(result.milestones[0]).toMatchObject({
      task_id: 'parent',
      is_important: true,
    });
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { includeChecklistCounts: true }])(
    'retains full default recurrence counts with options %j',
    async (options) => {
      const client = fakeSupabase(fixture());
      const repository = await repositoryFor(client);
      const result = await repository.getTimelineWorkspace(options);
      expect(client.tables).toEqual([
        'goals',
        'tasks',
        'timeline_milestones',
        'calendar_entries',
        'recurrence_rules',
        'calendar_occurrence_states',
      ]);
      expect(result.tasks.find((item) => item.id === 'parent')).toMatchObject({
        active_checklist_count: 3,
        checklist_resolved_count: 2,
        checklist_done_count: 1,
        progress: 67,
      });
      expect(result.tasks.find((item) => item.id === 'child')).toMatchObject({
        active_checklist_count: 0,
        progress: 15,
        parent_task_id: 'parent',
      });
    },
  );
  it('does not cache an empty lightweight summary into a later full read', async () => {
    const client = fakeSupabase(fixture());
    const repository = await repositoryFor(client);
    await repository.getTimelineWorkspace({ includeChecklistCounts: false });
    const full = await repository.getTimelineWorkspace();
    expect(
      full.tasks.find((item) => item.id === 'parent')?.active_checklist_count,
    ).toBe(3);
    const lightAgain = await repository.getTimelineWorkspace({
      includeChecklistCounts: false,
    });
    expect(lightAgain.links).toEqual(full.links);
    expect(lightAgain.goals).toEqual(full.goals);
    expect(lightAgain.milestones).toEqual(full.milestones);
  });
  it('reads all active Tasks in 500-row pages and excludes archived/deleted rows', async () => {
    const data = fixture();
    data.tasks = [
      ...Array.from({ length: 1001 }, (_, i) =>
        task(`t${i}`, { goal_id: i % 2 ? 'g1' : null }),
      ),
      task('archived', { archived_at: '2026-11-12T00:00:00.000Z' }),
      task('deleted', { deleted_at: '2026-11-12T00:00:00.000Z' }),
    ];
    const client = fakeSupabase(data);
    const repository = await repositoryFor(client);
    const result = await repository.getTimelineWorkspace({
      includeChecklistCounts: false,
    });
    expect(result.tasks).toHaveLength(1001);
    expect(client.pages.filter((page) => page.table === 'tasks')).toEqual([
      { table: 'tasks', from: 0, to: 499 },
      { table: 'tasks', from: 500, to: 999 },
      { table: 'tasks', from: 1000, to: 1499 },
    ]);
    expect(result.links).toHaveLength(500);
    expect(
      result.tasks.some((item) => ['archived', 'deleted'].includes(item.id)),
    ).toBe(false);
    expect(
      client.operations
        .filter(
          (operation) =>
            operation.table === 'tasks' && operation.method === 'order',
        )
        .map((operation) => operation.args[0]),
    ).toEqual(['sort_order', 'created_at', 'id']);
  });
  it('fails when an active Timeline table fails instead of returning a partial workspace', async () => {
    const client = fakeSupabase(fixture(), { tasks: 'Task read failed' });
    const repository = await repositoryFor(client);
    await expect(
      repository.getTimelineWorkspace({ includeChecklistCounts: false }),
    ).rejects.toThrow('Task read failed');
  });
  it('ignores unavailable occurrence history only when it was explicitly omitted', async () => {
    const client = fakeSupabase(fixture(), {
      calendar_occurrence_states: 'History unavailable',
    });
    const repository = await repositoryFor(client);
    await expect(
      repository.getTimelineWorkspace({ includeChecklistCounts: false }),
    ).resolves.toMatchObject({ tasks: expect.any(Array) });
    await expect(repository.getTimelineWorkspace()).rejects.toThrow(
      'History unavailable',
    );
  });
});
