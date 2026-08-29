import type { RecurrenceRule } from './calendar';
import {
  selectedDateOffsets,
  selectedDatesFromOffsets,
} from './selected-dates.mjs';

export function parseRrule(
  rrule?: string,
  start?: string,
): {
  recurrence: RecurrenceRule;
  recurrence_until: string | null;
  recurrence_interval: number;
  recurrence_dates?: string[];
} {
  if (!rrule)
    return {
      recurrence: 'none' as const,
      recurrence_until: null,
      recurrence_interval: 1,
    };
  const until = rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/);
  const interval = Number(rrule.match(/INTERVAL=(\d+)/)?.[1] ?? 1);
  const selected = rrule.match(/(?:^|;)X-MYPLAN-DATES=([\d,]+)(?:;|$)/);
  const recurrence: RecurrenceRule = selected
    ? 'dates'
    : rrule.includes('FREQ=WEEKLY')
      ? 'weekly'
      : rrule.includes('FREQ=MONTHLY')
        ? 'monthly'
        : interval > 1
          ? 'custom'
          : 'daily';
  return {
    recurrence,
    recurrence_until: until ? `${until[1]}-${until[2]}-${until[3]}` : null,
    recurrence_interval: interval,
    ...(selected && start
      ? {
          recurrence_dates: selectedDatesFromOffsets(
            start,
            selected[1].split(',').map(Number),
          ) as string[],
        }
      : {}),
  };
}

export function makeRrule(input: {
  recurrence: RecurrenceRule;
  recurrence_until: string | null;
  recurrence_interval: number;
  starts_at: string;
  recurrence_dates?: string[];
}) {
  if (input.recurrence === 'none') return null;
  const freq =
    input.recurrence === 'weekly'
      ? 'WEEKLY'
      : input.recurrence === 'monthly'
        ? 'MONTHLY'
        : 'DAILY';
  const interval =
    input.recurrence === 'custom' ? Math.max(1, input.recurrence_interval) : 1;
  const until = input.recurrence_until
    ? `;UNTIL=${input.recurrence_until.replaceAll('-', '')}T235959Z`
    : '';
  const dates =
    input.recurrence === 'dates'
      ? `;X-MYPLAN-DATES=${selectedDateOffsets(input.recurrence_dates, input.starts_at).join(',')}`
      : '';
  return `FREQ=${freq};INTERVAL=${interval}${until}${dates}`;
}
