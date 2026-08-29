import { describe, it, expect } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { buildTimelineRows } from '../lib/timeline-outline';
import type { TimelineWorkspace } from '../lib/data/repository';
describe('Timeline parent collapse', () => {
  function setup() {
    const db = new LocalDatabase(':memory:');
    const goal = db.createGoal({ title: 'Career' });
    const project = db.createTask({
      title: 'Project',
      workflow_status_id: 'local-status-planned',
      priority: 'medium',
      goal_id: goal,
    });
    const child = db.createTask({
      title: 'Child',
      workflow_status_id: 'local-status-planned',
      priority: 'medium',
      goal_id: goal,
      parent_task_id: project,
    });
    const leaf = db.createTask({
      title: 'Leaf',
      workflow_status_id: 'local-status-planned',
      priority: 'medium',
      goal_id: goal,
      parent_task_id: child,
    });
    const sibling = db.createTask({
      title: 'Other project',
      workflow_status_id: 'local-status-planned',
      priority: 'medium',
      goal_id: goal,
    });
    const workspace = db.getTimelineWorkspace() as unknown as TimelineWorkspace;
    db.close();
    return {
      goal,
      project,
      child,
      leaf,
      sibling,
      workspace,
      links: new Map(workspace.links.map((l) => [l.task_id, l.goal_id])),
    };
  }
  it('collapses all descendants, keeps parent/siblings and never re-adds hidden children as orphans', () => {
    const f = setup(),
      before = structuredClone(f.workspace),
      rows = buildTimelineRows(
        f.workspace,
        f.links,
        new Set(),
        new Set([f.project]),
      );
    expect(rows.filter((r) => r.kind === 'task').map((r) => r.task.id)).toEqual(
      [f.project, f.sibling],
    );
    expect(f.workspace).toEqual(before);
  });
  it('restores nested branch state and supports every parent depth', () => {
    const f = setup();
    const rows = buildTimelineRows(
      f.workspace,
      f.links,
      new Set(),
      new Set([f.child]),
    );
    expect(rows.filter((r) => r.kind === 'task').map((r) => r.task.id)).toEqual(
      [f.project, f.child, f.sibling],
    );
    const full = buildTimelineRows(f.workspace, f.links, new Set());
    expect(
      full
        .filter((r) => r.kind === 'task')
        .map((r) =>
          r.kind === 'task' ? [r.task.id, r.depth, r.hasChildren] : [],
        ),
    ).toEqual([
      [f.project, 0, true],
      [f.child, 1, true],
      [f.leaf, 2, false],
      [f.sibling, 0, false],
    ]);
  });
  it('goal collapse remains independent and search can request an expanded tree without changing collapse state', () => {
    const f = setup(),
      state = new Set([f.project]);
    expect(
      buildTimelineRows(f.workspace, f.links, new Set([f.goal]), state).filter(
        (r) => r.kind === 'task',
      ),
    ).toHaveLength(0);
    expect(
      buildTimelineRows(f.workspace, f.links, new Set(), new Set()).filter(
        (r) => r.kind === 'task',
      ),
    ).toHaveLength(4);
    expect(state.has(f.project)).toBe(true);
  });
  it('handles Inbox, cross-goal parents, orphaned and cyclic legacy references', () => {
    const f = setup();
    const tasks = f.workspace.tasks.map((t) => ({ ...t }));
    tasks.find((t) => t.id === f.project)!.parent_task_id = f.child;
    const cyclic = { ...f.workspace, tasks };
    const full = buildTimelineRows(cyclic, f.links, new Set());
    expect(
      new Set(full.filter((r) => r.kind === 'task').map((r) => r.task.id)).size,
    ).toBe(4);
    const collapsed = buildTimelineRows(
      cyclic,
      f.links,
      new Set(),
      new Set([f.project]),
    );
    expect(
      collapsed.filter((r) => r.kind === 'task').map((r) => r.task.id),
    ).not.toContain(f.leaf);
    const inbox = buildTimelineRows(
      f.workspace,
      new Map(),
      new Set(),
      new Set([f.project]),
    );
    expect(
      inbox.filter((r) => r.kind === 'task').map((r) => r.task.id),
    ).toEqual([f.project, f.sibling]);
    const cross = new Map(f.links);
    cross.delete(f.child);
    expect(
      buildTimelineRows(f.workspace, cross, new Set(), new Set([f.project]))
        .filter((r) => r.kind === 'task')
        .map((r) => r.task.id),
    ).toContain(f.child);
  });
});
