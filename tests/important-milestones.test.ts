import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { LocalDatabase } from '../local-server/database.mjs';
import { undoContext } from '../local-server/undo.mjs';
import { milestoneLevels, milestoneMarkerWidth } from '../lib/workspace-view';

describe('important milestones', () => {
  it('defaults old callers to Normal, persists Important and preserves dates/parents/colors on partial edits', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const goal = db.createGoal({
        title: 'Goal',
        starts_on: '2026-10-01',
        ends_on: '2026-10-31',
      });
      const id = db.createTimelineMilestone({
        title: 'Launch',
        goal_id: goal,
        milestone_on: '2026-10-15',
        color_key: 'jade',
      });
      const before = db.getTimelineWorkspace();
      expect(before.milestones[0].is_important).toBe(false);
      db.updateTimelineMilestone(id, { is_important: true });
      expect(db.getTimelineWorkspace()).toEqual({
        ...before,
        milestones: [{ ...before.milestones[0], is_important: true }],
      });
      db.updateTimelineMilestone(id, { title: 'Launch updated' });
      expect(db.getTimelineWorkspace().milestones[0].is_important).toBe(true);
      db.updateTimelineMilestone(id, { is_important: false });
      expect(db.getTimelineWorkspace().milestones[0].is_important).toBe(false);
      const important = db.createTimelineMilestone({
        title: 'Another',
        goal_id: goal,
        milestone_on: '2026-10-16',
        is_important: true,
      });
      expect(
        db
          .getTimelineWorkspace()
          .milestones.find((item) => item.id === important)?.is_important,
      ).toBe(true);
    } finally {
      db.close();
    }
  });
  it('rejects malformed importance before any insert or partial update', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const id = db.createTimelineMilestone({
        title: 'Keep',
        milestone_on: '2026-10-15',
      });
      for (const invalid of [null, 1, 'true', [], {}]) {
        expect(() =>
          db.createTimelineMilestone({
            title: 'Bad',
            milestone_on: '2026-10-15',
            is_important: invalid,
          }),
        ).toThrow(/boolean/);
        expect(() =>
          db.updateTimelineMilestone(id, {
            title: 'Changed',
            is_important: invalid,
          }),
        ).toThrow(/boolean/);
      }
      expect(db.getTimelineWorkspace().milestones).toHaveLength(1);
      expect(db.getTimelineWorkspace().milestones[0].title).toBe('Keep');
    } finally {
      db.close();
    }
  });
  it('supports Undo and preserves importance through group schedule moves', () => {
    const db = new LocalDatabase(':memory:');
    const session = '00000000-0000-4000-8000-000000000031',
      operation = '00000000-0000-4000-8000-000000000032';
    try {
      const goal = db.createGoal({
        title: 'Group',
        starts_on: '2026-10-01',
        ends_on: '2026-10-31',
      });
      const id = db.createTimelineMilestone({
        title: 'Launch',
        goal_id: goal,
        milestone_on: '2026-10-15',
      });
      undoContext.run({ session, operation }, () =>
        db.updateTimelineMilestone(id, { is_important: true }),
      );
      (
        db as LocalDatabase & {
          applyUndo: (operation: string, session: string) => void;
        }
      ).applyUndo(operation, session);
      expect(db.getTimelineWorkspace().milestones[0].is_important).toBe(false);
      db.updateTimelineMilestone(id, { is_important: true });
      db.moveTimelineGroup(goal, 1, db.previewTimelineGroup(goal).version);
      expect(db.getTimelineWorkspace().milestones[0]).toMatchObject({
        is_important: true,
        milestone_on: '2026-10-16',
      });
    } finally {
      db.close();
    }
  });
  it('upgrades an existing SQLite database idempotently without losing milestones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myplan-milestone-test-')),
      path = join(dir, 'legacy.db');
    try {
      let db = new LocalDatabase(path);
      const id = db.createTimelineMilestone({
        title: 'Existing',
        milestone_on: '2026-10-15',
        color_key: 'jade',
      });
      db.close();
      const legacy = new DatabaseSync(path);
      legacy.exec('ALTER TABLE timeline_milestones DROP COLUMN is_important');
      legacy.close();
      db = new LocalDatabase(path);
      expect(db.getTimelineWorkspace().milestones[0]).toMatchObject({
        id,
        title: 'Existing',
        color_key: 'jade',
        is_important: false,
      });
      db.updateTimelineMilestone(id, { is_important: true });
      db.close();
      db = new LocalDatabase(path);
      expect(db.getTimelineWorkspace().milestones[0].is_important).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reserves the actual label width at every zoom and reuses unoccupied lanes', () => {
    const items = [
      {
        id: 'a',
        milestone_on: '2026-10-01',
        title: 'Important deadline with a long name',
        is_important: true,
      },
      { id: 'b', milestone_on: '2026-10-01' },
      {
        id: 'c',
        milestone_on: '2026-10-02',
        title: '次の重要なイベント',
        is_important: true,
      },
      { id: 'd', milestone_on: '2026-10-03' },
      {
        id: 'e',
        milestone_on: '2027-01-01',
        title: 'Another',
        is_important: true,
      },
    ];
    for (const dayWidth of [3, 8, 18, 46]) {
      const levels = milestoneLevels(items, dayWidth),
        ends = new Map<number, number>();
      for (const item of items) {
        const x =
          (Date.parse(`${item.milestone_on}T00:00:00Z`) / 86400000) * dayWidth;
        const lane = levels.get(item.id)!;
        expect(x).toBeGreaterThanOrEqual(ends.get(lane) ?? -Infinity);
        ends.set(lane, x + milestoneMarkerWidth(item) + 4);
      }
      expect(levels.get('e')).toBe(0);
    }
    expect(
      milestoneMarkerWidth({ is_important: true, title: 'x'.repeat(200) }),
    ).toBe(220);
    expect(milestoneMarkerWidth({ title: 'Normal' })).toBe(24);
  });
});
