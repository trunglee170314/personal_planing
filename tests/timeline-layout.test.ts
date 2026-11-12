import { describe, expect, it } from 'vitest';
import type {
  Goal,
  Task,
  TimelineMilestone,
  TimelineWorkspace,
} from '../lib/data/repository';
import { buildTimelineRows } from '../lib/timeline-outline';
import {
  buildTimelineLayout,
  indexTimeline,
  visibleTimelineRows,
  type TimelineLayoutRow,
} from '../lib/timeline-layout';

function goal(id: string): Goal {
  return {
    id,
    title: id,
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
}
function task(
  id: string,
  start: string | null,
  end: string | null,
  parent: string | null = null,
): Task {
  return {
    id,
    title: id,
    priority: 'medium',
    due_at: end ? `${end}T16:59:00.000Z` : null,
    completed_at: null,
    workflow_status_id: 'planned',
    previous_status_id: null,
    planned_start: start,
    planned_end: null,
    progress: 0,
    parent_task_id: parent,
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
  taskId: string | null,
  day: string,
  important = false,
): TimelineMilestone {
  return {
    id,
    title: important ? 'Important deadline with a very long title' : id,
    goal_id: taskId ? null : 'g1',
    task_id: taskId,
    milestone_on: day,
    color_key: null,
    is_important: important,
  };
}
function setup(
  tasks: Task[],
  milestones: TimelineMilestone[] = [],
  extraGoals: Goal[] = [],
  taskGoals: Record<string, string> = {},
) {
  const workspace: TimelineWorkspace = {
    goals: [goal('g1'), ...extraGoals],
    tasks,
    milestones,
    statuses: [],
    links: tasks.map((item) => ({
      task_id: item.id,
      goal_id: taskGoals[item.id] ?? 'g1',
    })),
  };
  const links = new Map(
    workspace.links.map((link) => [link.task_id, link.goal_id]),
  );
  const sourceRows = buildTimelineRows(workspace, links, new Set());
  return { workspace, sourceRows, index: indexTimeline(workspace), links };
}
function layout(f: ReturnType<typeof setup>, compact = true, dayWidth = 46) {
  return buildTimelineLayout(
    f.sourceRows,
    f.index,
    '2026-11-01',
    dayWidth,
    compact,
  );
}
function taskGroups(rows: TimelineLayoutRow[]) {
  return rows
    .filter((row) => row.kind === 'tasks')
    .map((row) => row.tasks.map((plan) => plan.row.task.id));
}

describe('Timeline indexed metadata', () => {
  it('keeps goal-owned, task-owned and Inbox milestones separate', () => {
    const f = setup(
      [task('a', '2026-11-01', '2026-11-02')],
      [
        mark('task', 'a', '2026-11-01'),
        mark('goal', null, '2026-11-02'),
        { ...mark('inbox', null, '2026-11-03'), goal_id: null },
      ],
    );
    expect(f.index.taskMilestones.get('a')?.map((item) => item.id)).toEqual([
      'task',
    ]);
    expect(f.index.goalMilestones.get('g1')?.map((item) => item.id)).toEqual([
      'goal',
    ]);
    expect(f.index.goalMilestones.get(null)?.map((item) => item.id)).toEqual([
      'inbox',
    ]);
    expect(f.index.goalsById.get('g1')?.title).toBe('g1');
    expect(f.index.tasksById.get('a')?.id).toBe('a');
  });
  it('Important only removes normal marker footprints but retains every task', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-01'),
        task('b', '2026-11-10', '2026-11-10'),
      ],
      [mark('normal', 'a', '2026-11-10')],
    );
    expect(taskGroups(layout(f).rows)).toEqual([['a'], ['b']]);
    const filtered = buildTimelineLayout(
      f.sourceRows,
      indexTimeline(f.workspace, true),
      '2026-11-01',
      46,
      true,
    );
    expect(taskGroups(filtered.rows)).toEqual([['a', 'b']]);
    expect(filtered.plansByTaskId.size).toBe(2);
  });
  it('filters malformed marker dates before they affect geometry', () => {
    const f = setup(
      [],
      [mark('bad', null, '2026-02-30'), mark('good', null, '2026-11-02')],
    );
    expect(f.index.goalMilestones.get('g1')?.map((item) => item.id)).toEqual([
      'good',
    ]);
  });
  it('never mutates source data or reorders its milestones', () => {
    const f = setup(
      [task('a', '2026-11-01', '2026-11-02')],
      [mark('late', 'a', '2026-11-15'), mark('early', 'a', '2026-11-01')],
    );
    const before = structuredClone(f.workspace);
    layout(f);
    expect(f.workspace).toEqual(before);
    expect(f.index.taskMilestones.get('a')?.map((item) => item.id)).toEqual([
      'late',
      'early',
    ]);
  });
});

