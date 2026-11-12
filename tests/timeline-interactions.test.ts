import { describe, expect, it } from 'vitest';
import {
  createTimelineLoadGuard,
  restoreTimelineEntity,
  timelineEdgeSpeed,
  timelineWheelStep,
  timelineZoomScroll,
  visibleTimelineLabel,
} from '../lib/timeline-interactions';
import { LocalDatabase } from '../local-server/database.mjs';
import type { TimelineWorkspace } from '../lib/data/repository';

describe('Timeline pointer-anchored zoom', () => {
  it.each([0, 240])(
    'keeps the pointed date fixed with outline width %i',
    (outline) => {
      const scroll = 1200,
        pointer = 650;
      const day = (scroll + pointer - outline) / 18;
      const next = timelineZoomScroll(scroll, pointer, outline, 18, 46);
      expect(outline + day * 46 - next).toBeCloseTo(pointer);
    },
  );
  it('anchors to the chart edge over the sticky outline and clamps at zero', () => {
    expect(timelineZoomScroll(1000, 100, 240, 18, 8)).toBeCloseTo(
      (1000 * 8) / 18,
    );
    expect(timelineZoomScroll(0, 1000, 0, 46, 3)).toBe(0);
  });
});

describe('Timeline sticky labels', () => {
  it('slides inside a partly visible task without crossing its right edge', () => {
    expect(visibleTimelineLabel(0, 800, 200, 400)).toEqual({
      left: 208,
      width: 384,
    });
    expect(visibleTimelineLabel(0, 250, 200, 400)).toEqual({
      left: 208,
      width: 34,
    });
  });
  it('hides offscreen or too-small labels rather than placing them on another task', () => {
    expect(visibleTimelineLabel(0, 100, 200, 400)).toBeNull();
    expect(visibleTimelineLabel(900, 100, 200, 400)).toBeNull();
    expect(visibleTimelineLabel(210, 10, 200, 400)).toBeNull();
  });
});

describe('Timeline wheel gestures', () => {
  it('limits burst events from one trackpad gesture to deliberate scale steps', () => {
    let state: { delta: number; time: number; lastStep?: number } = {
      delta: 0,
      time: 0,
    };
    const steps: number[] = [];
    for (const now of [1000, 1010, 1020, 1050, 1100, 1150]) {
      const result = timelineWheelStep(state, 120, 0, now);
      steps.push(result.step);
      state = result.state;
    }
    expect(steps).toEqual([1, 0, 0, 0, 0, 1]);
  });
  it('accumulates trackpad events and resets after a pause or reversal', () => {
    let state = { delta: 0, time: 0 };
    let result = timelineWheelStep(state, 20, 0, 1000);
    expect(result.step).toBe(0);
    state = result.state;
    result = timelineWheelStep(state, 40, 0, 1010);
    expect(result.step).toBe(1);
    expect(
      timelineWheelStep({ delta: 50, time: 1000 }, -20, 0, 1010).step,
    ).toBe(0);
    expect(timelineWheelStep({ delta: 50, time: 1000 }, 20, 0, 1300).step).toBe(
      0,
    );
  });
  it('normalizes line/page units and bounds large deltas to one step', () => {
    expect(timelineWheelStep({ delta: 0, time: 0 }, -4, 1, 1000).step).toBe(-1);
    expect(timelineWheelStep({ delta: 0, time: 0 }, 1, 2, 1000).step).toBe(1);
    expect(timelineWheelStep({ delta: 0, time: 0 }, 10000, 0, 1000).step).toBe(
      1,
    );
  });
});

describe('Timeline edge scrolling', () => {
  it('scrolls toward the pointer and caps speed even outside the board', () => {
    expect(timelineEdgeSpeed(500, 100, 900)).toBe(0);
    expect(timelineEdgeSpeed(100, 100, 900)).toBe(-16);
    expect(timelineEdgeSpeed(900, 100, 900)).toBe(16);
    expect(timelineEdgeSpeed(1000, 100, 900)).toBe(16);
  });
});

describe('Timeline asynchronous load ownership', () => {
  it('discards an older response arriving after the latest response', async () => {
    const guard = createTimelineLoadGuard();
    let displayed = '';
    let finishOld!: () => void;
    const oldCurrent = guard.begin();
    const old = new Promise<void>((resolve) => {
      finishOld = resolve;
    }).then(() => {
      if (oldCurrent()) displayed = 'old';
    });
    const newCurrent = guard.begin();
    if (newCurrent()) displayed = 'new';
    finishOld();
    await old;
    expect(displayed).toBe('new');
  });
  it('invalidates pending results on mutation, disposal and later asynchronous stages', () => {
    const guard = createTimelineLoadGuard();
    const duringRead = guard.begin();
    guard.invalidate();
    expect(duringRead()).toBe(false);
    const duringNotes = guard.begin();
    guard.dispose();
    expect(duringNotes()).toBe(false);
    expect(guard.begin()()).toBe(false);
  });
});

describe('Timeline failed-save recovery', () => {
  it('restores the exact deadline time and legacy end field without reverting other Tasks', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const id = db.createTask({
        title: 'Original',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
        planned_start: '2026-11-12',
        planned_end: '2026-11-13',
        due_at: '2026-11-13T03:00:00.000Z',
      });
      const other = db.createTask({
        title: 'Another task',
        priority: 'medium',
        workflow_status_id: 'local-status-planned',
      });
      const workspace =
        db.getTimelineWorkspace() as unknown as TimelineWorkspace;
      const before = workspace.tasks.find((task) => task.id === id)!;
      const optimistic = {
        ...workspace,
        tasks: workspace.tasks.map((task) =>
          task.id === id
            ? {
                ...task,
                planned_start: '2026-11-11',
                planned_end: null,
                due_at: '2026-11-15T16:59:00.000Z',
              }
            : { ...task, title: 'Newer unrelated title' },
        ),
      };
      const restored = restoreTimelineEntity(optimistic, 'task', before);
      expect(restored.tasks.find((task) => task.id === id)).toEqual(before);
      expect(restored.tasks.find((task) => task.id === id)?.due_at).toBe(
        '2026-11-13T03:00:00.000Z',
      );
      expect(restored.tasks.find((task) => task.id === other)?.title).toBe(
        'Newer unrelated title',
      );
      expect(
        optimistic.tasks.find((task) => task.id === id)?.planned_end,
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  it('preserves null schedules and all Goal/milestone metadata on rollback', () => {
    const db = new LocalDatabase(':memory:');
    try {
      const goalId = db.createGoal({ title: 'Goal' });
      const markerId = db.createTimelineMilestone({
        title: 'Important',
        goal_id: goalId,
        milestone_on: '2026-11-12',
        is_important: true,
        color_key: 'jade',
      });
      const workspace =
        db.getTimelineWorkspace() as unknown as TimelineWorkspace;
      const goal = workspace.goals.find((item) => item.id === goalId)!;
      const marker = workspace.milestones.find((item) => item.id === markerId)!;
      const optimistic = {
        ...workspace,
        goals: [{ ...goal, starts_on: '2026-11-01', ends_on: '2026-11-30' }],
        milestones: [{ ...marker, milestone_on: '2026-12-01' }],
      };
      const restored = restoreTimelineEntity(
        restoreTimelineEntity(optimistic, 'goal', goal),
        'milestone',
        marker,
      );
      expect(restored).toEqual(workspace);
    } finally {
      db.close();
    }
  });
});
