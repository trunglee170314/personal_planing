import { describe, expect, it } from 'vitest';
import {
  expandRecurringSessions,
  nearestRecurringOccurrence,
  recurringSeriesFrom,
} from '../lib/calendar';
import { makeRrule, parseRrule } from '../lib/calendar-rules';
import {
  normalizeDateSchedule,
  normalizeSelectedDates,
} from '../lib/selected-dates.mjs';
import { LocalDatabase } from '../local-server/database.mjs';
import { undoContext } from '../local-server/undo.mjs';

const input = {
  title: 'Three dates',
  task_id: 'task',
  item_type: 'checklist' as const,
  starts_at: '2026-10-16T01:00:00.000Z',
  ends_at: '2026-10-16T02:00:00.000Z',
  recurrence: 'dates' as const,
  recurrence_dates: ['2026-10-23', '2026-10-16', '2026-10-18'],
  recurrence_until: '2026-10-23',
  recurrence_interval: 1,
  timezone: 'Asia/Ho_Chi_Minh',
  all_day: false,
  completed_at: null,
  not_needed_at: null,
};
const session = { ...normalizeDateSchedule(input), id: 'series' };
const range = [new Date('2026-10-01'), new Date('2026-11-01')] as const;

describe('selected-date Checklists', () => {
  it('normalizes and round-trips sparse dates using relative offsets', () => {
    expect(session.recurrence_dates).toEqual([
      '2026-10-16',
      '2026-10-18',
      '2026-10-23',
    ]);
    const rule = makeRrule(session);
    expect(rule).toBe(
      'FREQ=DAILY;INTERVAL=1;UNTIL=20261023T235959Z;X-MYPLAN-DATES=0,2,7',
    );
    expect(parseRrule(rule!, session.starts_at).recurrence_dates).toEqual(
      session.recurrence_dates,
    );
    expect(parseRrule(rule!, '2026-10-18T01:00:00Z').recurrence_dates).toEqual([
      '2026-10-18',
      '2026-10-20',
      '2026-10-25',
    ]);
  });
  it('rejects empty, invalid, excessive, reminder and overnight schedules', () => {
    for (const dates of [
      [],
      ['2026-02-30'],
      ['1999-12-31'],
      Array(367).fill('2026-10-16'),
    ])
      expect(() => normalizeSelectedDates(dates)).toThrow();
    // Inherited reminders preserve dates after permanent Task deletion; new Reminder creation is rejected by the database.
    expect(() =>
      normalizeDateSchedule({ ...input, ends_at: '2026-10-17T01:00:00Z' }),
    ).toThrow(/same Vietnam day/);
  });
  it('renders only selected identities, with independent outcomes and moved-in overrides', () => {
    const states = [
      {
        calendar_entry_id: 'series',
        occurrence_start: '2026-10-18T01:00:00.000Z',
        completed_at: '2026-10-18T02:00:00Z',
        not_needed_at: null,
        override_starts_at: '2026-10-20T01:00:00Z',
        override_ends_at: '2026-10-20T02:00:00Z',
      },
      {
        calendar_entry_id: 'series',
        occurrence_start: '2026-10-19T01:00:00.000Z',
        completed_at: null,
        not_needed_at: null,
        override_starts_at: '2026-10-21T01:00:00Z',
        override_ends_at: '2026-10-21T02:00:00Z',
      },
    ];
    const items = expandRecurringSessions([session], ...range, states);
    expect(items).toHaveLength(3);
    expect(items.map((item) => Boolean(item.completed_at))).toEqual([
      false,
      true,
      false,
    ]);
    expect(items[1].starts_at).toBe('2026-10-20T01:00:00Z');
    expect(
      recurringSeriesFrom(session, items[1], states).map(
        (item) => item.occurrence_start,
      ),
    ).toEqual(['2026-10-18T01:00:00.000Z', '2026-10-23T01:00:00.000Z']);
  });
  it('finds a nearest occurrence across multi-year gaps', () => {
    const sparse = {
      ...session,
      recurrence_dates: ['2026-10-16', '2040-10-16'],
      recurrence_until: '2040-10-16',
    };
    expect(
      nearestRecurringOccurrence(sparse, new Date('2038-01-01'))?.starts_at,
    ).toBe('2040-10-16T01:00:00.000Z');
  });
  it('persists Local dates, metadata edits, progress, moves and Undo without duplicating entries', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const task = db.createTask({
        title: 'Task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      const id = db.createCalendarSession({ ...input, task_id: task });
      const get = () =>
        db.getCalendarWorkspace().sessions.find((item) => item.id === id)!;
      expect(get().recurrence_dates).toEqual(session.recurrence_dates);
      expect(db.getCalendarWorkspace().sessions).toHaveLength(1);
      db.updateCalendarSession(id, { title: 'Shared title' }, get());
      const op = '00000000-0000-4000-8000-000000000011',
        sess = '00000000-0000-4000-8000-000000000010';
      undoContext.run({ session: sess, operation: op }, () =>
        db.updateCalendarOccurrence(id, {
          occurrence_start: '2026-10-18T01:00:00.000Z',
          completed_at: '2026-10-18T02:00:00.000Z',
        }),
      );
      expect(
        db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
          ?.progress,
      ).toBe(33);
      (
        db as LocalDatabase & {
          applyUndo: (op: string, session: string) => void;
        }
      ).applyUndo(op, sess);
      expect(
        db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
          ?.progress,
      ).toBe(0);
      db.updateCalendarOccurrence(id, {
        occurrence_start: '2026-10-18T01:00:00.000Z',
        completed_at: '2026-10-18T02:00:00.000Z',
      });
      db.moveCalendarSeries(id, {
        original_start: input.starts_at,
        original_end: input.ends_at,
        next_start: '2026-10-18T02:00:00.000Z',
        next_end: '2026-10-18T03:00:00.000Z',
      });
      expect(get().recurrence_dates).toEqual([
        '2026-10-18',
        '2026-10-20',
        '2026-10-25',
      ]);
      expect(
        db.getCalendarWorkspace().occurrence_states[0].occurrence_start,
      ).toBe('2026-10-20T02:00:00.000Z');
      db.updateCalendarSession(id, { title: 'Updated again' }, get());
      expect(() =>
        db.updateCalendarSession(id, {
          recurrence_dates: ['2026-10-18', '2026-10-24'],
        }),
      ).toThrow(/history/);
      expect(get().title).toBe('Updated again');
    } finally {
      db.close();
    }
  });
  it('lets an explicitly reopened occurrence override a completed Task series', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const task = db.createTask({
        title: 'Task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      const id = db.createCalendarSession({ ...input, task_id: task });
      db.setTaskCompletion(task, true);
      db.updateCalendarOccurrence(id, {
        occurrence_start: '2026-10-18T01:00:00.000Z',
        completed_at: null,
        not_needed_at: null,
      });
      expect(
        db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
          ?.progress,
      ).toBe(67);
    } finally {
      db.close();
    }
  });
  it('preserves inherited Reminder dates after permanent Task deletion and rejects internal offset writes', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const task = db.createTask({
        title: 'Task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      const id = db.createCalendarSession({ ...input, task_id: task });
      expect(() =>
        db.updateCalendarSession(id, { recurrence_offsets: 'broken' }),
      ).toThrow(/internal/);
      expect(() =>
        db.createCalendarSession({
          ...input,
          item_type: 'reminder',
          task_id: null,
        }),
      ).toThrow(/Checklists only/);
      db.deleteTask(task);
      const get = () =>
        db.getCalendarWorkspace().sessions.find((item) => item.id === id)!;
      expect(get().item_type).toBe('reminder');
      expect(get().recurrence_dates).toHaveLength(3);
      db.updateCalendarSession(id, { title: 'Inherited reminder' }, get());
      db.moveCalendarSeries(id, {
        original_start: get().starts_at,
        original_end: get().ends_at,
        next_start: '2026-10-17T01:00:00.000Z',
        next_end: '2026-10-17T01:15:00.000Z',
      });
      expect(get().recurrence_dates).toEqual([
        '2026-10-17',
        '2026-10-19',
        '2026-10-24',
      ]);
      expect(get().title).toBe('Inherited reminder');
    } finally {
      db.close();
    }
  });
});
