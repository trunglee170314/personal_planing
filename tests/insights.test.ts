import { describe, expect, it } from 'vitest';
import {
  buildWeeklyInsights,
  insightDay,
  insightWeek,
  insightMidnight,
  safeTaskLink,
  taskDeadline,
  occurrenceOutcome,
} from '../lib/insights';
import { expandRecurringSessions, recurringSeriesFrom } from '../lib/calendar';
import type {
  CalendarSession,
  CalendarWorkspace,
  Task,
} from '../lib/data/repository';

const now = new Date('2026-10-15T12:00:00+07:00');
const iso = (day: string, time = '08:00') =>
  new Date(`${day}T${time}:00+07:00`).toISOString();
function task(id: string, changes: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    priority: 'medium',
    due_at: null,
    completed_at: null,
    workflow_status_id: 'planned',
    previous_status_id: null,
    planned_start: null,
    planned_end: null,
    progress: 0,
    parent_task_id: null,
    dependency_task_id: null,
    is_milestone: false,
    archived_at: null,
    deleted_at: null,
    link_url: null,
    link_label: null,
    active_checklist_count: 0,
    checklist_resolved_count: 0,
    checklist_done_count: 0,
    ...changes,
  };
}
function session(
  id: string,
  day = '2026-10-15',
  changes: Partial<CalendarSession> = {},
): CalendarSession {
  return {
    id,
    task_id: 'task',
    title: id,
    starts_at: iso(day),
    ends_at: iso(day, '09:00'),
    all_day: false,
    timezone: 'Asia/Ho_Chi_Minh',
    recurrence: 'none',
    recurrence_until: null,
    recurrence_interval: 1,
    item_type: 'checklist',
    completed_at: null,
    not_needed_at: null,
    notification_offsets: [],
    is_pinned: false,
    ...changes,
  };
}
function workspace(
  changes: Partial<CalendarWorkspace> = {},
): CalendarWorkspace {
  return {
    goals: [{ id: 'goal', title: 'Career', color_key: 'jade' }],
    tasks: [task('task')],
    statuses: [
      { id: 'planned', category: 'planned' },
      { id: 'cancelled', category: 'cancelled' },
      { id: 'completed', category: 'completed' },
    ],
    sessions: [],
    links: [{ task_id: 'task', goal_id: 'goal' }],
    occurrence_states: [],
    ...changes,
  };
}
const build = (w: CalendarWorkspace, week = '2026-10-12') =>
  buildWeeklyInsights(w, week, now);
