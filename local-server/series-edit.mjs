import { randomUUID } from 'node:crypto';
import {
  normalizeDateSchedule,
  selectedDateOffsets,
  selectedDatesFromOffsets,
} from '../lib/selected-dates.mjs';
import { planSeriesRevision } from '../lib/repeat-series.mjs';

export function reviseSeries(
  database,
  id,
  input,
  scope = 'series',
  from,
  expected,
) {
  const db = database.db;
  database.beginTransaction();
  try {
    const raw = db
      .prepare('SELECT * FROM calendar_sessions WHERE id=?')
      .get(id);
    if (!raw) throw new Error('Calendar item not found.');
    const base = {
      ...raw,
      ...(raw.recurrence === 'dates'
        ? {
            recurrence_dates: selectedDatesFromOffsets(
              raw.starts_at,
              JSON.parse(raw.recurrence_offsets),
            ),
          }
        : {}),
    };
    if (expected)
      for (const field of [
        'title',
        'task_id',
        'starts_at',
        'ends_at',
        'recurrence',
        'recurrence_until',
        'recurrence_interval',
      ]) {
        if ((base[field] ?? null) !== (expected[field] ?? null))
          throw new Error(
            'This calendar item changed. Reopen it before saving.',
          );
      }
    if (
      expected &&
      'notification_offsets' in expected &&
      JSON.stringify(JSON.parse(base.notification_offsets)) !==
        JSON.stringify(expected.notification_offsets)
    )
      throw new Error('This calendar item changed. Reopen it before saving.');
    if (
      expected &&
      'is_pinned' in expected &&
      Boolean(base.is_pinned) !== Boolean(expected.is_pinned)
    )
      throw new Error('This calendar item changed. Reopen it before saving.');
    if (
      expected &&
      base.recurrence === 'dates' &&
      JSON.stringify(base.recurrence_dates) !==
        JSON.stringify(expected.recurrence_dates)
    )
      throw new Error(
        'This repeat rule changed. Reopen the item before saving.',
      );
    const next = normalizeDateSchedule({ ...base, ...input });
    database.validateSession(next);
    if (scope === 'future' && next.task_id !== base.task_id)
      throw new Error(
        'Task applies to the entire series. Change it using Edit entire series.',
      );
    if (
      scope === 'future' &&
      (JSON.stringify(
        typeof next.notification_offsets === 'string'
          ? JSON.parse(next.notification_offsets)
          : next.notification_offsets,
      ) !== JSON.stringify(JSON.parse(base.notification_offsets)) ||
        Boolean(next.is_pinned) !== Boolean(base.is_pinned))
    )
      throw new Error('Notifications and pin apply to the entire series.');
    const states = db
      .prepare(
        'SELECT * FROM calendar_occurrence_states WHERE calendar_entry_id=?',
      )
      .all(id);
    const notes = new Set(
      db
        .prepare(
          'SELECT occurrence_state_id FROM planner_annotations WHERE calendar_entry_id=? AND occurrence_state_id IS NOT NULL',
        )
        .all(id)
        .map((row) => row.occurrence_state_id),
    );
    const rows = planSeriesRevision(base, states, notes, next, scope, from);
    const retained = new Set(rows.map((row) => row.occurrence_start));
    for (const row of states)
      if (!retained.has(row.occurrence_start))
        db.prepare(
          'DELETE FROM calendar_occurrence_states WHERE calendar_entry_id=? AND occurrence_start=?',
        ).run(id, row.occurrence_start);
    const write = db.prepare(
      `INSERT INTO calendar_occurrence_states(id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at,title_override,is_exception,title_is_exception,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(calendar_entry_id,occurrence_start) DO UPDATE SET completed_at=excluded.completed_at,not_needed_at=excluded.not_needed_at,override_starts_at=excluded.override_starts_at,override_ends_at=excluded.override_ends_at,title_override=excluded.title_override,is_exception=excluded.is_exception,title_is_exception=excluded.title_is_exception,updated_at=excluded.updated_at`,
    );
    for (const row of rows)
      write.run(
        row.id ?? randomUUID(),
        id,
        row.occurrence_start,
        row.completed_at,
        row.not_needed_at,
        row.override_starts_at,
        row.override_ends_at,
        row.title_override,
        Number(row.is_exception),
        Number(Boolean(row.title_is_exception)),
        new Date().toISOString(),
      );
    db.prepare(
      `UPDATE calendar_sessions SET title=?,task_id=?,starts_at=?,ends_at=?,recurrence=?,recurrence_until=?,recurrence_interval=?,recurrence_offsets=?,occurrence_mode=1,completed_at=NULL,not_needed_at=NULL,notification_offsets=?,is_pinned=?,updated_at=? WHERE id=?`,
    ).run(
      next.title,
      next.task_id,
      next.starts_at,
      next.ends_at,
      next.recurrence,
      next.recurrence_until,
      next.recurrence_interval,
      JSON.stringify(
        next.recurrence === 'dates'
          ? selectedDateOffsets(next.recurrence_dates, next.starts_at)
          : [],
      ),
      typeof next.notification_offsets === 'string'
        ? next.notification_offsets
        : JSON.stringify(next.notification_offsets ?? [15]),
      Number(Boolean(next.is_pinned)),
      new Date().toISOString(),
      id,
    );
    database.syncTaskChecklistProgress(base.task_id);
    if (next.task_id !== base.task_id)
      database.syncTaskChecklistProgress(next.task_id);
    database.commitTransaction();
  } catch (error) {
    database.rollbackTransaction();
    throw error;
  }
}
