import { describe, expect, it } from 'vitest';
import type {
  Goal,
  Task,
  TimelineMilestone,
  TimelineWorkspace,
} from '../lib/data/repository';
import { buildTimelineRows } from '../lib/timeline-outline';
import { buildTimelineLayout, indexTimeline } from '../lib/timeline-layout';
import { clusterMilestones, milestoneMarkerWidth } from '../lib/workspace-view';

const goal: Goal = {
  id: 'g',
  title: 'Goal',
  description: null,
  progress: 0,
  status: 'active',
  starts_on: null,
  ends_on: null,
  archived_at: null,
  deleted_at: null,
  task_count: 0,
  completed_task_count: 0,
  color_key: 'jade',
};
function task(id: string, start: string, end: string): Task {
  return {
    id,
    title: id,
    priority: 'medium',
    due_at: `${end}T16:59:00.000Z`,
    completed_at: null,
    workflow_status_id: 'planned',
    previous_status_id: null,
    planned_start: start,
    planned_end: null,
    progress: 0,
    parent_task_id: null,
    dependency_task_id: null,
    is_milestone: false,
    archived_at: null,
    deleted_at: null,
    link_url: null,
    link_label: null,
    active_checklist_count: 0,
    checklist_resolved_count: 0,
    checklist_done_count: 0,
  };
}
function mark(
  id: string,
  day: string,
  important = false,
  taskId = 'a',
): TimelineMilestone {
  return {
    id,
    task_id: taskId,
    goal_id: null,
    title: important ? 'Important release with a long label' : id,
    milestone_on: day,
    color_key: null,
    is_important: important,
  };
}
function layout(
  milestones: TimelineMilestone[],
  dayWidth = 18,
  tasks = [
    task('a', '2026-11-01', '2026-11-10'),
    task('b', '2026-11-11', '2026-11-20'),
  ],
) {
  const workspace: TimelineWorkspace = {
    goals: [goal],
    tasks,
    milestones,
    statuses: [],
    links: tasks.map((t) => ({ task_id: t.id, goal_id: 'g' })),
  };
  const rows = buildTimelineRows(
    workspace,
    new Map(workspace.links.map((l) => [l.task_id, l.goal_id])),
    new Set(),
  );
  return buildTimelineLayout(
    rows,
    indexTimeline(workspace),
    '2026-11-01',
    dayWidth,
    true,
  );
}
const groups = (result: ReturnType<typeof layout>) =>
  result.rows
    .filter((row) => row.kind === 'tasks')
    .map((row) => row.tasks.map((t) => t.row.task.id));

