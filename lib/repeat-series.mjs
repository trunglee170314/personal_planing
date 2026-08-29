import { selectedOccurrenceStarts, vietnamDay } from './selected-dates.mjs';

export const MAX_EFFECTIVE_OCCURRENCES = 1000;
export function isRepeatStart(session, key) {
  const date = new Date(key),
    start = new Date(session.starts_at),
    delta = +date - +start;
  if (
    !Number.isFinite(delta) ||
    delta < 0 ||
    (session.recurrence_until && vietnamDay(date) > session.recurrence_until)
  )
    return false;
  if (session.recurrence === 'none') return delta === 0;
  if (session.recurrence === 'dates')
    return selectedOccurrenceStarts(session).includes(date.toISOString());
  if (session.recurrence === 'monthly') {
    const a = new Date(+start + 7 * 3600000),
      b = new Date(+date + 7 * 3600000),
      months =
        (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
        b.getUTCMonth() -
        a.getUTCMonth();
    const last = new Date(
      Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return (
      date.toISOString() ===
        new Date(
          Date.UTC(
            b.getUTCFullYear(),
            b.getUTCMonth(),
            Math.min(a.getUTCDate(), last),
            a.getUTCHours(),
            a.getUTCMinutes(),
            a.getUTCSeconds(),
            a.getUTCMilliseconds(),
          ) -
            7 * 3600000,
        ).toISOString() && months >= 0
    );
  }
  const days =
    session.recurrence === 'weekly'
      ? 7
      : session.recurrence === 'custom'
        ? Math.max(1, session.recurrence_interval || 1)
        : 1;
  return delta % (days * 86400000) === 0;
}
export function repeatStarts(session) {
  if (session.recurrence === 'dates') return selectedOccurrenceStarts(session);
  if (session.recurrence === 'none')
    return [new Date(session.starts_at).toISOString()];
  if (!session.recurrence_until)
    throw new Error('Choose an end date before editing a repeat schedule.');
  const base = new Date(session.starts_at),
    until = Date.parse(`${session.recurrence_until}T23:59:59.999+07:00`);
  const result = [];
  for (let i = 0; i <= MAX_EFFECTIVE_OCCURRENCES; i++) {
    let date;
    if (session.recurrence === 'monthly') {
      const local = new Date(+base + 7 * 3600000);
      const first = new Date(
        Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + i, 1),
      );
      const day = Math.min(
        local.getUTCDate(),
        new Date(
          Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      );
      date = new Date(
        Date.UTC(
          first.getUTCFullYear(),
          first.getUTCMonth(),
          day,
          local.getUTCHours(),
          local.getUTCMinutes(),
          local.getUTCSeconds(),
          local.getUTCMilliseconds(),
        ) -
          7 * 3600000,
      );
    } else
      date = new Date(
        +base +
          i *
            86400000 *
            (session.recurrence === 'weekly'
              ? 7
              : session.recurrence === 'custom'
                ? Math.max(1, session.recurrence_interval || 1)
                : 1),
      );
    if (+date > until) break;
    if (i === MAX_EFFECTIVE_OCCURRENCES)
      throw new Error(
        'A repeat schedule can contain at most 1,000 occurrences. Shorten its end date.',
      );
    result.push(date.toISOString());
  }
  if (!result.length) throw new Error('The repeat schedule has no dates.');
  return result;
}

/** Preserve original keys, not display dates or ordinal indexes. This is the
 * Local counterpart of the account-locked PostgreSQL reconciliation command. */
export function planSeriesRevision(
  base,
  states,
  annotatedIds,
  next,
  scope,
  from,
  today = vietnamDay(new Date()),
) {
  if (!['series', 'future'].includes(scope))
    throw new Error('Invalid edit scope.');
  const metadataOnly =
    Boolean(base.occurrence_mode) &&
    [
      'recurrence',
      'recurrence_until',
      'recurrence_interval',
      'recurrence_dates',
    ].every(
      (field) =>
        JSON.stringify(base[field] ?? null) ===
        JSON.stringify(next[field] ?? null),
    ) &&
    Date.parse(base.starts_at) === Date.parse(next.starts_at) &&
    Date.parse(base.ends_at) === Date.parse(next.ends_at);
  const byKey = new Map(
    states.map((state) => [
      new Date(state.occurrence_start).toISOString(),
      state,
    ]),
  );
  const generated = base.occurrence_mode ? [] : repeatStarts(base);
  const keys = [...new Set([...generated, ...byKey.keys()])].sort();
  if (keys.length > MAX_EFFECTIVE_OCCURRENCES)
    throw new Error(
      'This series has more than 1,000 occurrences. Edit individual occurrences instead.',
    );
  const cut = from ? new Date(from).toISOString() : null;
  if (scope === 'future' && (!cut || !keys.includes(cut)))
    throw new Error(
      'This occurrence changed. Reopen it before editing the schedule.',
    );
  const duration = Date.parse(base.ends_at) - Date.parse(base.starts_at);
  const protectedDays = new Set(),
    reusable = new Map(),
    result = [];
  for (const key of keys) {
    const state = byKey.get(key);
    const shownStart = state?.override_starts_at ?? key;
    const shownEnd =
      state?.override_ends_at ??
      new Date(Date.parse(key) + duration).toISOString();
    const before = scope === 'future' && key < cut;
    const completed = state ? state.completed_at : base.completed_at;
    const skipped = state ? state.not_needed_at : base.not_needed_at;
    const protectedRow =
      metadataOnly ||
      (!base.occurrence_mode && !generated.includes(key)) ||
      before ||
      completed ||
      skipped ||
      state?.is_exception ||
      annotatedIds.has(state?.id);
    const row = {
      ...state,
      occurrence_start: key,
      completed_at: completed ?? null,
      not_needed_at: skipped ?? null,
      override_starts_at: shownStart,
      override_ends_at: shownEnd,
      title_override: before
        ? (state?.title_override ?? base.title)
        : next.title !== base.title && !state?.title_is_exception
          ? null
          : (state?.title_override ?? null),
      title_is_exception: Boolean(state?.title_is_exception),
      is_exception: Boolean(state?.is_exception),
    };
    if (protectedRow) {
      result.push(row);
      protectedDays.add(vietnamDay(key));
    } else reusable.set(vietnamDay(key), row);
  }
  const newDuration = Date.parse(next.ends_at) - Date.parse(next.starts_at);
  for (const start of metadataOnly ? [] : repeatStarts(next)) {
    const day = vietnamDay(start);
    if (scope === 'future' && day < vietnamDay(cut)) continue;
    if (protectedDays.has(day)) continue;
    const old = reusable.get(day);
    result.push({
      ...old,
      occurrence_start: old?.occurrence_start ?? start,
      override_starts_at: start,
      override_ends_at: new Date(Date.parse(start) + newDuration).toISOString(),
      completed_at: old?.completed_at ?? null,
      not_needed_at: old?.not_needed_at ?? null,
      title_override: old?.title_override ?? null,
      is_exception: false,
    });
  }
  if (result.length > MAX_EFFECTIVE_OCCURRENCES)
    throw new Error(
      'History plus the new schedule exceeds 1,000 occurrences. Shorten the new end date.',
    );
  return result.sort((a, b) =>
    a.occurrence_start.localeCompare(b.occurrence_start),
  );
}
