import { describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import {
  calendarItemDraft,
  calendarItemInput,
  calendarItemOccurrence,
  calendarItemOccurrences,
} from '../lib/calendar-items';
import type {
  CalendarOccurrenceState,
  CalendarSession,
  CalendarWorkspace,
} from '../lib/data/repository';

const DAY = 86_400_000;
function session(changes: Partial<CalendarSession> = {}): CalendarSession {
  return {
    id: 'daily',
    title: 'Daily work',
    task_id: 'task',
    starts_at: '2000-01-01T01:00:00.000Z',
    ends_at: '2000-01-01T02:00:00.000Z',
    all_day: false,
    timezone: 'Asia/Ho_Chi_Minh',
    recurrence: 'daily',
    recurrence_until: '2030-01-01',
    recurrence_interval: 1,
    item_type: 'checklist',
    completed_at: null,
    not_needed_at: null,
    notification_offsets: [0, 15],
    is_pinned: true,
    ...changes,
  };
}
function state(
  key: string,
  changes: Partial<CalendarOccurrenceState> = {},
): CalendarOccurrenceState {
  return {
    calendar_entry_id: 'daily',
    occurrence_start: key,
    completed_at: null,
    not_needed_at: null,
    ...changes,
  };
}

describe('Calendar shared editor identity targeting', () => {
  it('opens a current identity more than 1,000 dates after a legacy daily anchor', () => {
    const base = session();
    const row = calendarItemOccurrence(base, '2026-11-19T08:00:00+07:00', []);
    expect(row).toMatchObject({
      occurrence_start: '2026-11-19T01:00:00.000Z',
      starts_at: '2026-11-19T01:00:00.000Z',
      ends_at: '2026-11-19T02:00:00.000Z',
    });
  });
  it('opens a far-future identity without a two-year browsing limit', () => {
    expect(
      calendarItemOccurrence(
        session({ recurrence_until: '2200-12-31' }),
        '2199-11-19T01:00:00Z',
        [],
      )?.occurrence_start,
    ).toBe('2199-11-19T01:00:00.000Z');
  });
  it('preserves original identity when its title and displayed time moved to another year', () => {
    const key = '2026-11-19T01:00:00.000Z';
    const moved = state(key, {
      id: 'immutable-state',
      title_override: 'Special work',
      override_starts_at: '2050-01-01T03:00:00.000Z',
      override_ends_at: '2050-01-01T04:00:00.000Z',
      not_needed_at: '2026-11-19T00:00:00.000Z',
    });
    expect(calendarItemOccurrence(session(), key, [moved])).toMatchObject({
      title: 'Special work',
      occurrence_start: key,
      starts_at: moved.override_starts_at,
      ends_at: moved.override_ends_at,
      not_needed_at: moved.not_needed_at,
    });
  });
  it('uses displayed states for materialized None, including original keys before the descriptor anchor', () => {
    const key = '2026-11-01T01:00:00.000Z';
    const base = session({
      starts_at: '2030-01-01T01:00:00.000Z',
      ends_at: '2030-01-01T02:00:00.000Z',
      recurrence: 'none',
      recurrence_until: null,
      occurrence_mode: true,
    });
    expect(
      calendarItemOccurrence(base, key, [
        state(key, {
          override_starts_at: '2031-05-01T03:00:00.000Z',
          override_ends_at: '2031-05-01T04:00:00.000Z',
        }),
      ]),
    ).toMatchObject({
      occurrence_start: key,
      starts_at: '2031-05-01T03:00:00.000Z',
    });
    expect(
      calendarItemOccurrence(base, '2026-11-02T01:00:00Z', [state(key)]),
    ).toBeNull();
  });
  it('resolves selected-date instances and rejects a nonselected date', () => {
    const base = session({
      recurrence: 'dates',
      recurrence_dates: ['2000-01-01', '2026-11-19'],
      recurrence_until: '2026-11-19',
    });
    expect(
      calendarItemOccurrence(base, '2026-11-19T01:00:00Z', [])
        ?.occurrence_start,
    ).toBe('2026-11-19T01:00:00.000Z');
    expect(calendarItemOccurrence(base, '2026-11-18T01:00:00Z', [])).toBeNull();
  });
  it('rejects invalid or removed original identities, even when an unrelated override exists', () => {
    const base = session({
      recurrence: 'weekly',
      recurrence_until: '2026-01-01',
    });
    expect(calendarItemOccurrence(base, 'not-a-date', [])).toBeNull();
    expect(calendarItemOccurrence(base, '2027-01-01T01:00:00Z', [])).toBeNull();
    expect(
      calendarItemOccurrence(base, '2000-01-02T01:00:00Z', [
        state('2000-01-02T01:00:00.000Z', {
          override_starts_at: '2025-01-01T01:00:00Z',
          override_ends_at: '2025-01-01T02:00:00Z',
        }),
      ]),
    ).toBeNull();
  });
  it('does not consume the iteration budget on a legacy event duration longer than 1,000 days', () => {
    const base = session({
      ends_at: new Date(
        Date.parse('2000-01-01T01:00:00Z') + 1500 * DAY,
      ).toISOString(),
    });
    const row = calendarItemOccurrence(base, '2026-11-19T01:00:00Z', []);
    expect(row?.starts_at).toBe('2026-11-19T01:00:00.000Z');
    expect(Date.parse(row!.ends_at) - Date.parse(row!.starts_at)).toBe(
      1500 * DAY,
    );
  });
});

describe('Calendar finite listing without silent truncation', () => {
  it('optionally bounds ordinary original identities without truncating long-duration events', () => {
    const base = session({
      starts_at: '2026-11-01T01:00:00.000Z',
      ends_at: new Date(
        Date.parse('2026-11-01T01:00:00Z') + 1500 * DAY,
      ).toISOString(),
      recurrence_until: '2200-12-31',
    });
    const before = new Date('2026-11-20T00:00:00+07:00');
    const rows = calendarItemOccurrences(
      [base],
      [],
      new Date('2026-11-19T00:00:00Z'),
      before,
    );
    expect(rows).toHaveLength(19);
    expect(rows.at(-1)?.occurrence_start).toBe('2026-11-19T01:00:00.000Z');
    expect(
      rows.every(
        (row) =>
          Date.parse(row.ends_at) - Date.parse(row.starts_at) === 1500 * DAY,
      ),
    ).toBe(true);
  });
  it('retains an original future identity moved before the optional boundary and excludes later moved-in overrides', () => {
    const base = session({
      starts_at: '2026-12-01T01:00:00.000Z',
      ends_at: '2026-12-01T02:00:00.000Z',
      recurrence_until: '2026-12-31',
    });
    const rows = calendarItemOccurrences(
      [base],
      [
        state('2026-12-02T01:00:00.000Z', {
          override_starts_at: '2026-11-19T03:00:00.000Z',
          override_ends_at: '2026-11-19T04:00:00.000Z',
        }),
        state('2026-12-03T01:00:00.000Z', {
          override_starts_at: '2026-11-20T03:00:00.000Z',
          override_ends_at: '2026-11-20T04:00:00.000Z',
        }),
      ],
      new Date('2026-11-19T00:00:00Z'),
      new Date('2026-11-20T00:00:00+07:00'),
    );
    expect(rows.map((row) => row.occurrence_start)).toEqual([
      '2026-12-02T01:00:00.000Z',
    ]);
  });
  it('rejects an invalid optional boundary without changing the three-argument API', () => {
    const base = session({ recurrence_until: '2000-01-03' });
    expect(
      calendarItemOccurrences([base], [], new Date('2026-11-19')),
    ).toHaveLength(3);
    expect(() =>
      calendarItemOccurrences(
        [base],
        [],
        new Date('2026-11-19'),
        new Date('invalid'),
      ),
    ).toThrow(/boundary/);
  });
  it('lists every identity in a decades-old finite daily series, including dates beyond the old two-year window', () => {
    const base = session();
    const rows = calendarItemOccurrences(
      [base],
      [],
      new Date('2026-11-19T00:00:00Z'),
    );
    const expected =
      Math.round(
        (Date.parse('2030-01-01T01:00:00Z') - Date.parse(base.starts_at)) / DAY,
      ) + 1;
    expect(rows).toHaveLength(expected);
    expect(
      rows.find((row) => row.occurrence_start === '2026-11-19T01:00:00.000Z'),
    ).toBeDefined();
    expect(rows.at(-1)?.occurrence_start).toBe('2030-01-01T01:00:00.000Z');
    expect(new Set(rows.map((row) => row.occurrence_id)).size).toBe(
      rows.length,
    );
  });
  it('retains moved-in and moved-out finite overrides once and preserves explicit reopened outcomes', () => {
    const base = session({
      completed_at: '2020-01-01T00:00:00.000Z',
      recurrence_until: '2005-01-01',
    });
    const key = '2004-01-01T01:00:00.000Z';
    const states = [
      state(key, {
        override_starts_at: '2050-01-01T01:00:00.000Z',
        override_ends_at: '2050-01-01T02:00:00.000Z',
        title_override: 'Future exception',
      }),
    ];
    const before = structuredClone({ base, states });
    const rows = calendarItemOccurrences([base], states);
    expect(rows.filter((row) => row.occurrence_start === key)).toHaveLength(1);
    expect(rows.find((row) => row.occurrence_start === key)).toMatchObject({
      title: 'Future exception',
      starts_at: '2050-01-01T01:00:00.000Z',
      completed_at: null,
    });
    expect({ base, states }).toEqual(before);
  });
  it.each(['weekly', 'monthly', 'custom'] as const)(
    'does not truncate a long finite %s series',
    (recurrence) => {
      const base = session({
        recurrence,
        recurrence_interval: recurrence === 'custom' ? 3 : 1,
        recurrence_until: '2200-12-31',
      });
      const rows = calendarItemOccurrences([base], []);
      expect(rows.length).toBeGreaterThan(1000);
      expect(
        rows.find((row) => row.occurrence_start.startsWith('2200-12-')),
      ).toBeDefined();
      expect(new Set(rows.map((row) => row.occurrence_id)).size).toBe(
        rows.length,
      );
    },
  );
  it('includes a far-future nonrepeating item and all materialized/selected instances', () => {
    const one = session({
      id: 'one',
      recurrence: 'none',
      recurrence_until: null,
      starts_at: '2199-01-01T01:00:00.000Z',
      ends_at: '2199-01-01T02:00:00.000Z',
    });
    const materialized = session({
      id: 'materialized',
      recurrence: 'none',
      occurrence_mode: true,
    });
    const selected = session({
      id: 'selected',
      recurrence: 'dates',
      recurrence_dates: ['2000-01-01', '2199-01-01'],
    });
    const rows = calendarItemOccurrences(
      [one, materialized, selected],
      [
        state('2001-01-01T01:00:00.000Z', {
          calendar_entry_id: 'materialized',
        }),
        state('2199-01-01T01:00:00.000Z', {
          calendar_entry_id: 'materialized',
        }),
      ],
    );
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.id === 'materialized')).toHaveLength(2);
  });
  it('bounds an unbounded Reminder at 730 future days while including an original future identity moved in', () => {
    const now = new Date('2026-11-19T00:00:00Z');
    const base = session({
      item_type: 'reminder',
      task_id: null,
      ends_at: '2000-01-01T01:15:00.000Z',
      recurrence_until: null,
    });
    const key = '2050-01-01T01:00:00.000Z';
    const rows = calendarItemOccurrences(
      [base],
      [
        state(key, {
          override_starts_at: '2026-11-19T03:00:00.000Z',
          override_ends_at: '2026-11-19T03:15:00.000Z',
        }),
      ],
      now,
    );
    expect(rows.find((row) => row.occurrence_start === key)?.starts_at).toBe(
      '2026-11-19T03:00:00.000Z',
    );
    expect(
      rows.filter(
        (row) => row.starts_at >= new Date(+now + 730 * DAY).toISOString(),
      ),
    ).toHaveLength(0);
  });
  it('restores original long event duration in every returned row', () => {
    const base = session({
      ends_at: new Date(
        Date.parse('2000-01-01T01:00:00Z') + 1500 * DAY,
      ).toISOString(),
      recurrence_until: '2005-01-01',
    });
    const rows = calendarItemOccurrences([base], []);
    expect(rows.length).toBeGreaterThan(1000);
    expect(
      rows.every(
        (row) =>
          Date.parse(row.ends_at) - Date.parse(row.starts_at) === 1500 * DAY,
      ),
    ).toBe(true);
  });
  it('does not show an unbounded Reminder moved beyond the explicit browsing horizon', () => {
    const base = session({
      item_type: 'reminder',
      task_id: null,
      ends_at: '2000-01-01T01:15:00.000Z',
      recurrence_until: null,
    });
    const key = '2001-01-01T01:00:00.000Z';
    const rows = calendarItemOccurrences(
      [base],
      [
        state(key, {
          override_starts_at: '2050-01-01T01:00:00.000Z',
          override_ends_at: '2050-01-01T01:15:00.000Z',
        }),
      ],
      new Date('2026-11-19T00:00:00Z'),
    );
    expect(rows.find((row) => row.occurrence_start === key)).toBeUndefined();
  });
  it('bounds a malformed far-future horizon to the supported calendar years', () => {
    const rows = calendarItemOccurrences(
      [session({ recurrence_until: '2400-12-31' })],
      [],
    );
    expect(rows.length).toBeLessThanOrEqual(201 * 366);
    expect(rows.at(-1)?.occurrence_start.startsWith('2200-12-31')).toBe(true);
    expect(rows.some((row) => row.occurrence_start >= '2201')).toBe(false);
  });
});

