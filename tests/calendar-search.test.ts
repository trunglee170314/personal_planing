import { describe, expect, it } from 'vitest';
import {
  calendarSearchItems,
  isOccurrenceSeries,
} from '../lib/calendar-search';
import type {
  CalendarSession,
  CalendarOccurrenceState,
} from '../lib/data/repository';
import {
  matchesPlanningSearch,
  planningContext,
} from '../lib/planning-context';

const session: CalendarSession = {
  id: 'series',
  task_id: 'linux',
  title: 'Read chapter',
  starts_at: '2026-11-01T01:00:00.000Z',
  ends_at: '2026-11-01T02:00:00.000Z',
  all_day: false,
  timezone: 'Asia/Ho_Chi_Minh',
  recurrence: 'none',
  recurrence_until: null,
  recurrence_interval: 1,
  item_type: 'checklist',
  completed_at: null,
  not_needed_at: null,
  notification_offsets: [],
  is_pinned: false,
};
const states: CalendarOccurrenceState[] = [
  {
    id: 'instance-a',
    calendar_entry_id: 'series',
    occurrence_start: '2026-11-01T01:00:00.000Z',
    title_override: 'Finished introduction',
    completed_at: '2026-11-01T02:00:00.000Z',
    not_needed_at: null,
    override_starts_at: '2026-11-03T03:00:00.000Z',
    override_ends_at: '2026-11-03T04:00:00.000Z',
  },
  {
    id: 'instance-b',
    calendar_entry_id: 'series',
    occurrence_start: '2026-11-02T01:00:00.000Z',
    completed_at: null,
    not_needed_at: null,
  },
];

describe('materialized occurrence routing and search', () => {
  it('uses occurrence controls even when a materialized series requests Does not repeat', () => {
    expect(isOccurrenceSeries(session)).toBe(false);
    expect(isOccurrenceSeries({ ...session, occurrence_mode: true })).toBe(
      true,
    );
    expect(isOccurrenceSeries({ ...session, recurrence: 'daily' })).toBe(true);
    expect(isOccurrenceSeries({ ...session, recurrence: 'dates' })).toBe(true);
  });
  it('projects only actual materialized states, retaining original edit identities and independent outcomes', () => {
    const rows = calendarSearchItems({
      sessions: [{ ...session, occurrence_mode: true }],
      occurrence_states: states,
    });
    expect(rows.map((row) => row.search_id)).toEqual([
      'instance-a',
      'instance-b',
    ]);
    expect(rows.map((row) => row.title)).toEqual([
      'Finished introduction',
      'Read chapter',
    ]);
    expect(rows[0]).toMatchObject({
      id: 'series',
      occurrence_start: '2026-11-01T01:00:00.000Z',
      starts_at: '2026-11-03T03:00:00.000Z',
      completed_at: '2026-11-01T02:00:00.000Z',
    });
    expect(rows[1].ends_at).toBe('2026-11-02T02:00:00.000Z');
    expect(rows[1].completed_at).toBeNull();
    expect(
      calendarSearchItems({
        sessions: [{ ...session, occurrence_mode: true }],
        occurrence_states: [],
      }),
    ).toEqual([]);
  });
  it('keeps regular series search compact while exposing renamed occurrence exceptions', () => {
    const rows = calendarSearchItems({
      sessions: [
        { ...session, recurrence: 'daily', recurrence_until: '2026-11-03' },
      ],
      occurrence_states: states,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].search_id).toBe('series');
    expect(rows[0].occurrence_start).toBeUndefined();
    expect(rows[1].search_id).toBe('instance-a');
    expect(rows[1].title).toBe('Finished introduction');
    expect(session.title).toBe('Read chapter');
  });
  it('includes inherited Goal and Task when searching a renamed occurrence and excludes foreign entries', () => {
    const workspace = {
      sessions: [{ ...session, occurrence_mode: true }],
      occurrence_states: [
        ...states,
        { ...states[0], id: 'other-instance', calendar_entry_id: 'other' },
      ],
      goals: [{ id: 'career', title: 'Career' }],
      tasks: [{ id: 'linux', title: 'Learn Linux' }],
      links: [{ task_id: 'linux', goal_id: 'career' }],
    };
    const rows = calendarSearchItems(workspace);
    expect(rows).toHaveLength(2);
    expect(
      rows
        .filter((row) =>
          matchesPlanningSearch(
            'goal:caree introduction',
            planningContext(workspace, row.task_id),
            row.title,
          ),
        )
        .map((row) => row.search_id),
    ).toEqual(['instance-a']);
    expect(
      rows.filter((row) =>
        matchesPlanningSearch(
          'task:linux',
          planningContext(workspace, row.task_id),
          row.title,
        ),
      ),
    ).toHaveLength(2);
  });
});