describe('Timeline normal milestone at a Task boundary', () => {
  it('regression: Month end-day flag no longer prevents adjacent Tasks from sharing a row', () => {
    const result = layout([mark('end', '2026-11-10')]);
    expect(groups(result)).toEqual([['a', 'b']]);
    const a = result.plansByTaskId.get('a')!,
      b = result.plansByTaskId.get('b')!;
    const flagRight = 9 * 18 + a.clusters[0].offset + 14;
    expect(flagRight).toBeLessThanOrEqual(a.left + a.width);
    expect(b.left - (a.left + a.width)).toBe(4);
  });
  it('moving the flag one day earlier gives the same Month lanes', () => {
    expect(groups(layout([mark('end', '2026-11-10')]))).toEqual(
      groups(layout([mark('earlier', '2026-11-09')])),
    );
  });
  it('packs B with a flag at its start instead of reserving a 2px shortfall', () => {
    const result = layout([mark('b-start', '2026-11-11', false, 'b')]);
    expect(groups(result)).toEqual([['a', 'b']]);
    const a = result.plansByTaskId.get('a')!,
      b = result.plansByTaskId.get('b')!;
    const markerLeft = 10 * 18 + b.clusters[0].offset;
    expect(markerLeft - (a.left + a.width)).toBe(4);
  });
  it('packs both end and start flags on adjacent phases in Month', () => {
    const result = layout([
      mark('a-end', '2026-11-10'),
      mark('b-start', '2026-11-11', false, 'b'),
    ]);
    expect(groups(result)).toEqual([['a', 'b']]);
    const a = result.plansByTaskId.get('a')!,
      b = result.plansByTaskId.get('b')!;
    const markerARight = 9 * 18 + a.clusters[0].offset + 14;
    const markerBLeft = 10 * 18 + b.clusters[0].offset;
    expect(markerBLeft - markerARight).toBe(4);
  });
  it.each([46, 18])(
    'packs the adjacent phases at %spx/day where there is enough room',
    (dayWidth) => {
      const result = layout([mark('end', '2026-11-10')], dayWidth);
      expect(groups(result)).toEqual([['a', 'b']]);
    },
  );
  it.each([8, 3])(
    'keeps the readable minimum forcing separate lanes at %spx/day',
    (dayWidth) => {
      const result = layout([mark('end', '2026-11-10')], dayWidth);
      expect(groups(result)).toEqual([['a'], ['b']]);
    },
  );
  it.each([
    { scale: 46, expected: 24 },
    { scale: 18, expected: 14 },
    { scale: 8, expected: 10 },
    { scale: 3, expected: 10 },
  ])('uses exact rendered marker bounds at $scale', ({ scale, expected }) => {
    const result = layout([mark('end', '2026-11-10')], scale);
    const plan = result.plansByTaskId.get('a')!;
    expect(plan.clusters[0].width).toBe(expected);
    // Independently reconstruct every piece instead of trusting the helper.
    const expectedBarLeft = 2;
    const expectedBarRight = 2 + Math.max(10, 10 * scale - 4);
    const expectedFlagLeft = 9 * scale;
    const offset = Math.max(0, (scale - expected) / 2);
    expect(plan.clusters[0].offset).toBe(offset);
    const expectedFlagRight = expectedFlagLeft + offset + expected;
    expect(plan.footprints).toEqual([
      {
        left: Math.min(expectedBarLeft, expectedFlagLeft + offset),
        right: Math.max(expectedBarRight, expectedFlagRight),
      },
    ]);
  });
  it('keeps Important labels at their full width and therefore separate', () => {
    const result = layout([mark('important', '2026-11-10', true)]);
    expect(result.plansByTaskId.get('a')?.clusters[0].width).toBe(220);
    expect(groups(result)).toEqual([['a'], ['b']]);
  });
  it('keeps a cluster at full width so it still prevents packing', () => {
    const result = layout([mark('m1', '2026-11-10'), mark('m2', '2026-11-10')]);
    expect(result.plansByTaskId.get('a')?.clusters[0].width).toBe(48);
    expect(groups(result)).toEqual([['a'], ['b']]);
  });
  it('keeps a milestone outside the Task on its real date, even when it blocks B', () => {
    const result = layout([mark('outside', '2026-11-11')]);
    expect(result.plansByTaskId.get('a')?.clusters[0].day).toBe('2026-11-11');
    expect(groups(result)).toEqual([['a'], ['b']]);
  });
  it('still separates two bars that share a day', () => {
    const result = layout([], 18, [
      task('a', '2026-11-01', '2026-11-10'),
      task('b', '2026-11-10', '2026-11-20'),
    ]);
    expect(groups(result)).toEqual([['a'], ['b']]);
  });
  it('does not change source metadata', () => {
    const marks = [mark('end', '2026-11-10')];
    const before = structuredClone(marks);
    layout(marks);
    expect(marks).toEqual(before);
  });
  it('retains 24px for callers omitting scale', () => {
    expect(milestoneMarkerWidth(mark('m', '2026-11-10'))).toBe(24);
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid scale %s', (scale) => {
    expect(() =>
      milestoneMarkerWidth(mark('m', '2026-11-10'), scale),
    ).toThrow();
  });
  it('keeps adjacent Normal flags distinct in Month', () => {
    const items = [mark('m1', '2026-11-01'), mark('m2', '2026-11-02')];
    expect(
      clusterMilestones(items, 18).map((cluster) => cluster.items),
    ).toEqual([[items[0]], [items[1]]]);
  });
  it('still clusters same-day flags', () => {
    const items = [mark('m1', '2026-11-01'), mark('m2', '2026-11-01')];
    expect(clusterMilestones(items, 18)).toMatchObject([{ width: 48, items }]);
  });
  it('back-merges when a growing count resets its offset and collides with the previous flag', () => {
    const items = [
      mark('a', '2026-11-01'),
      mark('b', '2026-11-02'),
      mark('c', '2026-11-02'),
    ];
    expect(clusterMilestones(items, 18)).toMatchObject([
      { day: '2026-11-01', offset: 0, width: 48, items },
    ]);
  });
  it('keeps cluster output stable when input order is shuffled', () => {
    const items = [
      mark('a', '2026-11-01'),
      mark('b', '2026-11-02'),
      mark('c', '2026-11-02'),
    ];
    expect(clusterMilestones([...items].reverse(), 18)).toEqual(
      clusterMilestones(items, 18),
    );
  });
  it('back-merges the Week Important example instead of leaving colliding clusters', () => {
    const important = {
      ...mark('important', '2026-11-01', true),
      title: '1234567',
    };
    const second = mark('b', '2026-11-03');
    expect(clusterMilestones([important, second], 46)).toMatchObject([
      { day: '2026-11-01', width: 96, offset: 0 },
      { day: '2026-11-03', width: 24, offset: 11 },
    ]);
    const duplicate = mark('c', '2026-11-03');
    expect(clusterMilestones([important, second, duplicate], 46)).toMatchObject(
      [
        {
          day: '2026-11-01',
          width: 48,
          offset: 0,
          items: [important, second, duplicate],
        },
      ],
    );
  });
  it('keeps mixed Important and Normal flags clustered where they collide', () => {
    const items = [
      mark('important', '2026-11-01', true),
      mark('normal', '2026-11-02'),
    ];
    expect(clusterMilestones(items, 18)).toMatchObject([{ width: 48, items }]);
  });
  it.each([3, 8, 18, 46, 50])(
    'keeps every seeded cluster lossless and noncolliding at %spx/day',
    (scale) => {
      let seed = 170314;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const items = Array.from({ length: 80 }, (_, i) => {
        const day = new Date(Date.UTC(2026, 10, 1 + Math.floor(random() * 30)))
          .toISOString()
          .slice(0, 10);
        return {
          ...mark(`m${String(i).padStart(3, '0')}`, day, random() > 0.5),
          title: 'x'.repeat(1 + Math.floor(random() * 30)),
        };
      });
      const before = structuredClone(items);
      const clusters = clusterMilestones(items, scale);
      expect(clusters.flatMap((cluster) => cluster.items)).toEqual(
        [...items].sort(
          (a, b) =>
            a.milestone_on.localeCompare(b.milestone_on) ||
            a.id.localeCompare(b.id),
        ),
      );
      const pixel = (day: string) =>
        ((Date.parse(`${day}T00:00:00Z`) - Date.UTC(2026, 10, 1)) / 86400000) *
        scale;
      for (let i = 1; i < clusters.length; ++i)
        expect(
          pixel(clusters[i].day) + clusters[i].offset,
        ).toBeGreaterThanOrEqual(
          pixel(clusters[i - 1].day) +
            clusters[i - 1].offset +
            clusters[i - 1].width +
            4,
        );
      expect(items).toEqual(before);
    },
  );
});
