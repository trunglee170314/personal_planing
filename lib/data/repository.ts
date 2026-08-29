'use client';

import type { SupabaseClient } from '@supabase/supabase-js';
import { expandRecurringSessions, type RecurrenceRule } from '@/lib/calendar';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { configureUndo, recordUndo, undoHeaders } from '@/lib/undo-manager';

export type AppDataMode = 'local' | 'cloud';
export type LifecycleView = 'active' | 'archived' | 'trash';
export type GoalStatus = 'active' | 'completed' | 'archived';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type GoalColor =
  | 'jade'
  | 'teal'
  | 'sky'
  | 'sapphire'
  | 'indigo'
  | 'plum'
  | 'amber'
  | 'terracotta'
  | 'rose'
  | 'coral'
  | 'lime'
  | 'slate';
export type CalendarItemType = 'checklist' | 'reminder';
export type ThemeId = 'jade' | 'sapphire' | 'ink' | 'paper';
export type Goal = {
  id: string;
  title: string;
  description: string | null;
  progress: number;
  status: GoalStatus;
  starts_on: string | null;
  ends_on: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  task_count: number;
  completed_task_count: number;
  color_key: GoalColor;
};
export type GoalOption = Pick<Goal, 'id' | 'title' | 'color_key'>;
export type WorkflowStatus = { id: string; category: string };
export type Task = {
  id: string;
  title: string;
  priority: Priority;
  due_at: string | null;
  completed_at: string | null;
  workflow_status_id: string;
  previous_status_id: string | null;
  planned_start: string | null;
  planned_end: string | null;
  progress: number;
  parent_task_id: string | null;
  dependency_task_id: string | null;
  is_milestone: boolean;
  archived_at: string | null;
  deleted_at: string | null;
  link_url: string | null;
  link_label: string | null;
  active_checklist_count: number;
  checklist_resolved_count: number;
  checklist_done_count: number;
};
export type TaskGoalLink = { task_id: string; goal_id: string };
export type CalendarSession = {
  id: string;
  task_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  timezone: string;
  recurrence: RecurrenceRule;
  recurrence_until: string | null;
  recurrence_interval: number;
  item_type: CalendarItemType;
  completed_at: string | null;
  not_needed_at: string | null;
  notification_offsets: number[];
  is_pinned: boolean;
};
export type CalendarOccurrenceState = {
  calendar_entry_id: string;
  occurrence_start: string;
  completed_at: string | null;
  not_needed_at: string | null;
  override_starts_at?: string | null;
  override_ends_at?: string | null;
};
export type CalendarMoveScope = 'occurrence' | 'future' | 'series';
export type CalendarSessionInput = Omit<
  CalendarSession,
  | 'id'
  | 'item_type'
  | 'completed_at'
  | 'not_needed_at'
  | 'notification_offsets'
  | 'is_pinned'
> &
  Partial<
    Pick<
      CalendarSession,
      | 'item_type'
      | 'completed_at'
      | 'not_needed_at'
      | 'notification_offsets'
      | 'is_pinned'
    >
  >;
export type TimelineMilestone = {
  id: string;
  goal_id: string | null;
  task_id?: string | null;
  title: string;
  milestone_on: string;
};
export type WeeklyReview = {
  id: string;
  week_start: string;
  wins: string;
  challenges: string;
  next_week_focus: string;
  satisfaction: number | null;
  updated_at: string;
};
export type ReviewStats = {
  completedTasks: number;
  openTasks: number;
  activeGoals: number;
};
export type PomodoroSettings = {
  focus_minutes: number;
  short_break_minutes: number;
  long_break_minutes: number;
  daily_target_type: 'sessions' | 'minutes';
  daily_target_value: number;
};
export type PomodoroSession = {
  id: string;
  started_at: string;
  completed_at: string;
  duration_minutes: number;
};
export type PomodoroRecord = Omit<PomodoroSession, 'id'> & {
  client_id: string;
};
export type TaskWorkspace = {
  goals: GoalOption[];
  statuses: WorkflowStatus[];
  tasks: Task[];
  links: TaskGoalLink[];
};
export type TodayWorkspace = {
  goals: GoalOption[];
  tasks: Task[];
  statuses: WorkflowStatus[];
  sessions: CalendarSession[];
  links: TaskGoalLink[];
  occurrence_states: CalendarOccurrenceState[];
};
export type CalendarWorkspace = TodayWorkspace;
export type TimelineWorkspace = {
  goals: Goal[];
  tasks: Task[];
  links: TaskGoalLink[];
  milestones: TimelineMilestone[];
  statuses: WorkflowStatus[];
};
export type TimelineGroupPlan = {
  version: string;
  tasks: number;
  milestones: number;
  calendar: number;
};
export type TimelineTaskMove = {
  days: number;
  goal_id: string | null;
  expected_goal: string | null;
  expected_parent: string | null;
  expected_start: string | null;
  expected_due: string | null;
};
export type ReviewsWorkspace = { reviews: WeeklyReview[]; stats: ReviewStats };
export type PomodoroWorkspace = {
  settings: PomodoroSettings;
  sessions: PomodoroSession[];
};
export type GoalInput = {
  title: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  color_key?: GoalColor;
};
export type TaskInput = Omit<
  Task,
  | 'id'
  | 'completed_at'
  | 'previous_status_id'
  | 'archived_at'
  | 'deleted_at'
  | 'link_url'
  | 'link_label'
  | 'active_checklist_count'
  | 'checklist_resolved_count'
  | 'checklist_done_count'
> & { goal_id?: string; link_url?: string | null; link_label?: string | null };
export type TaskChanges = Partial<Omit<Task, 'id'>> & {
  goal_id?: string | null;
};

