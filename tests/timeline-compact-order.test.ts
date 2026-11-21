import { describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  Goal,
  Task,
  TimelineMilestone,
  TimelineWorkspace,
} from '../lib/data/repository';
import {
  buildTimelineRows,
  type TimelineOutlineRow,
} from '../lib/timeline-outline';
import { buildTimelineLayout, indexTimeline } from '../lib/timeline-layout';

const day = (n: number) =>
  new Date(Date.UTC(2035, 0, n)).toISOString().slice(0, 10);
const goal = (id: string): Goal => ({
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
});
function task(
  id: string,
  start: number | null,
  end: number | null,
  parent: string | null = null,
): Task {
  return {
    id,
    title: id,
    priority: 'medium',
    due_at: end === null ? null : `${day(end)}T16:59:00.000Z`,
    planned_start: start === null ? null : day(start),
    planned_end: null,
    completed_at: null,
    workflow_status_id: 'planned',
    previous_status_id: null,
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
function setup(
  tasks: Task[],
  milestones: TimelineMilestone[] = [],
  goals = [goal('g')],
  memberships: Record<string, string | null> = {},
) {
  const workspace: TimelineWorkspace = {
    goals,
    tasks,
    milestones,
    statuses: [],
    links: tasks.flatMap((t) => {
      const g = Object.hasOwn(memberships, t.id)
        ? memberships[t.id]
        : goals[0]?.id;
      return g ? [{ task_id: t.id, goal_id: g }] : [];
    }),
  };
  const rows = buildTimelineRows(
    workspace,
    new Map(workspace.links.map((l) => [l.task_id, l.goal_id])),
    new Set(),
  );
  return { workspace, rows };
}
function layout(
  f: ReturnType<typeof setup>,
  width = 18,
  origin = day(1),
  rows: TimelineOutlineRow[] = f.rows,
) {
  return buildTimelineLayout(
    rows,
    indexTimeline(f.workspace),
    origin,
    width,
    true,
  );
}
const groups = (result: ReturnType<typeof layout>) =>
  result.rows
    .filter((r) => r.kind === 'tasks')
    .map((r) => r.tasks.map((t) => t.row.task.id));
const flatten = (result: ReturnType<typeof layout>) => groups(result).flat();

describe('Compact Timeline preserves saved outline order', () => {
  it.each([46, 18, 8, 3])(
    'regression: source1/2/3 stays1/2/3 despite date order1/3/2 at %spx/day',
    (width) => {
      const f = setup([task('1', 1, 30), task('2', 15, 25), task('3', 10, 20)]);
      expect(groups(layout(f, width))).toEqual([['1'], ['2'], ['3']]);
    },
  );
  it.each([46, 18, 8, 3])(
    'regression: never backfills C into an older A lane across B at %spx/day',
    (width) => {
      const f = setup([task('A', 1, 10), task('B', 5, 20), task('C', 15, 25)]);
      expect(groups(layout(f, width))).toEqual([['A'], ['B'], ['C']]);
    },
  );
  it.each([46, 18, 8, 3])(
    'still merges C into the latest B lane when it fits at %spx/day',
    (width) => {
      const f = setup([task('A', 1, 10), task('B', 5, 12), task('C', 20, 25)]);
      expect(groups(layout(f, width))).toEqual([['A'], ['B', 'C']]);
    },
  );
  it.each([46, 18, 8, 3])(
    'merges consecutive source Tasks with nonchronological disjoint dates at %spx/day',
    (width) => {
      const f = setup([
        task('late', 21, 24),
        task('early', 1, 4),
        task('middle', 11, 14),
      ]);
      const result = layout(f, width);
      expect(groups(result)).toEqual([['late', 'early', 'middle']]);
      expect(result.plansByTaskId.get('late')!.left).toBeGreaterThan(
        result.plansByTaskId.get('early')!.left,
      );
    },
  );
  it('keeps a nested DFS branch in saved order rather than sorting its dates', () => {
    const f = setup(
      [
        task('parent', 1, 30),
        task('child-2', 20, 25, 'parent'),
        task('other-root', 5, 15),
        task('child-1', 10, 20, 'parent'),
        task('grandchild', 8, 9, 'child-1'),
      ],
      [
        {
          id: 'child-mark',
          task_id: 'child-2',
          goal_id: null,
          title: 'Child mark',
          milestone_on: day(28),
          color_key: null,
        },
      ],
    );
    const expected = [
      'parent',
      'child-2',
      'child-1',
      'grandchild',
      'other-root',
    ];
    for (const width of [46, 18, 8, 3]) {
      const result = layout(f, width);
      expect(flatten(result)).toEqual(expected);
      expect(result.plansByTaskId.get('grandchild')!.row.depth).toBe(2);
      expect(
        result.plansByTaskId.get('child-2')!.milestones.map((m) => m.id),
      ).toEqual(['child-mark']);
    }
  });
  it('handles a deep saved hierarchy without flattening or reordering descendants', () => {
    const tasks = Array.from({ length: 180 }, (_, i) =>
      task(`t${i}`, 1, 30, i === 0 ? null : `t${i - 1}`),
    );
    const f = setup(tasks),
      result = layout(f);
    expect(flatten(result)).toEqual(tasks.map((t) => t.id));
    expect(result.plansByTaskId.get('t179')!.row.depth).toBe(179);
  });
  it('keeps Goal and Inbox boundaries in the saved outline order', () => {
    const f = setup(
      [
        task('g2-1', 1, 30),
        task('g1-1', 1, 30),
        task('inbox', 1, 30),
        task('g1-2', 1, 30),
        task('g2-2', 1, 30),
      ],
      [],
      [goal('g1'), goal('g2')],
      { 'g2-1': 'g2', 'g2-2': 'g2', 'g1-1': 'g1', 'g1-2': 'g1', inbox: null },
    );
    const result = layout(f);
    expect(flatten(result)).toEqual(['g1-1', 'g1-2', 'g2-1', 'g2-2', 'inbox']);
    expect(
      result.rows.filter((r) => r.kind === 'goal').map((r) => r.goal!.id),
    ).toEqual(['g1', 'g2', 'inbox']);
    expect(
      result.rows
        .filter((r) => r.kind === 'tasks')
        .every((r) => new Set(r.tasks.map((t) => t.row.goalId)).size === 1),
    ).toBe(true);
  });
  it('hides unscheduled and partial Tasks only in compact mode while keeping scheduled relative order', () => {
    const f = setup([
      task('A', 20, 25),
      task('none', null, null),
      task('start-only', 1, null),
      task('end-only', null, 5),
      task('B', 1, 5),
    ]);
    expect(flatten(layout(f))).toEqual(['A', 'B']);
    const opened = buildTimelineLayout(
      f.rows,
      indexTimeline(f.workspace),
      day(1),
      18,
      false,
    );
    expect(
      opened.rows.flatMap((r) => r.tasks.map((t) => t.row.task.id)),
    ).toEqual(['A', 'none', 'start-only', 'end-only', 'B']);
  });
  it('keeps a milestone outside its Task from colliding with a later merged Task', () => {
    const f = setup(
      [task('A', 1, 4), task('B', 10, 13), task('C', 18, 22)],
      [
        {
          id: 'outside',
          task_id: 'A',
          goal_id: null,
          title: 'Outside mark',
          milestone_on: day(20),
          color_key: null,
        },
      ],
    );
    expect(groups(layout(f))).toEqual([['A', 'B'], ['C']]);
    expect(layout(f).plansByTaskId.get('A')!.clusters[0].day).toBe(day(20));
  });
  it('preserves Important marker collision rules across zoom changes without changing source order', () => {
    const f = setup(
      [task('A', 1, 1), task('B', 10, 10)],
      [
        {
          id: 'important',
          task_id: 'A',
          goal_id: null,
          title: 'Important deadline with a long label',
          milestone_on: day(3),
          color_key: null,
          is_important: true,
        },
      ],
    );
    expect(groups(layout(f, 46))).toEqual([['A', 'B']]);
    expect(groups(layout(f, 18))).toEqual([['A'], ['B']]);
    expect(flatten(layout(f, 46))).toEqual(flatten(layout(f, 18)));
  });
  it('separates Task-owned milestone collisions even when the bars are far apart', () => {
    const f = setup(
      [task('A', 1, 4), task('B', 10, 13)],
      ['A', 'B'].map((id) => ({
        id: `mark-${id}`,
        task_id: id,
        goal_id: null,
        title: id,
        milestone_on: day(25),
        color_key: null,
      })),
    );
    expect(groups(layout(f))).toEqual([['A'], ['B']]);
  });
  it('respects search-visible context rows without reintroducing hidden matches or milestones', () => {
    const f = setup([
      task('parent', 1, 30),
      task('first', 20, 25, 'parent'),
      task('match', 5, 10, 'parent'),
      task('other', 15, 20),
    ]);
    const filtered = f.rows.filter(
      (r) => r.kind === 'goal' || ['parent', 'match'].includes(r.task.id),
    );
    const result = layout(f, 18, day(1), filtered);
    expect(flatten(result)).toEqual(['parent', 'match']);
    expect(result.plansByTaskId.has('first')).toBe(false);
    expect(result.plansByTaskId.has('other')).toBe(false);
  });
  it('retains independent Task and Goal collapse decisions supplied by the outline', () => {
    const f = setup([
      task('parent', 1, 30),
      task('child', 5, 10, 'parent'),
      task('other', 15, 20),
    ]);
    const links = new Map(f.workspace.links.map((l) => [l.task_id, l.goal_id]));
    const collapsedTask = buildTimelineRows(
      f.workspace,
      links,
      new Set(),
      new Set(['parent']),
    );
    expect(flatten(layout(f, 18, day(1), collapsedTask))).toEqual([
      'parent',
      'other',
    ]);
    const collapsedGoal = buildTimelineRows(f.workspace, links, new Set(['g']));
    expect(flatten(layout(f, 18, day(1), collapsedGoal))).toEqual([]);
    expect(
      layout(f, 18, day(1), collapsedGoal).rows.some((r) => r.goal?.id === 'g'),
    ).toBe(true);
  });
  it.each([46, 18, 8, 3])(
    'does not change compact groups when the horizontal origin shifts at %spx/day',
    (width) => {
      const f = setup([task('A', 1, 10), task('B', 5, 20), task('C', 15, 25)]);
      const expected = groups(layout(f, width));
      expect(groups(layout(f, width, day(-20)))).toEqual(expected);
      expect(groups(layout(f, width, day(40)))).toEqual(expected);
    },
  );
  it('is a pure projection across repeated collapse/zoom/scroll calculations', () => {
    const f = setup([
      task('late', 20, 25),
      task('early', 1, 4),
      task('overlap', 3, 21),
    ]);
    const before = structuredClone(f);
    for (const width of [46, 18, 8, 3]) {
      layout(f, width);
      layout(f, width, day(-30));
    }
    expect(f).toEqual(before);
  });
  it.each([46, 18, 8, 3])(
    'preserves every scheduled source identity exactly once in seeded mixed geometry at %spx/day',
    (width) => {
      let seed = 170314;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const tasks = Array.from({ length: 100 }, (_, i) => {
        const start = 1 + Math.floor(random() * 150);
        return task(`t${i}`, start, start + Math.floor(random() * 10));
      });
      const milestones: TimelineMilestone[] = tasks
        .filter((_, i) => i % 4 === 0)
        .map((t, i) => ({
          id: `m${i}`,
          task_id: t.id,
          goal_id: null,
          title: 'Important milestone',
          milestone_on: day(1 + Math.floor(random() * 180)),
          color_key: null,
          is_important: i % 2 === 0,
        }));
      const f = setup(tasks, milestones),
        result = layout(f, width);
      expect(flatten(result)).toEqual(tasks.map((t) => t.id));
      expect(new Set(flatten(result)).size).toBe(tasks.length);
    },
  );
  it('keeps a persisted Local hierarchy reorder after closing/reopening storage and switching compact mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'myplan-compact-order-')),
      path = join(directory, 'test.db');
    const cleanupTarget = resolve(directory);
    if (
      dirname(cleanupTarget) !== resolve(tmpdir()) ||
      !basename(cleanupTarget).startsWith('myplan-compact-order-')
    )
      throw new Error('Unexpected compact-order test cleanup path');
    let db: LocalDatabase | undefined;
    try {
      db = new LocalDatabase(path);
      const g = db.createGoal({ title: 'Saved Goal' });
      const add = (
        title: string,
        start: number,
        end: number,
        parent: string | null = null,
      ) =>
        db!.createTask({
          title,
          priority: 'medium',
          workflow_status_id: 'local-status-planned',
          goal_id: g,
          parent_task_id: parent,
          planned_start: day(start),
          due_at: `${day(end)}T16:59:00.000Z`,
        });
      const parent = add('Parent', 1, 30),
        first = add('Child1', 20, 25, parent),
        second = add('Child2', 5, 15, parent),
        other = add('Root', 10, 12);
      const mark = db.createTimelineMilestone({
        title: 'Child milestone',
        task_id: second,
        goal_id: null,
        milestone_on: day(15),
      });
      db.restructureTimeline({
        task_id: second,
        target_kind: 'task',
        target_id: first,
        placement: 'before',
        expected_version: db.previewTimelineHierarchy(second).version,
      });
      db.close();
      db = undefined;
      db = new LocalDatabase(path);
      const workspace =
        db.getTimelineWorkspace() as unknown as TimelineWorkspace;
      const rows = buildTimelineRows(
        workspace,
        new Map(workspace.links.map((l) => [l.task_id, l.goal_id])),
        new Set(),
      );
      const f = { workspace, rows };
      for (const width of [46, 18, 8, 3])
        expect(flatten(layout(f, width))).toEqual([
          parent,
          second,
          first,
          other,
        ]);
      expect(workspace.milestones.find((m) => m.id === mark)?.task_id).toBe(
        second,
      );
      expect(workspace.tasks.find((t) => t.id === second)?.parent_task_id).toBe(
        parent,
      );
    } finally {
      db?.close();
      rmSync(cleanupTarget, { recursive: true, force: true });
    }
  });
});
