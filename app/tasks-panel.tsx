'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Flag,
  LoaderCircle,
  Plus,
  RotateCcw,
  Target,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  getErrorMessage,
  getPlanningRepository,
  type GoalOption,
  type Priority,
  type Task,
  type WorkflowStatus,
} from '@/lib/data/repository';

type StoredTask = Task & {
  goalId?: string;
  goalTitle?: string;
};

export function TasksPanel() {
  const repository = getPlanningRepository();
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [statuses, setStatuses] = useState<WorkflowStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueOn, setDueOn] = useState('');
  const [goalId, setGoalId] = useState('');
  const [plannedStart, setPlannedStart] = useState('');
  const [plannedEnd, setPlannedEnd] = useState('');
  const [parentTaskId, setParentTaskId] = useState('');
  const [dependencyTaskId, setDependencyTaskId] = useState('');
  const [milestone, setMilestone] = useState(false);
  const [message, setMessage] = useState('');

  const loadTasks = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    try {
      const workspace = await repository.getTaskWorkspace();
      const linkMap = new Map(
        workspace.links.map((link) => [link.task_id, link.goal_id]),
      );
      const goalMap = new Map(
        workspace.goals.map((goal) => [goal.id, goal.title]),
      );
      setGoals(workspace.goals);
      setStatuses(workspace.statuses);
      setTasks(
        workspace.tasks.map((task) => {
          const linkedGoalId = linkMap.get(task.id);
          return {
            ...task,
            goalId: linkedGoalId,
            goalTitle: linkedGoalId ? goalMap.get(linkedGoalId) : undefined,
          };
        }),
      );
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadTasks(), 0);
    return () => window.clearTimeout(handle);
  }, [loadTasks]);

  const completedCount = useMemo(
    () => tasks.filter((task) => Boolean(task.completed_at)).length,
    [tasks],
  );

  async function createTask(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!repository || !title.trim()) return;
    const initialStatus =
      statuses.find((status) => status.category === 'planned') ??
      statuses.find((status) => status.category === 'backlog');
    if (!initialStatus) {
      setMessage(
        'The default workflow is missing. Sign out and ask the owner to repair this account.',
      );
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      await repository.createTask({
        title: title.trim(),
        priority,
        due_at: dueOn ? new Date(`${dueOn}T23:59:00`).toISOString() : null,
        workflow_status_id: initialStatus.id,
        goal_id: goalId || undefined,
        planned_start: plannedStart || null,
        planned_end: plannedEnd || plannedStart || null,
        progress: 0,
        parent_task_id: parentTaskId || null,
        dependency_task_id: dependencyTaskId || null,
        is_milestone: milestone,
      });
    } catch (error) {
      setSaving(false);
      setMessage(getErrorMessage(error));
      return;
    }
    setSaving(false);
    setTitle('');
    setPriority('medium');
    setDueOn('');
    setGoalId('');
    setPlannedStart('');
    setPlannedEnd('');
    setParentTaskId('');
    setDependencyTaskId('');
    setMilestone(false);
    setShowForm(false);
    setMessage('Task created and added to your plan.');
    await loadTasks();
  }

  async function toggleTask(task: StoredTask) {
    if (!repository) return;
    const isCompleted = Boolean(task.completed_at);
    const completedStatus = statuses.find(
      (status) => status.category === 'completed',
    );
    const reopenStatus =
      statuses.find((status) => status.id === task.previous_status_id) ??
      statuses.find((status) => status.category === 'planned') ??
      statuses.find((status) => status.category === 'backlog');
    const nextStatus = isCompleted ? reopenStatus : completedStatus;
    if (!nextStatus) return;
    try {
      await repository.updateTask(task.id, {
        workflow_status_id: nextStatus.id,
        previous_status_id: isCompleted ? null : task.workflow_status_id,
        completed_at: isCompleted ? null : new Date().toISOString(),
      });
      await loadTasks();
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }

  return (
    <section aria-labelledby="tasks-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
            Turn direction into action
          </p>
          <h1
            id="tasks-heading"
            className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
          >
            Tasks
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {tasks.length} tasks · {completedCount} completed. Link each task to
            a goal when it supports one.
          </p>
        </div>
        <Button size="lg" onClick={() => setShowForm((value) => !value)}>
          <Plus />
          {showForm ? 'Close form' : 'Create task'}
        </Button>
      </div>

      {showForm ? (
        <Card className="mt-7 border bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Add a task</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 md:grid-cols-2" onSubmit={createTask}>
              <label className="text-xs font-semibold md:col-span-2">
                Task title
                <input
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What needs your attention?"
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="text-xs font-semibold">
                Priority
                <select
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as StoredTask['priority'])
                  }
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
              <label className="text-xs font-semibold">
                Deadline
                <input
                  type="date"
                  value={dueOn}
                  onChange={(event) => setDueOn(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-xs font-semibold">
                Planned start
                <input
                  type="date"
                  value={plannedStart}
                  onChange={(event) => setPlannedStart(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-xs font-semibold">
                Planned end
                <input
                  type="date"
                  min={plannedStart || undefined}
                  value={plannedEnd}
                  onChange={(event) => setPlannedEnd(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-xs font-semibold md:col-span-2">
                Primary goal
                <select
                  value={goalId}
                  onChange={(event) => setGoalId(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                >
                  <option value="">Inbox — no goal</option>
                  {goals.map((goal) => (
                    <option key={goal.id} value={goal.id}>
                      {goal.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold">
                Parent task (optional)
                <select
                  value={parentTaskId}
                  onChange={(event) => setParentTaskId(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold">
                Depends on (optional)
                <select
                  value={dependencyTaskId}
                  onChange={(event) => setDependencyTaskId(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold md:col-span-2">
                <input
                  type="checkbox"
                  checked={milestone}
                  onChange={(event) => setMilestone(event.target.checked)}
                />
                Milestone
              </label>
              <div className="md:col-span-2">
                <Button type="submit" disabled={saving}>
                  {saving ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Plus />
                  )}
                  Save task
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {message ? (
        <p
          className="mt-4 rounded-xl border bg-muted px-4 py-3 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}

      <Card className="mt-7 border bg-card shadow-sm">
        <CardContent className="pt-1">
          {loading ? (
            <div className="grid min-h-[260px] place-items-center">
              <LoaderCircle className="size-6 animate-spin text-primary" />
            </div>
          ) : tasks.length === 0 ? (
            <div className="grid min-h-[300px] place-items-center text-center">
              <div>
                <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
                  <CheckCircle2 />
                </span>
                <h2 className="mt-5 text-lg font-semibold">No tasks yet</h2>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                  Create a task and optionally connect it to one of your goals.
                </p>
                <Button className="mt-5" onClick={() => setShowForm(true)}>
                  <Plus />
                  Create task
                </Button>
              </div>
            </div>
          ) : (
            tasks.map((task) => {
              const overdue = Boolean(
                task.due_at &&
                !task.completed_at &&
                new Date(task.due_at) < new Date(),
              );
              return (
                <article
                  key={task.id}
                  className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 border-b py-4 last:border-b-0 sm:grid-cols-[20px_minmax(0,1fr)_auto]"
                >
                  <Checkbox
                    checked={Boolean(task.completed_at)}
                    onCheckedChange={() => void toggleTask(task)}
                    aria-label={`${task.completed_at ? 'Reopen' : 'Complete'} ${task.title}`}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => void toggleTask(task)}
                      className={`block max-w-full truncate text-left text-sm font-semibold ${task.completed_at ? 'text-muted-foreground line-through' : ''}`}
                    >
                      {task.title}
                    </button>
                    <p
                      className={`mt-1 text-[11px] ${overdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}
                    >
                      {task.due_at
                        ? `${overdue ? 'Overdue · ' : 'Due '}${new Date(task.due_at).toLocaleDateString()}`
                        : 'No deadline'}
                    </p>
                    <small className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Target className="size-3" />
                      {task.goalTitle ?? 'Inbox'}
                    </small>
                  </div>
                  <div className="col-start-2 flex items-center gap-2 sm:col-start-3">
                    <Badge
                      variant="outline"
                      className={`capitalize ${task.priority === 'urgent' ? 'border-destructive/30 bg-destructive/10 text-destructive' : task.priority === 'high' ? 'priority-high' : ''}`}
                    >
                      <Flag />
                      {task.priority}
                    </Badge>
                    {task.completed_at ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Reopen ${task.title}`}
                        onClick={() => void toggleTask(task)}
                      >
                        <RotateCcw />
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </CardContent>
      </Card>
    </section>
  );
}