export interface PlanningRepository {
  listGoals(view?: LifecycleView): Promise<Goal[]>;
  createGoal(input: GoalInput): Promise<string>;
  updateGoal(
    id: string,
    changes: Partial<Goal> & {
      completed_at?: string | null;
      archived_at?: string | null;
    },
  ): Promise<void>;
  deleteGoal(id: string): Promise<void>;
  getTaskWorkspace(view?: LifecycleView): Promise<TaskWorkspace>;
  createTask(input: TaskInput): Promise<string>;
  updateTask(id: string, changes: TaskChanges): Promise<void>;
  saveTaskEdit(
    id: string,
    changes: TaskChanges,
    completed: boolean,
  ): Promise<void>;
  setTaskCompletion(id: string, completed: boolean): Promise<void>;
  deleteTask(id: string): Promise<void>;
  getTodayWorkspace(): Promise<TodayWorkspace>;
  getCalendarWorkspace(): Promise<CalendarWorkspace>;
  createCalendarSession(input: CalendarSessionInput): Promise<string>;
  updateCalendarSession(
    id: string,
    changes: Partial<CalendarSessionInput>,
    expected?: CalendarSessionInput,
  ): Promise<void>;
  deleteCalendarSession(id: string): Promise<void>;
  updateCalendarOccurrence(
    calendarEntryId: string,
    occurrenceStart: string,
    changes: Partial<
      Pick<
        CalendarOccurrenceState,
        | 'completed_at'
        | 'not_needed_at'
        | 'override_starts_at'
        | 'override_ends_at'
      >
    >,
  ): Promise<void>;
  moveCalendarOccurrences(
    calendarEntryId: string,
    changes: Array<
      Pick<
        CalendarOccurrenceState,
        'occurrence_start' | 'override_starts_at' | 'override_ends_at'
      >
    >,
  ): Promise<void>;
  moveCalendarSeries(
    calendarEntryId: string,
    originalStart: string,
    originalEnd: string,
    nextStart: string,
    nextEnd: string,
  ): Promise<void>;
  getTimelineWorkspace(): Promise<TimelineWorkspace>;
  previewTimelineGroup(goalId: string): Promise<TimelineGroupPlan>;
  moveTimelineGroup(
    goalId: string,
    days: number,
    version: string,
  ): Promise<void>;
  moveTimelineTask(id: string, input: TimelineTaskMove): Promise<void>;
  createTimelineMilestone(
    input: Omit<TimelineMilestone, 'id'>,
  ): Promise<string>;
  updateTimelineMilestone(
    id: string,
    changes: Partial<Omit<TimelineMilestone, 'id'>>,
  ): Promise<void>;
  deleteTimelineMilestone(id: string): Promise<void>;
  getTheme(): Promise<ThemeId>;
  saveTheme(theme: ThemeId): Promise<void>;
  getPomodoroWorkspace(): Promise<PomodoroWorkspace>;
  savePomodoroSettings(input: PomodoroSettings): Promise<void>;
  recordPomodoroSession(input: PomodoroRecord): Promise<void>;
  getReviewsWorkspace(a: string, b: string): Promise<ReviewsWorkspace>;
  saveWeeklyReview(
    input: Omit<WeeklyReview, 'id' | 'updated_at'>,
  ): Promise<void>;
}

export function getAppDataMode(): AppDataMode {
  return process.env.NEXT_PUBLIC_APP_MODE === 'local' ? 'local' : 'cloud';
}
export function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
}
function assertNoError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}
async function allRows<T>(query: {
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}) {
  const data: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await query.range(offset, offset + 499);
    assertNoError(page.error);
    data.push(...(page.data ?? []));
    if ((page.data?.length ?? 0) < 500) break;
  }
  return { data, error: null };
}
function validateTaskFields(input: {
  planned_start?: string | null;
  due_at?: string | null;
  link_url?: string | null;
}) {
  for (const [label, value] of [
    ['Task start date', input.planned_start],
    ['Task deadline', input.due_at],
  ] as const) {
    if (!value) continue;
    const year = new Date(value).getFullYear();
    if (!Number.isFinite(year) || year < 2000 || year > 2200)
      throw new Error(`${label} must use a year between 2000 and 2200.`);
  }
  if (input.link_url) {
    let url: URL;
    try {
      url = new URL(input.link_url);
    } catch {
      throw new Error('Task link must be a valid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Task link must start with http:// or https://.');
  }
  if (
    input.planned_start &&
    input.due_at &&
    input.due_at.slice(0, 10) < input.planned_start.slice(0, 10)
  )
    throw new Error('Task deadline cannot be before its start date.');
}
export const defaultPomodoroSettings: PomodoroSettings = {
  focus_minutes: 25,
  short_break_minutes: 5,
  long_break_minutes: 15,
  daily_target_type: 'sessions',
  daily_target_value: 4,
};
const statuses: WorkflowStatus[] = [
  { id: 'backlog', category: 'backlog' },
  { id: 'planned', category: 'planned' },
  { id: 'in_progress', category: 'in_progress' },
  { id: 'blocked', category: 'blocked' },
  { id: 'completed', category: 'completed' },
  { id: 'cancelled', category: 'cancelled' },
];
type CloudTask = {
  id: string;
  title: string;
  priority: Priority;
  due_at: string | null;
  completed_at: string | null;
  status: string;
  previous_status: string | null;
  planned_start: string | null;
  planned_end: string | null;
  progress: number;
  parent_task_id: string | null;
  dependency_task_id: string | null;
  is_milestone: boolean;
  goal_id: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  link_url: string | null;
  link_label: string | null;
};
type GoalProgressTask = Pick<
  CloudTask,
  'id' | 'goal_id' | 'status' | 'parent_task_id' | 'archived_at' | 'deleted_at'
>;
function attachGoalTaskCounts(goals: Goal[], tasks: GoalProgressTask[]) {
  return goals.map((goal) => {
    const eligible = tasks.filter(
      (task) =>
        task.goal_id === goal.id &&
        !task.archived_at &&
        !task.deleted_at &&
        task.status !== 'cancelled',
    );
    const parentIds = new Set(
      eligible
        .map((task) => task.parent_task_id)
        .filter((id): id is string => Boolean(id)),
    );
    const leaves = eligible.filter((task) => !parentIds.has(task.id));
    return {
      ...goal,
      task_count: leaves.length,
      completed_task_count: leaves.filter((task) => task.status === 'completed')
        .length,
    };
  });
}
const mapTask = (row: CloudTask): Task => ({
  id: row.id,
  title: row.title,
  priority: row.priority,
  due_at: row.due_at,
  completed_at: row.completed_at,
  workflow_status_id: row.status,
  previous_status_id: row.previous_status,
  planned_start: row.planned_start,
  planned_end: row.planned_end,
  progress: row.progress,
  parent_task_id: row.parent_task_id,
  dependency_task_id: row.dependency_task_id,
  is_milestone: Boolean(row.is_milestone),
  archived_at: row.archived_at,
  deleted_at: row.deleted_at,
  link_url: row.link_url,
  link_label: row.link_label,
  active_checklist_count: 0,
  checklist_resolved_count: 0,
  checklist_done_count: 0,
});
const taskSelect =
  'id,title,priority,due_at,completed_at,status,previous_status,planned_start,planned_end,progress,parent_task_id,dependency_task_id,is_milestone,goal_id,archived_at,deleted_at,link_url,link_label';
const dateOnly = (value: string | null) => (value ? value.slice(0, 10) : null);
const answerText = (value: unknown) => (typeof value === 'string' ? value : '');
function parseRrule(rrule?: string) {
  if (!rrule)
    return {
      recurrence: 'none' as const,
      recurrence_until: null,
      recurrence_interval: 1,
    };
  const until = rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/);
  const interval = Number(rrule.match(/INTERVAL=(\d+)/)?.[1] ?? 1);
  const recurrence: RecurrenceRule = rrule.includes('FREQ=WEEKLY')
    ? 'weekly'
    : rrule.includes('FREQ=MONTHLY')
      ? 'monthly'
      : interval > 1
        ? 'custom'
        : 'daily';
  return {
    recurrence,
    recurrence_until: until ? `${until[1]}-${until[2]}-${until[3]}` : null,
    recurrence_interval: interval,
  };
}
function makeRrule(input: CalendarSessionInput) {
  if (input.recurrence === 'none') return null;
  const freq =
    input.recurrence === 'weekly'
      ? 'WEEKLY'
      : input.recurrence === 'monthly'
        ? 'MONTHLY'
        : 'DAILY';
  const interval =
    input.recurrence === 'custom' ? Math.max(1, input.recurrence_interval) : 1;
  const until = input.recurrence_until
    ? `;UNTIL=${input.recurrence_until.replaceAll('-', '')}T235959Z`
    : '';
  return `FREQ=${freq};INTERVAL=${interval}${until}`;
}

