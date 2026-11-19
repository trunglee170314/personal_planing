import {
  expandRecurringSessions,
  toLocalInput,
  vietnamInputToIso,
  type RecurrenceRule,
} from './calendar';
import { normalizeDateSchedule } from './selected-dates.mjs';
import type {
  CalendarItemType,
  CalendarOccurrenceState,
  CalendarSession,
  CalendarSessionInput,
} from './data/repository';

export type CalendarItemOccurrence = CalendarSession & {
  occurrence_id: string;
  occurrence_start: string;
};
export type CalendarItemDraft = {
  id?: string;
  original?: CalendarSession;
  edit_scope?: 'future';
  edit_from?: string;
  title: string;
  task_id: string;
  starts_at: string;
  ends_at: string;
  recurrence: RecurrenceRule;
  recurrence_until: string;
  recurrence_interval: number;
  recurrence_dates: string[];
  notification_offsets: number[];
  completed_at: string | null;
  not_needed_at: string | null;
  is_pinned: boolean;
};

const DAY = 86_400_000;
const MIN_TIME = Date.parse('1999-12-31T17:00:00Z');
const MAX_TIME = Date.parse('2200-12-31T17:00:00Z');

function effectiveOccurrence(
  session: CalendarSession,
  row: CalendarItemOccurrence,
  state?: CalendarOccurrenceState,
): CalendarItemOccurrence {
  const duration = Date.parse(session.ends_at) - Date.parse(session.starts_at);
  return {
    ...row,
    ...(state?.title_override ? { title: state.title_override } : {}),
    starts_at: state?.override_starts_at ?? row.occurrence_start,
    ends_at:
      state?.override_ends_at ??
      new Date(Date.parse(row.occurrence_start) + duration).toISOString(),
    completed_at: state ? state.completed_at : session.completed_at,
    not_needed_at: state ? state.not_needed_at : session.not_needed_at,
  };
}

/** Resolve one original identity, even when it is far from the series anchor or
 * its displayed override has moved into a completely different year. */