describe('Insights projection', () => {
  it('uses Vietnam Monday boundaries independent of the host timezone', () => {
    expect(insightWeek('2026-10-18')).toBe('2026-10-12');
    expect(insightWeek('2026-10-19')).toBe('2026-10-19');
    expect(insightMidnight('2026-10-12').toISOString()).toBe(
      '2026-10-11T17:00:00.000Z',
    );
    expect(insightDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(() => insightDay('2026-02-30')).toThrow();
  });
  it('has honest empty states rather than a fabricated 100% rate', () => {
    const result = build(workspace());
    expect(result.completionRate).toBeNull();
    expect(result.weekly).toEqual([]);
    expect(result.byGoal.reduce((n, g) => n + g.items.length, 0)).toBe(0);
  });
  it('partitions outcomes, makes overdue a subset of Open, and never counts Not needed as performed', () => {
    const result = build(
      workspace({
        sessions: [
          session('done', '2026-10-12', { completed_at: iso('2026-10-12') }),
          session('skipped', '2026-10-13', {
            not_needed_at: iso('2026-10-13'),
          }),
          session('late'),
          session('future', '2026-10-16'),
        ],
      }),
    );
    expect([
      result.weekly.length,
      result.done.length,
      result.notNeeded.length,
      result.open.length,
      result.overdue.length,
    ]).toEqual([4, 1, 1, 2, 1]);
    expect(result.completionRate).toBe(25);
    expect(
      result.done.length + result.notNeeded.length + result.open.length,
    ).toBe(result.weekly.length);
    expect(result.overdue.every((s) => result.open.includes(s))).toBe(true);
    expect(result.byGoal[0].overdue).toBe(1);
    expect(result.byGoal[0].tasks[0].progress).toBe(0);
  });
  it('counts displayed starts once, including exact Monday and excluding prior-week cross-midnight work', () => {
    const result = build(
      workspace({
        sessions: [
          session('monday', '2026-10-12', {
            starts_at: iso('2026-10-12', '00:00'),
          }),
          session('crossing', '2026-10-11', {
            starts_at: iso('2026-10-11', '23:30'),
            ends_at: iso('2026-10-12', '00:30'),
          }),
          session('next-week', '2026-10-19', {
            starts_at: iso('2026-10-19', '00:00'),
          }),
        ],
      }),
    );
    expect(result.weekly.map((s) => s.id)).toEqual(['monday']);
  });
  it('counts recurrence occurrences and applies moved-in/out overrides with original identities', () => {
    const w = workspace({
      sessions: [
        session('daily', '2026-10-01', {
          recurrence: 'daily',
          recurrence_until: '2026-10-31',
        }),
      ],
      occurrence_states: [
        {
          calendar_entry_id: 'daily',
          occurrence_start: iso('2026-10-12'),
          override_starts_at: iso('2026-10-21'),
          override_ends_at: iso('2026-10-21', '09:00'),
          completed_at: null,
          not_needed_at: null,
        },
        {
          calendar_entry_id: 'daily',
          occurrence_start: iso('2026-10-20'),
          override_starts_at: iso('2026-10-14'),
          override_ends_at: iso('2026-10-14', '09:00'),
          completed_at: iso('2026-10-14'),
          not_needed_at: null,
        },
        {
          calendar_entry_id: 'daily',
          occurrence_start: iso('2026-10-13'),
          completed_at: null,
          not_needed_at: iso('2026-10-13'),
        },
      ],
    });
    const result = build(w);
    expect(result.weekly).toHaveLength(7);
    expect(new Set(result.weekly.map((s) => s.occurrence_id)).size).toBe(7);
    expect(
      result.weekly.some((s) => s.occurrence_start === iso('2026-10-12')),
    ).toBe(false);
    expect(result.done[0].occurrence_start).toBe(iso('2026-10-20'));
    expect(result.notNeeded).toHaveLength(1);
  });
  it('excludes reminders and task lifecycle-unavailable series consistently', () => {
    const w = workspace({
      tasks: [
        task('task'),
        task('archived', { archived_at: iso('2026-10-01') }),
        task('deleted', { deleted_at: iso('2026-10-01') }),
        task('cancelled', { workflow_status_id: 'cancelled' }),
      ],
      sessions: [
        session('valid'),
        session('reminder', undefined, { item_type: 'reminder' }),
        ...['archived', 'deleted', 'cancelled', 'missing'].map((id) =>
          session(id, undefined, { task_id: id }),
        ),
      ],
    });
    const result = build(w);
    expect(result.weekly.map((s) => s.id)).toEqual(['valid']);
    expect(result.excludedSeries).toBe(4);
    expect(result.tasksById.size).toBe(1);
  });
  it('keeps all eligible work in exactly one Goal bucket, including missing Goal links', () => {
    const result = build(
      workspace({
        tasks: [task('task'), task('inbox'), task('dangling')],
        links: [
          { task_id: 'task', goal_id: 'goal' },
          { task_id: 'dangling', goal_id: 'missing' },
        ],
        sessions: [
          session('a'),
          session('b', undefined, { task_id: 'inbox' }),
          session('c', undefined, { task_id: 'dangling' }),
          session('orphan', undefined, { task_id: null }),
        ],
      }),
    );
    expect(result.byGoal.map((g) => g.items.length)).toEqual([1, 3]);
    expect(result.checklistsWithoutGoal).toHaveLength(3);
    expect(result.tasksWithoutGoal.map((t) => t.id)).toEqual([
      'dangling',
      'inbox',
    ]);
    expect(
      result.byGoal.reduce((n, g) => n + g.done + g.notNeeded + g.open, 0),
    ).toBe(4);
  });
  it('does not double-count child checklists under their parent Task', () => {
    const result = build(
      workspace({
        tasks: [task('task'), task('child', { parent_task_id: 'task' })],
        links: [
          { task_id: 'task', goal_id: 'goal' },
          { task_id: 'child', goal_id: 'goal' },
        ],
        sessions: [session('child-work', undefined, { task_id: 'child' })],
      }),
    );
    expect(result.byGoal[0].tasks).toHaveLength(2);
    expect(result.weekly).toHaveLength(1);
  });
  it('uses inclusive Vietnam deadline dates with planned_end fallback', () => {
    expect(taskDeadline(task('a', { due_at: '2026-10-15' }))).toBe(
      '2026-10-15',
    );
    expect(taskDeadline(task('b', { due_at: '2026-10-14T20:00:00Z' }))).toBe(
      '2026-10-15',
    );
    expect(taskDeadline(task('c', { planned_end: '2026-10-16' }))).toBe(
      '2026-10-16',
    );
    const result = build(
      workspace({
        tasks: [
          task('past', { due_at: '2026-10-14' }),
          task('today', { due_at: '2026-10-15' }),
          task('day6', { due_at: '2026-10-21' }),
          task('day7', { due_at: '2026-10-22' }),
          task('done', {
            due_at: '2026-10-14',
            completed_at: iso('2026-10-14'),
          }),
          task('cancelled', {
            due_at: '2026-10-14',
            workflow_status_id: 'cancelled',
          }),
        ],
      }),
    );
    expect(result.overdueTasks.map((t) => t.id)).toEqual(['past']);
    expect(result.unscheduledTasks.map((t) => t.id)).toEqual(['today', 'day6']);
  });
  it('only an open upcoming or ongoing occurrence before the deadline clears the due-soon alert', () => {
    const ids = ['past', 'done', 'skip', 'ongoing', 'future', 'after-deadline'];
    const result = build(
      workspace({
        tasks: ids.map((id) => task(id, { due_at: '2026-10-16' })),
        sessions: [
          session('p', '2026-10-14', { task_id: 'past' }),
          session('d', '2026-10-16', {
            task_id: 'done',
            completed_at: iso('2026-10-15'),
          }),
          session('s', '2026-10-16', {
            task_id: 'skip',
            not_needed_at: iso('2026-10-15'),
          }),
          session('o', '2026-10-15', {
            task_id: 'ongoing',
            starts_at: iso('2026-10-15', '11:00'),
            ends_at: iso('2026-10-15', '13:00'),
          }),
          session('f', '2026-10-16', { task_id: 'future' }),
          session('a', '2026-10-17', { task_id: 'after-deadline' }),
        ],
      }),
    );
    expect(new Set(result.unscheduledTasks.map((t) => t.id))).toEqual(
      new Set(['past', 'done', 'skip', 'after-deadline']),
    );
  });
  it('keeps current Task attention independent from a selected historical week', () => {
    const result = build(
      workspace({
        tasks: [task('past', { due_at: '2026-10-14' })],
        sessions: [session('scheduled', '2026-10-15', { task_id: 'past' })],
      }),
      '2026-09-07',
    );
    expect(result.weekly).toHaveLength(0);
    expect(result.overdueTasks).toHaveLength(1);
  });
  it('does not mutate data or reinterpret resolved work as actual execution', () => {
    const w = workspace({
        sessions: [
          session('skip', undefined, { not_needed_at: iso('2026-10-15') }),
        ],
      }),
      before = structuredClone(w);
    const result = build(w);
    expect(w).toEqual(before);
    expect(result.completionRate).toBe(0);
    expect(occurrenceOutcome(result.weekly[0])).toBe('Not needed');
  });
  it('only exposes http/https Task links', () => {
    expect(
      safeTaskLink(task('a', { link_url: 'https://example.test/path' })),
    ).toBe('https://example.test/path');
    for (const url of ['javascript:alert(1)', 'file:///private', 'broken'])
      expect(safeTaskLink(task('a', { link_url: url }))).toBeNull();
  });
});
describe('Insights recurrence regressions', () => {
  it('fast-forwards monthly series older than the safety budget without losing the month-end anchor', () => {
    const items = expandRecurringSessions(
      [session('ancient', '1900-01-31', { recurrence: 'monthly' })],
      insightMidnight('2026-02-01'),
      insightMidnight('2026-03-01'),
    );
    expect(items).toHaveLength(1);
    expect(items[0].starts_at).toBe(iso('2026-02-28'));
  });
  it('keeps Vietnam recurrence times stable across another host timezone DST boundary', () => {
    const items = expandRecurringSessions(
      [
        session('dst', '2026-03-06', {
          recurrence: 'daily',
          recurrence_until: '2026-03-10',
        }),
      ],
      insightMidnight('2026-03-06'),
      insightMidnight('2026-03-11'),
    );
    expect(items.map((s) => s.starts_at)).toEqual(
      ['06', '07', '08', '09', '10'].map((day) => iso(`2026-03-${day}`)),
    );
    const future = recurringSeriesFrom(
      session('dst', '2026-03-06', {
        recurrence: 'daily',
        recurrence_until: '2026-03-10',
      }),
      items[2],
      [],
    );
    expect(future.map((item) => item.occurrence_start)).toEqual(
      items.slice(2).map((item) => item.occurrence_start),
    );
  });
});
