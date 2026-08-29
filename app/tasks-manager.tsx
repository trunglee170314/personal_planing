'use client';
import { readSettledPlanning } from '@/lib/undo-manager';

import { RelationSelect } from '@/components/relation-select';
import { ItemAnnotations } from '@/components/item-annotations';
import {
  useWorkspaceList,
  WorkspaceListTools,
} from '@/components/workspace-list-tools';
import { MYPLAN_DATA_CHANGED } from '@/lib/data/data-events';

import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ExternalLink,
  Flag,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getErrorMessage,
  getPlanningRepository,
  type GoalOption,
  type LifecycleView,
  type Priority,
  type Task,
  type TaskChanges,
  type WorkflowStatus,
} from '@/lib/data/repository';
import { announceDataChanged } from '@/lib/data/data-events';

type StoredTask = Task & { goalId?: string; goalTitle?: string };
const viewCopy: Record<LifecycleView, { label: string; empty: string }> = {
  active: { label: 'Active', empty: 'No active tasks yet.' },
  archived: { label: 'Archived', empty: 'No archived tasks.' },
  trash: { label: 'Trash', empty: 'Task trash is empty.' },
};

export function TasksPanel({
  initialView = 'active',
  initialQuery = '',
}: { initialView?: LifecycleView; initialQuery?: string } = {}) {
  const repository = getPlanningRepository();
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [referenceTasks, setReferenceTasks] = useState<Task[]>([]);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [statuses, setStatuses] = useState<WorkflowStatus[]>([]);
  const [view, setView] = useState<LifecycleView>(initialView);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueOn, setDueOn] = useState('');
  const [goalId, setGoalId] = useState('');
  const [plannedStart, setPlannedStart] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [parentTaskId, setParentTaskId] = useState('');
  const [dependencyTaskId, setDependencyTaskId] = useState('');
  const [workflowStatusId, setWorkflowStatusId] = useState('');
  const [message, setMessage] = useState('');
  const [permanentDelete, setPermanentDelete] = useState<StoredTask | null>(
    null,
  );
  const mutationVersionsRef = useRef(new Map<string, number>());
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());
  const sourceRef = useRef('tasks');
  const loadRequestRef = useRef(0);

  function nextMutationVersion(id: string) {
    const version = (mutationVersionsRef.current.get(id) ?? 0) + 1;
    mutationVersionsRef.current.set(id, version);
    return version;
  }

  async function enqueueMutation(id: string, action: () => Promise<void>) {
    const previous = mutationQueuesRef.current.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    mutationQueuesRef.current.set(id, next);
    try {
      await next;
    } finally {
      if (mutationQueuesRef.current.get(id) === next)
        mutationQueuesRef.current.delete(id);
    }
  }

  const loadTasks = useCallback(
    async (silent = false) => {
      if (!repository) return;
      const request = ++loadRequestRef.current;
      if (!silent) setLoading(true);
      try {
        const [workspace, activeWorkspace] = await readSettledPlanning(() =>
          Promise.all([
            repository.getTaskWorkspace(view),
            view === 'active'
              ? Promise.resolve(null)
              : repository.getTaskWorkspace('active'),
          ]),
        );
        const linkMap = new Map(
          workspace.links.map((link) => [link.task_id, link.goal_id]),
        );
        const goalMap = new Map(
          workspace.goals.map((goal) => [goal.id, goal.title]),
        );
        if (request !== loadRequestRef.current) return;
        setGoals(workspace.goals);
        setStatuses(workspace.statuses);
        const references = activeWorkspace ?? workspace;
        setReferenceTasks(
          references.tasks.map((task) => ({
            ...task,
            goalTitle: references.goals.find(
              (goal) =>
                goal.id ===
                references.links.find((link) => link.task_id === task.id)
                  ?.goal_id,
            )?.title,
          })),
        );
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
        if (request === loadRequestRef.current)
          setMessage(getErrorMessage(error));
      } finally {
        if (request === loadRequestRef.current && !silent) setLoading(false);
      }
    },
    [repository, view],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => void loadTasks(), 0);
    return () => window.clearTimeout(handle);
  }, [loadTasks]);
  useEffect(() => {
    const sync = (event: Event) => {
      if ((event as CustomEvent).detail?.source !== 'tasks')
        void loadTasks(true);
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
  }, [loadTasks]);

  const completedCount = useMemo(
    () => tasks.filter((task) => Boolean(task.completed_at)).length,
    [tasks],
  );
  const taskOptions = useMemo(() => {
    const byId = new Map(
      [...referenceTasks, ...tasks].map((task) => [task.id, task]),
    );
    if (editingId) byId.delete(editingId);
    return [...byId.values()];
  }, [editingId, referenceTasks, tasks]);
  const listing = useWorkspaceList(
    tasks,
    `tasks:${view}`,
    (item) => item.goalTitle ?? 'No goal',
    (item) => item.title,
    (item) => item.due_at ?? '',
    initialQuery,
  );

  function resetForm() {
    setEditingId(null);
    setTitle('');
    setPriority('medium');
    setDueOn('');
    setGoalId('');
    setPlannedStart('');
    setLinkUrl('');
    setLinkLabel('');
    setParentTaskId('');
    setDependencyTaskId('');
    setWorkflowStatusId('');
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
    setMessage('');
  }
  function closeForm() {
    resetForm();
    setShowForm(false);
  }

  function startEdit(task: StoredTask) {
    setEditingId(task.id);
    setTitle(task.title);
    setPriority(task.priority);
    setDueOn(task.due_at?.slice(0, 10) ?? '');
    setGoalId(task.goalId ?? '');
    setPlannedStart(task.planned_start ?? '');
    setLinkUrl(task.link_url ?? '');
    setLinkLabel(task.link_label ?? '');
    setParentTaskId(task.parent_task_id ?? '');
    setDependencyTaskId(task.dependency_task_id ?? '');
    setWorkflowStatusId(task.workflow_status_id);
    setShowForm(true);
    setMessage('');
  }

  async function saveTask(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository || !title.trim()) return;
    const initialStatus =
      statuses.find((status) => status.category === 'planned') ??
      statuses.find((status) => status.category === 'backlog');
    const selectedStatus =
      statuses.find((status) => status.id === workflowStatusId) ??
      initialStatus;
    if (!selectedStatus) {
      setMessage(
        'The default workflow is missing. Sign out and ask the owner to repair this account.',
      );
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const editingTask = editingId
        ? tasks.find((task) => task.id === editingId)
        : null;
      if (
        editingTask &&
        !editingTask.completed_at &&
        selectedStatus.category === 'completed' &&
        editingTask.checklist_resolved_count <
          editingTask.active_checklist_count &&
        !window.confirm(
          `Complete “${editingTask.title}” now? Unfinished checklist items will be marked Not needed.`,
        )
      ) {
        setSaving(false);
        return;
      }
      const common = {
        title: title.trim(),
        priority,
        due_at: dueOn
          ? new Date(`${dueOn}T23:59:00+07:00`).toISOString()
          : null,
        planned_start: plannedStart || null,
        planned_end: null,
        parent_task_id: parentTaskId || null,
        dependency_task_id: dependencyTaskId || null,
        is_milestone: false,
        link_url: linkUrl.trim() || null,
        link_label: linkLabel.trim() || null,
      };
      if (editingId) {
        if (!editingTask) throw new Error('Task not found.');
        const checklistControlled = Boolean(editingTask.active_checklist_count);
        const linkedGoal = goals.find((goal) => goal.id === (goalId || null));
        const changes: TaskChanges = {
          ...common,
          goal_id: goalId || null,
          ...(checklistControlled
            ? selectedStatus.category === 'completed'
              ? {}
              : { workflow_status_id: selectedStatus.id }
            : {
                workflow_status_id: selectedStatus.id,
                progress: editingTask.progress,
                completed_at:
                  selectedStatus.category === 'completed'
                    ? new Date().toISOString()
                    : null,
              }),
        };
        const optimistic: StoredTask = {
          ...editingTask,
          ...common,
          goalId: goalId || undefined,
          goalTitle: linkedGoal?.title,
          workflow_status_id: selectedStatus.id,
          completed_at:
            selectedStatus.category === 'completed'
              ? (editingTask.completed_at ?? new Date().toISOString())
              : null,
          progress:
            selectedStatus.category === 'completed'
              ? 100
              : editingTask.progress,
          checklist_resolved_count:
            checklistControlled && selectedStatus.category === 'completed'
              ? editingTask.active_checklist_count
              : editingTask.checklist_resolved_count,
        };
        const fields = [
          ...Object.keys(common),
          'goalId',
          'goalTitle',
          'workflow_status_id',
          'completed_at',
          'progress',
          'checklist_resolved_count',
        ];
        const versions = new Map(
          fields.map((field) => [
            field,
            nextMutationVersion(`${editingId}:${field}`),
          ]),
        );
        setTasks((items) =>
          items.map((item) => (item.id === editingId ? optimistic : item)),
        );
        closeForm();
        try {
          await enqueueMutation(editingId, async () => {
            try {
              if (
                checklistControlled &&
                editingTask.completed_at &&
                selectedStatus.category !== 'completed'
              )
                await repository.setTaskCompletion(editingId, false);
              await repository.updateTask(editingId, changes);
              if (
                checklistControlled &&
                selectedStatus.category === 'completed' &&
                !editingTask.completed_at
              )
                await repository.setTaskCompletion(editingId, true);
            } catch (error) {
              try {
                if (checklistControlled)
                  await repository.setTaskCompletion(
                    editingId,
                    Boolean(editingTask.completed_at),
                  );
                await repository.updateTask(editingId, {
                  title: editingTask.title,
                  priority: editingTask.priority,
                  due_at: editingTask.due_at,
                  planned_start: editingTask.planned_start,
                  planned_end: editingTask.planned_end,
                  parent_task_id: editingTask.parent_task_id,
                  dependency_task_id: editingTask.dependency_task_id,
                  is_milestone: editingTask.is_milestone,
                  link_url: editingTask.link_url,
                  link_label: editingTask.link_label,
                  goal_id: editingTask.goalId ?? null,
                  ...(checklistControlled
                    ? {}
                    : {
                        workflow_status_id: editingTask.workflow_status_id,
                        progress: editingTask.progress,
                        completed_at: editingTask.completed_at,
                      }),
                });
              } catch {
                /* original failure remains the actionable error */
              }
              throw error;
            }
          });
        } catch (error) {
          setTasks((items) =>
            items.map((item) => {
              if (item.id !== editingId) return item;
              const rollback = { ...item };
              for (const field of fields)
                if (
                  mutationVersionsRef.current.get(`${editingId}:${field}`) ===
                  versions.get(field)
                )
                  Object.assign(rollback, {
                    [field]: editingTask[field as keyof StoredTask],
                  });
              return rollback;
            }),
          );
          try {
            const fresh = await repository.getTaskWorkspace(view);
            const serverTask = fresh.tasks.find(
              (item) => item.id === editingId,
            );
            const serverGoalId = fresh.links.find(
              (link) => link.task_id === editingId,
            )?.goal_id;
            const serverGoal = fresh.goals.find(
              (goal) => goal.id === serverGoalId,
            );
            if (serverTask)
              setTasks((items) =>
                items.map((item) => {
                  if (item.id !== editingId) return item;
                  const reconciled = { ...item };
                  for (const field of fields) {
                    if (
                      mutationVersionsRef.current.get(
                        `${editingId}:${field}`,
                      ) !== versions.get(field)
                    )
                      continue;
                    if (field === 'goalId') reconciled.goalId = serverGoalId;
                    else if (field === 'goalTitle')
                      reconciled.goalTitle = serverGoal?.title;
                    else {
                      const taskField = field as keyof Task;
                      Object.assign(reconciled, {
                        [taskField]: serverTask[taskField],
                      });
                    }
                  }
                  return reconciled;
                }),
              );
          } catch {
            /* keep the targeted optimistic rollback when reconciliation fails */
          }
          throw error;
        }
      } else {
        const id = await repository.createTask({
          ...common,
          workflow_status_id: selectedStatus.id,
          progress: 0,
          goal_id: goalId || undefined,
        });
        const linkedGoal = goals.find((goal) => goal.id === (goalId || null));
        const created: StoredTask = {
          id,
          ...common,
          workflow_status_id: selectedStatus.id,
          previous_status_id: null,
          completed_at: null,
          progress: 0,
          archived_at: null,
          deleted_at: null,
          active_checklist_count: 0,
          checklist_resolved_count: 0,
          checklist_done_count: 0,
          goalId: goalId || undefined,
          goalTitle: linkedGoal?.title,
        };
        setTasks((items) => [created, ...items]);
        setReferenceTasks((items) => [created, ...items]);
      }
      if (!editingId) closeForm();
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleTask(task: StoredTask) {
    if (!repository) return;
    const isCompleted = Boolean(task.completed_at);
    if (
      !isCompleted &&
      task.active_checklist_count > task.checklist_resolved_count &&
      !window.confirm(
        `Complete “${task.title}” now? Unfinished checklist items will be marked Not needed.`,
      )
    ) {
      return;
    }
    setMessage('');
    const completionFields = [
      'completed_at',
      'workflow_status_id',
      'previous_status_id',
      'progress',
      'checklist_resolved_count',
    ];
    const versions = new Map(
      completionFields.map((field) => [
        field,
        nextMutationVersion(`${task.id}:${field}`),
      ]),
    );
    const completedAt = isCompleted ? null : new Date().toISOString();
    const completedStatus = statuses.find(
      (status) => status.category === 'completed',
    );
    const reopenedStatus =
      statuses.find((status) => status.id === task.previous_status_id) ??
      statuses.find((status) => status.category === 'planned') ??
      statuses.find((status) => status.category === 'backlog');
    const optimistic: StoredTask = {
      ...task,
      completed_at: completedAt,
      workflow_status_id: isCompleted
        ? (reopenedStatus?.id ?? task.workflow_status_id)
        : (completedStatus?.id ?? task.workflow_status_id),
      previous_status_id: isCompleted ? null : task.workflow_status_id,
      progress: isCompleted
        ? task.active_checklist_count
          ? Math.round(
              (task.checklist_resolved_count /
                Math.max(task.active_checklist_count, 1)) *
                100,
            )
          : Math.min(task.progress, 99)
        : 100,
      checklist_resolved_count: isCompleted
        ? task.checklist_resolved_count
        : task.active_checklist_count,
    };
    setTasks((items) =>
      items.map((item) => (item.id === task.id ? optimistic : item)),
    );
    try {
      await enqueueMutation(task.id, () =>
        repository.setTaskCompletion(task.id, !isCompleted),
      );
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setTasks((items) =>
        items.map((item) => {
          if (item.id !== task.id) return item;
          const rollback = { ...item } as StoredTask;
          for (const field of completionFields)
            if (
              mutationVersionsRef.current.get(`${task.id}:${field}`) ===
              versions.get(field)
            )
              Object.assign(rollback, {
                [field]: task[field as keyof StoredTask],
              });
          return rollback;
        }),
      );
      setMessage(getErrorMessage(error));
    }
  }

  async function changeTask(
    task: StoredTask,
    changes: TaskChanges,
    _success: string,
  ) {
    if (!repository) return;
    setMessage('');
    const fields = [
      ...Object.keys(changes),
      ...('goal_id' in changes ? ['goalId', 'goalTitle'] : []),
    ];
    const versions = new Map(
      fields.map((field) => [
        field,
        nextMutationVersion(`${task.id}:${field}`),
      ]),
    );
    const linkedGoal =
      'goal_id' in changes
        ? goals.find((goal) => goal.id === changes.goal_id)
        : null;
    const nextTask = {
      ...task,
      ...changes,
      ...('goal_id' in changes
        ? {
            goalId: changes.goal_id ?? undefined,
            goalTitle: linkedGoal?.title,
          }
        : {}),
    };
    const remainsInView =
      view === 'trash'
        ? Boolean(nextTask.deleted_at)
        : view === 'archived'
          ? Boolean(nextTask.archived_at) && !nextTask.deleted_at
          : !nextTask.archived_at && !nextTask.deleted_at;
    const originalIndex = tasks.findIndex((item) => item.id === task.id);
    setTasks((items) =>
      remainsInView
        ? items.map((item) => (item.id === task.id ? nextTask : item))
        : items.filter((item) => item.id !== task.id),
    );
    try {
      await enqueueMutation(task.id, () =>
        repository.updateTask(task.id, changes),
      );
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setTasks((items) => {
        const existing = items.find((item) => item.id === task.id);
        if (!existing) {
          const latest = fields.every(
            (field) =>
              mutationVersionsRef.current.get(`${task.id}:${field}`) ===
              versions.get(field),
          );
          if (!latest) return items;
          const insertAt = Math.max(0, Math.min(originalIndex, items.length));
          return [...items.slice(0, insertAt), task, ...items.slice(insertAt)];
        }
        const rollback = { ...existing } as StoredTask;
        for (const field of fields) {
          if (
            mutationVersionsRef.current.get(`${task.id}:${field}`) !==
            versions.get(field)
          )
            continue;
          if (field === 'goal_id') continue;
          Object.assign(rollback, {
            [field]: task[field as keyof StoredTask],
          });
        }
        return items.map((item) => (item.id === task.id ? rollback : item));
      });
      setMessage(getErrorMessage(error));
    }
  }

  async function permanentlyDeleteTask() {
    if (!repository || !permanentDelete) return;
    const target = permanentDelete;
    const index = tasks.findIndex((item) => item.id === target.id);
    setSaving(true);
    setMessage('');
    setTasks((items) => items.filter((item) => item.id !== target.id));
    setPermanentDelete(null);
    try {
      await repository.deleteTask(target.id);
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setTasks((items) => [
        ...items.slice(0, Math.max(index, 0)),
        target,
        ...items.slice(Math.max(index, 0)),
      ]);
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="tasks-heading">
      <WorkspaceListTools {...listing} groupLabel="Goal" />
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
            {tasks.length} {view.toLowerCase()} tasks · {completedCount}{' '}
            completed. Click a task title to edit it.
          </p>
        </div>
        <Button size="lg" onClick={showForm ? closeForm : startCreate}>
          <Plus />
          {showForm ? 'Close form' : 'Create task'}
        </Button>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" aria-label="Task views">
        {(Object.keys(viewCopy) as LifecycleView[]).map((item) => (
          <Button
            key={item}
            type="button"
            variant={view === item ? 'default' : 'outline'}
            onClick={() => {
              closeForm();
              setView(item);
            }}
          >
            {viewCopy[item].label}
          </Button>
        ))}
      </div>

      {showForm ? (
        <div className="space-y-4">
          <TaskForm
            editing={Boolean(editingId)}
            saving={saving}
            title={title}
            setTitle={setTitle}
            priority={priority}
            setPriority={setPriority}
            dueOn={dueOn}
            setDueOn={setDueOn}
            goalId={goalId}
            setGoalId={setGoalId}
            plannedStart={plannedStart}
            setPlannedStart={setPlannedStart}
            linkUrl={linkUrl}
            setLinkUrl={setLinkUrl}
            linkLabel={linkLabel}
            setLinkLabel={setLinkLabel}
            parentTaskId={parentTaskId}
            setParentTaskId={setParentTaskId}
            dependencyTaskId={dependencyTaskId}
            setDependencyTaskId={setDependencyTaskId}
            workflowStatusId={workflowStatusId}
            setWorkflowStatusId={setWorkflowStatusId}
            goals={goals}
            statuses={statuses}
            taskOptions={taskOptions}
            completionLocked={false}
            onSubmit={saveTask}
            onCancel={closeForm}
          />
          {editingId ? (
            <ItemAnnotations target={{ kind: 'task', id: editingId }} />
          ) : null}
        </div>
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
            <div className="grid min-h-[260px] place-items-center text-center">
              <div>
                <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
                  {view === 'archived' ? (
                    <Archive />
                  ) : view === 'trash' ? (
                    <Trash2 />
                  ) : (
                    <CheckCircle2 />
                  )}
                </span>
                <h2 className="mt-5 text-lg font-semibold">
                  {viewCopy[view].empty}
                </h2>
                {view === 'active' ? (
                  <Button className="mt-5" onClick={startCreate}>
                    <Plus />
                    Create task
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            listing.visible.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                view={view}
                goals={goals}
                statuses={statuses}
                onQuickChange={(changes, success) =>
                  changeTask(task, changes, success)
                }
                onEdit={startEdit}
                onToggle={toggleTask}
                onArchive={(item) =>
                  changeTask(
                    item,
                    { archived_at: new Date().toISOString() },
                    'Task archived.',
                  )
                }
                onRestoreArchive={(item) =>
                  changeTask(
                    item,
                    { archived_at: null },
                    'Task restored to Active.',
                  )
                }
                onTrash={(item) =>
                  changeTask(
                    item,
                    { deleted_at: new Date().toISOString() },
                    'Task moved to Trash.',
                  )
                }
                onRestoreTrash={(item) =>
                  changeTask(
                    item,
                    { deleted_at: null },
                    item.archived_at
                      ? 'Task restored to Archived.'
                      : 'Task restored to Active.',
                  )
                }
                onPermanentDelete={setPermanentDelete}
              />
            ))
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(permanentDelete)}
        onOpenChange={(open) => {
          if (!open) setPermanentDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Child and dependency links will be
              detached. Existing calendar blocks will remain as history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saving}
              onClick={() => void permanentlyDeleteTask()}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

type TaskFormProps = {
  editing: boolean;
  saving: boolean;
  title: string;
  setTitle: (value: string) => void;
  priority: Priority;
  setPriority: (value: Priority) => void;
  dueOn: string;
  setDueOn: (value: string) => void;
  goalId: string;
  setGoalId: (value: string) => void;
  plannedStart: string;
  setPlannedStart: (value: string) => void;
  linkUrl: string;
  setLinkUrl: (value: string) => void;
  linkLabel: string;
  setLinkLabel: (value: string) => void;
  parentTaskId: string;
  setParentTaskId: (value: string) => void;
  dependencyTaskId: string;
  setDependencyTaskId: (value: string) => void;
  workflowStatusId: string;
  setWorkflowStatusId: (value: string) => void;
  goals: GoalOption[];
  statuses: WorkflowStatus[];
  taskOptions: StoredTask[];
  completionLocked: boolean;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function TaskForm(props: TaskFormProps) {
  return (
    <Card className="mt-7 border bg-card shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">
          {props.editing ? 'Edit task' : 'Add a task'}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={props.onSubmit}>
          <label className="text-xs font-semibold md:col-span-2">
            Task title
            <input
              required
              value={props.title}
              onChange={(event) => props.setTitle(event.target.value)}
              placeholder="What needs your attention?"
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold">
            Priority
            <RelationSelect
              value={props.priority}
              onChange={(event) =>
                props.setPriority(event.target.value as Priority)
              }
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </RelationSelect>
          </label>
          <label className="text-xs font-semibold">
            Status
            <RelationSelect
              disabled={props.completionLocked}
              value={props.workflowStatusId}
              onChange={(event) =>
                props.setWorkflowStatusId(event.target.value)
              }
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            >
              <option value="">Default status</option>
              {props.statuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.category.replaceAll('_', ' ')}
                </option>
              ))}
            </RelationSelect>
          </label>
          <label className="text-xs font-semibold">
            Start date
            <input
              type="date"
              min="2000-01-01"
              max="2200-12-31"
              value={props.plannedStart}
              onChange={(event) => props.setPlannedStart(event.target.value)}
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold">
            Deadline
            <input
              type="date"
              min={props.plannedStart || '2000-01-01'}
              max="2200-12-31"
              value={props.dueOn}
              onChange={(event) => props.setDueOn(event.target.value)}
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold md:col-span-2">
            Goal
            <RelationSelect
              value={props.goalId}
              onChange={(event) => props.setGoalId(event.target.value)}
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            >
              <option value="">Inbox — no goal</option>
              {props.goals.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.title}
                </option>
              ))}
            </RelationSelect>
          </label>
          <label className="text-xs font-semibold">
            Link URL (optional)
            <input
              type="url"
              value={props.linkUrl}
              onChange={(event) => props.setLinkUrl(event.target.value)}
              placeholder="https://…"
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold">
            Link label (optional)
            <input
              value={props.linkLabel}
              onChange={(event) => props.setLinkLabel(event.target.value)}
              placeholder="Document"
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold">
            Parent task (optional)
            <RelationSelect
              value={props.parentTaskId}
              onChange={(event) => props.setParentTaskId(event.target.value)}
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            >
              <option value="">None</option>
              {props.taskOptions.map((task) => (
                <option
                  key={task.id}
                  value={task.id}
                  data-group={task.goalTitle ?? 'Inbox'}
                >
                  {task.title}
                </option>
              ))}
            </RelationSelect>
          </label>
          <label className="text-xs font-semibold">
            Depends on (optional)
            <RelationSelect
              value={props.dependencyTaskId}
              onChange={(event) =>
                props.setDependencyTaskId(event.target.value)
              }
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            >
              <option value="">None</option>
              {props.taskOptions.map((task) => (
                <option
                  key={task.id}
                  value={task.id}
                  data-group={task.goalTitle ?? 'Inbox'}
                >
                  {task.title}
                </option>
              ))}
            </RelationSelect>
          </label>
          <p className="text-xs text-muted-foreground md:col-span-2">
            Progress is calculated from active checklist items. Milestones are
            created directly on Timeline.
          </p>
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={props.saving}>
              {props.saving ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              {props.editing ? 'Save changes' : 'Save task'}
            </Button>
            {props.editing ? (
              <Button type="button" variant="outline" onClick={props.onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

type TaskRowProps = {
  task: StoredTask;
  view: LifecycleView;
  goals: GoalOption[];
  statuses: WorkflowStatus[];
  onQuickChange: (changes: TaskChanges, success: string) => void;
  onEdit: (task: StoredTask) => void;
  onToggle: (task: StoredTask) => void;
  onArchive: (task: StoredTask) => void;
  onRestoreArchive: (task: StoredTask) => void;
  onTrash: (task: StoredTask) => void;
  onRestoreTrash: (task: StoredTask) => void;
  onPermanentDelete: (task: StoredTask) => void;
};

function TaskRow({
  task,
  view,
  goals,
  statuses,
  onQuickChange,
  onEdit,
  onToggle,
  onArchive,
  onRestoreArchive,
  onTrash,
  onRestoreTrash,
  onPermanentDelete,
}: TaskRowProps) {
  const overdue = Boolean(
    task.due_at && !task.completed_at && new Date(task.due_at) < new Date(),
  );
  const deadline = task.due_at?.slice(0, 10) ?? '';
  const linkText = (() => {
    if (task.link_label) return task.link_label;
    try {
      return task.link_url ? new URL(task.link_url).hostname : '';
    } catch {
      return task.link_url ?? '';
    }
  })();
  const quickSetLink = () => {
    const value = window.prompt(
      'Task link (http:// or https://)',
      task.link_url ?? '',
    );
    if (value === null) return;
    onQuickChange(
      { link_url: value.trim() || null, link_label: null },
      value.trim() ? 'Link updated.' : 'Link removed.',
    );
  };
  const resolved = Math.min(
    task.active_checklist_count,
    task.checklist_resolved_count,
  );
  return (
    <article className="border-b py-4 last:border-b-0">
      <div className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3">
        {view === 'active' ? (
          <Checkbox
            checked={Boolean(task.completed_at)}
            onCheckedChange={() => onToggle(task)}
            aria-label={`${task.completed_at ? 'Reopen' : 'Complete'} ${task.title}`}
          />
        ) : (
          <span className="size-2 rounded-full bg-muted-foreground/40" />
        )}
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onEdit(task)}
            className={`block max-w-full truncate text-left text-sm font-semibold hover:text-primary ${task.completed_at ? 'text-muted-foreground line-through' : ''}`}
          >
            {task.title}
          </button>
          {task.active_checklist_count ? (
            <small
              className="text-[10px] text-muted-foreground"
              title={`${task.checklist_done_count} done · ${Math.max(0, resolved - task.checklist_done_count)} not needed`}
            >
              {resolved}/{task.active_checklist_count} ({task.progress}%)
            </small>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${task.title}`}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {view !== 'trash' ? (
              <DropdownMenuItem onClick={() => onEdit(task)}>
                <Pencil /> Edit details
              </DropdownMenuItem>
            ) : null}
            {view === 'active' ? (
              <>
                <DropdownMenuItem onClick={() => onArchive(task)}>
                  <Archive /> Archive
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onTrash(task)}
                >
                  <Trash2 /> Move to trash
                </DropdownMenuItem>
              </>
            ) : null}
            {view === 'archived' ? (
              <DropdownMenuItem onClick={() => onRestoreArchive(task)}>
                <ArchiveRestore /> Restore
              </DropdownMenuItem>
            ) : null}
            {view === 'trash' ? (
              <>
                <DropdownMenuItem onClick={() => onRestoreTrash(task)}>
                  <RotateCcw /> Restore
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onPermanentDelete(task)}
                >
                  <Trash2 /> Delete permanently
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5 xl:items-end">
        <label className="text-[10px] text-muted-foreground">
          Goal
          <RelationSelect
            disabled={view !== 'active'}
            value={task.goalId ?? ''}
            onChange={(event) =>
              onQuickChange(
                { goal_id: event.target.value || null },
                'Goal updated.',
              )
            }
            className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-xs text-foreground"
          >
            <option value="">Inbox</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </RelationSelect>
        </label>
        <label className="text-[10px] text-muted-foreground">
          Start
          <input
            disabled={view !== 'active'}
            type="date"
            min="2000-01-01"
            max="2200-12-31"
            value={task.planned_start ?? ''}
            onChange={(event) =>
              onQuickChange(
                { planned_start: event.target.value || null },
                'Start date updated.',
              )
            }
            className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-xs text-foreground"
          />
        </label>
        <label
          className={`text-[10px] ${overdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}
        >
          Deadline
          <input
            disabled={view !== 'active'}
            type="date"
            min={task.planned_start || '2000-01-01'}
            max="2200-12-31"
            value={deadline}
            onChange={(event) =>
              onQuickChange(
                {
                  due_at: event.target.value
                    ? new Date(
                        `${event.target.value}T23:59:00+07:00`,
                      ).toISOString()
                    : null,
                },
                'Deadline updated.',
              )
            }
            className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-xs text-foreground"
          />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Status
          <RelationSelect
            disabled={view !== 'active'}
            value={task.workflow_status_id}
            onChange={(event) => {
              const status = statuses.find(
                (item) => item.id === event.target.value,
              );
              if (status?.category === 'completed') {
                onToggle(task);
                return;
              }
              onQuickChange(
                {
                  workflow_status_id: event.target.value,
                },
                'Status updated.',
              );
            }}
            className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-xs capitalize text-foreground"
          >
            {statuses.map((status) => (
              <option key={status.id} value={status.id}>
                {status.category.replaceAll('_', ' ')}
              </option>
            ))}
          </RelationSelect>
        </label>
        <label className="min-w-0 text-[10px] text-muted-foreground">
          Link
          <span className="mt-1 block text-xs">
            {task.link_url ? (
              <span className="flex h-9 items-center rounded-lg border">
                <a
                  href={task.link_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex min-w-0 flex-1 items-center gap-2 truncate px-2 text-primary hover:underline"
                >
                  <ExternalLink className="size-3.5 shrink-0" />
                  <span className="truncate">{linkText}</span>
                </a>
                {view === 'active' ? (
                  <button
                    type="button"
                    onClick={quickSetLink}
                    className="h-full border-l px-2 text-muted-foreground hover:bg-muted"
                    aria-label={`Edit link for ${task.title}`}
                  >
                    Edit
                  </button>
                ) : null}
              </span>
            ) : view === 'active' ? (
              <button
                type="button"
                onClick={quickSetLink}
                className="flex h-9 w-full items-center gap-2 rounded-lg border px-2 text-muted-foreground hover:bg-muted"
              >
                <Link2 className="size-3.5" />
                Add link
              </button>
            ) : (
              <span className="text-muted-foreground">No link</span>
            )}
          </span>
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Badge
          variant="outline"
          className={`capitalize ${task.priority === 'urgent' ? 'border-destructive/30 bg-destructive/10 text-destructive' : task.priority === 'high' ? 'priority-high' : ''}`}
        >
          <Flag />
          {task.priority}
        </Badge>
        {overdue ? (
          <small className="font-semibold text-destructive">Overdue</small>
        ) : null}
      </div>
    </article>
  );
}
