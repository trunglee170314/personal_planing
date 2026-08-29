import { describe, it, expect } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { undoContext } from '../local-server/undo.mjs';
const session = '00000000-0000-4000-8000-000000000010';
const operation = '00000000-0000-4000-8000-000000000011';
const undo = (db: LocalDatabase) =>
  db as LocalDatabase & {
    applyUndo: (operation: string, session: string) => void;
    undoReady: (operation: string, session: string) => boolean;
  };
const checklist = (db: LocalDatabase, taskId: string, title: string) =>
  db.createCalendarSession({
    title,
    task_id: taskId,
    item_type: 'checklist',
    starts_at: '2026-09-01T01:00:00.000Z',
    ends_at: '2026-09-01T01:15:00.000Z',
    all_day: false,
    timezone: 'Asia/Ho_Chi_Minh',
    recurrence: 'none',
    notification_offsets: [],
  });
describe('transactional local Undo', () => {
  it('recomputes progress if other checklist membership changed at the same percentage', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const task = db.createTask({
        title: 'Task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      const a = checklist(db, task, 'A'),
        b = checklist(db, task, 'B');
      undoContext.run({ session, operation }, () =>
        db.updateCalendarSession(a, {
          completed_at: '2026-09-01T01:05:00.000Z',
        }),
      );
      db.updateCalendarSession(b, { completed_at: '2026-09-01T01:06:00.000Z' });
      checklist(db, task, 'C');
      checklist(db, task, 'D');
      expect(
        db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
          ?.progress,
      ).toBe(50);
      undo(db).applyUndo(operation, session);
      expect(
        db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
          ?.progress,
      ).toBe(25);
    } finally {
      db.close();
    }
  });
  it('rejects contradictory Task status after all checklists were explicitly completed', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const task = db.createTask({
        title: 'Task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      const a = checklist(db, task, 'A');
      db.updateCalendarSession(a, { completed_at: '2026-09-01T01:05:00.000Z' });
      expect(() =>
        db.saveTaskEdit(
          task,
          { title: 'Changed', workflow_status_id: 'local-status-planned' },
          false,
        ),
      ).toThrow(/Reopen a checklist/);
      expect(db.getTaskWorkspace().tasks[0]).toMatchObject({
        title: 'Task',
        workflow_status_id: 'local-status-completed',
        progress: 100,
      });
    } finally {
      db.close();
    }
  });
  it('allows manual completion/reopen and restores skipped items atomically with Undo', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const task = db.createTask({
        title: 'Task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      checklist(db, task, 'A');
      undoContext.run({ session, operation }, () =>
        db.saveTaskEdit(
          task,
          {
            title: 'Completed task',
            workflow_status_id: 'local-status-completed',
          },
          true,
        ),
      );
      expect(db.getTaskWorkspace().tasks[0].progress).toBe(100);
      undo(db).applyUndo(operation, session);
      expect(db.getTaskWorkspace().tasks[0]).toMatchObject({
        title: 'Task',
        workflow_status_id: 'local-status-planned',
        progress: 0,
        completed_at: null,
      });
      expect(
        db.db
          .prepare('SELECT not_needed_at FROM calendar_sessions LIMIT 1')
          .get()?.not_needed_at,
      ).toBeNull();
      db.saveTaskEdit(
        task,
        { workflow_status_id: 'local-status-completed' },
        true,
      );
      db.saveTaskEdit(
        task,
        { workflow_status_id: 'local-status-planned' },
        false,
      );
      expect(db.getTaskWorkspace().tasks[0].completed_at).toBeNull();
    } finally {
      db.close();
    }
  });
  it('restores original occurrence keys and overrides after moving a whole series', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const id = db.createCalendarSession({
        title: 'Recurring reminder',
        task_id: null,
        item_type: 'reminder',
        starts_at: '2026-09-01T01:00:00.000Z',
        ends_at: '2026-09-01T01:15:00.000Z',
        all_day: false,
        timezone: 'Asia/Ho_Chi_Minh',
        recurrence: 'daily',
        recurrence_until: '2026-09-04',
        notification_offsets: [],
      });
      db.updateCalendarOccurrence(id, {
        occurrence_start: '2026-09-01T01:00:00.000Z',
        completed_at: '2026-09-01T01:05:00.000Z',
        override_starts_at: '2026-09-01T02:00:00.000Z',
        override_ends_at: '2026-09-01T02:15:00.000Z',
      });
      db.updateCalendarOccurrence(id, {
        occurrence_start: '2026-09-02T01:00:00.000Z',
        completed_at: '2026-09-02T01:05:00.000Z',
      });
      const before = db.getCalendarWorkspace();
      undoContext.run({ session, operation }, () =>
        db.moveCalendarSeries(id, {
          original_start: '2026-09-01T01:00:00.000Z',
          original_end: '2026-09-01T01:15:00.000Z',
          next_start: '2026-09-02T01:00:00.000Z',
          next_end: '2026-09-02T01:15:00.000Z',
        }),
      );
      undo(db).applyUndo(operation, session);
      expect(db.getCalendarWorkspace().sessions).toEqual(before.sessions);
      expect(db.getCalendarWorkspace().occurrence_states).toEqual(
        before.occurrence_states,
      );
    } finally {
      db.close();
    }
  });
  it('undoes only changed fields and keeps a later unrelated edit', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const id = db.createGoal({ title: 'Before', color_key: 'jade' });
      undoContext.run({ session, operation }, () =>
        db.updateGoal(id, { title: 'After' }),
      );
      db.updateGoal(id, { color_key: 'rose' });
      undo(db).applyUndo(operation, session);
      expect(db.listGoals()[0]).toMatchObject({
        title: 'Before',
        color_key: 'rose',
      });
      expect(undo(db).undoReady(operation, session)).toBe(false);
    } finally {
      db.close();
    }
  });
  it('aborts a whole multirow Undo when one changed field conflicts', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const a = db.createGoal({ title: 'A' }),
        b = db.createGoal({ title: 'B' });
      undoContext.run({ session, operation }, () => {
        db.updateGoal(a, { title: 'A edited' });
        db.updateGoal(b, { title: 'B edited' });
      });
      db.updateGoal(b, { title: 'Other device' });
      expect(() => undo(db).applyUndo(operation, session)).toThrow(/conflict/);
      expect(db.listGoals().find((goal) => goal.id === a)?.title).toBe(
        'A edited',
      );
    } finally {
      db.close();
    }
  });
  it('does not allow a different browser session to undo the command', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const id = db.createGoal({ title: 'Before' });
      undoContext.run({ session, operation }, () =>
        db.updateGoal(id, { title: 'After' }),
      );
      expect(() =>
        undo(db).applyUndo(operation, '00000000-0000-4000-8000-000000000099'),
      ).toThrow(/no longer available/);
    } finally {
      db.close();
    }
  });
});
