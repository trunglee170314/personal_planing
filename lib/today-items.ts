import { vietnamDateKey, vietnamInputToIso } from './calendar';
import { calendarItemOccurrences } from './calendar-items';
import type { TodayWorkspace } from './data/repository';

/** Use the shared identity projection so old schedules, long legacy durations
 * and moved-in exceptions all remain reachable without the viewport safety cap. */
export function todayOutstanding(
  workspace: Pick<TodayWorkspace, 'sessions' | 'occurrence_states'>,
  today: Date,
) {
  const todayKey = vietnamDateKey(today);
  const tomorrow = new Date(
    Date.parse(vietnamInputToIso(todayKey + 'T00:00')) + 86_400_000,
  );
  return calendarItemOccurrences(
    workspace.sessions,
    workspace.occurrence_states,
    today,
    tomorrow,
  )
    .filter(
      (item) =>
        !item.completed_at &&
        !item.not_needed_at &&
        vietnamDateKey(item.starts_at) <= todayKey,
    )
    .sort(
      (a, b) =>
        Number(b.is_pinned) - Number(a.is_pinned) ||
        Date.parse(a.starts_at) - Date.parse(b.starts_at) ||
        a.occurrence_id.localeCompare(b.occurrence_id),
    );
}
