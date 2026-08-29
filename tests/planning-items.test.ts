import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';

type Status = { id: string; category: string };

describe('unified planning items', () => {
  let directory: string;
  let path: string;
  let database: LocalDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'myplan-items-'));
    path = join(directory, 'myplan.db');
    database = new LocalDatabase(path);
  });
  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function status(category: string) {
    const item = (database.listStatuses() as unknown as Status[]).find(
      (candidate) => candidate.category === category,
    );
    if (!item) throw new Error(`Missing ${category}`);
    return item.id;
  }

  it('persists goal color, task link and account theme', () => {
    database.createGoal({
      title: 'IELTS',
      description: null,
      starts_on: '2026-09-01',
      ends_on: '2026-10-01',
      color_key: 'plum',
    });
    const goal = database.listGoals()[0];
    expect(goal.color_key).toBe('plum');
    const taskId = database.createTask({
      title: 'Listening source',
      priority: 'medium',
      due_at: '2026-09-20T16:59:00.000Z',
      workflow_status_id: status('planned'),
      goal_id: goal.id,
      link_url: 'https://example.com/lesson',
      link_label: 'Lesson',
    });
    expect(
      database.getTaskWorkspace().tasks.find((task) => task.id === taskId),
    ).toMatchObject({
      link_url: 'https://example.com/lesson',
      link_label: 'Lesson',
    });
    database.saveTheme('sapphire');
    expect(database.getTheme()).toBe('sapphire');
    expect(() =>
      database.updateTask(taskId, { link_url: 'javascript:alert(1)' }),
    ).toThrow(/http/i);
    expect(() =>
      database.updateTask(taskId, { due_at: '3213-01-01T00:00:00.000Z' }),
    ).toThrow(/2200/);
  });

  it('derives task progress from resolved checklist items', () => {
    const taskId = database.createTask({
      title: 'Finish lesson',
      priority: 'high',
      due_at: null,
      workflow_status_id: status('planned'),
    });
    const first = database.createCalendarSession({
      task_id: taskId,
      title: 'Part one',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T02:00:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'none',
      recurrence_until: null,
      item_type: 'checklist',
      notification_offsets: [5, 15],
    });
    const second = database.createCalendarSession({
      task_id: taskId,
      title: 'Part two',
      starts_at: '2026-09-01T03:00:00.000Z',
      ends_at: '2026-09-01T04:00:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'none',
      recurrence_until: null,
      item_type: 'checklist',
    });
    expect(
      database.getTaskWorkspace().tasks.find((task) => task.id === taskId)
        ?.active_checklist_count,
    ).toBe(2);
    expect(() =>
      database.updateTask(taskId, {
        workflow_status_id: status('completed'),
        completed_at: new Date().toISOString(),
      }),
    ).toThrow(/checklist/i);
    database.updateCalendarSession(first, {
      completed_at: '2026-09-01T02:00:00.000Z',
    });
    expect(database.getTaskWorkspace().tasks[0].progress).toBe(50);
    database.updateCalendarSession(second, {
      not_needed_at: '2026-09-01T02:30:00.000Z',
    });
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      progress: 100,
      completed_at: expect.any(String),
    });
    expect(() =>
      database.updateTask(taskId, {
        workflow_status_id: status('planned'),
        completed_at: null,
        progress: 100,
      }),
    ).toThrow(/completion control/i);
    database.updateCalendarSession(first, {
      not_needed_at: '2026-09-01T03:00:00.000Z',
      completed_at: null,
    });
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      progress: 100,
      completed_at: expect.any(String),
    });
  });

  it('supports manual Task completion and restores only auto-skipped checklist items', () => {
    const taskId = database.createTask({
      title: 'Manual finish',
      priority: 'medium',
      due_at: null,
      workflow_status_id: status('in_progress'),
    });
    database.createCalendarSession({
      task_id: taskId,
      title: 'Still open',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T02:00:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'none',
      recurrence_until: null,
      item_type: 'checklist',
    });
    database.setTaskCompletion(taskId, true);
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      progress: 100,
      completed_at: expect.any(String),
      workflow_status_id: status('completed'),
    });
    expect(
      (
        database.getCalendarWorkspace().sessions[0] as unknown as {
          not_needed_at: string | null;
        }
      ).not_needed_at,
    ).toEqual(expect.any(String));
    database.setTaskCompletion(taskId, false);
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      progress: 0,
      completed_at: null,
      workflow_status_id: status('in_progress'),
    });
    expect(
      (
        database.getCalendarWorkspace().sessions[0] as unknown as {
          not_needed_at: string | null;
        }
      ).not_needed_at,
    ).toBeNull();
  });

  it('completes recurring checklist occurrences idempotently and restores their prior state', () => {
    const taskId = database.createTask({
      title: 'Recurring manual finish',
      priority: 'medium',
      due_at: null,
      workflow_status_id: status('in_progress'),
    });
    const checklistId = database.createCalendarSession({
      task_id: taskId,
      title: 'Three practices',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T02:00:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'daily',
      recurrence_until: '2026-09-03',
      item_type: 'checklist',
    });
    database.updateCalendarOccurrence(checklistId, {
      occurrence_start: '2026-09-02T01:00:00.000Z',
      completed_at: '2026-09-02T02:00:00.000Z',
      not_needed_at: null,
      override_starts_at: '2026-09-02T03:00:00.000Z',
      override_ends_at: '2026-09-02T04:00:00.000Z',
    });

    database.setTaskCompletion(taskId, true);
    const completion = database.getTaskWorkspace().tasks[0].completed_at;
    database.setTaskCompletion(taskId, true);
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      active_checklist_count: 3,
      checklist_resolved_count: 3,
      checklist_done_count: 1,
      progress: 100,
      completed_at: completion,
    });
    expect(database.getTimelineWorkspace().tasks[0]).toMatchObject({
      active_checklist_count: 3,
      checklist_resolved_count: 3,
      checklist_done_count: 1,
    });
    database.updateCalendarSession(checklistId, {
      title: 'Three renamed practices',
    });
    expect(database.getTaskWorkspace().tasks[0].completed_at).toBe(completion);

    database.setTaskCompletion(taskId, false);
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      active_checklist_count: 3,
      checklist_resolved_count: 1,
      checklist_done_count: 1,
      progress: 33,
      completed_at: null,
      workflow_status_id: status('in_progress'),
    });
    const moved = database
      .getCalendarWorkspace()
      .occurrence_states.find(
        (item) => item.occurrence_start === '2026-09-02T01:00:00.000Z',
      );
    expect(moved).toMatchObject({
      completed_at: '2026-09-02T02:00:00.000Z',
      not_needed_at: null,
      override_starts_at: '2026-09-02T03:00:00.000Z',
      override_ends_at: '2026-09-02T04:00:00.000Z',
    });
  });

  it('rejects invalid Task dates and malformed calendar configuration', () => {
    const taskId = database.createTask({
      title: 'Guarded task',
      priority: 'medium',
      due_at: '2026-09-10T16:59:00.000Z',
      planned_start: '2026-09-01',
      workflow_status_id: status('planned'),
    });
    expect(() =>
      database.updateTask(taskId, { planned_start: '2026-09-11' }),
    ).toThrow(/deadline/i);
    expect(() =>
      database.createCalendarSession({
        task_id: null,
        title: 'Orphan checklist',
        starts_at: '2026-09-01T01:00:00.000Z',
        ends_at: '2026-09-01T02:00:00.000Z',
        all_day: false,
        timezone: 'Asia/Ho_Chi_Minh',
        recurrence: 'none',
        recurrence_until: null,
        item_type: 'checklist',
      }),
    ).toThrow(/Task/i);
    expect(() =>
      database.createCalendarSession({
        task_id: null,
        title: 'Bad notification',
        starts_at: '2026-09-01T01:00:00.000Z',
        ends_at: '2026-09-01T01:15:00.000Z',
        all_day: false,
        timezone: 'Asia/Ho_Chi_Minh',
        recurrence: 'none',
        recurrence_until: null,
        item_type: 'reminder',
        notification_offsets: [10],
      }),
    ).toThrow(/notification/i);
  });

  it('stores completion independently for each repeating occurrence', () => {
    const reminderId = database.createCalendarSession({
      task_id: null,
      title: 'Daily review',
      starts_at: '2026-09-01T01:30:00.000Z',
      ends_at: '2026-09-01T01:45:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'daily',
      recurrence_until: '2026-09-03',
      item_type: 'reminder',
    });
    database.updateCalendarOccurrence(reminderId, {
      occurrence_start: '2026-09-01T01:30:00.000Z',
      completed_at: '2026-09-01T01:35:00.000Z',
      not_needed_at: null,
    });
    expect(database.getCalendarWorkspace().occurrence_states).toEqual([
      expect.objectContaining({
        calendar_entry_id: reminderId,
        occurrence_start: '2026-09-01T01:30:00.000Z',
        completed_at: '2026-09-01T01:35:00.000Z',
      }),
    ]);
    expect(
      (
        database.getCalendarWorkspace().sessions as unknown as Array<{
          id: string;
          completed_at: string | null;
        }>
      ).find((item) => item.id === reminderId)?.completed_at,
    ).toBeNull();
    database.moveCalendarOccurrences(reminderId, [
      {
        occurrence_start: '2026-09-01T01:30:00.000Z',
        override_starts_at: '2026-09-01T02:00:00.000Z',
        override_ends_at: '2026-09-01T02:15:00.000Z',
      },
    ]);
    expect(database.getCalendarWorkspace().occurrence_states[0]).toMatchObject({
      occurrence_start: '2026-09-01T01:30:00.000Z',
      completed_at: '2026-09-01T01:35:00.000Z',
      override_starts_at: '2026-09-01T02:00:00.000Z',
      override_ends_at: '2026-09-01T02:15:00.000Z',
    });
    database.moveCalendarSeries(reminderId, {
      original_start: '2026-09-01T01:30:00.000Z',
      original_end: '2026-09-01T01:45:00.000Z',
      next_start: '2026-09-01T02:30:00.000Z',
      next_end: '2026-09-01T02:45:00.000Z',
    });
    expect(database.getCalendarWorkspace().occurrence_states[0]).toMatchObject({
      calendar_entry_id: reminderId,
      occurrence_start: '2026-09-01T02:30:00.000Z',
      completed_at: '2026-09-01T01:35:00.000Z',
      override_starts_at: '2026-09-01T03:00:00.000Z',
      override_ends_at: '2026-09-01T03:15:00.000Z',
    });
  });

  it('moves the repeat-until horizon with an entire series date move', () => {
    const reminderId = database.createCalendarSession({
      task_id: null,
      title: 'Finite reminder',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T01:15:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'daily',
      recurrence_until: '2026-09-03',
      item_type: 'reminder',
    });
    database.moveCalendarSeries(reminderId, {
      original_start: '2026-09-01T01:00:00.000Z',
      original_end: '2026-09-01T01:15:00.000Z',
      next_start: '2026-09-11T01:00:00.000Z',
      next_end: '2026-09-11T01:15:00.000Z',
    });
    expect(
      (
        database.getCalendarWorkspace().sessions as unknown as Array<{
          id: string;
          starts_at: string;
          recurrence_until: string | null;
        }>
      ).find((item) => item.id === reminderId),
    ).toMatchObject({
      starts_at: '2026-09-11T01:00:00.000Z',
      recurrence_until: '2026-09-13',
    });
  });

  it('calculates Task progress from each finite recurring checklist occurrence', () => {
    const taskId = database.createTask({
      title: 'Three-day practice',
      priority: 'medium',
      due_at: null,
      workflow_status_id: status('in_progress'),
    });
    const checklistId = database.createCalendarSession({
      task_id: taskId,
      title: 'Practice',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T02:00:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'daily',
      recurrence_until: '2026-09-03',
      item_type: 'checklist',
    });
    expect(database.getTaskWorkspace().tasks[0].progress).toBe(0);
    database.updateCalendarOccurrence(checklistId, {
      occurrence_start: '2026-09-01T01:00:00.000Z',
      completed_at: '2026-09-01T02:00:00.000Z',
      not_needed_at: null,
    });
    expect(database.getTaskWorkspace().tasks[0].progress).toBe(33);
    database.updateCalendarOccurrence(checklistId, {
      occurrence_start: '2026-09-02T01:00:00.000Z',
      completed_at: null,
      not_needed_at: '2026-09-02T01:30:00.000Z',
    });
    expect(database.getTaskWorkspace().tasks[0].progress).toBe(67);
    database.updateCalendarOccurrence(checklistId, {
      occurrence_start: '2026-09-03T01:00:00.000Z',
      completed_at: '2026-09-03T02:00:00.000Z',
      not_needed_at: null,
    });
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      progress: 100,
      workflow_status_id: status('completed'),
    });
    database.updateCalendarOccurrence(checklistId, {
      occurrence_start: '2026-09-03T01:00:00.000Z',
      completed_at: null,
      not_needed_at: null,
    });
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      progress: 67,
      workflow_status_id: status('in_progress'),
    });
  });

  it('preserves an active workflow status while checklist progress changes', () => {
    const taskId = database.createTask({
      title: 'Active lesson',
      priority: 'medium',
      due_at: null,
      workflow_status_id: status('in_progress'),
    });
    const checklistId = database.createCalendarSession({
      task_id: taskId,
      title: 'First pass',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T02:00:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'none',
      recurrence_until: null,
      item_type: 'checklist',
    });
    expect(database.getTaskWorkspace().tasks[0].workflow_status_id).toBe(
      status('in_progress'),
    );
    database.updateCalendarSession(checklistId, {
      completed_at: '2026-09-01T02:00:00.000Z',
    });
    expect(database.getTaskWorkspace().tasks[0].workflow_status_id).toBe(
      status('completed'),
    );
    database.updateCalendarSession(checklistId, { completed_at: null });
    expect(database.getTaskWorkspace().tasks[0].workflow_status_id).toBe(
      status('in_progress'),
    );
  });

  it('stores point reminders independently and keeps Timeline milestones editable', () => {
    const reminderId = database.createCalendarSession({
      task_id: null,
      title: 'Pay electricity',
      starts_at: '2026-09-01T01:30:00.000Z',
      ends_at: '2026-09-01T01:45:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'none',
      recurrence_until: null,
      item_type: 'reminder',
      notification_offsets: [0, 5, 15, 60, 1440],
      is_pinned: true,
    });
    const reminders = database.getCalendarWorkspace()
      .sessions as unknown as Array<{
      id: string;
      item_type: string;
      task_id: string | null;
      is_pinned: boolean;
      notification_offsets: number[];
    }>;
    expect(reminders.find((item) => item.id === reminderId)).toMatchObject({
      item_type: 'reminder',
      task_id: null,
      is_pinned: true,
      notification_offsets: [0, 5, 15, 60, 1440],
    });
    const milestoneId = database.createTimelineMilestone({
      title: 'Exam day',
      milestone_on: '2026-10-01',
      goal_id: null,
    });
    database.updateTimelineMilestone(milestoneId, {
      milestone_on: '2026-10-02',
    });
    expect(database.getTimelineWorkspace().milestones[0]).toMatchObject({
      id: milestoneId,
      milestone_on: '2026-10-02',
    });
  });
});
