import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { undoContext } from '../local-server/undo.mjs';
import {
  expandRecurringSessions,
  nearestRecurringOccurrence,
} from '../lib/calendar';
import type {
  CalendarSession,
  CalendarSessionInput,
  CalendarWorkspace,
} from '../lib/data/repository';

const start = (day: number, hour = '01') =>
  `2035-01-${String(day).padStart(2, '0')}T${hour}:00:00.000Z`;
const note = (body: string) => ({ kind: 'comment', body, url: null });
const sessionId = '00000000-0000-4000-8000-000000000091';
const operationId = '00000000-0000-4000-8000-000000000092';
type UndoDatabase = LocalDatabase & {
  applyUndo: (operation: string, session: string) => void;
};

describe('repeat edits and occurrence notes (isolated Local SQLite)', () => {
  let db: LocalDatabase;
  let id: string;
  let task: string;
  beforeEach(() => {
    db = new LocalDatabase(':memory:');
    task = db.createTask({
      title: 'Learn Linux',
      priority: 'medium',
      workflow_status_id: 'local-status-planned',
    });
    id = db.createCalendarSession({
      title: 'Daily work',
      task_id: task,
      item_type: 'checklist',
      starts_at: start(1),
      ends_at: start(1, '02'),
      timezone: 'Asia/Ho_Chi_Minh',
      all_day: false,
      recurrence: 'daily',
      recurrence_until: '2035-01-10',
      recurrence_interval: 1,
      completed_at: null,
      not_needed_at: null,
      notification_offsets: [],
      is_pinned: false,
    });
  });
  afterEach(() => db.close());
  const workspace = () =>
    db.getCalendarWorkspace() as unknown as CalendarWorkspace;
  const base = () => workspace().sessions.find((item) => item.id === id)!;
  const rows = () =>
    expandRecurringSessions(
      [base()],
      new Date('2034-01-01'),
      new Date('2037-01-01'),
      workspace().occurrence_states,
    ).sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
  const state = (key: string) =>
    db.db
      .prepare(
        'SELECT * FROM calendar_occurrence_states WHERE calendar_entry_id=? AND occurrence_start=?',
      )
      .get(id, key)!;
  const target = (day?: number) => ({
    kind: 'calendar',
    id,
    ...(day ? { occurrence_start: start(day) } : {}),
  });
  function revise(
    changes: Partial<CalendarSessionInput>,
    scope: 'series' | 'future' = 'series',
    from: string | null = null,
    expected: CalendarSession = base(),
  ) {
    const { id: _id, ...input } = base();
    db.reviseCalendarSeries(
      id,
      { ...input, ...changes },
      scope,
      from,
      expected,
    );
  }

  it('keeps Series notes and two occurrence comment threads independent', () => {
    db.saveAnnotation(target(), note('Shared instructions'));
    db.saveAnnotation(target(2), note('Only January 2'));
    db.saveAnnotation(target(3), note('Only January 3'));
    expect(db.listAnnotations(target()).map((row) => row.body)).toEqual([
      'Shared instructions',
    ]);
    expect(db.listAnnotations(target(2)).map((row) => row.body)).toEqual([
      'Only January 2',
    ]);
    expect(db.listAnnotations(target(3)).map((row) => row.body)).toEqual([
      'Only January 3',
    ]);
    expect(db.listAnnotations(target(4))).toEqual([]);
    expect(state(start(2)).id).toBeTruthy();
    expect(state(start(2)).id).not.toBe(state(start(3)).id);
    expect(
      db.db
        .prepare(
          'SELECT count(*) count FROM planner_annotations WHERE occurrence_state_id IS NULL',
        )
        .get()?.count,
    ).toBe(1);
  });

  it('rejects editing a comment through a different occurrence, series or Checklist target atomically', () => {
    db.saveAnnotation(target(2), note('Private to this date'));
    const annotation = db.listAnnotations(target(2))[0];
    expect(() =>
      db.saveAnnotation(target(3), note('Wrong date'), annotation.id),
    ).toThrow(/scope|exist/i);
    expect(() =>
      db.saveAnnotation(target(), note('Wrong series scope'), annotation.id),
    ).toThrow(/scope|exist/i);
    const other = db.createCalendarSession({
      ...base(),
      title: 'Another Checklist',
    });
    expect(() =>
      db.saveAnnotation(
        { kind: 'calendar', id: other, occurrence_start: start(2) },
        note('Wrong Checklist'),
        annotation.id,
      ),
    ).toThrow(/scope|exist/i);
    expect(db.listAnnotations(target(2))[0].body).toBe('Private to this date');
    expect(
      db.db
        .prepare(
          'SELECT count(*) count FROM calendar_occurrence_states WHERE calendar_entry_id=?',
        )
        .get(id)?.count,
    ).toBe(1);
    expect(
      db.db
        .prepare(
          'SELECT count(*) count FROM calendar_occurrence_states WHERE calendar_entry_id=?',
        )
        .get(other)?.count,
    ).toBe(0);
  });

  it('changes Daily to Weekly while preserving Done, annotated and moved identities and UUIDs', () => {
    db.updateCalendarOccurrence(id, {
      occurrence_start: start(2),
      completed_at: start(2, '02'),
    });
    db.saveAnnotation(target(3), note('Keep the January 3 observation'));
    db.moveCalendarOccurrences(id, [
      {
        occurrence_start: start(4),
        override_starts_at: start(20, '03'),
        override_ends_at: start(20, '04'),
      },
    ]);
    const ids = [2, 3, 4].map((day) => state(start(day)).id);
    revise({ recurrence: 'weekly', recurrence_until: '2035-01-22' });
    expect(base()).toMatchObject({
      occurrence_mode: true,
      recurrence: 'weekly',
      recurrence_until: '2035-01-22',
    });
    expect(rows().map((row) => row.occurrence_start)).toEqual(
      [1, 2, 3, 4, 8, 15, 22].map((day) => start(day)),
    );
    expect([2, 3, 4].map((day) => state(start(day)).id)).toEqual(ids);
    expect(
      rows().find((row) => row.occurrence_start === start(2))?.completed_at,
    ).toBe(start(2, '02'));
    expect(
      rows().find((row) => row.occurrence_start === start(4))?.starts_at,
    ).toBe(start(20, '03'));
    expect(db.listAnnotations(target(3))[0].body).toBe(
      'Keep the January 3 observation',
    );
  });

  it('changes Daily to Monthly without converting the requested descriptor into Selected dates', () => {
    db.updateCalendarOccurrence(id, {
      occurrence_start: start(2),
      completed_at: start(2, '02'),
    });
    revise({ recurrence: 'monthly', recurrence_until: '2035-03-31' });
    expect(base().recurrence).toBe('monthly');
    expect(rows().map((row) => row.occurrence_start)).toEqual([
      start(1),
      start(2),
      '2035-02-01T01:00:00.000Z',
      '2035-03-01T01:00:00.000Z',
    ]);
    expect(
      db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
        ?.progress,
    ).toBe(25);
  });

  it('changes to Selected dates but retains an annotated exception outside the new date list', () => {
    db.saveAnnotation(
      target(3),
      note('Protected history outside the new pattern'),
    );
    const originalId = state(start(3)).id;
    revise({
      recurrence: 'dates',
      recurrence_dates: ['2035-01-01', '2035-01-07'],
      recurrence_until: '2035-01-07',
    });
    expect(base().recurrence_dates).toEqual(['2035-01-01', '2035-01-07']);
    expect(rows().map((row) => row.occurrence_start)).toEqual(
      [1, 3, 7].map((day) => start(day)),
    );
    expect(state(start(3)).id).toBe(originalId);
    expect(
      nearestRecurringOccurrence(
        base(),
        new Date(start(3)),
        workspace().occurrence_states,
      )?.occurrence_start,
    ).toBe(start(3));
    expect(db.listAnnotations(target(3))[0].body).toBe(
      'Protected history outside the new pattern',
    );
  });

  it('supports Does not repeat with retained history and independent effective occurrence completion', () => {
    db.updateCalendarOccurrence(id, {
      occurrence_start: start(2),
      completed_at: start(2, '02'),
    });
    revise({
      recurrence: 'none',
      recurrence_until: null,
      starts_at: start(6),
      ends_at: start(6, '02'),
    });
    expect(base()).toMatchObject({
      recurrence: 'none',
      occurrence_mode: true,
      completed_at: null,
    });
    expect(rows().map((row) => row.occurrence_start)).toEqual([
      start(2),
      start(6),
    ]);
    expect(
      db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
        ?.progress,
    ).toBe(50);
    db.updateCalendarOccurrence(id, {
      occurrence_start: start(6),
      completed_at: start(6, '02'),
    });
    expect(
      db.db.prepare('SELECT progress FROM tasks WHERE id=?').get(task)
        ?.progress,
    ).toBe(100);
    expect(rows().filter((row) => row.completed_at)).toHaveLength(2);
  });

  it('cuts This and following by ORIGINAL identity, not a moved display date', () => {
    db.moveCalendarOccurrences(id, [
      {
        occurrence_start: start(3),
        override_starts_at: start(20),
        override_ends_at: start(20, '02'),
      },
    ]);
    const originalId = state(start(3)).id;
    revise(
      {
        title: 'New future work',
        starts_at: start(5, '03'),
        ends_at: start(5, '04'),
        recurrence_until: '2035-01-08',
      },
      'future',
      start(5),
    );
    expect(rows().map((row) => row.occurrence_start)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((day) => start(day)),
    );
    expect(
      rows().find((row) => row.occurrence_start === start(3)),
    ).toMatchObject({ title: 'Daily work', starts_at: start(20) });
    expect(state(start(3)).id).toBe(originalId);
    expect(rows().find((row) => row.starts_at === start(5, '03'))?.title).toBe(
      'New future work',
    );
  });

  it('never adds a newly requested date before a Following cutoff', () => {
    revise(
      {
        recurrence: 'dates',
        recurrence_dates: ['2035-01-02', '2035-01-06', '2035-01-09'],
        recurrence_until: '2035-01-09',
      },
      'future',
      start(5),
    );
    expect(rows().map((row) => row.occurrence_start)).toEqual(
      [1, 2, 3, 4, 6, 9].map((day) => start(day)),
    );
    expect(
      rows()
        .filter((row) => row.occurrence_start < start(5))
        .map((row) => row.title),
    ).toEqual(Array(4).fill('Daily work'));
  });

  it('freezes earlier titles for Following, then clears only automatic freezes on Entire series rename', () => {
    db.updateCalendarOccurrence(id, {
      occurrence_start: start(2),
      title_override: 'Explicit personal exception',
    });
    revise(
      {
        title: 'Future title',
        starts_at: start(5),
        ends_at: start(5, '02'),
        recurrence_until: '2035-01-08',
      },
      'future',
      start(5),
    );
    const beforeRename = rows().map((row) => row.occurrence_start);
    expect(rows().find((row) => row.occurrence_start === start(1))?.title).toBe(
      'Daily work',
    );
    expect(rows().find((row) => row.occurrence_start === start(2))?.title).toBe(
      'Explicit personal exception',
    );
    expect(rows().find((row) => row.occurrence_start === start(5))?.title).toBe(
      'Future title',
    );
    revise({ title: 'All new shared title' });
    expect(rows().map((row) => row.occurrence_start)).toEqual(beforeRename);
    expect(rows().find((row) => row.occurrence_start === start(1))?.title).toBe(
      'All new shared title',
    );
    expect(rows().find((row) => row.occurrence_start === start(2))?.title).toBe(
      'Explicit personal exception',
    );
    expect(state(start(2)).title_is_exception).toBe(1);
    expect(state(start(1)).title_override).toBeNull();
  });

  it('Undo restores mode, descriptor, exact membership, progress and note identities together', () => {
    db.saveAnnotation(target(), note('Shared instructions'));
    db.saveAnnotation(target(3), note('Occurrence history'));
    db.updateCalendarOccurrence(id, {
      occurrence_start: start(2),
      completed_at: start(2, '02'),
    });
    const before = workspace();
    const beforeId = state(start(3)).id;
    undoContext.run({ session: sessionId, operation: operationId }, () =>
      revise({
        title: 'Weekly work',
        recurrence: 'weekly',
        recurrence_until: '2035-01-22',
      }),
    );
    expect(Boolean(base().occurrence_mode)).toBe(true);
    (db as UndoDatabase).applyUndo(operationId, sessionId);
    expect(workspace()).toEqual(before);
    expect(state(start(3)).id).toBe(beforeId);
    expect(db.listAnnotations(target())[0].body).toBe('Shared instructions');
    expect(db.listAnnotations(target(3))[0].body).toBe('Occurrence history');
  });

  it('rejects Undo atomically if a later comment now depends on a newly created occurrence', () => {
    undoContext.run({ session: sessionId, operation: operationId }, () =>
      revise({ recurrence: 'weekly', recurrence_until: '2035-01-22' }),
    );
    db.saveAnnotation(target(15), note('Created after rescheduling'));
    const beforeUndo = workspace();
    const protectedId = state(start(15)).id;
    expect(() =>
      (db as UndoDatabase).applyUndo(operationId, sessionId),
    ).toThrow(/foreign key|conflict|comment/i);
    expect(workspace()).toEqual(beforeUndo);
    expect(state(start(15)).id).toBe(protectedId);
    expect(db.listAnnotations(target(15))[0].body).toBe(
      'Created after rescheduling',
    );
  });

  it('rejects stale expected snapshots without partial schedule or title changes', () => {
    const stale = base();
    db.updateCalendarSession(id, { title: 'Concurrent title' }, stale);
    const before = workspace();
    expect(() =>
      revise(
        { title: 'Stale replacement', recurrence: 'weekly' },
        'series',
        null,
        stale,
      ),
    ).toThrow(/changed|reopen/i);
    expect(workspace()).toEqual(before);
  });

  it('rejects invalid schedules atomically without changing notes or title', () => {
    db.saveAnnotation(target(3), note('Keep me'));
    const before = workspace();
    expect(() =>
      revise({
        title: 'Invalid replacement',
        recurrence: 'dates',
        recurrence_dates: [],
      }),
    ).toThrow();
    expect(workspace()).toEqual(before);
    expect(db.listAnnotations(target(3))[0].body).toBe('Keep me');
  });

  it('keeps Task, pin and notifications series-wide for Following edits', () => {
    const otherTask = db.createTask({
      title: 'Other Task',
      priority: 'medium',
      workflow_status_id: 'local-status-planned',
    });
    const before = workspace();
    const next = { starts_at: start(5), ends_at: start(5, '02') };
    expect(() =>
      revise({ ...next, task_id: otherTask }, 'future', start(5)),
    ).toThrow(/Task applies/i);
    expect(() =>
      revise({ ...next, is_pinned: true }, 'future', start(5)),
    ).toThrow(/pin apply|pin applies/i);
    expect(() =>
      revise({ ...next, notification_offsets: [15] }, 'future', start(5)),
    ).toThrow(/Notifications/i);
    expect(workspace()).toEqual(before);
  });

  it('retains a direct moved exception through rule changes without reassigning its note or UUID', () => {
    db.saveAnnotation(target(4), note('Original January 4 activity'));
    const oldId = state(start(4)).id;
    db.moveCalendarOccurrences(id, [
      {
        occurrence_start: start(4),
        override_starts_at: start(20, '03'),
        override_ends_at: start(20, '04'),
      },
    ]);
    revise({ recurrence: 'weekly', recurrence_until: '2035-01-22' });
    expect(state(start(4))).toMatchObject({
      id: oldId,
      is_exception: 1,
      override_starts_at: start(20, '03'),
    });
    expect(db.listAnnotations(target(4))[0].body).toBe(
      'Original January 4 activity',
    );
    expect(db.listAnnotations(target(20))).toEqual([]);
  });

  it('converts normal late-night Daily history into paired 15-minute Reminder overrides on Task deletion without losing UUIDs or notes', () => {
    const late = (day: number, clock = '16:50') =>
      `2035-01-${String(day).padStart(2, '0')}T${clock}:00.000Z`;
    id = db.createCalendarSession({
      ...base(),
      title: 'Late-night Daily work',
      starts_at: late(1),
      ends_at: late(1, '16:59'),
      recurrence: 'daily',
    });
    expect(base().occurrence_mode).toBe(false);
    db.updateCalendarOccurrence(id, {
      occurrence_start: late(2),
      completed_at: late(2, '16:59'),
    });
    const occurrenceTarget = {
      kind: 'calendar',
      id,
      occurrence_start: late(3),
    };
    db.saveAnnotation(
      occurrenceTarget,
      note('Keep this late-night observation'),
    );
    const doneId = state(late(2)).id;
    const commentId = state(late(3)).id;
    expect(state(late(2))).toMatchObject({
      override_starts_at: null,
      override_ends_at: null,
    });
    expect(state(late(3))).toMatchObject({
      override_starts_at: null,
      override_ends_at: null,
    });
    db.deleteTask(task);
    expect(base()).toMatchObject({
      item_type: 'reminder',
      task_id: null,
      recurrence: 'daily',
      occurrence_mode: false,
      starts_at: late(1),
      ends_at: late(1, '17:05'),
    });
    expect(state(late(2))).toMatchObject({
      id: doneId,
      completed_at: late(2, '16:59'),
      override_starts_at: late(2),
      override_ends_at: late(2, '17:05'),
    });
    expect(state(late(3))).toMatchObject({
      id: commentId,
      completed_at: null,
      override_starts_at: late(3),
      override_ends_at: late(3, '17:05'),
    });
    expect(
      rows().find((row) => row.occurrence_start === late(2)),
    ).toMatchObject({
      starts_at: late(2),
      ends_at: late(2, '17:05'),
      completed_at: late(2, '16:59'),
    });
    expect(
      rows().find((row) => row.occurrence_start === late(3)),
    ).toMatchObject({
      starts_at: late(3),
      ends_at: late(3, '17:05'),
      completed_at: null,
    });
    expect(db.listAnnotations(occurrenceTarget)[0].body).toBe(
      'Keep this late-night observation',
    );
  });

  it('allows ordinary Done and comments on a valid occurrence beyond the 1,000th legacy date', () => {
    const legacyTask = db.createTask({
      title: 'Legacy Task',
      priority: 'medium',
      workflow_status_id: 'local-status-planned',
    });
    const legacy = db.createCalendarSession({
      ...base(),
      task_id: legacyTask,
      title: 'Long existing daily series',
      starts_at: '2000-01-01T01:00:00.000Z',
      ends_at: '2000-01-01T02:00:00.000Z',
      recurrence: 'daily',
      recurrence_until: '2035-01-01',
    });
    const key = '2034-12-30T01:00:00.000Z';
    const legacyTarget = {
      kind: 'calendar',
      id: legacy,
      occurrence_start: key,
    };
    db.saveAnnotation(legacyTarget, note('A valid late occurrence'));
    const originalId = db.db
      .prepare(
        'SELECT id FROM calendar_occurrence_states WHERE calendar_entry_id=? AND occurrence_start=?',
      )
      .get(legacy, key)?.id;
    db.updateCalendarOccurrence(legacy, {
      occurrence_start: key,
      completed_at: '2034-12-30T02:00:00.000Z',
    });
    expect(db.listAnnotations(legacyTarget)[0].body).toBe(
      'A valid late occurrence',
    );
    expect(
      db.db
        .prepare(
          'SELECT id,completed_at FROM calendar_occurrence_states WHERE calendar_entry_id=? AND occurrence_start=?',
        )
        .get(legacy, key),
    ).toMatchObject({
      id: originalId,
      completed_at: '2034-12-30T02:00:00.000Z',
    });
    expect(
      workspace().sessions.find((row) => row.id === legacy)?.occurrence_mode,
    ).toBe(false);
  });
});