function validateCalendarInput(input: CalendarSessionInput) {
  const start = new Date(input.starts_at);
  const end = new Date(input.ends_at);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start
  )
    throw new Error('End time must be after the start time.');
  if (input.item_type === 'checklist' && !input.task_id)
    throw new Error('Choose a Task for this checklist.');
  if (input.item_type === 'reminder' && input.task_id)
    throw new Error('A Reminder cannot be linked to a Task.');
  if (
    input.item_type === 'reminder' &&
    end.getTime() - start.getTime() !== 15 * 60_000
  )
    throw new Error('A Reminder uses one point in time.');
  if (
    input.item_type === 'checklist' &&
    input.recurrence !== 'none' &&
    !input.recurrence_until
  )
    throw new Error('Choose an end date for a repeating checklist.');
  if (
    input.recurrence_until &&
    input.recurrence_until < input.starts_at.slice(0, 10)
  )
    throw new Error('Repeat-until date cannot be before the start date.');
}
function summarizeChecklistSessions(
  sessions: CalendarSession[],
  occurrenceStates: CalendarOccurrenceState[],
) {
  const summaries = new Map<
    string,
    { total: number; completed: number; resolved: number }
  >();
  for (const session of sessions) {
    if (session.item_type !== 'checklist' || !session.task_id) continue;
    const items =
      session.recurrence === 'none'
        ? [session]
        : session.recurrence_until
          ? expandRecurringSessions(
              [session],
              new Date(session.starts_at),
              new Date(`${session.recurrence_until}T17:00:00.000Z`),
              occurrenceStates,
            )
          : [];
    const summary = summaries.get(session.task_id) ?? {
      total: 0,
      completed: 0,
      resolved: 0,
    };
    summary.total += items.length;
    summary.completed += items.filter((item) => item.completed_at).length;
    summary.resolved += items.filter(
      (item) => item.completed_at || item.not_needed_at,
    ).length;
    summaries.set(session.task_id, summary);
  }
  return summaries;
}

