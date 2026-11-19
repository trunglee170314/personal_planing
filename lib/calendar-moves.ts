import type { PlanningRepository } from './data/repository';
import { readSettledPlanning } from './undo-manager';
import { dateKey } from './calendar';

export function embeddedCalendarAnchor(
  current: Date,
  previousToday: string,
  nextToday: string,
) {
  if (previousToday === nextToday) return current;
  return dateKey(current) === previousToday
    ? new Date(`${nextToday}T12:00:00`)
    : current;
}

export type CalendarSeriesMove = {
  id: string;
  originalStart: string;
  originalEnd: string;
  nextStart: string;
  nextEnd: string;
};

export function hasFiniteCalendarSeries(session: {
  occurrence_mode?: boolean;
  recurrence_until: string | null;
}) {
  return Boolean(session.occurrence_mode || session.recurrence_until);
}

export class CalendarMoveReadError extends Error {
  constructor(cause: unknown) {
    super(
      'The calendar move was saved, but the updated calendar could not be loaded. Refresh to see the saved schedule.',
      { cause },
    );
    this.name = 'CalendarMoveReadError';
  }
}

/** A series move changes membership, original keys, exceptions and its horizon.
 * Read the canonical workspace instead of applying a base-session-only patch. */
export async function moveCalendarSeriesAndRead(
  repository: Pick<
    PlanningRepository,
    'moveCalendarSeries' | 'getCalendarWorkspace'
  >,
  move: CalendarSeriesMove,
  runMutation: (action: () => Promise<void>) => Promise<void> = (action) =>
    action(),
) {
  await runMutation(() =>
    repository.moveCalendarSeries(
      move.id,
      move.originalStart,
      move.originalEnd,
      move.nextStart,
      move.nextEnd,
    ),
  );
  return readMovedCalendar(repository);
}

export async function moveCalendarOccurrencesAndRead(
  repository: Pick<
    PlanningRepository,
    'moveCalendarOccurrences' | 'getCalendarWorkspace'
  >,
  id: string,
  changes: Parameters<PlanningRepository['moveCalendarOccurrences']>[1],
  runMutation: (action: () => Promise<void>) => Promise<void> = (action) =>
    action(),
) {
  await runMutation(() => repository.moveCalendarOccurrences(id, changes));
  return readMovedCalendar(repository);
}

async function readMovedCalendar(
  repository: Pick<PlanningRepository, 'getCalendarWorkspace'>,
) {
  try {
    return await readSettledPlanning(() => repository.getCalendarWorkspace());
  } catch (cause) {
    throw new CalendarMoveReadError(cause);
  }
}