describe('Timeline compact ownership and visibility', () => {
  it('packs disjoint scheduled tasks in one row', () => {
    const f = setup([
      task('a', '2026-11-01', '2026-11-02'),
      task('b', '2026-11-04', '2026-11-05'),
    ]);
    expect(taskGroups(layout(f).rows)).toEqual([['a', 'b']]);
  });
  it('separates overlapping inclusive dates', () => {
    const f = setup([
      task('a', '2026-11-01', '2026-11-03'),
      task('b', '2026-11-03', '2026-11-05'),
    ]);
    expect(taskGroups(layout(f).rows)).toEqual([['a'], ['b']]);
  });
  it.each([46, 18, 8])(
    'packs adjacent date ranges with a visible 4px gap at %spx/day',
    (dayWidth) => {
      const f = setup([
        task('a', '2026-11-01', '2026-11-02'),
        task('b', '2026-11-03', '2026-11-04'),
      ]);
      const result = layout(f, true, dayWidth);
      expect(taskGroups(result.rows)).toEqual([['a', 'b']]);
      const a = result.plansByTaskId.get('a')!,
        b = result.plansByTaskId.get('b')!;
      expect(b.left - (a.left + a.width)).toBe(4);
    },
  );
  it('does not pack adjacent one-day bars narrower than the minimum readable width', () => {
    const f = setup([
      task('a', '2026-11-01', '2026-11-01'),
      task('b', '2026-11-02', '2026-11-02'),
    ]);
    expect(taskGroups(layout(f, true, 8).rows)).toEqual([['a'], ['b']]);
    expect(taskGroups(layout(f, true, 3).rows)).toEqual([['a'], ['b']]);
  });
  it('does not share rows across Goal boundaries', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-02'),
        task('b', '2026-11-04', '2026-11-05'),
      ],
      [],
      [goal('g2')],
      { b: 'g2' },
    );
    const rows = layout(f).rows;
    expect(taskGroups(rows)).toEqual([['a'], ['b']]);
    expect(
      rows.map((row) =>
        row.kind === 'goal' ? row.goal?.id : row.tasks[0].row.task.id,
      ),
    ).toEqual(['g1', 'a', 'g2', 'b', 'inbox']);
  });
  it('keeps Goal rows visible when every task is unscheduled', () => {
    const f = setup([task('empty', null, null)], [], [goal('g2')]);
    expect(layout(f).rows.map((row) => row.goal?.id)).toEqual([
      'g1',
      'g2',
      'inbox',
    ]);
  });
  it('hides fully unscheduled, start-only and deadline-only tasks in compact mode', () => {
    const f = setup([
      task('empty', null, null),
      task('start', '2026-11-01', null),
      task('end', null, '2026-11-02'),
    ]);
    expect(taskGroups(layout(f).rows)).toEqual([]);
    expect(taskGroups(layout(f, false).rows)).toEqual([
      ['empty'],
      ['start'],
      ['end'],
    ]);
  });
  it('does not make unscheduled tasks visible merely because they have a milestone', () => {
    const f = setup(
      [task('empty', null, null)],
      [mark('m', 'empty', '2026-11-03')],
    );
    expect(taskGroups(layout(f).rows)).toEqual([]);
    expect(
      layout(f, false).rows.find((row) => row.kind === 'tasks')?.milestones,
    ).toHaveLength(1);
  });
  it('treats invalid or inverted task ranges as unscheduled', () => {
    const f = setup([
      task('invalid', '2026-02-30', '2026-11-05'),
      task('inverted', '2026-11-10', '2026-11-05'),
    ]);
    expect(taskGroups(layout(f).rows)).toEqual([]);
    expect(taskGroups(layout(f, false).rows)).toEqual([
      ['invalid'],
      ['inverted'],
    ]);
  });
  it('retains source order and hierarchy when outline is open', () => {
    const f = setup([
      task('parent', '2026-11-10', '2026-11-11'),
      task('child', '2026-11-01', '2026-11-02', 'parent'),
      task('other', '2026-11-05', '2026-11-06'),
    ]);
    expect(taskGroups(layout(f, false).rows)).toEqual([
      ['parent'],
      ['child'],
      ['other'],
    ]);
    expect(layout(f, false).plansByTaskId.get('child')?.row.depth).toBe(1);
    expect(layout(f, false).plansByTaskId.get('parent')?.row.hasChildren).toBe(
      true,
    );
    layout(f);
    expect(taskGroups(layout(f, false).rows)).toEqual([
      ['parent'],
      ['child'],
      ['other'],
    ]);
  });
  it('honors collapsed branches and Goal membership supplied by the outline', () => {
    const f = setup([
      task('parent', '2026-11-01', '2026-11-02'),
      task('child', '2026-11-05', '2026-11-06', 'parent'),
    ]);
    const source = buildTimelineRows(
      f.workspace,
      f.links,
      new Set(),
      new Set(['parent']),
    );
    const result = buildTimelineLayout(source, f.index, '2026-11-01', 46, true);
    expect(taskGroups(result.rows)).toEqual([['parent']]);
    expect(result.plansByTaskId.has('child')).toBe(false);
  });
  it('deterministically sorts compact tasks by date without changing original outline order', () => {
    const f = setup([
      task('later', '2026-11-10', '2026-11-11'),
      task('earlier', '2026-11-01', '2026-11-02'),
    ]);
    expect(taskGroups(layout(f).rows)).toEqual([['earlier', 'later']]);
    expect(taskGroups(layout(f, false).rows)).toEqual([['later'], ['earlier']]);
  });
  it('uses planned_end for legacy tasks without a due_at value', () => {
    const legacy = {
      ...task('legacy', '2026-11-01', null),
      planned_end: '2026-11-02',
    };
    expect(layout(setup([legacy])).plansByTaskId.get('legacy')).toMatchObject({
      start: '2026-11-01',
      end: '2026-11-02',
      left: 2,
      width: 88,
    });
  });
});

