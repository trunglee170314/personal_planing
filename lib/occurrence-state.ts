import type { CalendarOccurrenceState } from './data/repository';

export const sameOccurrenceTime = (
  a: string | undefined,
  b: string | undefined,
) => Boolean(a && b) && new Date(a!).getTime() === new Date(b!).getTime();

// Patches must preserve other fields: completing a moved occurrence must not
// drop its schedule override (and moving it must not drop completion history).
export function patchOccurrence(
  states: CalendarOccurrenceState[],
  calendarEntryId: string,
  occurrenceStart: string,
  changes: Partial<CalendarOccurrenceState>,
): CalendarOccurrenceState[] {
  const index = states.findIndex(
    (state) =>
      state.calendar_entry_id === calendarEntryId &&
      sameOccurrenceTime(state.occurrence_start, occurrenceStart),
  );
  const matches = states.filter(
    (state) =>
      state.calendar_entry_id === calendarEntryId &&
      sameOccurrenceTime(state.occurrence_start, occurrenceStart),
  );
  const next = {
    completed_at: null,
    not_needed_at: null,
    ...Object.assign({}, ...matches),
    ...changes,
    calendar_entry_id: calendarEntryId,
    occurrence_start: new Date(occurrenceStart).toISOString(),
  };
  if (index < 0) return [...states, next];
  return states.flatMap((state, position) =>
    position === index
      ? [next]
      : state.calendar_entry_id === calendarEntryId &&
          sameOccurrenceTime(state.occurrence_start, occurrenceStart)
        ? []
        : [state],
  );
}
