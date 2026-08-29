export const MAX_SELECTED_DATES = 366;
const DAY = 86400000;
const VN = 7 * 3600000;
export function vietnamDay(value) {
  return new Date(new Date(value).getTime() + VN).toISOString().slice(0, 10);
}
export function shiftSelectedDay(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY)
    .toISOString()
    .slice(0, 10);
}
export function normalizeSelectedDates(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_SELECTED_DATES
  )
    throw new Error(`Choose between 1 and ${MAX_SELECTED_DATES} dates.`);
  for (const day of value) {
    if (
      typeof day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      day < '2000-01-01' ||
      day > '2200-12-31' ||
      !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
    )
      throw new Error('Choose valid dates between 2000 and 2200.');
  }
  return [...new Set(value)].sort();
}
export function selectedDateOffsets(dates, start) {
  const anchor = vietnamDay(start);
  return normalizeSelectedDates(dates).map((day) =>
    Math.round(
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) /
        DAY,
    ),
  );
}
export function selectedDatesFromOffsets(start, offsets) {
  const anchor = vietnamDay(start);
  return offsets.map((offset) => shiftSelectedDay(anchor, offset));
}
/** Public inputs use absolute date-only values. Persistence uses relative days
 * so whole-series schedule moves retain the exact, possibly sparse pattern. */
export function normalizeDateSchedule(input) {
  if (input.recurrence !== 'dates') return input;
  const dates = normalizeSelectedDates(input.recurrence_dates);
  const start = new Date(input.starts_at),
    end = new Date(input.ends_at);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    end <= start ||
    (input.item_type === 'reminder'
      ? +end - +start !== 15 * 60000
      : vietnamDay(start) !== vietnamDay(end))
  )
    throw new Error(
      'Selected-date Checklists need a start and end time within the same Vietnam day.',
    );
  const clock = (date) => new Date(+date + VN).toISOString().slice(11, 23);
  return {
    ...input,
    recurrence_dates: dates,
    starts_at: new Date(`${dates[0]}T${clock(start)}+07:00`).toISOString(),
    ends_at:
      input.item_type === 'reminder'
        ? new Date(
            Date.parse(`${dates[0]}T${clock(start)}+07:00`) + 15 * 60000,
          ).toISOString()
        : new Date(`${dates[0]}T${clock(end)}+07:00`).toISOString(),
    recurrence_until: dates.at(-1),
    recurrence_interval: 1,
  };
}
export function selectedOccurrenceStarts(session) {
  const dates = normalizeSelectedDates(session.recurrence_dates);
  const clock = new Date(new Date(session.starts_at).getTime() + VN)
    .toISOString()
    .slice(11, 23);
  return dates.map((day) => new Date(`${day}T${clock}+07:00`).toISOString());
}