class SupabasePlanningRepository implements PlanningRepository {
  constructor(private readonly supabase: SupabaseClient) {}
  private async userId() {
    const { data, error } = await this.supabase.auth.getUser();
    assertNoError(error);
    if (!data.user)
      throw new Error('Your cloud session has expired. Please sign in again.');
    return data.user.id;
  }
  async listGoals(view: LifecycleView = 'active') {
    let query = this.supabase
      .from('goals')
      .select(
        'id,title,description,progress,status,starts_at,ends_at,archived_at,deleted_at,color_key',
      );
    query =
      view === 'trash'
        ? query.not('deleted_at', 'is', null)
        : view === 'archived'
          ? query.eq('status', 'archived').is('deleted_at', null)
          : query.neq('status', 'archived').is('deleted_at', null);
    const [goalResult, taskResult] = await Promise.all([
      allRows(query.order('created_at', { ascending: false }).order('id')),
      allRows(
        this.supabase
          .from('tasks')
          .select('id,goal_id,status,parent_task_id,archived_at,deleted_at')
          .is('archived_at', null)
          .is('deleted_at', null)
          .order('id'),
      ),
    ]);
    assertNoError(goalResult.error || taskResult.error);
    const goals = (goalResult.data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      progress: row.progress,
      status: row.status,
      starts_on: dateOnly(row.starts_at),
      ends_on: dateOnly(row.ends_at),
      archived_at: row.archived_at,
      deleted_at: row.deleted_at,
      task_count: 0,
      completed_task_count: 0,
      color_key: row.color_key,
    })) as Goal[];
    return attachGoalTaskCounts(
      goals,
      (taskResult.data ?? []) as GoalProgressTask[],
    );
  }
  async createGoal(input: GoalInput) {
    const user_id = await this.userId();
    const id = crypto.randomUUID();
    const { error } = await this.supabase.from('goals').insert({
      id,
      user_id,
      title: input.title,
      description: input.description,
      starts_at: input.starts_on,
      ends_at: input.ends_on,
      color_key: input.color_key,
    });
    assertNoError(error);
    return id;
  }
  async updateGoal(
    id: string,
    changes: Partial<Goal> & {
      completed_at?: string | null;
      archived_at?: string | null;
    },
  ) {
    const { starts_on, ends_on, completed_at: _completed, ...rest } = changes;
    const payload = {
      ...rest,
      ...('starts_on' in changes ? { starts_at: starts_on } : {}),
      ...('ends_on' in changes ? { ends_at: ends_on } : {}),
    };
    const { error } = await this.supabase
      .from('goals')
      .update(payload)
      .eq('id', id);
    assertNoError(error);
  }
  async deleteGoal(id: string) {
    const { error } = await this.supabase.rpc('delete_myplan_goal', {
      target_goal_id: id,
    });
    assertNoError(error);
  }
  async getTaskWorkspace(view: LifecycleView = 'active') {
    let taskQuery = this.supabase.from('tasks').select(taskSelect);
    taskQuery =
      view === 'trash'
        ? taskQuery.not('deleted_at', 'is', null)
        : view === 'archived'
          ? taskQuery.not('archived_at', 'is', null).is('deleted_at', null)
          : taskQuery.is('archived_at', null).is('deleted_at', null);
    const [goals, tasks, checklistRows, rules, occurrenceStates] =
      await Promise.all([
        allRows(
          this.supabase
            .from('goals')
            .select('id,title,color_key')
            .neq('status', 'archived')
            .is('deleted_at', null)
            .order('created_at', { ascending: false })
            .order('id'),
        ),
        allRows(
          taskQuery.order('created_at', { ascending: false }).order('id'),
        ),
        allRows(
          this.supabase
            .from('calendar_entries')
            .select(
              'id,task_id,title,starts_at,ends_at,all_day,timezone,item_type,completed_at,not_needed_at,notification_offsets,is_pinned',
            )
            .eq('item_type', 'checklist')
            .neq('status', 'cancelled')
            .not('task_id', 'is', null)
            .order('id'),
        ),
        allRows(
          this.supabase
            .from('recurrence_rules')
            .select('calendar_entry_id,rrule')
            .order('id'),
        ),
        allRows(
          this.supabase
            .from('calendar_occurrence_states')
            .select(
              'calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at',
            )
            .order('calendar_entry_id')
            .order('occurrence_start'),
        ),
      ]);
    assertNoError(
      goals.error ||
        tasks.error ||
        checklistRows.error ||
        rules.error ||
        occurrenceStates.error,
    );
    const rows = (tasks.data ?? []) as CloudTask[];
    const ruleMap = new Map(
      (rules.data ?? []).map((rule) => [rule.calendar_entry_id, rule.rrule]),
    );
    const checklistCounts = summarizeChecklistSessions(
      (checklistRows.data ?? []).map((entry) => ({
        ...entry,
        ...parseRrule(ruleMap.get(entry.id)),
      })) as CalendarSession[],
      (occurrenceStates.data ?? []) as CalendarOccurrenceState[],
    );
    return {
      goals: (goals.data ?? []) as GoalOption[],
      statuses,
      tasks: rows.map((row) => ({
        ...mapTask(row),
        active_checklist_count: checklistCounts.get(row.id)?.total ?? 0,
        checklist_resolved_count: checklistCounts.get(row.id)?.resolved ?? 0,
        checklist_done_count: checklistCounts.get(row.id)?.completed ?? 0,
        progress: checklistCounts.get(row.id)?.total
          ? Math.round(
              ((checklistCounts.get(row.id)?.resolved ?? 0) /
                (checklistCounts.get(row.id)?.total ?? 1)) *
                100,
            )
          : row.progress,
      })),
      links: rows
        .filter((row) => row.goal_id)
        .map((row) => ({ task_id: row.id, goal_id: row.goal_id as string })),
    };
  }
  async createTask(input: TaskInput) {
    validateTaskFields(input);
    const { goal_id, workflow_status_id, ...rest } = input;
    const user_id = await this.userId();
    const id = crypto.randomUUID();
    const { error } = await this.supabase.from('tasks').insert({
      ...rest,
      id,
      user_id,
      goal_id: goal_id ?? null,
      status: workflow_status_id,
    });
    assertNoError(error);
    return id;
  }
  async updateTask(id: string, changes: TaskChanges) {
    const currentResult = await this.supabase
      .from('tasks')
      .select('planned_start,due_at,status,completed_at,progress')
      .eq('id', id)
      .single();
    assertNoError(currentResult.error);
    validateTaskFields(
      'planned_start' in changes || 'due_at' in changes
        ? {
            planned_start:
              changes.planned_start === undefined
                ? currentResult.data?.planned_start
                : changes.planned_start,
            due_at:
              changes.due_at === undefined
                ? currentResult.data?.due_at
                : changes.due_at,
            link_url: changes.link_url,
          }
        : { link_url: changes.link_url },
    );
    if (
      'workflow_status_id' in changes ||
      'completed_at' in changes ||
      'progress' in changes
    ) {
      const checklist = await this.checklistSummary(id);
      const changesDerivedState =
        ('workflow_status_id' in changes &&
          changes.workflow_status_id !== currentResult.data?.status &&
          (changes.workflow_status_id === 'completed' ||
            currentResult.data?.status === 'completed')) ||
        ('completed_at' in changes &&
          Boolean(changes.completed_at) !==
            Boolean(currentResult.data?.completed_at)) ||
        ('progress' in changes &&
          changes.progress !== currentResult.data?.progress);
      if (checklist.total > 0 && changesDerivedState)
        throw new Error(
          'Use the Task completion control when checklist items are attached.',
        );
    }
    const { goal_id, workflow_status_id, previous_status_id, ...rest } =
      changes;
    const payload = {
      ...rest,
      ...('goal_id' in changes ? { goal_id } : {}),
      ...('workflow_status_id' in changes
        ? { status: workflow_status_id }
        : {}),
      ...('previous_status_id' in changes
        ? { previous_status: previous_status_id }
        : {}),
    };
    const { error } = await this.supabase
      .from('tasks')
      .update(payload)
      .eq('id', id);
    assertNoError(error);
  }
  async saveTaskEdit(id: string, changes: TaskChanges, completed: boolean) {
    validateTaskFields(changes);
    const { workflow_status_id, previous_status_id, ...rest } = changes;
    const { error } = await this.supabase.rpc('myplan_save_task_edit', {
      target_task: id,
      changes: {
        ...rest,
        ...(workflow_status_id ? { status: workflow_status_id } : {}),
        ...(previous_status_id ? { previous_status: previous_status_id } : {}),
      },
      should_complete: completed,
    });
    assertNoError(error);
  }
  async setTaskCompletion(id: string, completed: boolean) {
    const { error } = await this.supabase.rpc('set_myplan_task_completion', {
      target_task_id: id,
      should_complete: completed,
    });
    assertNoError(error);
  }
  async deleteTask(id: string) {
    const { error } = await this.supabase.rpc('delete_myplan_task', {
      target_task_id: id,
    });
    assertNoError(error);
  }
  async getCalendarWorkspace() {
    const [goals, tasks, entries, rules, occurrenceStates] = await Promise.all([
      allRows(
        this.supabase
          .from('goals')
          .select('id,title,color_key')
          .neq('status', 'archived')
          .is('deleted_at', null)
          .order('id'),
      ),
      allRows(
        this.supabase
          .from('tasks')
          .select(taskSelect)
          .is('archived_at', null)
          .is('deleted_at', null)
          .order('created_at')
          .order('id'),
      ),
      allRows(
        this.supabase
          .from('calendar_entries')
          .select(
            'id,task_id,title,starts_at,ends_at,all_day,timezone,item_type,completed_at,not_needed_at,notification_offsets,is_pinned',
          )
          .neq('status', 'cancelled')
          .order('starts_at', { ascending: false })
          .order('id'),
      ),
      allRows(
        this.supabase
          .from('recurrence_rules')
          .select('calendar_entry_id,rrule')
          .order('id'),
      ),
      allRows(
        this.supabase
          .from('calendar_occurrence_states')
          .select(
            'calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at',
          )
          .order('occurrence_start', { ascending: false })
          .order('calendar_entry_id')
          .order('occurrence_start'),
      ),
    ]);
    assertNoError(
      goals.error ||
        tasks.error ||
        entries.error ||
        rules.error ||
        occurrenceStates.error,
    );
    const ruleMap = new Map(
      (rules.data ?? []).map((rule) => [rule.calendar_entry_id, rule.rrule]),
    );
    return {
      goals: (goals.data ?? []) as GoalOption[],
      tasks: ((tasks.data ?? []) as CloudTask[]).map(mapTask),
      statuses,
      links: ((tasks.data ?? []) as CloudTask[])
        .filter((row) => row.goal_id)
        .map((row) => ({ task_id: row.id, goal_id: row.goal_id as string })),
      occurrence_states: (occurrenceStates.data ??
        []) as CalendarOccurrenceState[],
      sessions: (entries.data ?? [])
        .filter((row) => row.starts_at && row.ends_at)
        .map((row) => ({
          ...row,
          item_type: row.item_type ?? 'checklist',
          notification_offsets: row.notification_offsets ?? [15],
          is_pinned: Boolean(row.is_pinned),
          ...parseRrule(ruleMap.get(row.id)),
        }))
        .sort((a, b) =>
          a.starts_at.localeCompare(b.starts_at),
        ) as CalendarSession[],
    };
  }
  async getTodayWorkspace() {
    return this.getCalendarWorkspace();
  }
  async createCalendarSession(input: CalendarSessionInput) {
    validateCalendarInput(input);
    const owner_user_id = await this.userId();
    const {
      recurrence: _recurrence,
      recurrence_until: _until,
      recurrence_interval: _interval,
      ...entry
    } = input;
    const { data, error } = await this.supabase
      .from('calendar_entries')
      .insert({
        ...entry,
        owner_user_id,
        entry_type: 'time_block',
        flexibility: 'fixed',
        status: 'planned',
      })
      .select('id')
      .single();
    assertNoError(error);
    if (!data) throw new Error('Calendar session id was not returned.');
    const rrule = makeRrule(input);
    if (rrule) {
      const result = await this.supabase.from('recurrence_rules').insert({
        owner_user_id,
        calendar_entry_id: data.id,
        rrule,
        timezone: input.timezone,
      });
      assertNoError(result.error);
    }
    await this.syncTaskFromChecklists(input.task_id);
    return data.id as string;
  }
  async updateCalendarSession(
    id: string,
    changes: Partial<CalendarSessionInput>,
    expected?: CalendarSessionInput,
  ) {
    const current = (await this.getCalendarWorkspace()).sessions.find(
      (item) => item.id === id,
    );
    if (!current) throw new Error('Calendar session not found.');
    const merged = { ...current, ...changes };
    validateCalendarInput(merged);
    const {
      recurrence: _recurrence,
      recurrence_until: _until,
      recurrence_interval: _interval,
      ...entry
    } = changes;
    const base = expected ?? current;
    const ruleChanged = [
      'recurrence',
      'recurrence_until',
      'recurrence_interval',
    ].some(
      (key) =>
        key in changes &&
        changes[key as keyof CalendarSessionInput] !==
          base[key as keyof CalendarSessionInput],
    );
    const expectedEntry = Object.fromEntries(
      Object.keys(entry).map((key) => [
        key,
        base[key as keyof CalendarSessionInput],
      ]),
    );
    const { error } = await this.supabase.rpc('myplan_update_calendar_entry', {
      target_entry: id,
      changes: entry,
      next_rule: makeRrule({ ...base, ...changes }),
      rule_changed: ruleChanged,
      expected_rule: makeRrule(base),
      expected_entry: expectedEntry,
    });
    assertNoError(error);
  }
  async deleteCalendarSession(id: string) {
    const current = (await this.getCalendarWorkspace()).sessions.find(
      (item) => item.id === id,
    );
    const { error } = await this.supabase
      .from('calendar_entries')
      .delete()
      .eq('id', id);
    assertNoError(error);
    await this.syncTaskFromChecklists(current?.task_id ?? null);
  }
  async updateCalendarOccurrence(
    calendarEntryId: string,
    occurrenceStart: string,
    changes: Partial<
      Pick<
        CalendarOccurrenceState,
        | 'completed_at'
        | 'not_needed_at'
        | 'override_starts_at'
        | 'override_ends_at'
      >
    >,
  ) {
    const { error } = await this.supabase.rpc('myplan_update_occurrence', {
      target_entry: calendarEntryId,
      original_start: occurrenceStart,
      changes,
    });
    assertNoError(error);
  }
  async moveCalendarOccurrences(
    calendarEntryId: string,
    changes: Array<
      Pick<
        CalendarOccurrenceState,
        'occurrence_start' | 'override_starts_at' | 'override_ends_at'
      >
    >,
  ) {
    if (!changes.length) return;
    const owner_user_id = await this.userId();
    const moved = await this.supabase.from('calendar_occurrence_states').upsert(
      changes.map((state) => ({
        owner_user_id,
        calendar_entry_id: calendarEntryId,
        ...state,
      })),
      { onConflict: 'owner_user_id,calendar_entry_id,occurrence_start' },
    );
    assertNoError(moved.error);
  }
  async moveCalendarSeries(
    calendarEntryId: string,
    originalStart: string,
    originalEnd: string,
    nextStart: string,
    nextEnd: string,
  ) {
    const { error } = await this.supabase.rpc('move_calendar_series', {
      target_entry_id: calendarEntryId,
      original_occurrence_start: originalStart,
      original_occurrence_end: originalEnd,
      next_occurrence_start: nextStart,
      next_occurrence_end: nextEnd,
    });
    assertNoError(error);
  }
  private async checklistSummary(taskId: string) {
    const [entryResult, ruleResult, stateResult] = await Promise.all([
      allRows(
        this.supabase
          .from('calendar_entries')
          .select(
            'id,task_id,title,starts_at,ends_at,all_day,timezone,item_type,completed_at,not_needed_at,notification_offsets,is_pinned',
          )
          .eq('task_id', taskId)
          .eq('item_type', 'checklist')
          .neq('status', 'cancelled')
          .order('id'),
      ),
      allRows(
        this.supabase
          .from('recurrence_rules')
          .select('calendar_entry_id,rrule')
          .order('id'),
      ),
      allRows(
        this.supabase
          .from('calendar_occurrence_states')
          .select(
            'calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at',
          )
          .order('calendar_entry_id')
          .order('occurrence_start'),
      ),
    ]);
    assertNoError(entryResult.error || ruleResult.error || stateResult.error);
    const ruleMap = new Map(
      (ruleResult.data ?? []).map((rule) => [
        rule.calendar_entry_id,
        rule.rrule,
      ]),
    );
    const sessions = (entryResult.data ?? []).map((entry) => ({
      ...entry,
      ...parseRrule(ruleMap.get(entry.id)),
      recurrence_interval: parseRrule(ruleMap.get(entry.id))
        .recurrence_interval,
    })) as CalendarSession[];
    const items = sessions.flatMap((session) => {
      if (session.recurrence === 'none')
        return [
          {
            ...session,
            occurrence_id: `${session.id}:${session.starts_at}`,
            occurrence_start: session.starts_at,
          },
        ];
      if (!session.recurrence_until) return [];
      return expandRecurringSessions(
        [session],
        new Date(session.starts_at),
        new Date(`${session.recurrence_until}T17:00:00.000Z`),
        (stateResult.data ?? []) as CalendarOccurrenceState[],
      );
    });
    return {
      total: items.length,
      completed: items.filter((item) => item.completed_at).length,
      resolved: items.filter((item) => item.completed_at || item.not_needed_at)
        .length,
    };
  }
  private async syncTaskFromChecklists(taskId: string | null | undefined) {
    if (!taskId) return;
    const [summary, taskResult] = await Promise.all([
      this.checklistSummary(taskId),
      this.supabase
        .from('tasks')
        .select('status,previous_status,completed_at')
        .eq('id', taskId)
        .single(),
    ]);
    assertNoError(taskResult.error);
    if (!taskResult.data) return;
    const done = summary.total > 0 && summary.resolved === summary.total;
    const currentStatus = taskResult.data.status as string;
    const nextStatus = done
      ? 'completed'
      : currentStatus === 'completed'
        ? ((taskResult.data.previous_status as string | null) ?? 'planned')
        : currentStatus;
    const update = await this.supabase
      .from('tasks')
      .update({
        progress: summary.total
          ? Math.round((summary.resolved / summary.total) * 100)
          : 0,
        status: nextStatus,
        previous_status:
          done && currentStatus !== 'completed'
            ? currentStatus
            : done
              ? taskResult.data.previous_status
              : null,
        completed_at: done
          ? (taskResult.data.completed_at ?? new Date().toISOString())
          : null,
      })
      .eq('id', taskId);
    assertNoError(update.error);
  }
  async previewTimelineGroup(goalId: string) {
    const result = await this.supabase.rpc('myplan_preview_timeline_group', {
      target_goal: goalId,
    });
    assertNoError(result.error);
    return result.data as TimelineGroupPlan;
  }
  async moveTimelineGroup(goalId: string, days: number, version: string) {
    const result = await this.supabase.rpc('myplan_move_timeline_group', {
      target_goal: goalId,
      day_offset: days,
      expected_version: version,
    });
    assertNoError(result.error);
  }
  async moveTimelineTask(id: string, input: TimelineTaskMove) {
    const result = await this.supabase.rpc('myplan_move_timeline_task', {
      target_task: id,
      input,
    });
    assertNoError(result.error);
  }
  async getTimelineWorkspace() {
    const [goals, tasks, milestones, checklistRows, rules, occurrenceStates] =
      await Promise.all([
        allRows(
          this.supabase
            .from('goals')
            .select(
              'id,title,description,progress,status,starts_at,ends_at,archived_at,deleted_at,color_key',
            )
            .neq('status', 'archived')
            .is('deleted_at', null)
            .order('created_at')
            .order('id'),
        ),
        allRows(
          this.supabase
            .from('tasks')
            .select(taskSelect)
            .is('archived_at', null)
            .is('deleted_at', null)
            .order('created_at')
            .order('id'),
        ),
        allRows(
          this.supabase
            .from('timeline_milestones')
            .select('id,goal_id,task_id,title,milestone_on')
            .order('milestone_on')
            .order('id'),
        ),
        allRows(
          this.supabase
            .from('calendar_entries')
            .select(
              'id,task_id,title,starts_at,ends_at,all_day,timezone,item_type,completed_at,not_needed_at,notification_offsets,is_pinned',
            )
            .eq('item_type', 'checklist')
            .order('id'),
        ),
        allRows(
          this.supabase
            .from('recurrence_rules')
            .select('calendar_entry_id,rrule')
            .order('id'),
        ),
        allRows(
          this.supabase
            .from('calendar_occurrence_states')
            .select(
              'calendar_entry_id,occurrence_start,completed_at,not_needed_at,override_starts_at,override_ends_at',
            )
            .order('calendar_entry_id')
            .order('occurrence_start'),
        ),
      ]);
    assertNoError(
      goals.error ||
        tasks.error ||
        milestones.error ||
        checklistRows.error ||
        rules.error ||
        occurrenceStates.error,
    );
    const rows = (tasks.data ?? []) as CloudTask[];
    const ruleMap = new Map(
      (rules.data ?? []).map((rule) => [rule.calendar_entry_id, rule.rrule]),
    );
    const checklistCounts = summarizeChecklistSessions(
      (checklistRows.data ?? []).map((entry) => ({
        ...entry,
        ...parseRrule(ruleMap.get(entry.id)),
      })) as CalendarSession[],
      (occurrenceStates.data ?? []) as CalendarOccurrenceState[],
    );
    return {
      goals: attachGoalTaskCounts(
        (goals.data ?? []).map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          progress: row.progress,
          status: row.status,
          starts_on: dateOnly(row.starts_at),
          ends_on: dateOnly(row.ends_at),
          archived_at: row.archived_at,
          deleted_at: row.deleted_at,
          task_count: 0,
          completed_task_count: 0,
          color_key: row.color_key,
        })) as Goal[],
        rows,
      ),
      tasks: rows.map((row) => ({
        ...mapTask(row),
        active_checklist_count: checklistCounts.get(row.id)?.total ?? 0,
        checklist_resolved_count: checklistCounts.get(row.id)?.resolved ?? 0,
        checklist_done_count: checklistCounts.get(row.id)?.completed ?? 0,
        progress: checklistCounts.get(row.id)?.total
          ? Math.round(
              ((checklistCounts.get(row.id)?.resolved ?? 0) /
                (checklistCounts.get(row.id)?.total ?? 1)) *
                100,
            )
          : row.progress,
      })),
      links: rows
        .filter((row) => row.goal_id)
        .map((row) => ({ task_id: row.id, goal_id: row.goal_id as string })),
      milestones: (milestones.data ?? []) as TimelineMilestone[],
      statuses,
    };
  }
  async createTimelineMilestone(input: Omit<TimelineMilestone, 'id'>) {
    const owner_user_id = await this.userId();
    const id = crypto.randomUUID();
    const { error } = await this.supabase
      .from('timeline_milestones')
      .insert({ ...input, id, owner_user_id });
    assertNoError(error);
    return id;
  }
  async updateTimelineMilestone(
    id: string,
    changes: Partial<Omit<TimelineMilestone, 'id'>>,
  ) {
    const { error } = await this.supabase
      .from('timeline_milestones')
      .update(changes)
      .eq('id', id);
    assertNoError(error);
  }
  async deleteTimelineMilestone(id: string) {
    const { error } = await this.supabase
      .from('timeline_milestones')
      .delete()
      .eq('id', id);
    assertNoError(error);
  }
  async getTheme() {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('theme')
      .maybeSingle();
    assertNoError(error);
    return (data?.theme ?? 'jade') as ThemeId;
  }
  async saveTheme(theme: ThemeId) {
    const id = await this.userId();
    const { error } = await this.supabase
      .from('profiles')
      .update({ theme })
      .eq('id', id);
    assertNoError(error);
  }
  async getPomodoroWorkspace() {
    const [settingsResult, sessionsResult] = await Promise.all([
      this.supabase
        .from('pomodoro_settings')
        .select(
          'focus_minutes,short_break_minutes,long_break_minutes,daily_target_type,daily_target_value',
        )
        .maybeSingle(),
      allRows(
        this.supabase
          .from('pomodoro_sessions')
          .select('id,started_at,completed_at,duration_seconds')
          .eq('session_type', 'focus')
          .eq('status', 'completed')
          .order('completed_at', { ascending: false })
          .order('id'),
      ),
    ]);
    assertNoError(settingsResult.error || sessionsResult.error);
    return {
      settings: (settingsResult.data ??
        defaultPomodoroSettings) as PomodoroSettings,
      sessions: (sessionsResult.data ?? [])
        .filter((row) => row.completed_at)
        .map((row) => ({
          id: row.id,
          started_at: row.started_at,
          completed_at: row.completed_at as string,
          duration_minutes: Math.round(row.duration_seconds / 60),
        })),
    };
  }
  async savePomodoroSettings(input: PomodoroSettings) {
    const owner_user_id = await this.userId();
    const { error } = await this.supabase
      .from('pomodoro_settings')
      .upsert({ ...input, owner_user_id }, { onConflict: 'owner_user_id' });
    assertNoError(error);
  }
  async recordPomodoroSession(input: PomodoroRecord) {
    const owner_user_id = await this.userId();
    const duration_seconds = input.duration_minutes * 60;
    const { error } = await this.supabase.from('pomodoro_sessions').upsert(
      {
        id: crypto.randomUUID(),
        owner_user_id,
        session_type: 'focus',
        started_at: input.started_at,
        expected_end_at: input.completed_at,
        completed_at: input.completed_at,
        duration_seconds,
        status: 'completed',
        actual_focus_seconds: duration_seconds,
        client_id: input.client_id,
      },
      { onConflict: 'owner_user_id,client_id', ignoreDuplicates: true },
    );
    assertNoError(error);
  }
  async getReviewsWorkspace(a: string, b: string) {
    const [reviews, completed, open, goals] = await Promise.all([
      allRows(
        this.supabase
          .from('reviews')
          .select('id,period_start,answers,updated_at')
          .eq('review_type', 'weekly')
          .order('period_start', { ascending: false })
          .order('id'),
      ),
      this.supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .gte('completed_at', a)
        .lt('completed_at', b)
        .is('deleted_at', null),
      this.supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .is('completed_at', null)
        .is('archived_at', null)
        .is('deleted_at', null),
      this.supabase
        .from('goals')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active')
        .is('deleted_at', null),
    ]);
    assertNoError(
      reviews.error || completed.error || open.error || goals.error,
    );
    return {
      reviews: (reviews.data ?? []).map((row) => {
        const answers = (row.answers ?? {}) as Record<string, unknown>;
        return {
          id: row.id,
          week_start: dateOnly(row.period_start) ?? '',
          wins: answerText(answers.wins),
          challenges: answerText(answers.challenges),
          next_week_focus: answerText(answers.next_week_focus),
          satisfaction:
            typeof answers.satisfaction === 'number'
              ? answers.satisfaction
              : null,
          updated_at: row.updated_at,
        };
      }),
      stats: {
        completedTasks: completed.count ?? 0,
        openTasks: open.count ?? 0,
        activeGoals: goals.count ?? 0,
      },
    };
  }
  async saveWeeklyReview(input: Omit<WeeklyReview, 'id' | 'updated_at'>) {
    const owner_user_id = await this.userId();
    const answers = {
      wins: input.wins,
      challenges: input.challenges,
      next_week_focus: input.next_week_focus,
      satisfaction: input.satisfaction,
    };
    const existing = await this.supabase
      .from('reviews')
      .select('id')
      .eq('owner_user_id', owner_user_id)
      .eq('review_type', 'weekly')
      .eq('period_start', input.week_start)
      .maybeSingle();
    assertNoError(existing.error);
    if (existing.data) {
      const result = await this.supabase
        .from('reviews')
        .update({ answers, completed_at: new Date().toISOString() })
        .eq('id', existing.data.id);
      assertNoError(result.error);
    } else {
      const end = new Date(`${input.week_start}T00:00:00`);
      end.setDate(end.getDate() + 6);
      const result = await this.supabase.from('reviews').insert({
        id: crypto.randomUUID(),
        owner_user_id,
        review_type: 'weekly',
        period_start: input.week_start,
        period_end: end.toISOString().slice(0, 10),
        answers,
        completed_at: new Date().toISOString(),
      });
      assertNoError(result.error);
    }
  }
}

