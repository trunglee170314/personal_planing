import { describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';

function setup() {
  const db = new LocalDatabase(':memory:');
  const goal = db.createGoal({
    title: 'Timeline Goal',
    starts_on: '2026-11-01',
    ends_on: '2026-11-30',
  });
  const parent = db.createTask({
    title: 'Parent',
    priority: 'medium',
    workflow_status_id: 'local-status-planned',
    goal_id: goal,
    planned_start: '2026-11-01',
    due_at: '2026-11-30T16:59:00.000Z',
    link_url: 'https://example.com',
  });
  const child = db.createTask({
    title: 'Child',
    priority: 'high',
    workflow_status_id: 'local-status-planned',
    goal_id: goal,
    parent_task_id: parent,
    planned_start: '2026-11-02',
    due_at: '2026-11-29T16:59:00.000Z',
  });
  const calendar = db.createCalendarSession({
    title: 'Daily checklist',
    task_id: parent,
    item_type: 'checklist',
    starts_at: '2026-11-01T01:00:00.000Z',
    ends_at: '2026-11-01T02:00:00.000Z',
    all_day: false,
    timezone: 'Asia/Ho_Chi_Minh',
    recurrence: 'daily',
    recurrence_until: '2026-11-03',
    notification_offsets: [],
  });
  db.updateCalendarOccurrence(calendar, {
    occurrence_start: '2026-11-01T01:00:00.000Z',
    completed_at: '2026-11-01T02:00:00.000Z',
  });
  db.updateCalendarOccurrence(calendar, {
    occurrence_start: '2026-11-02T01:00:00.000Z',
    not_needed_at: '2026-11-02T02:00:00.000Z',
  });
  db.createTimelineMilestone({
    title: 'Release',
    milestone_on: '2026-11-10',
    task_id: parent,
    goal_id: null,
    is_important: true,
  });
  return { db, goal, parent, child, calendar };
}

describe('Timeline lightweight reads', () => {
  it('keeps full occurrence counts by default and when explicitly requested', () => {
    const f = setup();
    try {
      const full = f.db.getTimelineWorkspace();
      const parent = full.tasks.find((item) => item.id === f.parent)!;
      expect(parent).toMatchObject({
        active_checklist_count: 3,
        checklist_resolved_count: 2,
        checklist_done_count: 1,
        progress: 67,
      });
      expect(
        f.db.getTimelineWorkspace({ includeChecklistCounts: true }),
      ).toEqual(full);
      expect(f.db.getTimelineWorkspace({})).toEqual(full);
    } finally {
      f.db.close();
    }
  });
  it('does not expand recurrence or query occurrence history in lightweight mode', () => {
    const f = setup();
    try {
      const summary = vi.spyOn(f.db, 'checklistOccurrenceSummary');
      const queries = vi.spyOn(f.db.db, 'prepare');
      const light = f.db.getTimelineWorkspace({
        includeChecklistCounts: false,
      });
      expect(summary).not.toHaveBeenCalled();
      expect(
        queries.mock.calls
          .map(([sql]) => String(sql))
          .some((sql) =>
            /calendar_sessions|calendar_occurrence_states/i.test(sql),
          ),
      ).toBe(false);
      expect(light.tasks).toHaveLength(2);
      queries.mockRestore();
      summary.mockRestore();
    } finally {
      f.db.close();
    }
  });
  it('preserves status, stored progress, links, hierarchy, dates, Goals and milestones', () => {
    const f = setup();
    try {
      const full = f.db.getTimelineWorkspace();
      const light = f.db.getTimelineWorkspace({
        includeChecklistCounts: false,
      });
      expect(light.goals).toEqual(full.goals);
      expect(light.links).toEqual(full.links);
      expect(light.milestones).toEqual(full.milestones);
      expect(light.statuses).toEqual(full.statuses);
      for (const current of light.tasks) {
        const expected = full.tasks.find((item) => item.id === current.id)!;
        const {
          active_checklist_count: _total,
          checklist_resolved_count: _resolved,
          checklist_done_count: _done,
          ...fullBase
        } = expected;
        const {
          active_checklist_count: _lightTotal,
          checklist_resolved_count: _lightResolved,
          checklist_done_count: _lightDone,
          ...lightBase
        } = current;
        expect(lightBase).toEqual(fullBase);
      }
      expect(
        light.tasks.find((item) => item.id === f.child)?.parent_task_id,
      ).toBe(f.parent);
    } finally {
      f.db.close();
    }
  });
  it('cannot change a later full read or persisted planning data', () => {
    const f = setup();
    try {
      const before = f.db.getCalendarWorkspace();
      const full = f.db.getTimelineWorkspace();
      f.db.getTimelineWorkspace({ includeChecklistCounts: false });
      expect(f.db.getTimelineWorkspace()).toEqual(full);
      expect(f.db.getCalendarWorkspace()).toEqual(before);
    } finally {
      f.db.close();
    }
  });
  it('preserves active/archived/trash visibility filtering in lightweight mode', () => {
    const f = setup();
    try {
      f.db.updateTask(f.child, { archived_at: '2026-11-12T01:00:00.000Z' });
      const fullIds = f.db.getTimelineWorkspace().tasks.map((item) => item.id);
      expect(fullIds).toEqual([f.parent]);
      expect(
        f.db
          .getTimelineWorkspace({ includeChecklistCounts: false })
          .tasks.map((item) => item.id),
      ).toEqual(fullIds);
    } finally {
      f.db.close();
    }
  });
});
