import type {
  TimelineWorkspace,
  TimelineHierarchyTree,
} from './data/repository';

export type TimelineHierarchyTarget = {
  kind: 'goal' | 'task';
  id: string | null;
  placement: 'inside' | 'before' | 'after';
};
export type TimelineHierarchyDrop = {
  target: TimelineHierarchyTarget;
  valid: boolean;
  reason: string;
  parentId: string | null;
  label: 'Inside' | 'Before' | 'After';
};

export function timelineHierarchyPlacement(
  y: number,
  height: number,
): TimelineHierarchyTarget['placement'] {
  if (height <= 0 || !Number.isFinite(y) || !Number.isFinite(height))
    return 'inside';
  return y < height * 0.25 ? 'before' : y > height * 0.75 ? 'after' : 'inside';
}

export function timelineHierarchyTree(
  workspace: Pick<TimelineWorkspace, 'tasks' | 'links'>,
): TimelineHierarchyTree {
  const links = new Map(
    workspace.links.map((item) => [item.task_id, item.goal_id]),
  );
  return workspace.tasks
    .map((task) => ({
      id: task.id,
      parent_task_id: task.parent_task_id ?? null,
      goal_id: links.get(task.id) ?? null,
      sort_order: task.sort_order ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function sameTimelineHierarchy(
  a: TimelineHierarchyTree,
  b: TimelineHierarchyTree,
) {
  const normalized = (tree: TimelineHierarchyTree) =>
    [...tree]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => [
        row.id,
        row.parent_task_id ?? null,
        row.goal_id ?? null,
        row.sort_order ?? null,
      ]);
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

/** Validate against the complete frozen tree, including collapsed descendants. */
export function timelineHierarchyDrop(
  workspace: Pick<TimelineWorkspace, 'tasks' | 'goals' | 'links'>,
  sourceId: string,
  target: TimelineHierarchyTarget,
): TimelineHierarchyDrop {
  const tasks = new Map(workspace.tasks.map((task) => [task.id, task]));
  const links = new Map(
    workspace.links.map((item) => [item.task_id, item.goal_id]),
  );
  const source = tasks.get(sourceId);
  const goalId = links.get(sourceId) ?? null;
  const label =
    target.placement === 'inside'
      ? 'Inside'
      : target.placement === 'before'
        ? 'Before'
        : 'After';
  const result = (
    reason: string,
    parentId: string | null = null,
  ): TimelineHierarchyDrop => ({
    target,
    label,
    valid: !reason,
    reason,
    parentId,
  });
  if (!source) return result('Task is no longer available');
  if (goalId && !workspace.goals.some((goal) => goal.id === goalId))
    return result('Goal is unavailable');
  if (target.kind === 'goal') {
    if (target.placement !== 'inside') return result('Drop inside a Goal');
    if (target.id !== goalId) return result('Different Goal');
    return result('');
  }
  const destination = tasks.get(target.id ?? '');
  if (!destination) return result('Target is no longer available');
  if (destination.id === sourceId) return result('Cannot drop on itself');
  if ((links.get(destination.id) ?? null) !== goalId)
    return result('Different Goal');
  const seen = new Set<string>();
  let ancestor: string | null = destination.id;
  while (ancestor) {
    if (ancestor === sourceId) return result('Cannot move into a descendant');
    if (seen.has(ancestor)) return result('Task hierarchy needs repair');
    seen.add(ancestor);
    const row = tasks.get(ancestor);
    if (!row || (links.get(ancestor) ?? null) !== goalId)
      return result('Task hierarchy needs repair');
    ancestor = row.parent_task_id;
  }
  return result(
    '',
    target.placement === 'inside' ? destination.id : destination.parent_task_id,
  );
}

/** Skip view-level no-ops so an empty command never replaces the Undo receipt. */
export function timelineHierarchyNoop(
  workspace: Pick<TimelineWorkspace, 'tasks' | 'links'>,
  sourceId: string,
  drop: TimelineHierarchyDrop,
) {
  const source = workspace.tasks.find((task) => task.id === sourceId);
  if (!drop.valid || !source || source.parent_task_id !== drop.parentId)
    return false;
  const links = new Map(
    workspace.links.map((row) => [row.task_id, row.goal_id]),
  );
  const goal = links.get(sourceId) ?? null;
  const siblings = workspace.tasks
    .filter(
      (task) =>
        task.parent_task_id === drop.parentId &&
        (links.get(task.id) ?? null) === goal,
    )
    .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
    .map((task) => task.id);
  const next = siblings.filter((id) => id !== sourceId);
  const target =
    drop.target.placement === 'inside'
      ? -1
      : next.indexOf(drop.target.id ?? '');
  const at =
    target < 0
      ? next.length
      : target + Number(drop.target.placement === 'after');
  next.splice(at, 0, sourceId);
  return siblings.join('|') === next.join('|');
}
