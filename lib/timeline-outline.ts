import type { Goal, Task, TimelineWorkspace } from './data/repository';
export type TimelineOutlineRow =
  | { kind: 'goal'; goal: Goal }
  | {
      kind: 'task';
      task: Task;
      goalId: string | null;
      depth: number;
      hasChildren: boolean;
    };

// Collapse is view state only. Consume hidden descendants too, so the orphan
// fallback cannot accidentally re-add them as top-level rows.
export function buildTimelineRows(
  workspace: Pick<TimelineWorkspace, 'goals' | 'tasks'>,
  links: Map<string, string>,
  collapsedGoals: Set<string>,
  collapsedTasks: Set<string> = new Set(),
): TimelineOutlineRow[] {
  const rows: TimelineOutlineRow[] = [],
    activeGoals = new Set(workspace.goals.map((g) => g.id));
  const goalOf = (task: Task) => {
    const id = links.get(task.id);
    return id && activeGoals.has(id) ? id : null;
  };
  const byId = new Map(workspace.tasks.map((t) => [t.id, t]));
  const children = new Map<string, Task[]>();
  for (const task of workspace.tasks) {
    const parent = task.parent_task_id && byId.get(task.parent_task_id);
    if (parent && goalOf(parent) === goalOf(task)) {
      const list = children.get(parent.id) ?? [];
      list.push(task);
      children.set(parent.id, list);
    }
  }
  function appendGroup(goalId: string | null) {
    const tasks = workspace.tasks.filter((t) => goalOf(t) === goalId),
      ids = new Set(tasks.map((t) => t.id)),
      seen = new Set<string>();
    function append(task: Task) {
      const stack = [{ task, depth: 0, hidden: false }];
      while (stack.length) {
        const item = stack.pop()!;
        if (seen.has(item.task.id)) continue;
        seen.add(item.task.id);
        const descendants = children.get(item.task.id) ?? [];
        if (!item.hidden)
          rows.push({
            kind: 'task',
            task: item.task,
            goalId,
            depth: item.depth,
            hasChildren: descendants.length > 0,
          });
        const hidden = item.hidden || collapsedTasks.has(item.task.id);
        for (let i = descendants.length - 1; i >= 0; --i)
          stack.push({ task: descendants[i], depth: item.depth + 1, hidden });
      }
    }
    tasks
      .filter((t) => !t.parent_task_id || !ids.has(t.parent_task_id))
      .forEach(append);
    tasks.forEach(append); // Existing cyclic/orphan parents remain recoverable.
  }
  for (const goal of workspace.goals) {
    rows.push({ kind: 'goal', goal });
    if (!collapsedGoals.has(goal.id)) appendGroup(goal.id);
  }
  const inbox: Goal = {
    id: 'inbox',
    title: 'Inbox — no goal',
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
  rows.push({ kind: 'goal', goal: inbox });
  if (!collapsedGoals.has('inbox')) appendGroup(null);
  return rows;
}