describe('Timeline whole-Task footprint packing', () => {
  it('separates a Task marker that overlaps another Task bar', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-02'),
        task('b', '2026-11-10', '2026-11-11'),
      ],
      [mark('m', 'a', '2026-11-10')],
    );
    expect(taskGroups(layout(f).rows)).toEqual([['a'], ['b']]);
  });
  it('separates two Task-owned markers even though their bars are disjoint', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-02'),
        task('b', '2026-11-10', '2026-11-11'),
      ],
      [mark('ma', 'a', '2026-11-20'), mark('mb', 'b', '2026-11-20')],
    );
    expect(taskGroups(layout(f).rows)).toEqual([['a'], ['b']]);
  });
  it('reserves Important label width, not just the date or flag icon', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-01'),
        task('b', '2026-11-06', '2026-11-06'),
      ],
      [mark('long', 'a', '2026-11-03', true)],
    );
    expect(taskGroups(layout(f).rows)).toEqual([['a'], ['b']]);
    expect(layout(f).plansByTaskId.get('a')?.clusters[0].width).toBe(220);
  });
  it('recomputes marker collision at each zoom', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-01'),
        task('b', '2026-11-10', '2026-11-10'),
      ],
      [mark('long', 'a', '2026-11-03', true)],
    );
    expect(taskGroups(layout(f, true, 46).rows)).toEqual([['a', 'b']]);
    expect(taskGroups(layout(f, true, 18).rows)).toEqual([['a'], ['b']]);
  });
  it('allows a Task to occupy a real gap between another Task bar and a distant marker', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-02'),
        task('b', '2026-11-10', '2026-11-11'),
      ],
      [mark('far', 'a', '2026-11-20')],
    );
    expect(taskGroups(layout(f).rows)).toEqual([['a', 'b']]);
    expect(layout(f).plansByTaskId.get('a')?.footprints).toHaveLength(2);
  });
  it('keeps each Task marker cluster owned by that Task', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-01'),
        task('b', '2026-11-10', '2026-11-10'),
      ],
      [
        mark('ma1', 'a', '2026-11-02'),
        mark('ma2', 'a', '2026-11-02'),
        mark('mb', 'b', '2026-11-11'),
      ],
    );
    const result = layout(f);
    expect(taskGroups(result.rows)).toEqual([['a', 'b']]);
    expect(
      result.plansByTaskId.get('a')?.clusters[0].items.map((item) => item.id),
    ).toEqual(['ma1', 'ma2']);
    expect(
      result.plansByTaskId.get('b')?.clusters[0].items.map((item) => item.id),
    ).toEqual(['mb']);
  });
  it('uses the actual compact cluster width rather than invisible former label widths', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-01'),
        task('b', '2026-11-06', '2026-11-06'),
      ],
      [
        mark('important', 'a', '2026-11-03', true),
        mark('normal', 'a', '2026-11-03'),
      ],
    );
    expect(layout(f).plansByTaskId.get('a')?.clusters[0].width).toBe(48);
    expect(taskGroups(layout(f).rows)).toEqual([['a', 'b']]);
  });
  it('keeps minimum-width bars from overlapping when zoomed far out', () => {
    const f = setup([
      task('a', '2026-11-01', '2026-11-01'),
      task('b', '2026-11-04', '2026-11-04'),
    ]);
    expect(layout(f, true, 3).plansByTaskId.get('a')?.width).toBe(10);
    expect(taskGroups(layout(f, true, 3).rows)).toEqual([['a'], ['b']]);
  });
  it('gives a shared lane exactly one milestone strip and no strip to empty lanes', () => {
    const f = setup(
      [
        task('a', '2026-11-01', '2026-11-02'),
        task('b', '2026-11-10', '2026-11-11'),
      ],
      [mark('ma', 'a', '2026-11-01'), mark('mb', 'b', '2026-11-10')],
    );
    expect(layout(f).rows.find((row) => row.kind === 'tasks')?.height).toBe(74);
    expect(
      layout(setup(f.workspace.tasks)).rows.find((row) => row.kind === 'tasks')
        ?.height,
    ).toBe(42);
  });
  it('includes Goal milestone strip in row offsets and total height', () => {
    const f = setup(
      [task('a', '2026-11-01', '2026-11-02')],
      [mark('mg', null, '2026-11-01')],
    );
    expect(layout(f).rows.map((row) => [row.top, row.height])).toEqual([
      [0, 88],
      [88, 42],
      [130, 56],
    ]);
    expect(layout(f).totalHeight).toBe(186);
  });
  it('preserves pre-range marker and bar footprints for valid horizontal clipping', () => {
    const f = setup(
      [task('past', '2026-10-01', '2026-10-02')],
      [mark('m', 'past', '2026-10-03')],
    );
    const plan = layout(f).plansByTaskId.get('past')!;
    expect(plan.left).toBeLessThan(0);
    expect(plan.footprints.every((piece) => piece.right < 0)).toBe(true);
  });
  it('uses UTC calendar-day arithmetic across a daylight-saving boundary', () => {
    const f = setup([task('dst', '2026-11-01', '2026-11-02')]);
    expect(layout(f, false).plansByTaskId.get('dst')?.width).toBe(92);
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid day width %s', (width) => {
    const f = setup([]);
    expect(() => layout(f, true, width)).toThrow(/geometry/);
  });
  it('rejects malformed or impossible origin dates', () => {
    const f = setup([]);
    for (const date of ['bad', '2026-2-01', '2026-02-30'])
      expect(() =>
        buildTimelineLayout(f.sourceRows, f.index, date, 46, true),
      ).toThrow(/geometry/);
  });
  it.each([3, 8, 18, 46])(
    'never overlaps independently reconstructed rendered pieces in mixed data at %spx/day',
    (dayWidth) => {
      let seed = 170314;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const day = (offset: number) =>
        new Date(Date.UTC(2026, 10, 1 + offset)).toISOString().slice(0, 10);
      const tasks = Array.from({ length: 160 }, (_, i) => {
        const start = Math.floor(random() * 180);
        return task(`t${i}`, day(start), day(start + Math.floor(random() * 8)));
      });
      const marks = tasks.flatMap((item, i) =>
        Array.from({ length: i % 4 }, (_, n) =>
          mark(
            `m${i}-${n}`,
            item.id,
            day(Math.floor(random() * 210)),
            random() > 0.6,
          ),
        ),
      );
      const f = setup(tasks, marks);
      const before = structuredClone(f.workspace);
      const result = layout(f, true, dayWidth);
      expect(
        result.rows
          .flatMap((row) => row.tasks.map((plan) => plan.row.task.id))
          .sort(),
      ).toEqual(tasks.map((item) => item.id).sort());
      const pixel = (value: string) =>
        ((Date.parse(`${value}T00:00:00Z`) - Date.UTC(2026, 10, 1)) /
          86400000) *
        dayWidth;
      for (const row of result.rows) {
        const pieces = row.tasks.map((plan) => [
          { left: plan.left, right: plan.left + plan.width },
          ...plan.clusters.map((cluster) => ({
            left: pixel(cluster.day),
            right: pixel(cluster.day) + cluster.width,
          })),
        ]);
        for (let i = 0; i < pieces.length; ++i)
          for (let j = i + 1; j < pieces.length; ++j)
            for (const a of pieces[i])
              for (const b of pieces[j])
                expect(a.right + 4 <= b.left || b.right + 4 <= a.left).toBe(
                  true,
                );
      }
      expect(f.workspace).toEqual(before);
      expect(taskGroups(layout(f, true, dayWidth).rows)).toEqual(
        taskGroups(result.rows),
      );
    },
  );
});

