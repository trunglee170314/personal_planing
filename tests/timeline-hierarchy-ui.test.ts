import { describe, expect, it } from 'vitest';
import type {
  Goal,
  Task,
  TimelineHierarchyTree,
  TimelineWorkspace,
} from '../lib/data/repository';
import {
  sameTimelineHierarchy,
  timelineHierarchyDrop,
  timelineHierarchyPlacement,
  timelineHierarchyTree,
  timelineHierarchyNoop,
  type TimelineHierarchyTarget,
} from '../lib/timeline-hierarchy';
import { buildTimelineRows } from '../lib/timeline-outline';

function task(id: string, parent: string | null = null, order?: number): Task {
  return {
    id,
    title: id,
    priority: 'medium',
    due_at: null,
    completed_at: null,
    workflow_status_id: 'planned',
    previous_status_id: null,
    planned_start: null,
    planned_end: null,
    progress: 0,
    parent_task_id: parent,
    dependency_task_id: null,
    is_milestone: false,
    archived_at: null,
    deleted_at: null,
    link_url: 'https://example.com/task',
    link_label: 'Reference',
    active_checklist_count: 0,
    checklist_resolved_count: 0,
    checklist_done_count: 0,
    ...(order === undefined ? {} : { sort_order: order }),
  };
}
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
function workspace(
  tasks = [
    task('source', null, 1024),
    task('source-child', 'source', 1024),
    task('source-grandchild', 'source-child', 1024),
    task('parent', null, 2048),
    task('target', 'parent', 1024),
    task('target-child', 'target', 1024),
  ],
  goals: Record<string, string | null> = {},
): TimelineWorkspace {
  return {
    tasks,
    goals: [goal('g1'), goal('g2')],
    statuses: [],
    milestones: [],
    links: tasks.flatMap((item) => {
      const id = item.id in goals ? goals[item.id] : 'g1';
      return id === null ? [] : [{ task_id: item.id, goal_id: id }];
    }),
  };
}
function target(
  id: string | null,
  placement: TimelineHierarchyTarget['placement'] = 'inside',
  kind: TimelineHierarchyTarget['kind'] = 'task',
): TimelineHierarchyTarget {
  return { id, placement, kind };
}

describe('Timeline hierarchy pointer drop quarters', () => {
  it.each([
    [-10, 'before'],
    [0, 'before'],
    [9.999, 'before'],
    [10, 'inside'],
    [20, 'inside'],
    [30, 'inside'],
    [30.001, 'after'],
    [40, 'after'],
    [50, 'after'],
  ] as const)('maps y=%s in a 40px row to %s', (y, placement) => {
    expect(timelineHierarchyPlacement(y, 40)).toBe(placement);
  });
  it.each([
    [1, 0],
    [1, -20],
    [Number.NaN, 40],
    [Infinity, 40],
    [0, Number.NaN],
    [0, Infinity],
  ])('handles invalid row geometry y=%s height=%s safely', (y, height) => {
    expect(timelineHierarchyPlacement(y, height)).toBe('inside');
  });
});

