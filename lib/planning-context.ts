import { matchesSearch, normalizeSearch } from './workspace-view';

export type PlanningContext = { goal?: string; task?: string };
type ContextWorkspace = {
  goals: readonly { id: string; title: string }[];
  tasks: readonly { id: string; title: string }[];
  links: readonly { task_id: string; goal_id: string }[];
};

/** Resolve current relations, never copy Goal/Task names into persisted tags. */
export function planningContext(
  workspace: ContextWorkspace,
  taskId?: string | null,
): PlanningContext {
  const task = workspace.tasks.find((item) => item.id === taskId);
  if (!task) return {};
  const goalId = workspace.links.find(
    (link) => link.task_id === task.id,
  )?.goal_id;
  return {
    task: task.title,
    goal: workspace.goals.find((goal) => goal.id === goalId)?.title,
  };
}

export function planningBreadcrumb(context: PlanningContext) {
  return [context.goal, context.task].filter(Boolean).join(' › ');
}

/** Plain words match inherited context; goal:/task: constrain the relation only. */
export function matchesPlanningSearch(
  query: string,
  context: PlanningContext,
  ...values: Array<string | null | undefined>
) {
  let scoped = true;
  const text = query.replace(
    /\b(goal|task):(?:"([^"]*)"|([^\s]*))/gi,
    (
      _match,
      kind: string,
      quoted: string | undefined,
      unquoted: string | undefined,
    ) => {
      const term = normalizeSearch(quoted ?? unquoted ?? '').trim();
      const value = normalizeSearch(
        context[kind.toLowerCase() as keyof PlanningContext] ?? '',
      );
      scoped = scoped && Boolean(term) && value.includes(term);
      return ' ';
    },
  );
  return scoped && matchesSearch(text, ...values, context.goal, context.task);
}