export function calendarItemOccurrence(
  session: CalendarSession,
  occurrenceStart: string,
  states: CalendarOccurrenceState[],
): CalendarItemOccurrence | null {
  const keyTime = Date.parse(occurrenceStart);
  if (!Number.isFinite(keyTime)) return null;
  const key = new Date(keyTime).toISOString();
  const ownStates = states.filter(
    (state) => state.calendar_entry_id === session.id,
  );
  const state = ownStates.find(
    (row) => Date.parse(row.occurrence_start) === keyTime,
  );
  const start = Date.parse(state?.override_starts_at ?? key);
  const duration = Date.parse(session.ends_at) - Date.parse(session.starts_at);
  if (!session.occurrence_mode && session.recurrence !== 'dates') {
    const baseStart = Date.parse(session.starts_at);
    if (
      !Number.isFinite(baseStart) ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      return null;
    const row = expandRecurringSessions(
      [{ ...session, ends_at: new Date(baseStart + 1).toISOString() }],
      new Date(keyTime),
      new Date(keyTime + 1),
    ).find((item) => item.occurrence_start === key);
    return row ? effectiveOccurrence(session, row, state) : null;
  }
  const end = state?.override_ends_at
    ? Date.parse(state.override_ends_at)
    : start + duration;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return null;
  return (
    expandRecurringSessions(
      [session],
      new Date(start),
      new Date(end),
      ownStates,
    ).find((item) => item.occurrence_start === key) ?? null
  );
}

/** All finite schedules are listed completely. Only an unbounded Reminder uses
 * the existing two-year future browsing horizon. Enumerate short identity
 * windows so the calendar viewport's 1,000-iteration guard never truncates an
 * old daily series, even if a legacy event itself has a very long duration. */
export function calendarItemOccurrences(
  sessions: CalendarSession[],
  states: CalendarOccurrenceState[],
  now = new Date(),
  before?: Date,
): CalendarItemOccurrence[] {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('Invalid calendar reference date.');
  const beforeTime = before?.getTime();
  if (beforeTime !== undefined && !Number.isFinite(beforeTime))
    throw new RangeError('Invalid calendar projection boundary.');
  const byEntry = new Map<string, CalendarOccurrenceState[]>();
  for (const state of states) {
    const rows = byEntry.get(state.calendar_entry_id) ?? [];
    rows.push(state);
    byEntry.set(state.calendar_entry_id, rows);
  }
  const result = new Map<string, CalendarItemOccurrence>();
  for (const session of sessions) {
    const ownStates = byEntry.get(session.id) ?? [];
    if (
      session.recurrence === 'dates' ||
      session.occurrence_mode ||
      session.recurrence === 'none'
    ) {
      for (const row of expandRecurringSessions(
        [session],
        new Date(MIN_TIME),
        new Date(MAX_TIME),
        ownStates,
      ))
        result.set(row.occurrence_id, row);
      continue;
    }
    const baseStart = Date.parse(session.starts_at);
    const duration = Date.parse(session.ends_at) - baseStart;
    if (
      !Number.isFinite(baseStart) ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      continue;
    const until = session.recurrence_until
      ? Date.parse(`${session.recurrence_until}T23:59:59.999+07:00`) + 1
      : now.getTime() + 730 * DAY;
    if (!Number.isFinite(until)) continue;
    const end = Math.min(MAX_TIME, until, beforeTime ?? MAX_TIME);
    const stateByKey = new Map(
      ownStates.map((row) => [
        new Date(row.occurrence_start).toISOString(),
        row,
      ]),
    );
    // Use a 1ms enumeration duration only to obtain original identities. Restore
    // the real duration below; no temporary duration reaches the returned data.
    const identitySession = {
      ...session,
      ends_at: new Date(baseStart + 1).toISOString(),
    };
    for (
      let start = Math.max(MIN_TIME, baseStart);
      start < end;
      start += 366 * DAY
    ) {
      for (const row of expandRecurringSessions(
        [identitySession],
        new Date(start),
        new Date(Math.min(end, start + 366 * DAY)),
      )) {
        const state = stateByKey.get(row.occurrence_start);
        const effective = effectiveOccurrence(session, row, state);
        if (!session.recurrence_until && Date.parse(effective.starts_at) >= end)
          continue;
        result.set(row.occurrence_id, effective);
      }
    }
    // An unbounded series can have a future original identity moved into the
    // current browsing horizon. Retain that exception without expanding infinity.
    for (const state of ownStates) {
      if (!state.override_starts_at || !state.override_ends_at) continue;
      const shown = Date.parse(state.override_starts_at);
      if (beforeTime !== undefined && shown >= beforeTime) continue;
      if (!session.recurrence_until && shown >= end) continue;
      const id = `${session.id}:${new Date(state.occurrence_start).toISOString()}`;
      if (result.has(id)) continue;
      const row = calendarItemOccurrence(
        session,
        state.occurrence_start,
        ownStates,
      );
      if (row) result.set(row.occurrence_id, row);
    }
  }
  return [...result.values()];
}

/** Shared editor round-trip fields, including series-wide pin settings. */
export function calendarItemDraft(base: CalendarSession): CalendarItemDraft {
  return {
    id: base.id,
    original: base,
    title: base.title,
    task_id: base.task_id ?? '',
    starts_at: toLocalInput(base.starts_at),
    ends_at: toLocalInput(base.ends_at),
    recurrence: base.recurrence,
    recurrence_until: base.recurrence_until ?? '',
    recurrence_interval: base.recurrence_interval || 1,
    recurrence_dates: base.recurrence_dates ?? [],
    notification_offsets: base.notification_offsets ?? [15],
    completed_at: base.completed_at,
    not_needed_at: base.not_needed_at,
    is_pinned: Boolean(base.is_pinned),
  };
}

export function calendarItemInput(
  draft: CalendarItemDraft,
  type: CalendarItemType,
): CalendarSessionInput {
  const start = vietnamInputToIso(draft.starts_at);
  return normalizeDateSchedule({
    title: draft.title.trim(),
    task_id: type === 'checklist' ? draft.task_id : null,
    starts_at: start,
    ends_at:
      type === 'reminder'
        ? new Date(Date.parse(start) + 15 * 60_000).toISOString()
        : vietnamInputToIso(draft.ends_at),
    all_day: false,
    timezone: 'Asia/Ho_Chi_Minh',
    recurrence: draft.recurrence,
    recurrence_until: draft.recurrence_until || null,
    recurrence_interval: draft.recurrence_interval,
    recurrence_dates:
      draft.recurrence === 'dates' ? draft.recurrence_dates : undefined,
    item_type: type,
    completed_at: draft.completed_at,
    not_needed_at: draft.not_needed_at,
    notification_offsets: draft.notification_offsets,
    is_pinned: draft.is_pinned,
  });
}
