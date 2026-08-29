import { describe, it, expect } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { undoContext } from '../local-server/undo.mjs';
import type { CalendarWorkspace } from '../lib/data/repository';
const session = '00000000-0000-4000-8000-000000000021',
  operation = '00000000-0000-4000-8000-000000000022';
function setup() {
  const db = new LocalDatabase(':memory:');
  const goal = db.createGoal({
    title: 'Group',
    starts_on: '2026-09-01',
    ends_on: '2026-09-30',
  });
  const task = db.createTask({
    title: 'Task',
    priority: 'medium',
    goal_id: goal,
    workflow_status_id: 'local-status-planned',
    planned_start: '2026-09-02',
    due_at: '2026-09-10T16:59:00.000Z',
  });
  const child = db.createTask({
    title: 'Child stays',
    priority: 'medium',
    goal_id: goal,
    parent_task_id: task,
    workflow_status_id: 'local-status-planned',
    planned_start: '2026-09-04',
    due_at: '2026-09-12T16:59:00.000Z',
  });
  const mark = db.createTimelineMilestone({
    title: 'Milestone',
    goal_id: null,
    task_id: task,
    milestone_on: '2026-09-09',
  });
  const calendar = db.createCalendarSession({
    title: 'Checklist',
    task_id: task,
    item_type: 'checklist',
    starts_at: '2026-09-03T01:00:00.000Z',
    ends_at: '2026-09-03T02:00:00.000Z',
    all_day: false,
    timezone: 'Asia/Ho_Chi_Minh',
    recurrence: 'daily',
    recurrence_until: '2026-09-10',
    notification_offsets: [],
  });
  db.updateCalendarOccurrence(calendar, {
    occurrence_start: '2026-09-04T01:00:00.000Z',
    completed_at: '2026-09-04T01:55:00.000Z',
    override_starts_at: '2026-09-04T02:00:00.000Z',
    override_ends_at: '2026-09-04T03:00:00.000Z',
  });
  return { db, goal, task, child, mark, calendar };
}
describe('atomic Timeline moves', () => {
  it.each([
    ['2026', '28'],
    ['2028', '29'],
  ])(
    'keeps monthly completion and override identity through a clamped month in %s',
    (year, lastDay) => {
      const { db, goal, calendar, task } = setup();
      try {
        db.db
          .prepare(
            'DELETE FROM calendar_occurrence_states WHERE calendar_entry_id=?',
          )
          .run(calendar);
        db.updateCalendarSession(calendar, {
          recurrence: 'monthly',
          starts_at: `${year}-01-30T01:00:00.000Z`,
          ends_at: `${year}-01-30T02:00:00.000Z`,
          recurrence_until: `${year}-03-30`,
        });
        db.updateCalendarOccurrence(calendar, {
          occurrence_start: `${year}-02-${lastDay}T01:00:00.000Z`,
          completed_at: `${year}-02-${lastDay}T02:00:00.000Z`,
          override_starts_at: `${year}-02-${lastDay}T03:00:00.000Z`,
          override_ends_at: `${year}-02-${lastDay}T04:00:00.000Z`,
        });
        const before = db.getCalendarWorkspace();
        expect(db.checklistOccurrenceSummary(task)).toMatchObject({
          total: 3,
          completed: 1,
        });
        undoContext.run({ session, operation }, () =>
          db.moveTimelineGroup(goal, 2, db.previewTimelineGroup(goal).version),
        );
        expect(db.checklistOccurrenceSummary(task)).toMatchObject({
          total: 3,
          completed: 1,
        });
        expect(db.getCalendarWorkspace().occurrence_states[0]).toMatchObject({
          occurrence_start: `${year}-03-01T01:00:00.000Z`,
          override_starts_at: `${year}-03-01T03:00:00.000Z`,
        });
        (
          db as LocalDatabase & {
            applyUndo: (op: string, session: string) => void;
          }
        ).applyUndo(operation, session);
        expect(db.getCalendarWorkspace()).toEqual(before);
      } finally {
        db.close();
      }
    },
  );
  it('saves series schedule and metadata with one Undo, rejects stale or invalid edits atomically', () => {
    const { db, calendar } = setup();
    try {
      const before = db.getCalendarWorkspace() as CalendarWorkspace,
        base = before.sessions.find((item) => item.id === calendar)!;
      undoContext.run({ session, operation }, () =>
        db.updateCalendarSession(
          calendar,
          {
            title: 'Moved and edited',
            starts_at: '2026-09-05T01:00:00.000Z',
            ends_at: '2026-09-05T02:00:00.000Z',
          },
          base,
        ),
      );
      expect(
        db.getCalendarWorkspace().occurrence_states[0].occurrence_start,
      ).toBe('2026-09-06T01:00:00.000Z');
      (
        db as LocalDatabase & {
          applyUndo: (op: string, session: string) => void;
        }
      ).applyUndo(operation, session);
      expect(db.getCalendarWorkspace()).toEqual(before);
      expect(() =>
        db.updateCalendarSession(
          calendar,
          {
            title: '',
            starts_at: '2026-09-05T01:00:00.000Z',
            ends_at: '2026-09-05T02:00:00.000Z',
          },
          base,
        ),
      ).toThrow();
      expect(db.getCalendarWorkspace()).toEqual(before);
      db.updateCalendarSession(calendar, { title: 'Elsewhere' });
      expect(() =>
        db.updateCalendarSession(calendar, { title: 'Stale form' }, base),
      ).toThrow(/changed/);
    } finally {
      db.close();
    }
  });
  it('moves every group date and Undo restores one command', () => {
    const { db, goal } = setup();
    try {
      const before = db.getTimelineWorkspace(),
        calendarBefore = db.getCalendarWorkspace();
      const plan = db.previewTimelineGroup(goal);
      expect(plan).toMatchObject({ tasks: 2, milestones: 1, calendar: 1 });
      undoContext.run({ session, operation }, () =>
        db.moveTimelineGroup(goal, 3, plan.version),
      );
      expect(db.listGoals()[0].starts_on).toBe('2026-09-04');
      expect(db.getTimelineWorkspace().milestones[0].milestone_on).toBe(
        '2026-09-12',
      );
      expect(
        db.db
          .prepare('SELECT recurrence_until FROM calendar_sessions LIMIT 1')
          .get()?.recurrence_until,
      ).toBe('2026-09-13');
      (
        db as LocalDatabase & {
          applyUndo: (op: string, session: string) => void;
        }
      ).applyUndo(operation, session);
      expect(db.getTimelineWorkspace()).toEqual(before);
      expect(db.getCalendarWorkspace()).toEqual(calendarBefore);
    } finally {
      db.close();
    }
  });
  it('rejects a stale preview and invalid dates without any partial movement', () => {
    const { db, goal, task } = setup();
    try {
      const plan = db.previewTimelineGroup(goal);
      db.updateTask(task, { title: 'Changed elsewhere' });
      const before = db.getTimelineWorkspace();
      expect(() => db.moveTimelineGroup(goal, 3, plan.version)).toThrow(
        /group changed/,
      );
      expect(() =>
        db.moveTimelineGroup(
          goal,
          73000,
          db.previewTimelineGroup(goal).version,
        ),
      ).toThrow(/2000 and 2200/);
      expect(db.getTimelineWorkspace()).toEqual(before);
    } finally {
      db.close();
    }
  });
  it('moves just one Task between Goals, keeping children and calendar dates', () => {
    const { db, goal, task, child } = setup();
    try {
      const target = db.createGoal({ title: 'Other Goal' }),
        beforeCalendar = db.getCalendarWorkspace();
      undoContext.run({ session, operation }, () =>
        db.moveTimelineTask(task, {
          days: 2,
          goal_id: target,
          expected_goal: goal,
          expected_parent: null,
          expected_start: '2026-09-02',
          expected_due: '2026-09-10T16:59:00.000Z',
        }),
      );
      const workspace = db.getTimelineWorkspace();
      expect(
        workspace.links.find((link) => link.task_id === task)?.goal_id,
      ).toBe(target);
      expect(
        workspace.links.find((link) => link.task_id === child)?.goal_id,
      ).toBe(goal);
      expect(workspace.tasks.find((item) => item.id === child)).toMatchObject({
        parent_task_id: null,
        planned_start: '2026-09-04',
      });
      expect(db.getCalendarWorkspace().sessions).toEqual(
        beforeCalendar.sessions,
      );
      (
        db as LocalDatabase & {
          applyUndo: (op: string, session: string) => void;
        }
      ).applyUndo(operation, session);
      expect(
        db.getTimelineWorkspace().tasks.find((item) => item.id === child)
          ?.parent_task_id,
      ).toBe(task);
      expect(
        db.getTimelineWorkspace().links.find((link) => link.task_id === task)
          ?.goal_id,
      ).toBe(goal);
    } finally {
      db.close();
    }
  });
});
