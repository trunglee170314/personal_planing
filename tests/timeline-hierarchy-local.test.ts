import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { undoContext } from '../local-server/undo.mjs';
import { buildTimelineRows } from '../lib/timeline-outline';
import type {
  TimelineHierarchyPlan,
  TimelineWorkspace,
} from '../lib/data/repository';

describe('Local atomic Timeline hierarchy commands', () => {
  let db: LocalDatabase;
  let g: string, other: string;
  let a: string,
    a1: string,
    a11: string,
    a2: string,
    b: string,
    b1: string,
    c: string,
    d: string,
    p: string,
    q: string;
  const tasks = () => db.db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const row = (id: string) =>
    db.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)!;
  const links = () =>
    db.db
      .prepare(
        'SELECT task_id,goal_id FROM task_goal_links ORDER BY task_id,goal_id',
      )
      .all();
  function create(
    title: string,
    goalId: string | null,
    parent: string | null,
    order: number,
  ) {
    const id = db.createTask({
      title,
      priority: 'high',
      workflow_status_id: 'local-status-planned',
      goal_id: goalId,
      parent_task_id: parent,
      planned_start: '2035-01-01',
      due_at: '2035-01-31T16:59:00.000Z',
      link_url: 'https://example.com/task',
    });
    db.db.prepare('UPDATE tasks SET sort_order=? WHERE id=?').run(order, id);
    return id;
  }
  beforeEach(() => {
    db = new LocalDatabase(':memory:');
    g = db.createGoal({
      title: 'Goal',
      starts_on: '2035-01-01',
      ends_on: '2035-01-31',
    });
    other = db.createGoal({ title: 'Other' });
    a = create('A', g, null, 1024);
    a1 = create('A1', g, a, 1024);
    a11 = create('A11', g, a1, 1024);
    a2 = create('A2', g, a, 2048);
    b = create('B', g, null, 2048);
    b1 = create('B1', g, b, 1024);
    c = create('C', g, null, 3072);
    d = create('D', other, null, 1024);
    p = create('Inbox P', null, null, 1024);
    q = create('Inbox Q', null, null, 2048);
  });
  afterEach(() => db.close());
  const children = (parent: string | null, goalId: string | null = g) =>
    db.db
      .prepare(
        `SELECT t.id FROM tasks t LEFT JOIN task_goal_links l ON l.task_id=t.id WHERE t.parent_task_id IS ? AND l.goal_id IS ? AND t.archived_at IS NULL AND t.deleted_at IS NULL ORDER BY t.sort_order,t.created_at,t.id`,
      )
      .all(parent, goalId)
      .map((t) => t.id);
  function move(
    source: string,
    target: string | null,
    placement: 'inside' | 'before' | 'after',
    targetKind: 'task' | 'goal' = 'task',
    version = db.previewTimelineHierarchy(source).version,
  ) {
    db.restructureTimeline({
      task_id: source,
      target_kind: targetKind,
      target_id: target,
      placement,
      expected_version: version,
    });
  }
  it('previews every account active Task in ID order with an opaque metadata version', () => {
    const first = db.previewTimelineHierarchy(a) as TimelineHierarchyPlan;
    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tree).toHaveLength(10);
    expect(first.tree.map((t) => t.id)).toEqual(
      first.tree.map((t) => t.id).sort((x, y) => x.localeCompare(y)),
    );
    expect(first.tree.find((t) => t.id === a1)).toEqual({
      id: a1,
      parent_task_id: a,
      goal_id: g,
      sort_order: 1024,
    });
    expect(first.tree.find((t) => t.id === p)?.goal_id).toBeNull();
    expect(db.previewTimelineHierarchy(b).version).toBe(first.version);
  });
  it('Inside appends the whole source branch after existing children', () => {
    const descendantA1 = { ...row(a1) },
      descendantA11 = { ...row(a11) },
      descendantA2 = { ...row(a2) };
    move(a, b, 'inside');
    expect(row(a).parent_task_id).toBe(b);
    expect(children(b)).toEqual([b1, a]);
    expect(children(null)).toEqual([b, c]);
    expect(row(a1)).toEqual(descendantA1);
    expect(row(a11)).toEqual(descendantA11);
    expect(row(a2)).toEqual(descendantA2);
  });
  it('Before adopts the target parent and keeps the source descendants attached', () => {
    move(b, a2, 'before');
    expect(row(b).parent_task_id).toBe(a);
    expect(children(a)).toEqual([a1, b, a2]);
    expect(row(b1).parent_task_id).toBe(b);
  });
  it('After adopts the target parent and inserts immediately after its whole branch', () => {
    move(b, a1, 'after');
    expect(children(a)).toEqual([a1, b, a2]);
    const workspace = db.getTimelineWorkspace() as unknown as TimelineWorkspace;
    const outlines = buildTimelineRows(
      workspace,
      new Map(workspace.links.map((l) => [l.task_id, l.goal_id])),
      new Set(),
    );
    const ids = outlines.filter((r) => r.kind === 'task').map((r) => r.task.id);
    expect(ids.indexOf(b)).toBeGreaterThan(ids.indexOf(a11));
    expect(row(b1).parent_task_id).toBe(b);
  });
  it('can promote a nested branch Before a root sibling', () => {
    move(a1, b, 'before');
    expect(children(null)).toEqual([a, a1, b, c]);
    expect(row(a1).parent_task_id).toBeNull();
    expect(row(a11).parent_task_id).toBe(a1);
  });
  it('Goal Inside appends the branch to the roots without flattening descendants', () => {
    move(a1, g, 'inside', 'goal');
    expect(children(null)).toEqual([a, b, c, a1]);
    expect(row(a11).parent_task_id).toBe(a1);
    expect(children(a)).toEqual([a2]);
  });
  it('allows reparenting and promoting Inbox Tasks only within raw-null Goal membership', () => {
    move(p, q, 'inside');
    expect(children(q, null)).toEqual([p]);
    move(p, null, 'inside', 'goal');
    expect(children(null, null)).toEqual([q, p]);
  });
  it('preserves every Task field other than source parent, destination order and update timestamps', () => {
    const before = tasks(),
      beforeLinks = links();
    const strip = (t: Record<string, unknown>) => {
      const { parent_task_id: _p, sort_order: _o, updated_at: _u, ...rest } = t;
      return rest;
    };
    move(a, b, 'inside');
    expect(tasks().map(strip)).toEqual(before.map(strip));
    expect(links()).toEqual(beforeLinks);
    for (const original of before)
      if (original.id !== a)
        expect(row(String(original.id)).parent_task_id).toBe(
          original.parent_task_id,
        );
  });
  it('preserves Calendar schedules, occurrence identities, notes and all Task/Goal milestones', () => {
    const entry = db.createCalendarSession({
      title: 'Checklist',
      task_id: a1,
      item_type: 'checklist',
      starts_at: '2035-01-01T01:00:00.000Z',
      ends_at: '2035-01-01T02:00:00.000Z',
      recurrence: 'daily',
      recurrence_until: '2035-01-03',
      timezone: 'Asia/Ho_Chi_Minh',
      all_day: false,
      notification_offsets: [15],
    });
    db.updateCalendarOccurrence(entry, {
      occurrence_start: '2035-01-02T01:00:00.000Z',
      completed_at: '2035-01-02T02:00:00.000Z',
    });
    db.saveAnnotation(
      { kind: 'task', id: a1 },
      { kind: 'comment', body: 'Task note', url: null },
    );
    db.createTimelineMilestone({
      title: 'A mark',
      task_id: a,
      goal_id: null,
      milestone_on: '2035-01-03',
      is_important: true,
    });
    db.createTimelineMilestone({
      title: 'Child mark',
      task_id: a1,
      goal_id: null,
      milestone_on: '2035-01-04',
    });
    db.createTimelineMilestone({
      title: 'Goal mark',
      goal_id: g,
      milestone_on: '2035-01-05',
    });
    const snapshot = () =>
      [
        'calendar_sessions',
        'calendar_occurrence_states',
        'planner_annotations',
        'timeline_milestones',
      ].map((table) =>
        db.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      );
    const before = snapshot();
    move(a, b, 'inside');
    expect(snapshot()).toEqual(before);
  });
  it.each(['inside', 'before', 'after'] as const)(
    'rejects self %s without any mutation',
    (placement) => {
      const before = tasks();
      expect(() => move(a, a, placement)).toThrow(/itself/);
      expect(tasks()).toEqual(before);
    },
  );
  it.each(['inside', 'before', 'after'] as const)(
    'rejects an own-descendant %s target',
    (placement) => {
      const before = tasks();
      expect(() => move(a, a11, placement)).toThrow(/subtree|cyclic/);
      expect(tasks()).toEqual(before);
    },
  );
  it('detects descendants connected through an archived intermediate parent', () => {
    db.db
      .prepare('UPDATE tasks SET archived_at=? WHERE id=?')
      .run('2035-01-01T00:00Z', a1);
    const before = tasks();
    expect(() => move(a, a11, 'inside')).toThrow(/subtree|cyclic|repair/);
    expect(tasks()).toEqual(before);
  });
  it('rejects cross-Goal Task targets while preserving the old links and subtree', () => {
    const before = tasks(),
      oldLinks = links();
    expect(() => move(a, d, 'inside')).toThrow(/same Goal/);
    expect(tasks()).toEqual(before);
    expect(links()).toEqual(oldLinks);
  });
  it('rejects cross-Goal headers and Inbox moves of Goal-owned Tasks', () => {
    expect(() => move(a, other, 'inside', 'goal')).toThrow(/same Goal/);
    expect(() => move(a, null, 'inside', 'goal')).toThrow(/same Goal/);
  });
  it('rejects an archived Goal even when its active Tasks render in Inbox', () => {
    const version = db.previewTimelineHierarchy(a).version;
    db.updateGoal(g, { status: 'archived', archived_at: '2035-01-01T00:00Z' });
    expect(() => move(a, b, 'inside', 'task', version)).toThrow(
      /Goal is unavailable/,
    );
  });
  it('does not preview archived or deleted source Tasks', () => {
    db.db
      .prepare('UPDATE tasks SET archived_at=? WHERE id=?')
      .run('2035-01-01T00:00Z', a);
    db.db
      .prepare('UPDATE tasks SET deleted_at=? WHERE id=?')
      .run('2035-01-01T00:00Z', b);
    expect(() => db.previewTimelineHierarchy(a)).toThrow(/not found/);
    expect(() => db.previewTimelineHierarchy(b)).toThrow(/not found/);
  });
  it('rejects archived and deleted targets absent from the current active snapshot', () => {
    db.db
      .prepare('UPDATE tasks SET archived_at=? WHERE id=?')
      .run('2035-01-01T00:00Z', b);
    db.db
      .prepare('UPDATE tasks SET deleted_at=? WHERE id=?')
      .run('2035-01-01T00:00Z', c);
    expect(() => move(a, b, 'inside')).toThrow(/not found/);
    expect(() => move(a, c, 'inside')).toThrow(/not found/);
  });
  it('rejects stale tree parents, ordering or metadata without clobbering later changes', () => {
    const first = db.previewTimelineHierarchy(a).version;
    db.db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(b, a2);
    const expected = tasks();
    expect(() => move(a, b, 'inside', 'task', first)).toThrow(/changed/);
    expect(tasks()).toEqual(expected);
    const second = db.previewTimelineHierarchy(a).version;
    db.db.prepare('UPDATE tasks SET sort_order=? WHERE id=?').run(99, c);
    expect(() => move(a, b, 'inside', 'task', second)).toThrow(/changed/);
    const third = db.previewTimelineHierarchy(a).version;
    db.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('Later title', d);
    expect(() => move(a, b, 'inside', 'task', third)).toThrow(/changed/);
  });
  it('includes another Goal and Inbox changes in the frozen account-wide version', () => {
    const first = db.previewTimelineHierarchy(a).version;
    move(p, q, 'inside');
    expect(() => move(a, b, 'inside', 'task', first)).toThrow(/changed/);
  });
  it('does not silently accept exact no-op drops and discard older Undo history', () => {
    const before = tasks();
    expect(() => move(b, a, 'after')).toThrow(/already/);
    expect(tasks()).toEqual(before);
  });
  it('keeps a previous Undo receipt usable after a rejected no-op', () => {
    const operation = '00000000-0000-4000-8000-000000000121',
      session = '00000000-0000-4000-8000-000000000122';
    undoContext.run({ operation, session }, () =>
      db.updateTask(c, { title: 'A later title' }),
    );
    expect(() => move(b, a, 'after')).toThrow(/already/);
    (
      db as LocalDatabase & {
        applyUndo: (operation: string, session: string) => void;
      }
    ).applyUndo(operation, session);
    expect(row(c).title).toBe('C');
  });
  it('rejects malformed placement, target type and missing versions atomically', () => {
    const base = {
      task_id: a,
      target_kind: 'task',
      target_id: b,
      placement: 'inside',
      expected_version: db.previewTimelineHierarchy(a).version,
    };
    const before = tasks();
    for (const changes of [
      { placement: 'around' },
      { target_kind: 'unknown' },
      { expected_version: '' },
      { target_id: null },
    ])
      expect(() => db.restructureTimeline({ ...base, ...changes })).toThrow();
    expect(tasks()).toEqual(before);
  });
  it('rejects a cyclic legacy target ancestor chain instead of creating another cycle', () => {
    db.db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(b1, b);
    const before = tasks();
    expect(() => move(a, b, 'inside')).toThrow(/cyclic/);
    expect(tasks()).toEqual(before);
  });
  it('rejects a legacy missing parent rather than attaching a branch to it', () => {
    db.db.exec('PRAGMA foreign_keys=OFF');
    db.db
      .prepare('UPDATE tasks SET parent_task_id=? WHERE id=?')
      .run('missing-parent', b);
    db.db.exec('PRAGMA foreign_keys=ON');
    const before = tasks();
    expect(() => move(a, b, 'inside')).toThrow(/repair/);
    expect(tasks()).toEqual(before);
  });
  it('recomputes Goal-derived leaf progress while retaining the completed parent Task status', () => {
    db.setTaskCompletion(c, true);
    expect(db.listGoals().find((goal) => goal.id === g)?.progress).toBe(25);
    const completedTask = { ...row(c) };
    move(a, c, 'inside');
    expect(db.listGoals().find((goal) => goal.id === g)?.progress).toBe(0);
    expect(row(c)).toEqual(completedTask);
  });
  it('hierarchy Undo preserves a later unrelated Task title edit', () => {
    const operation = '00000000-0000-4000-8000-000000000131',
      session = '00000000-0000-4000-8000-000000000132';
    undoContext.run({ operation, session }, () => move(a, b, 'inside'));
    db.updateTask(a, { title: 'Keep this title' });
    (
      db as LocalDatabase & {
        applyUndo: (operation: string, session: string) => void;
      }
    ).applyUndo(operation, session);
    expect(row(a).parent_task_id).toBeNull();
    expect(row(a).title).toBe('Keep this title');
  });
  it('rejects a target ancestor chain crossing raw Goal membership', () => {
    db.db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(d, b);
    const before = tasks();
    expect(() => move(a, b, 'inside')).toThrow(/repair/);
    expect(tasks()).toEqual(before);
  });
  it('rejects a target with an inactive ancestor even though the target itself is active', () => {
    db.db
      .prepare('UPDATE tasks SET archived_at=? WHERE id=?')
      .run('2035-01-01T00:00Z', b);
    const before = tasks();
    expect(() => move(a, b1, 'inside')).toThrow(/repair/);
    expect(tasks()).toEqual(before);
  });
  it('Undo restores parent, sibling order and derived Goal changes as one atomic command', () => {
    const before = db.getTimelineWorkspace(),
      originalTasks = tasks();
    const operation = '00000000-0000-4000-8000-000000000111',
      session = '00000000-0000-4000-8000-000000000112';
    undoContext.run({ operation, session }, () => move(a, b, 'inside'));
    (
      db as LocalDatabase & {
        applyUndo: (operation: string, session: string) => void;
      }
    ).applyUndo(operation, session);
    expect(db.getTimelineWorkspace()).toEqual(before);
    expect(tasks().map(({ updated_at: _u, ...rest }) => rest)).toEqual(
      originalTasks.map(({ updated_at: _u, ...rest }) => rest),
    );
  });
});