const LOCAL_API_URL =
  process.env.NEXT_PUBLIC_LOCAL_API_URL || 'http://127.0.0.1:4318';
const LOCAL_API_TOKEN = process.env.NEXT_PUBLIC_LOCAL_API_TOKEN || '';
export async function localRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(undoHeaders()))
    headers.set(key, value);
  headers.set('content-type', 'application/json');
  headers.set('x-myplan-local', '1');
  headers.set('x-myplan-local-token', LOCAL_API_TOKEN);
  const response = await fetch(`${LOCAL_API_URL}${path}`, { ...init, headers });
  const payload = (await response.json()) as { data?: T; error?: string };
  if (!response.ok || payload.error)
    throw new Error(
      payload.error || `Local database request failed (${response.status}).`,
    );
  return payload.data as T;
}
class LocalPlanningRepository implements PlanningRepository {
  saveTaskEdit(id: string, changes: TaskChanges, completed: boolean) {
    return localRequest<void>(`/api/tasks/${encodeURIComponent(id)}/edit`, {
      method: 'PUT',
      body: JSON.stringify({ changes, completed }),
    });
  }
  listGoals(view: LifecycleView = 'active') {
    return localRequest<Goal[]>(`/api/goals?view=${view}`);
  }
  createGoal(input: GoalInput) {
    return localRequest<string>('/api/goals', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  updateGoal(
    id: string,
    changes: Partial<Goal> & {
      completed_at?: string | null;
      archived_at?: string | null;
    },
  ) {
    return localRequest<void>(`/api/goals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
  }
  deleteGoal(id: string) {
    return localRequest<void>(`/api/goals/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  getTaskWorkspace(view: LifecycleView = 'active') {
    return localRequest<TaskWorkspace>(`/api/tasks/workspace?view=${view}`);
  }
  createTask(input: TaskInput) {
    return localRequest<string>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  updateTask(id: string, changes: TaskChanges) {
    return localRequest<void>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
  }
  setTaskCompletion(id: string, completed: boolean) {
    return localRequest<void>(
      `/api/tasks/${encodeURIComponent(id)}/completion`,
      {
        method: 'PUT',
        body: JSON.stringify({ completed }),
      },
    );
  }
  deleteTask(id: string) {
    return localRequest<void>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  getTodayWorkspace() {
    return localRequest<TodayWorkspace>('/api/today');
  }
  getCalendarWorkspace() {
    return localRequest<CalendarWorkspace>('/api/calendar');
  }
  createCalendarSession(input: CalendarSessionInput) {
    return localRequest<string>('/api/calendar', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  updateCalendarSession(
    id: string,
    changes: Partial<CalendarSessionInput>,
    expected?: CalendarSessionInput,
  ) {
    return localRequest<void>(`/api/calendar/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...changes,
        ...(expected ? { _expected: expected } : {}),
      }),
    });
  }
  deleteCalendarSession(id: string) {
    return localRequest<void>(`/api/calendar/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  updateCalendarOccurrence(
    calendarEntryId: string,
    occurrenceStart: string,
    changes: Partial<
      Pick<
        CalendarOccurrenceState,
        | 'completed_at'
        | 'not_needed_at'
        | 'override_starts_at'
        | 'override_ends_at'
      >
    >,
  ) {
    return localRequest<void>(
      `/api/calendar/${encodeURIComponent(calendarEntryId)}/occurrences`,
      {
        method: 'PUT',
        body: JSON.stringify({ occurrence_start: occurrenceStart, ...changes }),
      },
    );
  }
  moveCalendarOccurrences(
    calendarEntryId: string,
    changes: Array<
      Pick<
        CalendarOccurrenceState,
        'occurrence_start' | 'override_starts_at' | 'override_ends_at'
      >
    >,
  ) {
    return localRequest<void>(
      `/api/calendar/${encodeURIComponent(calendarEntryId)}/occurrences/move`,
      {
        method: 'PUT',
        body: JSON.stringify({ changes }),
      },
    );
  }
  moveCalendarSeries(
    calendarEntryId: string,
    originalStart: string,
    originalEnd: string,
    nextStart: string,
    nextEnd: string,
  ) {
    return localRequest<void>(
      `/api/calendar/${encodeURIComponent(calendarEntryId)}/series/move`,
      {
        method: 'PUT',
        body: JSON.stringify({
          original_start: originalStart,
          original_end: originalEnd,
          next_start: nextStart,
          next_end: nextEnd,
        }),
      },
    );
  }
  previewTimelineGroup(goalId: string) {
    return localRequest<TimelineGroupPlan>(
      `/api/timeline/groups/${encodeURIComponent(goalId)}`,
    );
  }
  moveTimelineGroup(goalId: string, days: number, version: string) {
    return localRequest<void>(
      `/api/timeline/groups/${encodeURIComponent(goalId)}/move`,
      { method: 'PUT', body: JSON.stringify({ days, version }) },
    );
  }
  moveTimelineTask(id: string, input: TimelineTaskMove) {
    return localRequest<void>(
      `/api/timeline/tasks/${encodeURIComponent(id)}/move`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }
  getTimelineWorkspace() {
    return localRequest<TimelineWorkspace>('/api/timeline');
  }
  createTimelineMilestone(input: Omit<TimelineMilestone, 'id'>) {
    return localRequest<string>('/api/timeline/milestones', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  updateTimelineMilestone(
    id: string,
    changes: Partial<Omit<TimelineMilestone, 'id'>>,
  ) {
    return localRequest<void>(
      `/api/timeline/milestones/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(changes) },
    );
  }
  deleteTimelineMilestone(id: string) {
    return localRequest<void>(
      `/api/timeline/milestones/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }
  getTheme() {
    return localRequest<ThemeId>('/api/settings/theme');
  }
  saveTheme(theme: ThemeId) {
    return localRequest<void>('/api/settings/theme', {
      method: 'PUT',
      body: JSON.stringify({ theme }),
    });
  }
  getPomodoroWorkspace() {
    return localRequest<PomodoroWorkspace>('/api/pomodoro');
  }
  savePomodoroSettings(input: PomodoroSettings) {
    return localRequest<void>('/api/pomodoro/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }
  recordPomodoroSession(input: PomodoroRecord) {
    return localRequest<void>('/api/pomodoro/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  getReviewsWorkspace(a: string, b: string) {
    return localRequest<ReviewsWorkspace>(
      `/api/reviews?weekStart=${encodeURIComponent(a)}&nextWeek=${encodeURIComponent(b)}`,
    );
  }
  saveWeeklyReview(input: Omit<WeeklyReview, 'id' | 'updated_at'>) {
    return localRequest<void>(
      `/api/reviews/${encodeURIComponent(input.week_start)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }
}
let localRepository: PlanningRepository | null = null;
let cloudRepository: PlanningRepository | null = null;
function withUndo(repository: PlanningRepository): PlanningRepository {
  const supported = new Set([
    'updateGoal',
    'updateTask',
    'saveTaskEdit',
    'setTaskCompletion',
    'updateCalendarSession',
    'updateCalendarOccurrence',
    'moveCalendarOccurrences',
    'moveCalendarSeries',
    'updateTimelineMilestone',
    'moveTimelineGroup',
    'moveTimelineTask',
  ]);
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(repository, {
    get(target, key) {
      if (methods.has(key)) return methods.get(key);
      const original = Reflect.get(target, key);
      if (typeof original !== 'function') return original;
      const wrapped = (...args: unknown[]) => {
        const name = String(key);
        return /^(update|set|save|move|create|delete|record)/.test(name)
          ? recordUndo(
              name.replace(/([A-Z])/g, ' $1').toLowerCase(),
              () => original.apply(target, args),
              supported.has(name),
              !supported.has(name),
            )
          : original.apply(target, args);
      };
      methods.set(key, wrapped);
      return wrapped;
    },
  });
}
export function getPlanningRepository(): PlanningRepository | null {
  if (getAppDataMode() === 'local') {
    configureUndo({
      ready: ({ operation, session }) =>
        localRequest<boolean>(
          `/api/undo/ready?operation=${operation}&session=${session}`,
        ),
      apply: ({ operation, session }) =>
        localRequest<void>('/api/undo', {
          method: 'POST',
          body: JSON.stringify({ operation, session }),
        }),
    });
    localRepository ??= withUndo(new LocalPlanningRepository());
    return localRepository;
  }
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  configureUndo({
    ready: async ({ operation, session }) => {
      const result = await supabase.rpc('myplan_undo_ready', {
        target_operation: operation,
        target_session: session,
      });
      assertNoError(result.error);
      return Boolean(result.data);
    },
    apply: async ({ operation, session }) => {
      const result = await supabase.rpc('myplan_undo_apply', {
        target_operation: operation,
        target_session: session,
      });
      assertNoError(result.error);
    },
  });
  cloudRepository ??= withUndo(new SupabasePlanningRepository(supabase));
  return cloudRepository;
}
