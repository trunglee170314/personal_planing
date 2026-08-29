import type {
  CalendarSession,
  CalendarWorkspace,
  CalendarOccurrenceState,
} from './data/repository';

export function isOccurrenceSeries(
  session: Pick<CalendarSession, 'recurrence' | 'occurrence_mode'>,
) {
  return Boolean(session.occurrence_mode) || session.recurrence !== 'none';
}

export type CalendarSearchItem = CalendarSession & {
  search_id: string;
  occurrence_start?: string;
};

/** Materialized instances and explicitly renamed occurrences must be searchable
 * by their displayed title, retaining the original key used to open the editor. */
export function calendarSearchItems(
  workspace: Pick<CalendarWorkspace, 'sessions' | 'occurrence_states'>,
): CalendarSearchItem[] {
  const statesByEntry = new Map<string, CalendarOccurrenceState[]>();
  for (const state of workspace.occurrence_states) {
    const rows = statesByEntry.get(state.calendar_entry_id) ?? [];
    rows.push(state);
    statesByEntry.set(state.calendar_entry_id, rows);
  }
  return workspace.sessions.flatMap((session) => {
    const rows: CalendarSearchItem[] = session.occurrence_mode
      ? []
      : [{ ...session, search_id: session.id }];
    const duration =
      Date.parse(session.ends_at) - Date.parse(session.starts_at);
    for (const state of statesByEntry.get(session.id) ?? []) {
      if (
        state.calendar_entry_id !== session.id ||
        (!session.occurrence_mode && !state.title_override)
      )
        continue;
      const original = new Date(state.occurrence_start).toISOString();
      const start = state.override_starts_at ?? original;
      rows.push({
        ...session,
        title: state.title_override ?? session.title,
        starts_at: start,
        ends_at:
          state.override_ends_at ??
          new Date(Date.parse(start) + duration).toISOString(),
        completed_at: state.completed_at,
        not_needed_at: state.not_needed_at,
        search_id: state.id ?? `${session.id}:${original}`,
        occurrence_start: original,
      });
    }
    return rows;
  });
}
