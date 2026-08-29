import { describe, expect, it } from 'vitest';
import { patchOccurrence } from '../lib/occurrence-state';
import { expandRecurringSessions } from '../lib/calendar';

const moved = {
  calendar_entry_id: 'daily', occurrence_start: '2026-09-01T01:00:00+00:00',
  completed_at: null, not_needed_at: null,
  override_starts_at: '2026-09-10T02:00:00.000Z', override_ends_at: '2026-09-10T03:00:00.000Z',
};
const series = {id:'daily', starts_at:'2026-09-01T01:00:00.000Z', ends_at:'2026-09-01T02:00:00.000Z', recurrence:'daily' as const, recurrence_until:'2026-09-03', completed_at:null,not_needed_at:null};
describe('moved occurrence completion', () => {
  it('merges equivalent Postgres timestamp forms without losing overrides', () => {
    const result = patchOccurrence([moved], 'daily', '2026-09-01T01:00:00.000Z', {completed_at:'2026-09-10T03:00:00.000Z'});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({override_starts_at:moved.override_starts_at,override_ends_at:moved.override_ends_at});
  });
  it('rolls back completion alone, keeping a later schedule edit', () => {
    const changed = patchOccurrence([moved], 'daily', moved.occurrence_start, {completed_at:'2026-09-10T03:00:00.000Z'});
    const later = patchOccurrence(changed,'daily',moved.occurrence_start,{override_starts_at:'2026-09-11T02:00:00.000Z'});
    expect(patchOccurrence(later,'daily',moved.occurrence_start,{completed_at:null})[0].override_starts_at).toBe('2026-09-11T02:00:00.000Z');
  });
  it('includes an exception moved beyond the recurrence window at its destination, once', () => {
    const result=expandRecurringSessions([series],new Date('2026-09-10'),new Date('2026-09-11'),[moved]);
    expect(result).toHaveLength(1);
    expect(result[0].starts_at).toBe(moved.override_starts_at);
    expect(result[0].occurrence_start).toBe('2026-09-01T01:00:00.000Z');
  });
  it('does not leave a ghost at its original date', () => {
    const result=expandRecurringSessions([series],new Date('2026-09-01'),new Date('2026-09-02'),[moved]);
    expect(result).toHaveLength(0);
  });
});
