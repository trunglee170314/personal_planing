import { expandRecurringSessions, vietnamDateKey } from './calendar';
import type {
  CalendarSession,
  CalendarWorkspace,
  Task,
} from './data/repository';

const DAY = 86_400_000;
export type InsightOccurrence = CalendarSession & {
  occurrence_id: string;
  occurrence_start: string;
};
export type InsightRow =
  | { kind: 'checklist'; item: InsightOccurrence }
  | { kind: 'task'; item: Task };

/** Date-only arithmetic is UTC-based; display and grouping always use Vietnam. */
export function insightDay(value: string, offset = 0) {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(+date) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error('Choose a valid date.');
  return new Date(+date + offset * DAY).toISOString().slice(0, 10);
}
export function insightWeek(value = vietnamDateKey(new Date())) {
  insightDay(value);
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return insightDay(value, -(day === 0 ? 6 : day - 1));
}
export function insightMidnight(key: string) {
  insightDay(key);
  return new Date(`${key}T00:00:00+07:00`);
}
export function taskDeadline(task: Task) {
  const value = task.due_at ?? task.planned_end;
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : vietnamDateKey(value);
}
export { safeTaskLink } from './task-links';
export function occurrenceOutcome(item: InsightOccurrence) {
  return item.completed_at
    ? 'Done'
    : item.not_needed_at
      ? 'Not needed'
      : 'Open';
}

/** Live projection only: no saved percentages, account caches or snapshot claims. */
export function buildWeeklyInsights(
  workspace: CalendarWorkspace,
  weekKey: string,
  now: Date,
) {
  const week = insightWeek(weekKey),
    end = insightDay(week, 7),
    today = vietnamDateKey(now),
    horizonEnd = insightDay(today, 7);
  const categories = new Map(workspace.statuses.map((s) => [s.id, s.category]));
  const tasks = workspace.tasks.filter(
    (t) =>
      !t.archived_at &&
      !t.deleted_at &&
      categories.get(t.workflow_status_id) !== 'cancelled',
  );
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const goalsById = new Map(workspace.goals.map((g) => [g.id, g]));
  const goalByTask = new Map(
    workspace.links
      .filter((l) => tasksById.has(l.task_id) && goalsById.has(l.goal_id))
      .map((l) => [l.task_id, l.goal_id]),
  );
  const checklistSessions = workspace.sessions.filter(
    (s) => s.item_type === 'checklist',
  );
  const eligible = checklistSessions.filter(
    (s) => !s.task_id || tasksById.has(s.task_id),
  );
  const weekly = expandRecurringSessions(
    eligible,
    insightMidnight(week),
    insightMidnight(end),
    workspace.occurrence_states,
  )
    .filter(
      (s) =>
        +new Date(s.starts_at) >= +insightMidnight(week) &&
        +new Date(s.starts_at) < +insightMidnight(end),
    )
    .sort(
      (a, b) =>
        +new Date(a.starts_at) - +new Date(b.starts_at) ||
        a.occurrence_id.localeCompare(b.occurrence_id),
    );
  const done = weekly.filter((s) => !!s.completed_at),
    notNeeded = weekly.filter((s) => !s.completed_at && !!s.not_needed_at),
    open = weekly.filter((s) => !s.completed_at && !s.not_needed_at),
    overdue = open.filter((s) => +new Date(s.ends_at) <= +now);
  const pendingTasks = tasks.filter(
    (t) =>
      !t.completed_at && categories.get(t.workflow_status_id) !== 'completed',
  );
  const upcoming = expandRecurringSessions(
    eligible,
    now,
    insightMidnight(horizonEnd),
    workspace.occurrence_states,
  ).filter(
    (s) => !s.completed_at && !s.not_needed_at && +new Date(s.ends_at) > +now,
  );
  const upcomingByTask = new Map<string, InsightOccurrence[]>();
  for (const item of upcoming) {
    if (!item.task_id) continue;
    const list = upcomingByTask.get(item.task_id) ?? [];
    list.push(item);
    upcomingByTask.set(item.task_id, list);
  }
  const byDeadline = (a: Task, b: Task) =>
    (taskDeadline(a) ?? '9999').localeCompare(taskDeadline(b) ?? '9999') ||
    a.title.localeCompare(b.title);
  const overdueTasks = pendingTasks
    .filter((t) => {
      const date = taskDeadline(t);
      return date && date < today;
    })
    .sort(byDeadline);
  const unscheduledTasks = pendingTasks
    .filter((t) => {
      const date = taskDeadline(t);
      return (
        date &&
        date >= today &&
        date < horizonEnd &&
        !(upcomingByTask.get(t.id) ?? []).some(
          (s) => +new Date(s.starts_at) < +insightMidnight(insightDay(date, 1)),
        )
      );
    })
    .sort(byDeadline);
  const tasksWithoutGoal = pendingTasks
    .filter((t) => !goalByTask.has(t.id))
    .sort(byDeadline);
  const checklistsWithoutGoal = weekly.filter(
    (s) => !s.task_id || !goalByTask.has(s.task_id),
  );
  const byGoal = [
    ...workspace.goals.map((goal) => ({
      id: goal.id as string | null,
      title: goal.title,
    })),
    { id: null, title: 'No available Goal' },
  ].map((goal) => {
    const items = weekly.filter(
      (s) =>
        (s.task_id ? (goalByTask.get(s.task_id) ?? null) : null) === goal.id,
    );
    const members = tasks.filter(
      (t) => (goalByTask.get(t.id) ?? null) === goal.id,
    );
    return {
      ...goal,
      items,
      tasks: members,
      done: items.filter((s) => s.completed_at).length,
      notNeeded: items.filter((s) => !s.completed_at && s.not_needed_at).length,
      open: items.filter((s) => !s.completed_at && !s.not_needed_at).length,
      overdue: items.filter(
        (s) =>
          !s.completed_at && !s.not_needed_at && +new Date(s.ends_at) <= +now,
      ).length,
    };
  });
  return {
    week,
    end,
    today,
    asOf: now.toISOString(),
    horizonEnd,
    weekly,
    done,
    notNeeded,
    open,
    overdue,
    byGoal,
    tasksById,
    goalByTask,
    goalsById,
    overdueTasks,
    unscheduledTasks,
    tasksWithoutGoal,
    checklistsWithoutGoal,
    excludedSeries: checklistSessions.length - eligible.length,
    completionRate: weekly.length
      ? Math.round((done.length / weekly.length) * 100)
      : null,
  };
}
export type WeeklyInsights = ReturnType<typeof buildWeeklyInsights>;
export const checklistRows = (items: InsightOccurrence[]): InsightRow[] =>
  items.map((item) => ({ kind: 'checklist', item }));
export const taskRows = (items: Task[]): InsightRow[] =>
  items.map((item) => ({ kind: 'task', item }));