describe('Timeline hierarchy target validation and parent choice', () => {
  it.each(['before', 'inside', 'after'] as const)(
    'rejects %s on source itself',
    (placement) => {
      expect(
        timelineHierarchyDrop(
          workspace(),
          'source',
          target('source', placement),
        ),
      ).toMatchObject({ valid: false, reason: 'Cannot drop on itself' });
    },
  );
  it.each(['before', 'inside', 'after'] as const)(
    'rejects %s on a descendant hidden by a collapsed ancestor',
    (placement) => {
      const data = workspace();
      const visible = buildTimelineRows(
        data,
        new Map(data.links.map((row) => [row.task_id, row.goal_id])),
        new Set(),
        new Set(['source']),
      );
      expect(
        visible.some(
          (row) => row.kind === 'task' && row.task.id === 'source-grandchild',
        ),
      ).toBe(false);
      expect(
        timelineHierarchyDrop(
          data,
          'source',
          target('source-grandchild', placement),
        ),
      ).toMatchObject({
        valid: false,
        reason: 'Cannot move into a descendant',
      });
    },
  );
  it.each(['before', 'after'] as const)(
    '%s makes the source a sibling of the target, outside its complete subtree',
    (placement) => {
      expect(
        timelineHierarchyDrop(
          workspace(),
          'source',
          target('target', placement),
        ),
      ).toMatchObject({
        valid: true,
        parentId: 'parent',
        label: placement === 'before' ? 'Before' : 'After',
      });
    },
  );
  it('Inside appends under the target and accepts an unscheduled source', () => {
    const data = workspace();
    expect(data.tasks[0].planned_start).toBeNull();
    expect(
      timelineHierarchyDrop(data, 'source', target('target')),
    ).toMatchObject({ valid: true, parentId: 'target', label: 'Inside' });
  });
  it('Before a root chooses a root parent', () => {
    expect(
      timelineHierarchyDrop(workspace(), 'target', target('source', 'before')),
    ).toMatchObject({ valid: true, parentId: null });
  });
  it('Goal header appends at root level inside the same Goal', () => {
    expect(
      timelineHierarchyDrop(
        workspace(),
        'target',
        target('g1', 'inside', 'goal'),
      ),
    ).toMatchObject({ valid: true, parentId: null });
  });
  it.each(['before', 'after'] as const)(
    'rejects %s on a Goal header',
    (placement) => {
      expect(
        timelineHierarchyDrop(
          workspace(),
          'source',
          target('g1', placement, 'goal'),
        ),
      ).toMatchObject({ valid: false, reason: 'Drop inside a Goal' });
    },
  );
  it('rejects task and Goal targets in a different Goal', () => {
    const data = workspace(undefined, { target: 'g2' });
    expect(timelineHierarchyDrop(data, 'source', target('target')).reason).toBe(
      'Different Goal',
    );
    expect(
      timelineHierarchyDrop(data, 'source', target('g2', 'inside', 'goal'))
        .reason,
    ).toBe('Different Goal');
  });
  it('allows Inbox tasks only with other raw Inbox targets and null Goal header', () => {
    const data = workspace(undefined, {
      source: null,
      'source-child': null,
      'source-grandchild': null,
      parent: null,
      target: null,
      'target-child': null,
    });
    expect(timelineHierarchyDrop(data, 'source', target('target')).valid).toBe(
      true,
    );
    expect(
      timelineHierarchyDrop(data, 'source', target(null, 'inside', 'goal')),
    ).toMatchObject({ valid: true, parentId: null });
    expect(
      timelineHierarchyDrop(data, 'source', target('g1', 'inside', 'goal'))
        .reason,
    ).toBe('Different Goal');
    expect(
      timelineHierarchyDrop(data, 'source', target('inbox', 'inside', 'goal'))
        .valid,
    ).toBe(false);
  });
  it('does not reinterpret an unavailable raw Goal link as Inbox', () => {
    const data = workspace(undefined, { source: 'archived-goal' });
    expect(
      timelineHierarchyDrop(data, 'source', target(null, 'inside', 'goal')),
    ).toMatchObject({ valid: false, reason: 'Goal is unavailable' });
    expect(
      timelineHierarchyTree(data).find((row) => row.id === 'source')?.goal_id,
    ).toBe('archived-goal');
  });
  it('rejects missing source and missing target', () => {
    expect(
      timelineHierarchyDrop(workspace(), 'missing', target('target')).reason,
    ).toBe('Task is no longer available');
    expect(
      timelineHierarchyDrop(workspace(), 'source', target('missing')).reason,
    ).toBe('Target is no longer available');
  });
  it('rejects a target with a pre-existing ancestor cycle without looping', () => {
    const data = workspace([task('source'), task('a', 'b'), task('b', 'a')]);
    expect(timelineHierarchyDrop(data, 'source', target('a'))).toMatchObject({
      valid: false,
      reason: 'Task hierarchy needs repair',
    });
  });
  it('rejects a target whose ancestor is missing from the active workspace', () => {
    const data = workspace([task('source'), task('target', 'missing')]);
    expect(
      timelineHierarchyDrop(data, 'source', target('target')),
    ).toMatchObject({
      valid: false,
      reason: 'Task hierarchy needs repair',
    });
  });
  it('rejects a target whose ancestor belongs to another raw Goal', () => {
    const data = workspace(
      [task('source'), task('target', 'parent'), task('parent')],
      { parent: 'g2' },
    );
    expect(
      timelineHierarchyDrop(data, 'source', target('target')),
    ).toMatchObject({
      valid: false,
      reason: 'Task hierarchy needs repair',
    });
  });
  it('leaves the complete input and target unchanged when resolving valid and invalid drops', () => {
    const data = workspace();
    const candidate = target('target', 'after');
    const before = structuredClone({ data, candidate });
    timelineHierarchyDrop(data, 'source', candidate);
    timelineHierarchyDrop(data, 'source', target('source-child'));
    expect({ data, candidate }).toEqual(before);
  });
});

