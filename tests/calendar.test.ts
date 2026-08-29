import { describe, expect, it } from 'vitest';
import {
  expandRecurringSessions,
  nearestRecurringOccurrence,
  recurringSeriesFrom,
  startOfMondayWeek,
  toLocalInput,
  vietnamDateKey,
  vietnamInputToIso,
} from '../lib/calendar';

describe('calendar planning helpers', () => {
  it('includes the selected occurrence and every future recurrence identity even when overrides moved outside the viewport', () => {
    const session = {
      id: 'daily',
      starts_at: '2026-09-01T01:00:00.000Z',
      ends_at: '2026-09-01T02:00:00.000Z',
      recurrence: 'daily' as const,
      recurrence_until: '2026-09-03',
      recurrence_interval: 1,
      completed_at: null as string | null,
      not_needed_at: null as string | null,
    };
    const states = [
      {
        calendar_entry_id: 'daily',
        occurrence_start: '2026-09-02T01:00:00.000Z',
        completed_at: '2026-09-02T02:00:00.000Z',
        not_needed_at: null,
        override_starts_at: '2026-08-20T01:00:00.000Z',
        override_ends_at: '2026-08-20T02:00:00.000Z',
      },
      {
        calendar_entry_id: 'daily',
        occurrence_start: '2026-09-03T01:00:00.000Z',
        completed_at: null,
        not_needed_at: '2026-09-03T02:00:00.000Z',
        override_starts_at: '2026-10-20T01:00:00.000Z',
        override_ends_at: '2026-10-20T02:00:00.000Z',
      },
    ];
    const selected = {
      ...session,
      ...states[0],
      occurrence_id: 'daily:selected',
      occurrence_start: states[0].occurrence_start,
      starts_at: states[0].override_starts_at,
      ends_at: states[0].override_ends_at,
    };
    const result = recurringSeriesFrom(session, selected, states);
    expect(result.map((item) => item.occurrence_start)).toEqual([
      '2026-09-02T01:00:00.000Z',
      '2026-09-03T01:00:00.000Z',
    ]);
    expect(
      result.map((item) => [
        Boolean(item.completed_at),
        Boolean(item.not_needed_at),
      ]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
  });
  it('fast-forwards a long-running series without dropping future occurrences', () => {
    const session = {
      id: 'long-running',
      starts_at: '2020-01-01T01:00:00.000Z',
      ends_at: '2020-01-01T02:00:00.000Z',
      recurrence: 'daily' as const,
      recurrence_until: '2026-09-08',
      recurrence_interval: 1,
      completed_at: null as string | null,
      not_needed_at: null as string | null,
    };
    const selected = {
      ...session,
      starts_at: '2026-09-06T01:00:00.000Z',
      ends_at: '2026-09-06T02:00:00.000Z',
      occurrence_start: '2026-09-06T01:00:00.000Z',
      occurrence_id: 'long-running:selected',
    };
    expect(
      recurringSeriesFrom(session, selected, []).map(
        (item) => item.occurrence_start,
      ),
    ).toEqual([
      '2026-09-06T01:00:00.000Z',
      '2026-09-07T01:00:00.000Z',
      '2026-09-08T01:00:00.000Z',
    ]);
  });
  it('selects the nearest occurrence when a checklist starts years in the future', () => {
    const occurrence = nearestRecurringOccurrence(
      {
        id: 'future',
        starts_at: '2028-09-06T01:00:00.000Z',
        ends_at: '2028-09-06T02:00:00.000Z',
        recurrence: 'daily' as const,
        recurrence_until: '2028-09-08',
      },
      new Date('2026-09-06T00:00:00.000Z'),
    );
    expect(occurrence?.occurrence_start).toBe('2028-09-06T01:00:00.000Z');
  });
  it('starts weeks on Monday', () => {
    expect(startOfMondayWeek(new Date('2026-08-30T10:00:00')).getDay()).toBe(1);
  });

  it('expands weekly sessions only inside the requested range', () => {
    const sessions = expandRecurringSessions(
      [
        {
          id: 'one',
          starts_at: '2026-08-03T02:00:00.000Z',
          ends_at: '2026-08-03T03:00:00.000Z',
          recurrence: 'weekly' as const,
          recurrence_until: '2026-08-31',
        },
      ],
      new Date('2026-08-10T00:00:00.000Z'),
      new Date('2026-08-25T00:00:00.000Z'),
    );
    expect(sessions).toHaveLength(3);
  });

  it('stores and displays calendar input in Vietnam time', () => {
    const iso = vietnamInputToIso('2026-09-01T08:30');
    expect(iso).toBe('2026-09-01T01:30:00.000Z');
    expect(toLocalInput(iso)).toBe('2026-09-01T08:30');
    expect(vietnamDateKey(iso)).toBe('2026-09-01');
  });

  it('applies completion only to the matching recurring occurrence', () => {
    const sessions = expandRecurringSessions(
      [
        {
          id: 'daily',
          starts_at: '2026-09-01T01:00:00.000Z',
          ends_at: '2026-09-01T01:30:00.000Z',
          recurrence: 'daily' as const,
          recurrence_until: '2026-09-03',
          completed_at: null,
          not_needed_at: null,
        },
      ],
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-04T00:00:00.000Z'),
      [
        {
          calendar_entry_id: 'daily',
          occurrence_start: '2026-09-02T01:00:00.000Z',
          completed_at: '2026-09-02T01:05:00.000Z',
          not_needed_at: null,
        },
      ],
    );
    expect(sessions.map((item) => Boolean(item.completed_at))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('applies a dragged time override without changing the recurrence key', () => {
    const [occurrence] = expandRecurringSessions(
      [
        {
          id: 'daily',
          starts_at: '2026-09-01T01:00:00.000Z',
          ends_at: '2026-09-01T02:00:00.000Z',
          recurrence: 'daily' as const,
          recurrence_until: '2026-09-01',
        },
      ],
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-02T00:00:00.000Z'),
      [
        {
          calendar_entry_id: 'daily',
          occurrence_start: '2026-09-01T01:00:00.000Z',
          completed_at: null,
          not_needed_at: null,
          override_starts_at: '2026-09-01T03:00:00.000Z',
          override_ends_at: '2026-09-01T04:00:00.000Z',
        },
      ],
    );
    expect(occurrence).toMatchObject({
      occurrence_start: '2026-09-01T01:00:00.000Z',
      starts_at: '2026-09-01T03:00:00.000Z',
      ends_at: '2026-09-01T04:00:00.000Z',
    });
  });

  it('anchors month-end recurrence consistently in Vietnam time', () => {
    const sessions = expandRecurringSessions(
      [
        {
          id: 'month-end',
          starts_at: '2026-01-31T01:00:00.000Z',
          ends_at: '2026-01-31T01:30:00.000Z',
          recurrence: 'monthly' as const,
          recurrence_until: '2026-04-30',
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-05-01T00:00:00.000Z'),
    );
    expect(sessions.map((item) => toLocalInput(item.starts_at))).toEqual([
      '2026-01-31T08:00',
      '2026-02-28T08:00',
      '2026-03-31T08:00',
      '2026-04-30T08:00',
    ]);
  });

  it('rejects malformed Vietnam calendar input', () => {
    expect(() => vietnamInputToIso('not-a-date')).toThrow(/valid Vietnam/i);
  });
});
