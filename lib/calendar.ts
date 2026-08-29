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
        if (new Date(shownEnd) > rangeStart && new Date(shownStart) < rangeEnd)
          result.push({
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
      const seen = new Set(
        result
          .filter((item) => item.id === session.id)
          .map((item) => item.occurrence_id),
      );
      for (const state of occurrenceStates) {
        if (
          state.calendar_entry_id !== session.id ||
          !state.override_starts_at ||
          !state.override_ends_at
        )
          continue;
        const original = new Date(state.occurrence_start);
        if (original < originalStart || original.getTime() > until) continue;
        const identity = `${session.id}:${original.toISOString()}`;
        if (
          seen.has(identity) ||
          new Date(state.override_ends_at) <= rangeStart ||
          new Date(state.override_starts_at) >= rangeEnd
        )
          continue;
        result.push({
          ...session,
          starts_at: state.override_starts_at,
          ends_at: state.override_ends_at,
          completed_at: state.completed_at,
          not_needed_at: state.not_needed_at,
          occurrence_start: original.toISOString(),
          occurrence_id: identity,
        });
        seen.add(identity);
      }
    }
  }
  return result;
}

/** Enumerate by recurrence identity, not viewport visibility. This is used by
 * "this and future" mutations so an occurrence moved outside the current
 * viewport is still included. */
export function recurringSeriesFrom<
  T extends RepeatingSession & {
    completed_at?: string | null;
    not_needed_at?: string | null;
  },
>(
  session: T,
  selected: T & { occurrence_id?: string; occurrence_start: string },
  occurrenceStates: {
    calendar_entry_id: string;
    occurrence_start: string;
    completed_at: string | null;
    not_needed_at: string | null;
    override_starts_at?: string | null;
    override_ends_at?: string | null;
  }[],
) {
  if (session.recurrence === 'none') return [selected];
  const selectedKey = new Date(selected.occurrence_start).toISOString();
  const duration =
    new Date(session.ends_at).getTime() - new Date(session.starts_at).getTime();
  const until = session.recurrence_until
    ? new Date(`${session.recurrence_until}T23:59:59+07:00`).getTime()
    : new Date(selectedKey).getTime();
  const states = new Map(
    occurrenceStates
      .filter((state) => state.calendar_entry_id === session.id)
      .map((state) => [new Date(state.occurrence_start).toISOString(), state]),
  );
  const result = new Map<
    string,
    T & { occurrence_id?: string; occurrence_start: string }
  >();
  const original = new Date(session.starts_at);
  let occurrence = new Date(original);
  let recurrenceIndex = 0;
  const selectedTime = new Date(selectedKey).getTime();
  const dayStep =
    session.recurrence === 'daily'
      ? 1
      : session.recurrence === 'weekly'
        ? 7
        : session.recurrence === 'custom'
          ? Math.max(1, session.recurrence_interval ?? 1)
          : 0;
  // A long-lived recurring series can be years old. Start close to the
  // selected identity instead of consuming the safety budget on old dates.
  if (dayStep && occurrence.getTime() < selectedTime) {
    recurrenceIndex = Math.max(
      0,
      Math.floor(
        (selectedTime - occurrence.getTime()) / (dayStep * 86_400_000),
      ),
    );
    occurrence = addDays(original, recurrenceIndex * dayStep);
    while (occurrence.getTime() < selectedTime) {
      recurrenceIndex += 1;
      occurrence = addDays(original, recurrenceIndex * dayStep);
    }
  } else if (
    session.recurrence === 'monthly' &&
    occurrence.getTime() < selectedTime
  ) {
    const originalLocal = new Date(original.getTime() + 7 * 3_600_000);
    const selectedLocal = new Date(selectedTime + 7 * 3_600_000);
    recurrenceIndex = Math.max(
      0,
      (selectedLocal.getUTCFullYear() - originalLocal.getUTCFullYear()) * 12 +
        selectedLocal.getUTCMonth() -
        originalLocal.getUTCMonth(),
    );
    occurrence = addVietnamMonths(original, recurrenceIndex);
    while (occurrence.getTime() < selectedTime) {
      recurrenceIndex += 1;
      occurrence = addVietnamMonths(original, recurrenceIndex);
    }
  }
  for (
    let safety = 0;
    occurrence.getTime() <= until && safety < 75_000;
    safety += 1
  ) {
    const key = occurrence.toISOString();
    if (key >= selectedKey) {
      const state = states.get(key);
      const shownStart = state?.override_starts_at ?? key;
      const shownEnd =
        state?.override_ends_at ??
        new Date(occurrence.getTime() + duration).toISOString();
      result.set(key, {
        ...session,
        starts_at: shownStart,
        ends_at: shownEnd,
        completed_at: state?.completed_at ?? session.completed_at ?? null,
        not_needed_at: state?.not_needed_at ?? session.not_needed_at ?? null,
        occurrence_start: key,
        occurrence_id: `${session.id}:${key}`,
      });
    }
    recurrenceIndex += 1;
    occurrence = dayStep
      ? addDays(original, recurrenceIndex * dayStep)
      : addVietnamMonths(original, recurrenceIndex);
  }
  result.set(selectedKey, selected);
  return [...result.values()].sort((a, b) =>
    a.occurrence_start.localeCompare(b.occurrence_start),
  );
}

/** Pick the occurrence a compact checklist control should toggle: today when
 * available, otherwise the deterministically nearest identity. Boundary scans
 * keep far-future and long-ended series usable without expanding every date. */
export function nearestRecurringOccurrence<T extends RepeatingSession>(
  session: T,
  reference: Date,
  occurrenceStates: {
    calendar_entry_id: string;
    occurrence_start: string;
    completed_at: string | null;
    not_needed_at: string | null;
    override_starts_at?: string | null;
    override_ends_at?: string | null;
  }[] = [],
) {
  const seriesStart = new Date(session.starts_at);
  const until = session.recurrence_until
    ? new Date(`${session.recurrence_until}T23:59:59+07:00`)
    : null;
  const windowEnd =
    until && until < addDays(reference, 366)
      ? addDays(until, 1)
      : addDays(reference, 366);
  let occurrences = expandRecurringSessions(
    [session],
    addDays(reference, -366),
    windowEnd,
    occurrenceStates,
  );
  if (!occurrences.length && seriesStart > reference) {
    const futureEnd =
      until && until < addDays(seriesStart, 366)
        ? addDays(until, 1)
        : addDays(seriesStart, 366);
    occurrences = expandRecurringSessions(
      [session],
      addDays(seriesStart, -1),
      futureEnd,
      occurrenceStates,
    );
  } else if (!occurrences.length && until && until < reference) {
    occurrences = expandRecurringSessions(
      [session],
      addDays(until, -366),
      addDays(until, 1),
      occurrenceStates,
    );
  }
  const sameDay = occurrences.find(
    (item) => vietnamDateKey(item.starts_at) === vietnamDateKey(reference),
  );
  if (sameDay) return sameDay;
  return (
    occurrences.sort(
      (a, b) =>
        Math.abs(new Date(a.starts_at).getTime() - reference.getTime()) -
          Math.abs(new Date(b.starts_at).getTime() - reference.getTime()) ||
        a.occurrence_start.localeCompare(b.occurrence_start),
    )[0] ?? null
  );
}

export function daysBetween(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
}

export function shiftDateKey(value: string, amount: number) {
  return dateKey(addDays(new Date(`${value}T00:00:00`), amount));
}
