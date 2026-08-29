import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalDatabase } from '../local-server/database.mjs';

type StatusRow = { id: string; category: string };

function statusId(database: LocalDatabase, category: string) {
  const status = (database.listStatuses() as unknown as StatusRow[]).find(
    (row) => row.category === category,
  );
  if (!status) throw new Error(`Missing ${category} status in test database.`);
  return status.id;
}

describe('local SQLite database', () => {
  let directory: string;
  let databasePath: string;
  let database: LocalDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'myplan-local-'));
    databasePath = join(directory, 'myplan.db');
    database = new LocalDatabase(databasePath);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('bootstraps one reusable default workflow', () => {
    const statuses = database.listStatuses() as unknown as StatusRow[];
    expect(statuses.map((status) => status.category)).toEqual([
      'backlog',
      'planned',
      'in_progress',
      'blocked',
      'completed',
      'cancelled',
      'archived',
    ]);

    database.close();
    database = new LocalDatabase(databasePath);
    expect(database.listStatuses()).toHaveLength(7);
  });

  it('creates, completes, reopens and archives goals', () => {
    database.createGoal({
      title: '  Ship local mode  ',
      description: 'Laptop workspace',
      ends_on: '2026-12-31',
    });
    const [goal] = database.listGoals();
    expect(goal.title).toBe('Ship local mode');

    database.updateGoal(goal.id, {
      progress: 100,
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    expect(database.listGoals()[0]).toMatchObject({
      progress: 100,
      status: 'completed',
    });

    database.updateGoal(goal.id, {
      progress: 40,
      status: 'active',
      completed_at: null,
    });
    expect(database.listGoals()[0]).toMatchObject({
      progress: 40,
      status: 'active',
    });

    database.updateGoal(goal.id, {
      status: 'archived',
      archived_at: new Date().toISOString(),
    });
    expect(database.listGoals()).toEqual([]);
    expect(() =>
      database.createGoal({ title: ' ', description: null, ends_on: null }),
    ).toThrow(/Goal title/);
  });

  it('edits, archives, trashes, restores and permanently deletes a goal without deleting linked tasks', () => {
    database.createGoal({
      title: 'Original goal',
      description: null,
      starts_on: '2026-09-01',
      ends_on: '2026-10-01',
    });
    const goal = database.listGoals()[0];
    const plannedId = statusId(database, 'planned');
    const taskId = database.createTask({
      title: 'Keep this task',
      priority: 'medium',
      due_at: null,
      workflow_status_id: plannedId,
      goal_id: goal.id,
    });

    database.updateGoal(goal.id, {
      title: 'Edited goal',
      description: 'Updated',
      starts_on: '2026-09-02',
      ends_on: '2026-10-02',
      progress: 35,
    });
    expect(database.listGoals()[0]).toMatchObject({
      title: 'Edited goal',
      description: 'Updated',
      progress: 0,
    });
    expect(() =>
      database.updateGoal(goal.id, {
        starts_on: '2026-11-01',
        ends_on: '2026-10-01',
      }),
    ).toThrow(/end date/i);

    database.updateGoal(goal.id, {
      status: 'archived',
      archived_at: new Date().toISOString(),
    });
    expect(database.listGoals('active')).toEqual([]);
    expect(database.listGoals('archived')[0].id).toBe(goal.id);

    database.updateGoal(goal.id, { deleted_at: new Date().toISOString() });
    expect(database.listGoals('archived')).toEqual([]);
    expect(database.listGoals('trash')[0].id).toBe(goal.id);

    database.updateGoal(goal.id, { deleted_at: null });
    expect(database.listGoals('archived')[0].id).toBe(goal.id);
    database.deleteGoal(goal.id);
    expect(database.listGoals('archived')).toEqual([]);
    expect(database.getTaskWorkspace().tasks[0].id).toBe(taskId);
    expect(database.getTaskWorkspace().links).toEqual([]);
  });

  it('creates a task and goal link atomically and exposes it in every workspace', () => {
    database.createGoal({
      title: 'Build a calmer system',
      description: null,
      ends_on: '2026-10-01',
    });
    const goal = database.listGoals()[0];
    const plannedId = statusId(database, 'planned');
    const completedId = statusId(database, 'completed');
    const dueAt = new Date().toISOString();

    const taskId = database.createTask({
      title: 'Write plan',
      priority: 'high',
      due_at: dueAt,
      workflow_status_id: plannedId,
      goal_id: goal.id,
    });
    const workspace = database.getTaskWorkspace();
    expect(workspace.tasks[0]).toMatchObject({
      id: taskId,
      title: 'Write plan',
      priority: 'high',
    });
    expect(workspace.links).toContainEqual(
      expect.objectContaining({ task_id: taskId, goal_id: goal.id }),
    );
    expect(database.getCalendarWorkspace().tasks).toHaveLength(1);
    expect(database.getTimelineWorkspace().tasks).toHaveLength(1);

    database.updateTask(taskId, {
      workflow_status_id: completedId,
      previous_status_id: plannedId,
      completed_at: dueAt,
    });
    expect(database.getTodayWorkspace().tasks[0].completed_at).toBe(dueAt);

    database.updateTask(taskId, {
      workflow_status_id: plannedId,
      previous_status_id: null,
      completed_at: null,
    });
    expect(database.getTaskWorkspace().tasks[0]).toMatchObject({
      workflow_status_id: plannedId,
      completed_at: null,
    });
    expect(() =>
      database.createTask({
        title: 'Broken',
        priority: 'invalid',
        due_at: null,
        workflow_status_id: plannedId,
      }),
    ).toThrow(/priority/);
  });

  it('derives goal progress from linked leaf tasks and reopens the goal', () => {
    database.createGoal({
      title: 'Automatic goal',
      description: null,
      ends_on: null,
    });
    const goalId = database.listGoals()[0].id;
    const plannedId = statusId(database, 'planned');
    const completedId = statusId(database, 'completed');
    const completedAt = '2026-08-31T12:00:00.000Z';

    const parentId = database.createTask({
      title: 'Parent task',
      priority: 'medium',
      due_at: null,
      workflow_status_id: plannedId,
      goal_id: goalId,
    });
    expect(database.listGoals()[0]).toMatchObject({
      task_count: 1,
      completed_task_count: 0,
      progress: 0,
      status: 'active',
    });

    database.updateTask(parentId, {
      workflow_status_id: completedId,
      completed_at: completedAt,
      progress: 100,
    });
    expect(database.listGoals()[0]).toMatchObject({
      task_count: 1,
      completed_task_count: 1,
      progress: 100,
      status: 'completed',
    });

    const childId = database.createTask({
      title: 'Leaf task',
      priority: 'high',
      due_at: null,
      workflow_status_id: plannedId,
      goal_id: goalId,
      parent_task_id: parentId,
    });
    expect(database.listGoals()[0]).toMatchObject({
      task_count: 1,
      completed_task_count: 0,
      progress: 0,
      status: 'active',
    });

    database.updateTask(childId, {
      workflow_status_id: completedId,
      completed_at: completedAt,
      progress: 100,
    });
    expect(database.listGoals()[0]).toMatchObject({
      task_count: 1,
      completed_task_count: 1,
      progress: 100,
      status: 'completed',
    });

    database.updateTask(childId, {
      workflow_status_id: plannedId,
      completed_at: null,
      progress: 0,
    });
    expect(database.listGoals()[0]).toMatchObject({
      progress: 0,
      status: 'active',
    });
  });

  it('edits, archives, trashes, restores and permanently deletes tasks while detaching references', () => {
    const plannedId = statusId(database, 'planned');
    const parentId = database.createTask({
      title: 'Parent',
      priority: 'low',
      due_at: null,
      workflow_status_id: plannedId,
    });
    const childId = database.createTask({
      title: 'Child',
      priority: 'medium',
      due_at: null,
      workflow_status_id: plannedId,
      parent_task_id: parentId,
      dependency_task_id: parentId,
    });
    database.createCalendarSession({
      task_id: parentId,
      title: 'Parent block',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T02:00:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'none',
      recurrence_until: null,
    });

    database.updateTask(parentId, {
      title: 'Edited parent',
      priority: 'urgent',
      planned_start: '2026-09-01',
      planned_end: '2026-09-03',
    });
    expect(
      database.getTaskWorkspace().tasks.find((task) => task.id === parentId),
    ).toMatchObject({
      title: 'Edited parent',
      priority: 'urgent',
      progress: 0,
    });
    expect(() => database.updateTask(parentId, { title: ' ' })).toThrow(
      /Task title/,
    );
    expect(() =>
      database.updateTask(parentId, {
        planned_start: '2026-09-04',
        planned_end: '2026-09-03',
      }),
    ).toThrow(/Planned end/);

    database.updateTask(parentId, { archived_at: new Date().toISOString() });
    expect(database.getTaskWorkspace('archived').tasks[0].id).toBe(parentId);
    database.updateTask(parentId, { deleted_at: new Date().toISOString() });
    expect(database.getTaskWorkspace('archived').tasks).toEqual([]);
    expect(database.getTaskWorkspace('trash').tasks[0].id).toBe(parentId);
    database.updateTask(parentId, { deleted_at: null, archived_at: null });
    expect(
      database
        .getTaskWorkspace('active')
        .tasks.some((task) => task.id === parentId),
    ).toBe(true);

    database.deleteTask(parentId);
    const child = database
      .getTaskWorkspace()
      .tasks.find((task) => task.id === childId);
    expect(child).toMatchObject({
      parent_task_id: null,
      dependency_task_id: null,
    });
    expect(
      database.getCalendarWorkspace().sessions[0] as unknown as {
        task_id: string | null;
        item_type: string;
      },
    ).toMatchObject({ task_id: null, item_type: 'reminder' });
  });

  it('stores calendar sessions, Gantt planning and completed pomodoros independently', () => {
    const plannedId = statusId(database, 'planned');
    const taskId = database.createTask({
      title: 'Deep work',
      priority: 'high',
      due_at: null,
      workflow_status_id: plannedId,
      planned_start: '2026-08-30',
      planned_end: '2026-09-03',
    });
    database.createCalendarSession({
      task_id: taskId,
      title: 'Deep work block',
      starts_at: '2026-08-30T01:00:00.000Z',
      ends_at: '2026-08-30T02:30:00.000Z',
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: 'none',
      recurrence_until: null,
    });
    database.recordPomodoroSession({
      started_at: '2026-08-30T01:00:00.000Z',
      completed_at: '2026-08-30T01:25:00.000Z',
      duration_minutes: 25,
    });

    expect(database.getTimelineWorkspace().tasks[0]).toMatchObject({
      planned_start: '2026-08-30',
      planned_end: '2026-09-03',
    });
    expect(database.getCalendarWorkspace().sessions[0]).toMatchObject({
      task_id: taskId,
      all_day: false,
    });
    expect(database.getPomodoroWorkspace().sessions[0]).toMatchObject({
      duration_minutes: 25,
    });
  });

  it('upserts one weekly review and calculates task and goal statistics', () => {
    const plannedId = statusId(database, 'planned');
    const completedId = statusId(database, 'completed');
    database.createGoal({
      title: 'Review consistently',
      description: null,
      ends_on: null,
    });
    const taskId = database.createTask({
      title: 'Finish review',
      priority: 'medium',
      due_at: null,
      workflow_status_id: plannedId,
    });
    database.updateTask(taskId, {
      workflow_status_id: completedId,
      previous_status_id: plannedId,
      completed_at: '2026-08-25T12:00:00.000Z',
    });

    database.saveWeeklyReview({
      week_start: '2026-08-24',
      wins: 'First',
      challenges: '',
      next_week_focus: '',
      satisfaction: 3,
    });
    database.saveWeeklyReview({
      week_start: '2026-08-24',
      wins: 'Updated',
      challenges: '',
      next_week_focus: 'Keep going',
      satisfaction: 5,
    });
    const workspace = database.getReviewsWorkspace(
      '2026-08-24T00:00:00.000Z',
      '2026-08-31T00:00:00.000Z',
    );

    expect(workspace.reviews).toHaveLength(1);
    expect(workspace.reviews[0]).toMatchObject({
      wins: 'Updated',
      satisfaction: 5,
    });
    expect(workspace.stats).toEqual({
      completedTasks: 1,
      openTasks: 0,
      activeGoals: 1,
    });
    expect(() =>
      database.saveWeeklyReview({
        week_start: '2026-08-24',
        wins: '',
        challenges: '',
        next_week_focus: '',
        satisfaction: 6,
      }),
    ).toThrow(/Satisfaction/);
  });
});
