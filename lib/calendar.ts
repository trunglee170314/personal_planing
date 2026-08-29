export const CALENDAR_START_HOUR = 0;
export const CALENDAR_END_HOUR = 24;
export const CALENDAR_SNAP_MINUTES = 15;
export const VIETNAM_TIMEZONE = 'Asia/Ho_Chi_Minh';

export type RecurrenceRule = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom';

export function startOfMondayWeek(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return date;
}

export function addDays(value: Date, amount: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

export function addVietnamMonths(value: Date, amount: number) {
  const local = new Date(value.getTime() + 7 * 3_600_000);
  const targetFirst = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + amount, 1),
  );
  const daysInTarget = new Date(
    Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const target = new Date(
    Date.UTC(
      targetFirst.getUTCFullYear(),
      targetFirst.getUTCMonth(),
      Math.min(local.getUTCDate(), daysInTarget),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ),
  );
  return new Date(target.getTime() - 7 * 3_600_000);
}

export function dateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function toLocalInput(value: Date | string) {
  const date = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIETNAM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export function vietnamInputToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('Choose a valid Vietnam date and time.');
  const date = new Date(`${value}:00+07:00`);
  if (Number.isNaN(date.getTime()))
    throw new Error('Choose a valid Vietnam date and time.');
  return date.toISOString();
}

export function vietnamDateKey(value: Date | string) {
  return toLocalInput(value).slice(0, 10);
}

export function snapDate(value: Date, minutes = CALENDAR_SNAP_MINUTES) {
  const date = new Date(value);
  date.setSeconds(0, 0);
  date.setMinutes(Math.round(date.getMinutes() / minutes) * minutes);
  return date;
}

export function minutesFromCalendarStart(value: Date) {
  const input = toLocalInput(value);
  const [hours, minutes] = input.slice(11).split(':').map(Number);
  return hours * 60 + minutes - CALENDAR_START_HOUR * 60;
}

export type RepeatingSession = {
  id: string;
  starts_at: string;
  ends_at: string;
  recurrence: RecurrenceRule;
  recurrence_until: string | null;
  recurrence_interval?: number;
};

export function expandRecurringSessions<T extends RepeatingSession>(
  sessions: T[],
  rangeStart: Date,
  rangeEnd: Date,
  occurrenceStates: {
    calendar_entry_id: string;
    occurrence_start: string;
    completed_at: string | null;
    not_needed_at: string | null;
    override_starts_at?: string | null;
    override_ends_at?: string | null;
  }[] = [],
): (T & { occurrence_id: string; occurrence_start: string })[] {
  const result: (T & {
    occurrence_id: string;
    occurrence_start: string;
  })[] = [];
  const stateMap = new Map(
    occurrenceStates.map((state) => [
      `${state.calendar_entry_id}:${new Date(state.occurrence_start).toISOString()}`,
      state,
    ]),
  );
  for (const session of sessions) {
    const originalStart = new Date(session.starts_at);
    const duration =
      new Date(session.ends_at).getTime() - originalStart.getTime();
    const until = session.recurrence_until
      ? new Date(`${session.recurrence_until}T23:59:59+07:00`).getTime()
      : Number.POSITIVE_INFINITY;
    let occurrence = new Date(originalStart);
    const dayStep =
      session.recurrence === 'daily'
        ? 1
        : session.recurrence === 'weekly'
          ? 7
          : session.recurrence === 'custom'
            ? Math.max(1, session.recurrence_interval ?? 1)
            : 0;
    if (dayStep && occurrence.getTime() + duration < rangeStart.getTime()) {
      const steps = Math.max(
        0,
        Math.floor(
          (rangeStart.getTime() - occurrence.getTime() - duration) /
            (dayStep * 86_400_000),
        ),
      );
      occurrence = new Date(
        occurrence.getTime() + steps * dayStep * 86_400_000,
      );
    }
    let safety = 0;
    while (
      occurrence < rangeEnd &&
      occurrence.getTime() <= until &&
      safety < 1000
    ) {
      const occurrenceEnd = new Date(occurrence.getTime() + duration);
      if (occurrenceEnd > rangeStart) {
        const occurrenceStart = occurrence.toISOString();
        const state = stateMap.get(`${session.id}:${occurrenceStart}`);
        const shownStart = state?.override_starts_at ?? occurrenceStart;
        const shownEnd = state?.override_ends_at ?? occurrenceEnd.toISOString();
        if (new Date(shownEnd) > rangeStart && new Date(shownStart) < rangeEnd) result.push({
          ...session,
          ...(state
            ? {
                completed_at: state.completed_at,
                not_needed_at: state.not_needed_at,
              }
            : {}),
          starts_at: shownStart,
          ends_at: shownEnd,
          occurrence_id: `${session.id}:${occurrenceStart}`,
          occurrence_start: occurrenceStart,
        });
      }
      if (session.recurrence === 'none') break;
      if (session.recurrence === 'daily') occurrence = addDays(occurrence, 1);
      if (session.recurrence === 'weekly') occurrence = addDays(occurrence, 7);
      if (session.recurrence === 'monthly')
        occurrence = addVietnamMonths(originalStart, safety + 1);
      if (session.recurrence === 'custom')
        occurrence = addDays(
          occurrence,
          Math.max(1, session.recurrence_interval ?? 1),
        );
      safety += 1;
    }
    // Overrides can move INTO this viewport from an original date outside it.
    // Preserve the original identity used for completion, not the display date.
    if (session.recurrence !== 'none') {
      const seen = new Set(result.filter((item) => item.id === session.id).map((item) => item.occurrence_id));
      for (const state of occurrenceStates) {
        if (state.calendar_entry_id !== session.id || !state.override_starts_at || !state.override_ends_at) continue;
        const original = new Date(state.occurrence_start);
        if (original < originalStart || original.getTime() > until) continue;
        const identity = `${session.id}:${original.toISOString()}`;
        if (seen.has(identity) || new Date(state.override_ends_at) <= rangeStart || new Date(state.override_starts_at) >= rangeEnd) continue;
        result.push({ ...session, starts_at: state.override_starts_at, ends_at: state.override_ends_at, completed_at: state.completed_at, not_needed_at: state.not_needed_at, occurrence_start: original.toISOString(), occurrence_id: identity });
        seen.add(identity);
      }
    }
  }
  return result;
}

export function daysBetween(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
}

export function shiftDateKey(value: string, amount: number) {
  return dateKey(addDays(new Date(`${value}T00:00:00`), amount));
}