describe('Timeline hierarchy frozen structural snapshots', () => {
  it('normalizes ordering and null sort values while retaining every collapsed descendant', () => {
    const data = workspace();
    const before = structuredClone(data);
    const tree = timelineHierarchyTree(data);
    expect(tree.map((row) => row.id)).toEqual(tree.map((row) => row.id).sort());
    expect(tree).toHaveLength(data.tasks.length);
    expect(tree.find((row) => row.id === 'source-grandchild')).toMatchObject({
      parent_task_id: 'source-child',
      goal_id: 'g1',
    });
    expect(data).toEqual(before);
    expect(sameTimelineHierarchy(tree, [...tree].reverse())).toBe(true);
  });
  it.each(['parent_task_id', 'goal_id', 'sort_order'] as const)(
    'rejects a server snapshot that changes a hidden descendant %s',
    (field) => {
      const tree = timelineHierarchyTree(workspace());
      const changed = structuredClone(tree);
      const hidden = changed.find((row) => row.id === 'source-grandchild')!;
      if (field === 'sort_order') hidden.sort_order = 999;
      else hidden[field] = 'different';
      expect(sameTimelineHierarchy(tree, changed)).toBe(false);
    },
  );
  it('detects additions and removals while ignoring unrelated metadata changes', () => {
    const data = workspace();
    const tree = timelineHierarchyTree(data);
    const renamed = structuredClone(data);
    renamed.tasks[0].title = 'Another title';
    renamed.tasks[0].planned_start = '2035-01-01';
    expect(sameTimelineHierarchy(tree, timelineHierarchyTree(renamed))).toBe(
      true,
    );
    expect(sameTimelineHierarchy(tree, tree.slice(1))).toBe(false);
    expect(
      sameTimelineHierarchy(tree, [
        ...tree,
        { id: 'new', parent_task_id: null, goal_id: 'g1', sort_order: null },
      ]),
    ).toBe(false);
  });
  it('does not mutate snapshots during comparison and distinguishes null from zero order', () => {
    const a: TimelineHierarchyTree = [
      { id: 'a', parent_task_id: null, goal_id: null, sort_order: null },
    ];
    const b = [{ ...a[0], sort_order: 0 }];
    const before = structuredClone({ a, b });
    expect(sameTimelineHierarchy(a, b)).toBe(false);
    expect({ a, b }).toEqual(before);
  });
});

describe('Timeline hierarchy no-op detection preserves the existing Undo receipt', () => {
  it('recognizes Before an immediate sibling even when the source has a complete subtree', () => {
    const data = workspace();
    const before = structuredClone(data);
    expect(
      timelineHierarchyNoop(
        data,
        'source',
        timelineHierarchyDrop(data, 'source', target('parent', 'before')),
      ),
    ).toBe(true);
    expect(
      timelineHierarchyNoop(
        data,
        'source',
        timelineHierarchyDrop(data, 'source', target('parent', 'after')),
      ),
    ).toBe(false);
    expect(data).toEqual(before);
  });
  it('recognizes After the immediately preceding sibling', () => {
    const data = workspace();
    expect(
      timelineHierarchyNoop(
        data,
        'parent',
        timelineHierarchyDrop(data, 'parent', target('source', 'after')),
      ),
    ).toBe(true);
  });
  it('skips a root append only when the source is already last in its Goal', () => {
    const data = workspace();
    expect(
      timelineHierarchyNoop(
        data,
        'parent',
        timelineHierarchyDrop(data, 'parent', target('g1', 'inside', 'goal')),
      ),
    ).toBe(true);
    expect(
      timelineHierarchyNoop(
        data,
        'source',
        timelineHierarchyDrop(data, 'source', target('g1', 'inside', 'goal')),
      ),
    ).toBe(false);
  });
  it('skips Inside an existing parent only when already its last child', () => {
    const data = workspace([
      task('parent'),
      task('first', 'parent', 1024),
      task('last', 'parent', 2048),
    ]);
    expect(
      timelineHierarchyNoop(
        data,
        'last',
        timelineHierarchyDrop(data, 'last', target('parent')),
      ),
    ).toBe(true);
    expect(
      timelineHierarchyNoop(
        data,
        'first',
        timelineHierarchyDrop(data, 'first', target('parent')),
      ),
    ).toBe(false);
  });
  it('never suppresses an actual parent change even when the source is its only current sibling', () => {
    const data = workspace();
    expect(
      timelineHierarchyNoop(
        data,
        'source-child',
        timelineHierarchyDrop(data, 'source-child', target('target')),
      ),
    ).toBe(false);
  });
  it('uses the repository ordering for tied/null orders and isolates other Goals', () => {
    const data = workspace(
      [task('first'), task('last'), task('elsewhere', null, 9000)],
      { elsewhere: 'g2' },
    );
    expect(
      timelineHierarchyNoop(
        data,
        'last',
        timelineHierarchyDrop(data, 'last', target('g1', 'inside', 'goal')),
      ),
    ).toBe(true);
  });
  it('rejects invalid candidates and unavailable sources instead of treating them as no-ops', () => {
    const data = workspace();
    expect(
      timelineHierarchyNoop(
        data,
        'source',
        timelineHierarchyDrop(data, 'source', target('source-child')),
      ),
    ).toBe(false);
    expect(
      timelineHierarchyNoop(
        data,
        'missing',
        timelineHierarchyDrop(data, 'missing', target('g1', 'inside', 'goal')),
      ),
    ).toBe(false);
  });
});