describe('Timeline vertical viewport', () => {
  const f = setup(
    [
      task('a', '2026-11-01', '2026-11-01'),
      task('b', '2026-11-01', '2026-11-01'),
    ],
    [mark('m', 'a', '2026-11-01')],
  );
  const rows = layout(f, false).rows; // [0,56), [56,130), [130,172), [172,228)
  it('includes only intersecting rows at exact lower and upper boundaries', () => {
    expect(visibleTimelineRows(rows, 56, 74, 0)).toEqual({
      start: 1,
      end: 2,
      paddingTop: 56,
      paddingBottom: 98,
    });
  });
  it('includes partially visible rows at both edges', () => {
    expect(visibleTimelineRows(rows, 55, 76, 0)).toEqual({
      start: 0,
      end: 3,
      paddingTop: 0,
      paddingBottom: 56,
    });
  });
  it('overscans variable-height rows without expanding the whole list', () => {
    expect(visibleTimelineRows(rows, 140, 10, 20)).toEqual({
      start: 1,
      end: 3,
      paddingTop: 56,
      paddingBottom: 56,
    });
  });
  it('keeps spacer totals equal to omitted content height', () => {
    const visible = visibleTimelineRows(rows, 80, 40, 0);
    const rendered = rows
      .slice(visible.start, visible.end)
      .reduce((sum, row) => sum + row.height, 0);
    expect(visible.paddingTop + rendered + visible.paddingBottom).toBe(228);
  });
  it('returns a stable empty window for empty input', () => {
    expect(visibleTimelineRows([], 0, 100)).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
  });
  it('handles a viewport past the list without double counting spacers', () => {
    expect(visibleTimelineRows(rows, 500, 100, 0)).toEqual({
      start: 4,
      end: 4,
      paddingTop: 228,
      paddingBottom: 0,
    });
  });
  it('returns no rendered rows for a zero-height viewport without overscan', () => {
    const window = visibleTimelineRows(rows, 80, 0, 0);
    expect(window.start).toBe(window.end);
    expect(window.paddingTop + window.paddingBottom).toBe(228);
  });
  it('clamps negative scroll caused by overscroll to the beginning', () => {
    expect(visibleTimelineRows(rows, -100, 56, 0)).toEqual({
      start: 0,
      end: 1,
      paddingTop: 0,
      paddingBottom: 172,
    });
  });
  it('bounds rendering in a 5,000-task outline while preserving every task in data', () => {
    const tasks = Array.from({ length: 5000 }, (_, i) =>
      task(`t${i}`, '2026-11-01', '2026-11-01'),
    );
    const result = layout(setup(tasks), false);
    const visible = visibleTimelineRows(result.rows, 100000, 800);
    expect(visible.end - visible.start).toBeLessThan(30);
    expect(result.plansByTaskId.size).toBe(5000);
    expect(result.rows).toHaveLength(5002);
  });
});
