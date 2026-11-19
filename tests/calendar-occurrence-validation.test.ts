import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { expandRecurringSessions } from '../lib/calendar';
import { occurrenceOutcome, patchOccurrence } from '../lib/occurrence-state';
import type {
  CalendarSession,
  CalendarWorkspace,
} from '../lib/data/repository';

const first = '2026-11-19T01:00:00.000Z';
const second = '2026-11-20T01:00:00.000Z';
const completed = '2026-11-19T02:00:00.000Z';
const movedStart = '2026-11-19T03:00:00.000Z';
const movedEnd = '2026-11-19T04:00:00.000Z';

describe('Local occurrence updates validate the merged record before writing', () => {
  let db: LocalDatabase;
  let entry: string;
  let task: string;
  beforeEach(() => {
    db = new LocalDatabase(':memory:');
    task = db.createTask({
      title: 'Isolated Task',
      priority: 'medium',
      workflow_status_id: 'local-status-planned',
    });
    entry = db.createCalendarSession({
      title: 'Daily Checklist',
      task_id: task,
      item_type: 'checklist',
      starts_at: first,
      ends_at: '2026-11-19T02:00:00.000Z',
      recurrence: 'daily',
      recurrence_until: '2026-11-21',
      timezone: 'Asia/Ho_Chi_Minh',
      all_day: false,
      notification_offsets: [],
    });
  });
  afterEach(() => db.close());
  function state(key = first) {
    return db.db
      .prepare(
        'SELECT * FROM calendar_occurrence_states WHERE calendar_entry_id=? AND occurrence_start=?',
      )
      .get(entry, key);
  }
  function snapshot() {
    return {
      workspace: db.getCalendarWorkspace(),
      states: db.db
        .prepare(
          'SELECT * FROM calendar_occurrence_states ORDER BY occurrence_start',
        )
        .all(),
      task: db.db.prepare('SELECT * FROM tasks WHERE id=?').get(task),
    };
  }

  it.each([
    ['reversed', movedEnd, movedStart],
    ['zero duration', movedStart, movedStart],
    ['invalid start', 'not-a-date', movedEnd],
    ['invalid end', movedStart, 'not-a-date'],
    ['impossible start', '2026-02-30T03:00:00Z', movedEnd],
    ['impossible end', '2026-02-28T03:00:00Z', '2026-02-30T04:00:00Z'],
    ['before supported range', '1999-12-31T23:59:59Z', movedEnd],
    ['after supported range', movedStart, '2201-01-01T00:00:00Z'],
    ['timezone crosses lower limit', '2000-01-01T00:00:00+07:00', movedEnd],
  ])(
    'rejects %s without inserting state or changing Task progress',
    (_label, start, end) => {
      const before = snapshot();
      expect(() =>
        db.updateCalendarOccurrence(entry, {
          occurrence_start: first,
          override_starts_at: start,
          override_ends_at: end,
          completed_at: completed,
        }),
      ).toThrow(/occurrence.*time/i);
      expect(snapshot()).toEqual(before);
    },
  );

  it.each([
    { override_starts_at: movedStart },
    { override_ends_at: movedEnd },
    { override_starts_at: null, override_ends_at: movedEnd },
    { override_starts_at: movedStart, override_ends_at: null },
  ])(
    'rejects an incomplete override pair before creating a row: %j',
    (changes) => {
      const before = snapshot();
      expect(() =>
        db.updateCalendarOccurrence(entry, {
          occurrence_start: first,
          ...changes,
        }),
      ).toThrow(/both a start and an end/i);
      expect(snapshot()).toEqual(before);
    },
  );

  it('merges a partial endpoint update while preserving the other endpoint, outcome and title identity', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      override_starts_at: movedStart,
      override_ends_at: movedEnd,
      completed_at: completed,
      title_override: 'Independent title',
    });
    const before = state()!;
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      override_ends_at: '2026-11-19T05:00:00.000Z',
    });
    expect(state()).toMatchObject({
      id: before.id,
      override_starts_at: movedStart,
      override_ends_at: '2026-11-19T05:00:00.000Z',
      completed_at: completed,
      not_needed_at: null,
      title_override: 'Independent title',
    });
  });

  it('rejects a partial endpoint update that is invalid against the stored endpoint', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      override_starts_at: movedStart,
      override_ends_at: movedEnd,
    });
    const before = snapshot();
    expect(() =>
      db.updateCalendarOccurrence(entry, {
        occurrence_start: first,
        override_starts_at: '2026-11-19T05:00:00.000Z',
      }),
    ).toThrow(/time range/i);
    expect(snapshot()).toEqual(before);
    expect(() =>
      db.updateCalendarOccurrence(entry, {
        occurrence_start: first,
        override_starts_at: null,
      }),
    ).toThrow(/both a start and an end/i);
    expect(snapshot()).toEqual(before);
  });

  it('clears both overrides together while retaining the state identity and outcome', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      override_starts_at: movedStart,
      override_ends_at: movedEnd,
      completed_at: completed,
    });
    const id = state()!.id;
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      override_starts_at: null,
      override_ends_at: null,
    });
    expect(state()).toMatchObject({
      id,
      override_starts_at: null,
      override_ends_at: null,
      completed_at: completed,
    });
  });

  it('checks mutually exclusive outcomes against the stored value, not only the patch', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      completed_at: completed,
    });
    const before = snapshot();
    expect(() =>
      db.updateCalendarOccurrence(entry, {
        occurrence_start: first,
        not_needed_at: completed,
      }),
    ).toThrow(/done and not needed/i);
    expect(snapshot()).toEqual(before);
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      completed_at: null,
      not_needed_at: completed,
    });
    expect(state()).toMatchObject({
      completed_at: null,
      not_needed_at: completed,
    });
  });

  it.each(['completed_at', 'not_needed_at'] as const)(
    'rejects malformed %s before inserting a row',
    (field) => {
      const before = snapshot();
      expect(() =>
        db.updateCalendarOccurrence(entry, {
          occurrence_start: first,
          [field]: 'not-a-date',
        }),
      ).toThrow(/outcome time/i);
      expect(snapshot()).toEqual(before);
    },
  );

  it.each([
    undefined,
    null,
    'not-a-date',
    '1999-12-31T23:59:59Z',
    '2201-01-01T00:00:00Z',
    '2026-02-30T01:00:00Z',
  ])('rejects invalid original identity %s without writing', (identity) => {
    const before = snapshot();
    expect(() =>
      db.updateCalendarOccurrence(entry, {
        occurrence_start: identity,
        completed_at: completed,
      }),
    ).toThrow(/occurrence time/i);
    expect(snapshot()).toEqual(before);
  });

  it('accepts both ends of the supported instant range and equivalent timezone forms', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: '2026-11-19T08:00:00+07:00',
      override_starts_at: '2000-01-01T07:00:00+07:00',
      override_ends_at: '2000-01-01T07:15:00+07:00',
    });
    expect(state()?.override_starts_at).toBe('2000-01-01T07:00:00+07:00');
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      override_starts_at: '2200-12-31T23:00:00Z',
      override_ends_at: '2200-12-31T23:59:59.999Z',
    });
    expect(state()?.override_ends_at).toBe('2200-12-31T23:59:59.999Z');
  });

  it('does not impose a new same-day restriction on explicit Checklist exceptions', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      override_starts_at: '2026-11-19T16:45:00Z',
      override_ends_at: '2026-11-19T17:15:00Z',
    });
    expect(state()?.override_ends_at).toBe('2026-11-19T17:15:00Z');
  });

  it('retains Cloud occurrence semantics for a Reminder duration exception', () => {
    const reminder = db.createCalendarSession({
      title: 'Reminder',
      item_type: 'reminder',
      task_id: null,
      starts_at: first,
      ends_at: '2026-11-19T01:15:00Z',
      recurrence: 'daily',
      recurrence_until: '2026-11-21',
      timezone: 'Asia/Ho_Chi_Minh',
      all_day: false,
      notification_offsets: [],
    });
    db.updateCalendarOccurrence(reminder, {
      occurrence_start: first,
      override_starts_at: movedStart,
      override_ends_at: movedEnd,
    });
    expect(
      db
        .getCalendarWorkspace()
        .occurrence_states.find((row) => row.calendar_entry_id === reminder),
    ).toMatchObject({
      override_starts_at: movedStart,
      override_ends_at: movedEnd,
    });
  });

  it('rolls back an entire bulk move when a later override is invalid', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      completed_at: completed,
    });
    const before = snapshot();
    expect(() =>
      db.moveCalendarOccurrences(entry, [
        {
          occurrence_start: first,
          override_starts_at: movedStart,
          override_ends_at: movedEnd,
        },
        {
          occurrence_start: second,
          override_starts_at: movedEnd,
          override_ends_at: movedStart,
        },
      ]),
    ).toThrow(/time range/i);
    expect(snapshot()).toEqual(before);
  });

  it('commits valid bulk overrides without changing outcomes on omitted fields', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      completed_at: completed,
    });
    db.moveCalendarOccurrences(entry, [
      {
        occurrence_start: first,
        override_starts_at: movedStart,
        override_ends_at: movedEnd,
      },
      {
        occurrence_start: second,
        override_starts_at: '2026-11-20T03:00:00Z',
        override_ends_at: '2026-11-20T04:00:00Z',
      },
    ]);
    expect(state()).toMatchObject({
      completed_at: completed,
      override_starts_at: movedStart,
    });
    expect(state(second)).toMatchObject({
      completed_at: null,
      override_starts_at: '2026-11-20T03:00:00Z',
    });
  });

  it.each(['completed_at', 'not_needed_at'] as const)(
    'inherits a base %s when a schedule-only move materializes a new state',
    (field) => {
      db.db
        .prepare(`UPDATE calendar_sessions SET ${field}=? WHERE id=?`)
        .run(completed, entry);
      db.moveCalendarOccurrences(entry, [
        {
          occurrence_start: first,
          override_starts_at: movedStart,
          override_ends_at: movedEnd,
        },
      ]);
      expect(state()?.[field]).toBe(completed);
      expect(state()?.override_starts_at).toBe(movedStart);
    },
  );

  it('preserves an existing explicitly open occurrence instead of inheriting the base outcome again', () => {
    db.db
      .prepare('UPDATE calendar_sessions SET completed_at=? WHERE id=?')
      .run(completed, entry);
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      completed_at: null,
      not_needed_at: null,
    });
    const id = state()!.id;
    db.moveCalendarOccurrences(entry, [
      {
        occurrence_start: first,
        override_starts_at: movedStart,
        override_ends_at: movedEnd,
        completed_at: completed,
      },
    ]);
    expect(state()).toMatchObject({
      id,
      completed_at: null,
      not_needed_at: null,
      override_starts_at: movedStart,
    });
  });

  it('ignores stale outcome fields in move commands while preserving current independent state', () => {
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      completed_at: completed,
      title_override: 'Independent title',
    });
    const id = state()!.id;
    db.moveCalendarOccurrences(entry, [
      {
        occurrence_start: first,
        override_starts_at: movedStart,
        override_ends_at: movedEnd,
        completed_at: null,
        not_needed_at: '2026-11-19T05:00:00Z',
      },
    ]);
    expect(state()).toMatchObject({
      id,
      completed_at: completed,
      not_needed_at: null,
      title_override: 'Independent title',
    });
  });

  it.each(['completed_at', 'not_needed_at'] as const)(
    'restores an inherited %s after a failed optimistic occurrence toggle',
    (field) => {
      db.db
        .prepare(`UPDATE calendar_sessions SET ${field}=? WHERE id=?`)
        .run(completed, entry);
      const base = db.getCalendarWorkspace()
        .sessions[0] as unknown as CalendarSession;
      const item = expandRecurringSessions(
        [base],
        new Date(first),
        new Date(second),
      )[0];
      const optimistic = patchOccurrence([], entry, first, {
        completed_at: null,
        not_needed_at: null,
      });
      const restored = patchOccurrence(
        optimistic,
        entry,
        first,
        occurrenceOutcome(undefined, item),
      );
      expect(
        expandRecurringSessions(
          [base],
          new Date(first),
          new Date(second),
          restored,
        )[0][field],
      ).toBe(completed);
      expect(db.getCalendarWorkspace().occurrence_states).toEqual([]);
    },
  );

  it('restores explicit open state over inherited Done without dropping moved time, UUID or title', () => {
    db.db
      .prepare('UPDATE calendar_sessions SET completed_at=? WHERE id=?')
      .run(completed, entry);
    db.updateCalendarOccurrence(entry, {
      occurrence_start: first,
      completed_at: null,
      not_needed_at: null,
      override_starts_at: movedStart,
      override_ends_at: movedEnd,
      title_override: 'Explicit open exception',
    });
    const workspace = db.getCalendarWorkspace() as unknown as CalendarWorkspace;
    const base = workspace.sessions[0];
    const previous = workspace.occurrence_states[0];
    const item = expandRecurringSessions(
      [base],
      new Date(first),
      new Date(second),
    )[0];
    const optimistic = patchOccurrence([previous], entry, first, {
      completed_at: completed,
    });
    const restored = patchOccurrence(
      optimistic,
      entry,
      first,
      occurrenceOutcome(previous, item),
    );
    expect(restored[0]).toEqual(previous);
    expect(
      expandRecurringSessions(
        [base],
        new Date(first),
        new Date(second),
        restored,
      )[0],
    ).toMatchObject({
      completed_at: null,
      not_needed_at: null,
      starts_at: movedStart,
      title: 'Explicit open exception',
    });
  });
});
