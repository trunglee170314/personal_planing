import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { undoContext } from '../local-server/undo.mjs';
import {
  expandRecurringSessions,
  recurringSeriesFrom,
  toLocalInput,
  type RecurrenceRule,
} from '../lib/calendar';
import {
  moveCalendarSeriesAndRead,
  moveCalendarOccurrencesAndRead,
  CalendarMoveReadError,
  hasFiniteCalendarSeries,
  embeddedCalendarAnchor,
  type CalendarSeriesMove,
} from '../lib/calendar-moves';
import type {
  CalendarSession,
  CalendarWorkspace,
} from '../lib/data/repository';
import { makeRrule } from '../lib/calendar-rules';
import { dateKey, vietnamDateKey } from '../lib/calendar';
import { todayOutstanding } from '../lib/today-items';
import {
  createPlanningReadGuard,
  planningReadDisposition,
} from '../lib/planning-read-guard';

const transport = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => transport.client,
}));
const day = (n: number, hour = '01') =>
  `2035-01-${String(n).padStart(2, '0')}T${hour}:00:00.000Z`;
const shifted = (value: string, delta: number) =>
  new Date(Date.parse(value) + delta).toISOString();
const DAY = 86400000;
function expand(workspace: CalendarWorkspace) {
  return expandRecurringSessions(
    workspace.sessions,
    new Date('2034-01-01T00:00Z'),
    new Date('2037-01-01T00:00Z'),
    workspace.occurrence_states,
  ).sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
}

