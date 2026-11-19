import type {
  Goal,
  Task,
  TimelineMilestone,
  TimelineWorkspace,
} from './data/repository';
import { matchesPlanningSearch } from './planning-context';

export type AgendaPeriod =
  | 'this-week'
  | 'next-week'
  | 'this-month'
  | 'next-month'
  | 'all';
export type AgendaMilestone = {
  milestone: TimelineMilestone;
  task: Task | null;
  goal: Goal | null;
};

const DAY_MS = 86_400_000;
function dayKey(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}
function validDay(day: string) {
  const value = Date.parse(`${day}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(value) &&
    dayKey(value) === day
  );
}
function vietnamDay(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid date.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) =>
    parts.find((item) => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function periodBounds(
  period: AgendaPeriod,
  now: Date,
): [string, string] | null {
  if (period === 'all') return null;
  const today = new Date(`${vietnamDay(now)}T00:00:00Z`);
  if (period === 'this-week' || period === 'next-week') {
    const monday =
      today.getTime() -
      ((today.getUTCDay() + 6) % 7) * DAY_MS +
      (period === 'next-week' ? 7 * DAY_MS : 0);
    return [dayKey(monday), dayKey(monday + 7 * DAY_MS)];
  }
  if (period === 'this-month' || period === 'next-month') {
    const month = today.getUTCMonth() + (period === 'next-month' ? 1 : 0);
    return [
      dayKey(Date.UTC(today.getUTCFullYear(), month, 1)),
      dayKey(Date.UTC(today.getUTCFullYear(), month + 1, 1)),
    ];
  }
  throw new RangeError('Unknown agenda period.');
}

/** Read-only projection matching Timeline scope; no writes or synthetic records. */
export function milestoneAgenda(
  workspace: TimelineWorkspace,
  options: {
    period: AgendaPeriod;
    now: Date;
    query: string;
    importantOnly: boolean;
  },
): AgendaMilestone[] {
  const goals = new Map(
    workspace.goals
      .filter(
        (goal) =>
          !goal.deleted_at && !goal.archived_at && goal.status !== 'archived',
      )
      .map((goal) => [goal.id, goal]),
  );
  const tasks = new Map(
    workspace.tasks
      .filter((task) => !task.deleted_at && !task.archived_at)
      .map((task) => [task.id, task]),
  );
  const links = new Map(
    workspace.links.map((link) => [link.task_id, link.goal_id]),
  );
  const bounds = periodBounds(options.period, options.now);
  const rows: AgendaMilestone[] = [];
  for (const milestone of workspace.milestones) {
    if (
      !validDay(milestone.milestone_on) ||
      (options.importantOnly && !milestone.is_important)
    )
      continue;
    if (
      bounds &&
      (milestone.milestone_on < bounds[0] ||
        milestone.milestone_on >= bounds[1])
    )
      continue;
    let task: Task | null = null,
      goal: Goal | null = null;
    if (milestone.task_id) {
      task = tasks.get(milestone.task_id) ?? null;
      if (!task) continue;
      // Match buildTimelineRows: an unavailable Goal means Inbox for an active Task.
      goal = goals.get(links.get(task.id) ?? '') ?? null;
    } else if (milestone.goal_id) {
      goal = goals.get(milestone.goal_id) ?? null;
      if (!goal) continue;
    }
    if (
      !matchesPlanningSearch(
        options.query,
        { goal: goal?.title, task: task?.title },
        milestone.title,
      )
    )
      continue;
    rows.push({ milestone, task, goal });
  }
  return rows.sort(
    (a, b) =>
      a.milestone.milestone_on.localeCompare(b.milestone.milestone_on) ||
      a.milestone.id.localeCompare(b.milestone.id),
  );
}