describe('Shared Calendar editor preserves series-wide pin settings', () => {
  it.each(['series', 'future'] as const)(
    'retains a pinned materialized series during %s title edits',
    (scope) => {
      const db = new LocalDatabase(':memory:');
      try {
        const task = db.createTask({
          title: 'Task',
          priority: 'medium',
          workflow_status_id: 'local-status-planned',
        });
        const id = db.createCalendarSession({
          ...session({
            starts_at: '2035-01-01T01:00:00.000Z',
            ends_at: '2035-01-01T02:00:00.000Z',
            recurrence_until: '2035-01-03',
          }),
          task_id: task,
        });
        const base = () =>
          (
            db.getCalendarWorkspace() as unknown as CalendarWorkspace
          ).sessions.find((row) => row.id === id)!;
        db.reviseCalendarSeries(
          id,
          { ...base(), title: 'Materialized' },
          'series',
          null,
          base(),
        );
        const before = base();
        const draft = calendarItemDraft(before);
        const input = calendarItemInput(
          { ...draft, title: 'Renamed through shared editor' },
          'checklist',
        );
        expect(input.is_pinned).toBe(true);
        expect(input.notification_offsets).toEqual([0, 15]);
        if (scope === 'future')
          db.reviseCalendarSeries(
            id,
            input,
            'future',
            '2035-01-02T01:00:00.000Z',
            before,
          );
        else db.updateCalendarSession(id, input, before);
        expect(base().is_pinned).toBe(true);
        expect(base().title).toBe('Renamed through shared editor');
      } finally {
        db.close();
      }
    },
  );
  it('retains an unpinned record and normalizes Reminder duration without changing its pin', () => {
    const draft = calendarItemDraft(
      session({
        item_type: 'reminder',
        task_id: null,
        recurrence: 'none',
        is_pinned: false,
      }),
    );
    const input = calendarItemInput(
      { ...draft, title: 'Renamed Reminder' },
      'reminder',
    );
    expect(input.is_pinned).toBe(false);
    expect(Date.parse(input.ends_at) - Date.parse(input.starts_at)).toBe(
      15 * 60_000,
    );
  });
});