describe('Calendar and Today canonical series-move regression (real SQLite)', () => {
  let db: LocalDatabase;
  let task: string;
  beforeEach(() => {
    db = new LocalDatabase(':memory:');
    task = db.createTask({
      title: 'Calendar regression Task',
      priority: 'medium',
      workflow_status_id: 'local-status-planned',
    });
  });
  afterEach(() => db.close());
  const workspace = () =>
    db.getCalendarWorkspace() as unknown as CalendarWorkspace;
  function create(
    recurrence: RecurrenceRule = 'daily',
    itemType: 'checklist' | 'reminder' = 'checklist',
  ) {
    return db.createCalendarSession({
      title: 'Repeated session',
      task_id: itemType === 'checklist' ? task : null,
      item_type: itemType,
      starts_at: day(1),
      ends_at:
        itemType === 'reminder' ? '2035-01-01T01:15:00.000Z' : day(1, '02'),
      timezone: 'Asia/Ho_Chi_Minh',
      all_day: false,
      recurrence,
      recurrence_until: recurrence === 'none' ? null : '2035-03-31',
      recurrence_interval: recurrence === 'custom' ? 3 : 1,
      notification_offsets: [15],
      is_pinned: true,
      ...(recurrence === 'dates'
        ? { recurrence_dates: ['2035-01-01', '2035-01-04', '2035-01-11'] }
        : {}),
    });
  }
  function adapter(events: string[] = []) {
    return {
      async moveCalendarSeries(
        id: string,
        originalStart: string,
        originalEnd: string,
        nextStart: string,
        nextEnd: string,
      ) {
        events.push('write');
        db.moveCalendarSeries(id, {
          original_start: originalStart,
          original_end: originalEnd,
          next_start: nextStart,
          next_end: nextEnd,
        });
      },
      async getCalendarWorkspace() {
        events.push('read');
        return workspace();
      },
    };
  }
  function moveInput(
    id: string,
    original: { starts_at: string; ends_at: string },
    delta = DAY + 3600000,
  ): CalendarSeriesMove {
    return {
      id,
      originalStart: original.starts_at,
      originalEnd: original.ends_at,
      nextStart: shifted(original.starts_at, delta),
      nextEnd: shifted(original.ends_at, delta),
    };
  }
  function materialized(descriptor: 'daily' | 'none' = 'daily') {
    const id = create();
    db.updateCalendarOccurrence(id, {
      occurrence_start: day(2),
      completed_at: day(2, '02'),
    });
    db.saveAnnotation(
      { kind: 'calendar', id, occurrence_start: day(3) },
      { kind: 'comment', body: 'Own occurrence note', url: null },
    );
    db.moveCalendarOccurrences(id, [
      {
        occurrence_start: day(4),
        override_starts_at: day(20, '03'),
        override_ends_at: day(20, '04'),
      },
    ]);
    const current = workspace().sessions.find((session) => session.id === id)!;
    const { id: _id, ...input } = current;
    db.reviseCalendarSeries(
      id,
      {
        ...input,
        recurrence: descriptor,
        recurrence_until: descriptor === 'none' ? null : '2035-01-05',
        title: 'Materialized series',
      },
      'series',
      null,
      current,
    );
    expect(
      workspace().sessions.find((session) => session.id === id)
        ?.occurrence_mode,
    ).toBe(true);
    return id;
  }
  it('regression: a materialized Daily series returns every moved canonical occurrence instead of a base-only edit', async () => {
    const id = materialized();
    const before = workspace(),
      rowsBefore = expand(before);
    const selected = rowsBefore.find((row) => row.occurrence_start === day(4))!;
    const delta = DAY + 3600000;
    const next = await moveCalendarSeriesAndRead(
      adapter(),
      moveInput(id, selected, delta),
    );
    const after = expand(next);
    expect(after).toHaveLength(rowsBefore.length);
    expect(after.map((row) => row.starts_at)).toEqual(
      rowsBefore.map((row) => shifted(row.starts_at, delta)),
    );
    expect(after.map((row) => row.ends_at)).toEqual(
      rowsBefore.map((row) => shifted(row.ends_at, delta)),
    );
    expect(
      next.occurrence_states
        .map((row) => row.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(
      before.occurrence_states
        .map((row) => row.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
    );
    expect(after.find((row) => row.completed_at)?.completed_at).toBe(
      day(2, '02'),
    );
    expect(
      db.listAnnotations({
        kind: 'calendar',
        id,
        occurrence_start: shifted(day(3), delta),
      })[0].body,
    ).toBe('Own occurrence note');
    expect(
      expand(db.getTodayWorkspace() as unknown as CalendarWorkspace),
    ).toEqual(after);
  });
  it('moves a materialized Does-not-repeat descriptor containing protected history', async () => {
    const id = materialized('none');
    const before = expand(workspace());
    const next = await moveCalendarSeriesAndRead(
      adapter(),
      moveInput(id, before[0], DAY),
    );
    expect(next.sessions.find((session) => session.id === id)).toMatchObject({
      recurrence: 'none',
      occurrence_mode: true,
    });
    expect(expand(next).map((row) => row.starts_at)).toEqual(
      before.map((row) => shifted(row.starts_at, DAY)),
    );
  });
  it.each<RecurrenceRule>([
    'none',
    'daily',
    'weekly',
    'monthly',
    'custom',
    'dates',
  ])(
    'refreshes the entire %s recurrence after moving a non-first occurrence',
    async (recurrence) => {
      const id = create(recurrence);
      const before = expand(workspace());
      const selected = before[Math.min(1, before.length - 1)];
      const next = await moveCalendarSeriesAndRead(
        adapter(),
        moveInput(id, selected, DAY),
      );
      expect(expand(next).map((row) => row.starts_at)).toEqual(
        before.map((row) => shifted(row.starts_at, DAY)),
      );
      expect(
        next.sessions.find((session) => session.id === id)?.recurrence,
      ).toBe(recurrence);
    },
  );
  it('preserves per-occurrence exceptions and both Done/Not-needed outcomes during a whole-series resize', async () => {
    const id = materialized();
    db.updateCalendarOccurrence(id, {
      occurrence_start: day(5),
      not_needed_at: day(5, '02'),
    });
    const before = expand(workspace());
    const input = moveInput(id, before[0], 0);
    input.nextEnd = shifted(input.originalEnd, 1800000);
    const after = expand(await moveCalendarSeriesAndRead(adapter(), input));
    expect(after.map((row) => row.starts_at)).toEqual(
      before.map((row) => row.starts_at),
    );
    expect(after.map((row) => row.ends_at)).toEqual(
      before.map((row) => shifted(row.ends_at, 1800000)),
    );
    expect(after.map((row) => [row.completed_at, row.not_needed_at])).toEqual(
      before.map((row) => [row.completed_at, row.not_needed_at]),
    );
  });
  it('keeps all Reminder durations at 15 minutes after a cross-midnight series move', async () => {
    const id = create('daily', 'reminder');
    const first = expand(workspace())[0];
    const nextStart = '2035-01-01T16:55:00.000Z';
    const result = await moveCalendarSeriesAndRead(adapter(), {
      id,
      originalStart: first.starts_at,
      originalEnd: first.ends_at,
      nextStart,
      nextEnd: shifted(nextStart, 3600000),
    });
    const rows = expand(result);
    expect(rows.length).toBeGreaterThan(1);
    expect(
      rows.every(
        (row) =>
          Date.parse(row.ends_at) - Date.parse(row.starts_at) === 15 * 60000,
      ),
    ).toBe(true);
    expect(toLocalInput(rows[0].starts_at)).toBe('2035-01-01T23:55');
    expect(toLocalInput(rows[0].ends_at)).toBe('2035-01-02T00:10');
  });
  it('executes the write inside its queue before taking the canonical read', async () => {
    const id = create();
    const events: string[] = [];
    await moveCalendarSeriesAndRead(
      adapter(events),
      moveInput(id, expand(workspace())[0]),
      async (action) => {
        events.push('queue');
        await action();
        events.push('committed');
      },
    );
    expect(events).toEqual(['queue', 'write', 'committed', 'read']);
  });
  it('makes a whole-series move undoable including keys, overrides, UUIDs and notes', async () => {
    const id = materialized();
    const before = workspace();
    const operation = '00000000-0000-4000-8000-000000000077',
      session = '00000000-0000-4000-8000-000000000078';
    await moveCalendarSeriesAndRead(
      adapter(),
      moveInput(id, expand(before)[0]),
      (action) => undoContext.run({ operation, session }, action),
    );
    (
      db as LocalDatabase & {
        applyUndo: (operation: string, session: string) => void;
      }
    ).applyUndo(operation, session);
    expect(workspace()).toEqual(before);
    expect(
      db.listAnnotations({ kind: 'calendar', id, occurrence_start: day(3) })[0]
        .body,
    ).toBe('Own occurrence note');
  });
  it('treats a failed write as unsaved and never reads a misleading canonical result', async () => {
    const read = vi.fn(async () => workspace());
    const cause = new Error('write rejected');
    const repository = {
      moveCalendarSeries: vi.fn(async () => {
        throw cause;
      }),
      getCalendarWorkspace: read,
    };
    const input: CalendarSeriesMove = {
      id: 'entry',
      originalStart: day(1),
      originalEnd: day(1, '02'),
      nextStart: day(2),
      nextEnd: day(2, '02'),
    };
    await expect(moveCalendarSeriesAndRead(repository, input)).rejects.toBe(
      cause,
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('distinguishes a committed write with failed reload and never repeats the mutation', async () => {
    const write = vi.fn(async () => {});
    const repository = {
      moveCalendarSeries: write,
      getCalendarWorkspace: vi.fn(async () => {
        throw new Error('read unavailable');
      }),
    };
    const input: CalendarSeriesMove = {
      id: 'entry',
      originalStart: day(1),
      originalEnd: day(1, '02'),
      nextStart: day(2),
      nextEnd: day(2, '02'),
    };
    await expect(
      moveCalendarSeriesAndRead(repository, input),
    ).rejects.toBeInstanceOf(CalendarMoveReadError);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('accepts materialized Does-not-repeat history as a finite series without repeat-until', () => {
    expect(
      hasFiniteCalendarSeries({
        occurrence_mode: true,
        recurrence_until: null,
      }),
    ).toBe(true);
  });
  it('moves only the selected occurrence and returns authoritative canonical state', async () => {
    const id = materialized();
    const before = workspace(),
      selected = expand(before).find((row) => row.occurrence_start === day(3))!;
    const repo = {
      async moveCalendarOccurrences(
        entryId: string,
        changes: Parameters<LocalDatabase['moveCalendarOccurrences']>[1],
      ) {
        db.moveCalendarOccurrences(entryId, changes);
      },
      async getCalendarWorkspace() {
        return workspace();
      },
    };
    const next = await moveCalendarOccurrencesAndRead(repo, id, [
      {
        occurrence_start: selected.occurrence_start,
        override_starts_at: shifted(selected.starts_at, DAY),
        override_ends_at: shifted(selected.ends_at, DAY),
      },
    ]);
    for (const original of expand(before)) {
      const after = expand(next).find(
        (row) => row.occurrence_start === original.occurrence_start,
      )!;
      expect(after.starts_at).toBe(
        original.occurrence_start === selected.occurrence_start
          ? shifted(original.starts_at, DAY)
          : original.starts_at,
      );
    }
    expect(
      db.listAnnotations({ kind: 'calendar', id, occurrence_start: day(3) })[0]
        .body,
    ).toBe('Own occurrence note');
  });
  it('moves This-and-following by original keys, retaining outcomes and UUIDs before and after the cutoff', async () => {
    const id = materialized(),
      before = workspace(),
      base = before.sessions.find((row) => row.id === id)!;
    const selected = expand(before).find(
      (row) => row.occurrence_start === day(3),
    )!;
    const future = recurringSeriesFrom(
      base,
      selected,
      before.occurrence_states,
    );
    const repo = {
      async moveCalendarOccurrences(
        entryId: string,
        changes: Parameters<LocalDatabase['moveCalendarOccurrences']>[1],
      ) {
        db.moveCalendarOccurrences(entryId, changes);
      },
      async getCalendarWorkspace() {
        return workspace();
      },
    };
    const next = await moveCalendarOccurrencesAndRead(
      repo,
      id,
      future.map((row) => ({
        occurrence_start: row.occurrence_start,
        override_starts_at: shifted(row.starts_at, DAY),
        override_ends_at: shifted(row.ends_at, DAY),
      })),
    );
    for (const original of expand(before)) {
      const after = expand(next).find(
        (row) => row.occurrence_start === original.occurrence_start,
      )!;
      expect(after.starts_at).toBe(
        original.occurrence_start >= selected.occurrence_start
          ? shifted(original.starts_at, DAY)
          : original.starts_at,
      );
      expect([after.completed_at, after.not_needed_at]).toEqual([
        original.completed_at,
        original.not_needed_at,
      ]);
    }
    expect(next.occurrence_states.map((row) => row.id)).toEqual(
      before.occurrence_states.map((row) => row.id),
    );
  });
  it.each(['completed_at', 'not_needed_at'] as const)(
    'preserves inherited base %s when a move materializes an occurrence',
    async (field) => {
      const id = create('daily');
      db.updateCalendarSession(id, { [field]: day(1, '02') });
      const repo = {
        async moveCalendarOccurrences(
          entryId: string,
          changes: Parameters<LocalDatabase['moveCalendarOccurrences']>[1],
        ) {
          db.moveCalendarOccurrences(entryId, changes);
        },
        async getCalendarWorkspace() {
          return workspace();
        },
      };
      const next = await moveCalendarOccurrencesAndRead(repo, id, [
        {
          occurrence_start: day(2),
          override_starts_at: day(8, '03'),
          override_ends_at: day(8, '04'),
        },
      ]);
      const moved = expand(next).find(
        (row) => row.occurrence_start === day(2),
      )!;
      expect(moved[field]).toBe(day(1, '02'));
      expect(moved.starts_at).toBe(day(8, '03'));
      expect(todayOutstanding(next, new Date('2035-04-01T12:00Z'))).toEqual([]);
    },
  );
  it('ignores stale outcome values supplied by an older UI snapshot during schedule-only moves', async () => {
    const id = create('daily');
    db.updateCalendarOccurrence(id, {
      occurrence_start: day(2),
      completed_at: day(5, '02'),
    });
    const staleChanges = [
      {
        occurrence_start: day(2),
        override_starts_at: day(8, '03'),
        override_ends_at: day(8, '04'),
        completed_at: null,
        not_needed_at: day(1, '02'),
      },
    ];
    const repo = {
      async moveCalendarOccurrences(
        entryId: string,
        changes: Parameters<LocalDatabase['moveCalendarOccurrences']>[1],
      ) {
        db.moveCalendarOccurrences(entryId, changes);
      },
      async getCalendarWorkspace() {
        return workspace();
      },
    };
    const next = await moveCalendarOccurrencesAndRead(repo, id, staleChanges);
    expect(
      expand(next).find((row) => row.occurrence_start === day(2)),
    ).toMatchObject({
      completed_at: day(5, '02'),
      not_needed_at: null,
      starts_at: day(8, '03'),
    });
  });
  it('runs occurrence moves inside their queue before canonical reload', async () => {
    const id = create('daily'),
      events: string[] = [];
    const repo = {
      async moveCalendarOccurrences(
        entryId: string,
        changes: Parameters<LocalDatabase['moveCalendarOccurrences']>[1],
      ) {
        events.push('write');
        db.moveCalendarOccurrences(entryId, changes);
      },
      async getCalendarWorkspace() {
        events.push('read');
        return workspace();
      },
    };
    await moveCalendarOccurrencesAndRead(
      repo,
      id,
      [
        {
          occurrence_start: day(2),
          override_starts_at: day(8, '03'),
          override_ends_at: day(8, '04'),
        },
      ],
      async (action) => {
        events.push('queue');
        await action();
        events.push('committed');
      },
    );
    expect(events).toEqual(['queue', 'write', 'committed', 'read']);
  });
  it('does not read after an occurrence write failure', async () => {
    const read = vi.fn(async () => workspace()),
      cause = new Error('occurrence denied');
    const repo = {
      async moveCalendarOccurrences() {
        throw cause;
      },
      getCalendarWorkspace: read,
    };
    await expect(
      moveCalendarOccurrencesAndRead(repo, 'entry', [
        {
          occurrence_start: day(2),
          override_starts_at: day(8),
          override_ends_at: day(8, '02'),
        },
      ]),
    ).rejects.toBe(cause);
    expect(read).not.toHaveBeenCalled();
  });
  it('reports a committed occurrence move if only its canonical reload fails', async () => {
    const write = vi.fn(async () => {});
    const repo = {
      moveCalendarOccurrences: write,
      async getCalendarWorkspace(): Promise<CalendarWorkspace> {
        throw new Error('reload failed');
      },
    };
    await expect(
      moveCalendarOccurrencesAndRead(repo, 'entry', [
        {
          occurrence_start: day(2),
          override_starts_at: day(8),
          override_ends_at: day(8, '02'),
        },
      ]),
    ).rejects.toBeInstanceOf(CalendarMoveReadError);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('requires a repeat-until horizon only for a non-materialized series', () => {
    expect(
      hasFiniteCalendarSeries({
        occurrence_mode: false,
        recurrence_until: null,
      }),
    ).toBe(false);
    expect(hasFiniteCalendarSeries({ recurrence_until: '2035-01-05' })).toBe(
      true,
    );
  });
});

function todaySession(
  id: string,
  starts_at: string,
  ends_at: string,
  changes: Partial<CalendarSession> = {},
): CalendarSession {
  return {
    id,
    title: id,
    task_id: null,
    item_type: 'reminder',
    starts_at,
    ends_at,
    all_day: false,
    timezone: 'Asia/Ho_Chi_Minh',
    recurrence: 'none',
    recurrence_until: null,
    recurrence_interval: 1,
    completed_at: null,
    not_needed_at: null,
    notification_offsets: [],
    is_pinned: false,
    ...changes,
  };
}
describe('Today overdue projection regressions', () => {
  it('does not let a legacy 1,100-day event duration consume the guard before reaching today', () => {
    const start = '2022-01-01T01:00:00.000Z';
    const session: CalendarSession = {
      id: 'long-duration',
      title: 'Legacy long duration',
      task_id: null,
      item_type: 'reminder',
      starts_at: start,
      ends_at: shifted(start, 1100 * DAY),
      recurrence: 'daily',
      recurrence_until: '2026-11-20',
      recurrence_interval: 1,
      timezone: 'Asia/Ho_Chi_Minh',
      all_day: false,
      completed_at: null,
      not_needed_at: null,
      notification_offsets: [],
      is_pinned: false,
    };
    const rows = todayOutstanding(
      { sessions: [session], occurrence_states: [] },
      new Date('2026-11-19T12:00:00Z'),
    );
    const expected = (Date.UTC(2026, 10, 19) - Date.UTC(2022, 0, 1)) / DAY + 1;
    expect(rows).toHaveLength(expected);
    expect(rows.at(-1)?.starts_at).toBe('2026-11-19T01:00:00.000Z');
    expect(
      rows.every(
        (row) =>
          Date.parse(row.ends_at) - Date.parse(row.starts_at) === 1100 * DAY,
      ),
    ).toBe(true);
  });
  it('keeps all overdue occurrences beyond the former 1,000-expansion cutoff', () => {
    const start = '2030-01-01T01:00:00.000Z',
      until = '2035-01-05';
    const session = todaySession('legacy', start, '2030-01-01T01:15:00.000Z', {
      recurrence: 'daily',
      recurrence_until: until,
    });
    const rows = todayOutstanding(
      { sessions: [session], occurrence_states: [] },
      new Date('2035-01-05T12:00:00Z'),
    );
    const expected = (Date.UTC(2035, 0, 5) - Date.UTC(2030, 0, 1)) / DAY + 1;
    expect(rows).toHaveLength(expected);
    expect(rows[0].starts_at).toBe(start);
    expect(rows.at(-1)?.starts_at).toBe('2035-01-05T01:00:00.000Z');
  });
  it('includes a moved-in overdue occurrence before a future series base', () => {
    const session = todaySession('future', day(20), day(20, '02'), {
      recurrence: 'daily',
      recurrence_until: '2035-01-22',
    });
    const rows = todayOutstanding(
      {
        sessions: [session],
        occurrence_states: [
          {
            calendar_entry_id: 'future',
            occurrence_start: day(20),
            override_starts_at: day(2),
            override_ends_at: day(2, '02'),
            completed_at: null,
            not_needed_at: null,
          },
        ],
      },
      new Date(day(5)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      starts_at: day(2),
      occurrence_start: day(20),
    });
  });
  it('includes materialized history before the base while retaining original identity', () => {
    const session = todaySession('materialized', day(20), day(20, '02'), {
      occurrence_mode: true,
    });
    const rows = todayOutstanding(
      {
        sessions: [session],
        occurrence_states: [
          {
            id: 'immutable',
            calendar_entry_id: session.id,
            occurrence_start: day(1),
            override_starts_at: day(2),
            override_ends_at: day(2, '02'),
            completed_at: null,
            not_needed_at: null,
          },
        ],
      },
      new Date(day(5)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurrence_start: day(1),
      starts_at: day(2),
    });
  });
  it('deduplicates an exception spanning the 365-day expansion chunk boundary', () => {
    const start = '2030-01-01T01:00:00.000Z';
    const boundary = shifted(start, 365 * DAY);
    const session = todaySession('chunks', start, shifted(start, 900000), {
      recurrence: 'daily',
      recurrence_until: '2031-01-05',
    });
    const rows = todayOutstanding(
      {
        sessions: [session],
        occurrence_states: [
          {
            calendar_entry_id: session.id,
            occurrence_start: boundary,
            override_starts_at: shifted(boundary, -300000),
            override_ends_at: shifted(boundary, 600000),
            completed_at: null,
            not_needed_at: null,
          },
        ],
      },
      new Date('2031-01-05T12:00Z'),
    );
    expect(
      rows.filter((row) => row.occurrence_start === boundary),
    ).toHaveLength(1);
    expect(new Set(rows.map((row) => row.occurrence_id)).size).toBe(
      rows.length,
    );
  });
  it('excludes Done and Not-needed occurrences, preserving an independent open occurrence', () => {
    const session = todaySession('outcomes', day(1), day(1, '02'), {
      recurrence: 'daily',
      recurrence_until: '2035-01-03',
    });
    const rows = todayOutstanding(
      {
        sessions: [session],
        occurrence_states: [
          {
            calendar_entry_id: session.id,
            occurrence_start: day(1),
            completed_at: day(1, '02'),
            not_needed_at: null,
          },
          {
            calendar_entry_id: session.id,
            occurrence_start: day(2),
            completed_at: null,
            not_needed_at: day(2, '02'),
          },
        ],
      },
      new Date(day(3, '03')),
    );
    expect(rows.map((row) => row.occurrence_start)).toEqual([day(3)]);
  });
  it('keeps pinned-first ordering, then date and stable occurrence identity', () => {
    const sessions = [
      todaySession('b', day(1), day(1, '02')),
      todaySession('a', day(1), day(1, '02')),
      todaySession('pin', day(3), day(3, '02'), { is_pinned: true }),
    ];
    expect(
      todayOutstanding(
        { sessions, occurrence_states: [] },
        new Date(day(5)),
      ).map((row) => row.id),
    ).toEqual(['pin', 'a', 'b']);
  });
  it('uses Vietnam midnight to include the new day and excludes tomorrow', () => {
    const sessions = [
      todaySession(
        'new-day',
        '2035-01-02T01:00:00.000Z',
        '2035-01-02T01:15:00.000Z',
      ),
      todaySession(
        'tomorrow',
        '2035-01-03T01:00:00.000Z',
        '2035-01-03T01:15:00.000Z',
      ),
    ];
    expect(
      todayOutstanding(
        { sessions, occurrence_states: [] },
        new Date('2035-01-01T16:59:59Z'),
      ),
    ).toEqual([]);
    expect(
      todayOutstanding(
        { sessions, occurrence_states: [] },
        new Date('2035-01-01T17:00:00Z'),
      ).map((row) => row.id),
    ).toEqual(['new-day']);
  });
  it('does not populate a future-only workspace with fake or early rows', () => {
    const session = todaySession('future', day(20), day(20, '02'));
    expect(
      todayOutstanding(
        { sessions: [session], occurrence_states: [] },
        new Date(day(5)),
      ),
    ).toEqual([]);
  });
  it('does not mutate sessions, overrides or outcomes', () => {
    const workspace = {
      sessions: [todaySession('plain', day(1), day(1, '02'))],
      occurrence_states: [],
    };
    const before = structuredClone(workspace);
    todayOutstanding(workspace, new Date(day(5)));
    expect(workspace).toEqual(before);
  });
});

describe('Calendar/Today request ownership guards', () => {
  it('applies an uncontested read from the current epoch', () => {
    expect(planningReadDisposition(3, 3, 0)).toBe('apply');
  });
  it.each([
    [3, 3],
    [2, 3],
  ])(
    'defers while mutations are still queued at epochs %s/%s',
    (started, current) => {
      expect(planningReadDisposition(started, current, 1)).toBe('defer');
    },
  );
  it('defers while a mutation is still active even if the read epoch is unchanged', () => {
    expect(planningReadDisposition(3, 3, 1)).toBe('defer');
    expect(planningReadDisposition(2, 3, 1)).toBe('defer');
  });
  it('reloads a stale response after the mutation queue has already drained', () => {
    expect(planningReadDisposition(2, 3, 0)).toBe('reload');
  });
  it('regression: refreshes a stale read when its mutation finalizer ran before the response arrived', async () => {
    const startedEpoch = 1;
    let currentEpoch = 1,
      pending = 0,
      displayed = 'initial',
      refreshed = 0;
    let finishRead!: () => void;
    const response = new Promise<void>((resolve) => {
      finishRead = resolve;
    }).then(() => {
      const disposition = planningReadDisposition(
        startedEpoch,
        currentEpoch,
        pending,
      );
      if (disposition === 'reload') {
        refreshed++;
        displayed = 'fresh';
      } else if (disposition === 'apply') displayed = 'stale';
    });
    currentEpoch++;
    pending++;
    pending--; // The finalizer has already checked its deferred flag and exited.
    finishRead();
    await response;
    expect(refreshed).toBe(1);
    expect(displayed).toBe('fresh');
  });
  it('only commits the latest response when an older read finishes last', async () => {
    const guard = createPlanningReadGuard();
    guard.mount();
    const old = guard.begin();
    let finish!: () => void;
    let displayed = '';
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => {
      if (old()) displayed = 'old';
    });
    const current = guard.begin();
    if (current()) displayed = 'new';
    finish();
    await pending;
    expect(displayed).toBe('new');
  });
  it('prevents errors or data from an unmounted consumer from committing', () => {
    const guard = createPlanningReadGuard();
    guard.mount();
    const current = guard.begin();
    guard.dispose();
    expect(current()).toBe(false);
    expect(guard.begin()()).toBe(false);
  });
  it('invalidates old requests across a dispose/remount cycle', () => {
    const guard = createPlanningReadGuard();
    guard.mount();
    const old = guard.begin();
    guard.dispose();
    guard.mount();
    const current = guard.begin();
    expect(old()).toBe(false);
    expect(current()).toBe(true);
  });
  it('does not allow a read started before mounting to take ownership afterward', () => {
    const guard = createPlanningReadGuard();
    const old = guard.begin();
    expect(old()).toBe(false);
    guard.mount();
    expect(old()).toBe(false);
    expect(guard.begin()()).toBe(true);
  });
});

describe('Embedded Today calendar follows Vietnam midnight without changing navigation', () => {
  it('advances an anchor that was following today to the next calendar day', () => {
    const current = new Date('2035-01-01T12:00:00');
    const next = embeddedCalendarAnchor(current, '2035-01-01', '2035-01-02');
    expect(dateKey(next)).toBe('2035-01-02');
    expect(next.getHours()).toBe(12);
  });
  it('keeps the same anchor object while the Vietnam calendar day has not changed', () => {
    const current = new Date('2035-01-01T12:00:00');
    expect(embeddedCalendarAnchor(current, '2035-01-01', '2035-01-01')).toBe(
      current,
    );
  });
  it.each(['2034-12-25', '2035-01-05'])(
    'preserves a user-navigated date %s across midnight',
    (key) => {
      const current = new Date(`${key}T12:00:00`);
      expect(embeddedCalendarAnchor(current, '2035-01-01', '2035-01-02')).toBe(
        current,
      );
    },
  );
  it.each([
    ['2035-01-31', '2035-02-01'],
    ['2036-02-28', '2036-02-29'],
    ['2035-12-31', '2036-01-01'],
  ])('follows day transitions from %s to %s', (previous, next) => {
    const result = embeddedCalendarAnchor(
      new Date(`${previous}T12:00:00`),
      previous,
      next,
    );
    expect(dateKey(result)).toBe(next);
    expect(result.getHours()).toBe(12);
  });
  it('uses the anchor calendar key rather than converting host-local noon into a Vietnam instant', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const current = new Date('2035-01-01T12:00:00');
      expect(dateKey(current)).toBe('2035-01-01');
      expect(vietnamDateKey(current)).toBe('2035-01-02');
      expect(
        dateKey(embeddedCalendarAnchor(current, '2035-01-01', '2035-01-02')),
      ).toBe('2035-01-02');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('Cloud series RPC and canonical Calendar/Today refresh contract', () => {
  let db: LocalDatabase;
  let id: string;
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APP_MODE', 'cloud');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.invalid');
    vi.stubEnv(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'sb_publishable_test_only',
    );
    db = new LocalDatabase(':memory:');
    const task = db.createTask({
      title: 'Cloud adapter Task',
      priority: 'medium',
      workflow_status_id: 'local-status-planned',
    });
    id = db.createCalendarSession({
      title: 'Cloud materialized',
      task_id: task,
      item_type: 'checklist',
      starts_at: day(1),
      ends_at: day(1, '02'),
      recurrence: 'daily',
      recurrence_until: '2035-01-05',
      recurrence_interval: 1,
      timezone: 'Asia/Ho_Chi_Minh',
      all_day: false,
      notification_offsets: [],
    });
    db.updateCalendarOccurrence(id, {
      occurrence_start: day(2),
      completed_at: day(2, '02'),
    });
    const base = (db.getCalendarWorkspace() as unknown as CalendarWorkspace)
      .sessions[0];
    const { id: _id, ...input } = base;
    db.reviseCalendarSeries(
      id,
      { ...input, title: 'Cloud authoritative states' },
      'series',
      null,
      base,
    );
  });
  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });
  const localWorkspace = () =>
    db.getCalendarWorkspace() as unknown as CalendarWorkspace;
  function client() {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const reads: { table: string; from: number; to: number }[] = [];
    let failMove = false,
      failRead = false;
    function data(table: string): Record<string, unknown>[] {
      const current = localWorkspace();
      if (table === 'goals')
        return current.goals.map((goal) => ({
          ...goal,
          status: 'active',
          deleted_at: null,
        }));
      if (table === 'tasks')
        return current.tasks.map((task) => ({
          ...task,
          status: task.workflow_status_id,
          previous_status: task.previous_status_id,
          goal_id:
            current.links.find((link) => link.task_id === task.id)?.goal_id ??
            null,
        }));
      if (table === 'calendar_entries')
        return current.sessions.map((session) => ({
          ...session,
          status: 'active',
        }));
      if (table === 'recurrence_rules')
        return current.sessions.map((session) => ({
          calendar_entry_id: session.id,
          rrule: makeRrule(session),
        }));
      if (table === 'calendar_occurrence_states')
        return current.occurrence_states.map((state) => ({ ...state }));
      throw new Error(`Unexpected cloud table ${table}`);
    }
    return {
      calls,
      reads,
      failMove() {
        failMove = true;
      },
      failRead() {
        failRead = true;
      },
      from(table: string) {
        let rows = data(table);
        const query = {
          select() {
            return query;
          },
          order() {
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
          range(from: number, to: number) {
            reads.push({ table, from, to });
            return Promise.resolve({
              data: failRead ? null : rows.slice(from, to + 1),
              error: failRead ? { message: 'Cloud reload unavailable' } : null,
            });
          },
        };
        return query;
      },
      async rpc(name: string, input: Record<string, unknown>) {
        calls.push({ name, input });
        if (
          name !== 'move_calendar_series' &&
          name !== 'myplan_move_occurrences'
        )
          throw new Error(`Unexpected cloud RPC ${name}`);
        if (failMove)
          return { data: null, error: { message: 'Cloud write denied' } };
        if (name === 'myplan_move_occurrences') {
          db.moveCalendarOccurrences(String(input.target_entry), input.changes);
        } else
          db.moveCalendarSeries(String(input.target_entry_id), {
            original_start: input.original_occurrence_start,
            original_end: input.original_occurrence_end,
            next_start: input.next_occurrence_start,
            next_end: input.next_occurrence_end,
          });
        return { data: null, error: null };
      },
    };
  }
  async function repository(fake: ReturnType<typeof client>) {
    transport.client = fake;
    const { getPlanningRepository } = await import('../lib/data/repository');
    const repo = getPlanningRepository();
    if (!repo) throw new Error('Cloud mock repository unavailable.');
    return repo;
  }
  it('uses the series RPC and refreshes all materialized states through the real Cloud adapter', async () => {
    const fake = client(),
      repo = await repository(fake);
    const before = localWorkspace(),
      selected = expand(before)[2],
      delta = DAY + 3600000;
    const move = {
      id,
      originalStart: selected.starts_at,
      originalEnd: selected.ends_at,
      nextStart: shifted(selected.starts_at, delta),
      nextEnd: shifted(selected.ends_at, delta),
    };
    const next = await moveCalendarSeriesAndRead(repo, move);
    expect(fake.calls).toEqual([
      {
        name: 'move_calendar_series',
        input: {
          target_entry_id: id,
          original_occurrence_start: move.originalStart,
          original_occurrence_end: move.originalEnd,
          next_occurrence_start: move.nextStart,
          next_occurrence_end: move.nextEnd,
        },
      },
    ]);
    expect(new Set(fake.reads.map((read) => read.table))).toEqual(
      new Set([
        'goals',
        'tasks',
        'calendar_entries',
        'recurrence_rules',
        'calendar_occurrence_states',
      ]),
    );
    expect(expand(next).map((row) => row.starts_at)).toEqual(
      expand(before).map((row) => shifted(row.starts_at, delta)),
    );
    expect(
      next.occurrence_states
        .map((state) => state.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(
      before.occurrence_states
        .map((state) => state.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
    );
    expect(expand(await repo.getTodayWorkspace())).toEqual(expand(next));
  });
  it('returns a committed-read error when Cloud write succeeded but canonical state cannot load', async () => {
    const fake = client(),
      repo = await repository(fake);
    const selected = expand(localWorkspace())[0];
    fake.failRead();
    await expect(
      moveCalendarSeriesAndRead(repo, {
        id,
        originalStart: selected.starts_at,
        originalEnd: selected.ends_at,
        nextStart: shifted(selected.starts_at, DAY),
        nextEnd: shifted(selected.ends_at, DAY),
      }),
    ).rejects.toBeInstanceOf(CalendarMoveReadError);
    expect(fake.calls).toHaveLength(1);
    expect(expand(localWorkspace())[0].starts_at).toBe(day(2));
  });
  it('does not perform a misleading refresh after Cloud rejects the series write', async () => {
    const fake = client(),
      repo = await repository(fake);
    const before = localWorkspace(),
      selected = expand(before)[0];
    fake.failMove();
    await expect(
      moveCalendarSeriesAndRead(repo, {
        id,
        originalStart: selected.starts_at,
        originalEnd: selected.ends_at,
        nextStart: shifted(selected.starts_at, DAY),
        nextEnd: shifted(selected.ends_at, DAY),
      }),
    ).rejects.toThrow('Cloud write denied');
    expect(fake.reads).toEqual([]);
    expect(localWorkspace()).toEqual(before);
  });
  it('uses the Cloud occurrence batch RPC and reads fresh server outcomes for both moved dates', async () => {
    const fake = client(),
      repo = await repository(fake);
    const before = localWorkspace(),
      rows = expand(before),
      first = rows[2],
      second = rows[3];
    db.updateCalendarOccurrence(id, {
      occurrence_start: first.occurrence_start,
      completed_at: day(5, '02'),
    });
    db.updateCalendarOccurrence(id, {
      occurrence_start: second.occurrence_start,
      not_needed_at: day(5, '03'),
    });
    const changes = [first, second].map((row) => ({
      occurrence_start: row.occurrence_start,
      override_starts_at: shifted(row.starts_at, DAY),
      override_ends_at: shifted(row.ends_at, DAY),
      completed_at: null,
      not_needed_at: null,
    }));
    const next = await moveCalendarOccurrencesAndRead(repo, id, changes);
    expect(fake.calls).toEqual([
      { name: 'myplan_move_occurrences', input: { target_entry: id, changes } },
    ]);
    expect(
      expand(next).find(
        (row) => row.occurrence_start === first.occurrence_start,
      ),
    ).toMatchObject({
      starts_at: shifted(first.starts_at, DAY),
      completed_at: day(5, '02'),
    });
    expect(
      expand(next).find(
        (row) => row.occurrence_start === second.occurrence_start,
      ),
    ).toMatchObject({
      starts_at: shifted(second.starts_at, DAY),
      not_needed_at: day(5, '03'),
    });
    expect(
      expand(next).find(
        (row) => row.occurrence_start === rows[0].occurrence_start,
      )?.starts_at,
    ).toBe(rows[0].starts_at);
    expect(expand(await repo.getTodayWorkspace())).toEqual(expand(next));
  });
  it('does not call a canonical Cloud read after an occurrence batch write rejects', async () => {
    const fake = client(),
      repo = await repository(fake);
    fake.failMove();
    await expect(
      moveCalendarOccurrencesAndRead(repo, id, [
        {
          occurrence_start: day(3),
          override_starts_at: day(8),
          override_ends_at: day(8, '02'),
        },
      ]),
    ).rejects.toThrow('Cloud write denied');
    expect(fake.reads).toEqual([]);
  });
  it('distinguishes a committed Cloud occurrence move when only the reload fails', async () => {
    const fake = client(),
      repo = await repository(fake);
    fake.failRead();
    await expect(
      moveCalendarOccurrencesAndRead(repo, id, [
        {
          occurrence_start: day(3),
          override_starts_at: day(8),
          override_ends_at: day(8, '02'),
        },
      ]),
    ).rejects.toBeInstanceOf(CalendarMoveReadError);
    expect(fake.calls).toHaveLength(1);
    expect(
      expand(localWorkspace()).find((row) => row.occurrence_start === day(3))
        ?.starts_at,
    ).toBe(day(8));
  });
});
