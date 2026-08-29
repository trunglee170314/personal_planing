'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from './searchable-select';
import { ItemAnnotations } from './item-annotations';
import {
  getPlanningRepository,
  getErrorMessage,
  type TimelineWorkspace,
  type GoalColor,
  type Priority,
} from '@/lib/data/repository';
import { announceDataChanged } from '@/lib/data/data-events';
import { goalColors } from '@/lib/colors';
import { descendantIds } from '@/lib/task-hierarchy';

export type PlanningEditorRequest = {
  kind: 'goal' | 'task' | 'milestone';
  id?: string;
  goalId?: string;
  taskId?: string;
  date?: string;
  endDate?: string;
};
const EDIT_EVENT = 'myplan-open-planning-editor';
export function openPlanningEditor(request: PlanningEditorRequest) {
  window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: request }));
}
type Fields = {
  title: string;
  description: string;
  start: string;
  end: string;
  goal: string;
  task: string;
  parent: string;
  dependency: string;
  priority: Priority;
  status: string;
  color: GoalColor;
  url: string;
  label: string;
  isMilestone: boolean;
};
const empty: Fields = {
  title: '',
  description: '',
  start: '',
  end: '',
  goal: '',
  task: '',
  parent: '',
  dependency: '',
  priority: 'medium',
  status: '',
  color: 'jade',
  url: '',
  label: '',
  isMilestone: false,
};

/** One full editor is shared by Timeline, search and Mindmap. */
export function PlanningEditor() {
  const repository = getPlanningRepository();
  const [request, setRequest] = useState<PlanningEditorRequest | null>(null);
  const [workspace, setWorkspace] = useState<TimelineWorkspace | null>(null);
  const [fields, setFields] = useState<Fields>(empty);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const listener = (event: Event) => {
      setWorkspace(null);
      setRequest((event as CustomEvent<PlanningEditorRequest>).detail);
      setError('');
    };
    window.addEventListener(EDIT_EVENT, listener);
    return () => window.removeEventListener(EDIT_EVENT, listener);
  }, []);
  useEffect(() => {
    if (!request || !repository) return;
    let active = true;
    void repository
      .getTimelineWorkspace()
      .then((next) => {
        if (!active) return;
        const goal = next.goals.find(
          (item) => request.kind === 'goal' && item.id === request.id,
        );
        const task = next.tasks.find(
          (item) => request.kind === 'task' && item.id === request.id,
        );
        const milestone = next.milestones.find(
          (item) => request.kind === 'milestone' && item.id === request.id,
        );
        if (request.id && !goal && !task && !milestone)
          throw new Error(
            'This item is no longer active. Open its Archived or Trash section to restore it.',
          );
        setFields({
          ...empty,
          title: goal?.title ?? task?.title ?? milestone?.title ?? '',
          description: goal?.description ?? '',
          start:
            goal?.starts_on ??
            task?.planned_start ??
            milestone?.milestone_on ??
            request.date ??
            '',
          end:
            goal?.ends_on ??
            task?.due_at?.slice(0, 10) ??
            task?.planned_end ??
            request.endDate ??
            request.date ??
            '',
          goal:
            milestone?.goal_id ??
            (task
              ? next.links.find((link) => link.task_id === task.id)?.goal_id
              : request.goalId) ??
            '',
          task: milestone?.task_id ?? request.taskId ?? '',
          parent:
            task?.parent_task_id ??
            (request.kind === 'task' ? request.taskId : '') ??
            '',
          dependency: task?.dependency_task_id ?? '',
          priority: task?.priority ?? 'medium',
          status:
            goal?.status ??
            task?.workflow_status_id ??
            next.statuses.find((status) => status.category === 'backlog')?.id ??
            '',
          color: goal?.color_key ?? 'jade',
          url: task?.link_url ?? '',
          label: task?.link_label ?? '',
          isMilestone: task?.is_milestone ?? false,
        });
        setWorkspace(next);
      })
      .catch((cause) => {
        if (active) setError(getErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [repository, request]);
  function field<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((current) => ({
      ...current,
      [key]: value,
      ...(key === 'goal' ? { parent: '' } : {}),
    }));
  }
  async function save(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository || !request || !workspace) return;
    setBusy(true);
    setError('');
    try {
      if (!fields.title.trim()) throw new Error('Enter a title.');
      if (
        fields.start &&
        fields.end &&
        fields.end < fields.start &&
        request.kind !== 'milestone'
      )
        throw new Error('Deadline cannot be earlier than start.');
      if (request.kind === 'goal') {
        const input = {
          title: fields.title.trim(),
          description: fields.description.trim() || null,
          starts_on: fields.start || null,
          ends_on: fields.end || null,
          color_key: fields.color,
        };
        if (request.id)
          await repository.updateGoal(request.id, {
            ...input,
            status: fields.status as 'active' | 'completed' | 'archived',
            archived_at:
              fields.status === 'archived' ? new Date().toISOString() : null,
          });
        else await repository.createGoal(input);
      } else if (request.kind === 'milestone') {
        if (!fields.start) throw new Error('Choose a milestone date.');
        const input = {
          title: fields.title.trim(),
          goal_id: fields.task ? null : fields.goal || null,
          task_id: fields.task || null,
          milestone_on: fields.start,
        };
        if (request.id)
          await repository.updateTimelineMilestone(request.id, input);
        else await repository.createTimelineMilestone(input);
      } else {
        if (
          fields.parent &&
          descendantIds(workspace.tasks, request.id).has(fields.parent)
        )
          throw new Error('A task cannot be its own ancestor.');
        if (
          fields.parent &&
          (workspace.links.find((link) => link.task_id === fields.parent)
            ?.goal_id ?? '') !== fields.goal
        )
          throw new Error('Parent task must belong to the same Goal.');
        const input = {
          title: fields.title.trim(),
          goal_id: fields.goal || undefined,
          priority: fields.priority,
          planned_start: fields.start || null,
          due_at: fields.end
            ? new Date(`${fields.end}T23:59:00+07:00`).toISOString()
            : null,
          planned_end: null,
          parent_task_id: fields.parent || null,
          dependency_task_id: fields.dependency || null,
          workflow_status_id: fields.status,
          link_url: fields.url.trim() || null,
          link_label: fields.label.trim() || null,
          is_milestone: fields.isMilestone,
          progress: 0,
        };
        if (request.id) {
          const { progress: _progress, ...changes } = input;
          const previous = workspace.tasks.find(
            (task) => task.id === request.id,
          )!;
          const completedStatus = workspace.statuses.find(
            (status) => status.category === 'completed',
          )?.id;
          const wasComplete = Boolean(previous.completed_at);
          const completing = fields.status === completedStatus;
          if (
            wasComplete !== completing &&
            previous.active_checklist_count > 0 &&
            !window.confirm(
              completing
                ? 'Complete this task and resolve its pending checklist items?'
                : 'Reopen this task and its checklist items?',
            )
          )
            return;
          await repository.saveTaskEdit(
            request.id,
            { ...changes, goal_id: fields.goal || null },
            completing,
          );
        } else {
          const completing =
            workspace.statuses.find((status) => status.id === fields.status)
              ?.category === 'completed';
          const id = await repository.createTask({
            ...input,
            workflow_status_id: completing
              ? workspace.statuses.find(
                  (status) => status.category === 'backlog',
                )!.id
              : fields.status,
          });
          if (completing) await repository.setTaskCompletion(id, true);
        }
      }
      announceDataChanged('planning-editor');
      setRequest(null);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!request?.id || !repository) return;
    const permanent = request.kind === 'milestone';
    if (
      !window.confirm(
        permanent
          ? 'Permanently remove this milestone and its comments?'
          : `Move this ${request.kind} to Trash? Its children will not be deleted.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      if (request.kind === 'milestone')
        await repository.deleteTimelineMilestone(request.id);
      if (request.kind === 'task')
        await repository.updateTask(request.id, {
          deleted_at: new Date().toISOString(),
        });
      if (request.kind === 'goal')
        await repository.updateGoal(request.id, {
          deleted_at: new Date().toISOString(),
        });
      announceDataChanged('planning-editor');
      setRequest(null);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const excluded = descendantIds(
    workspace?.tasks ?? [],
    request?.kind === 'task' ? request.id : undefined,
  );
  const taskOptions = (workspace?.tasks ?? [])
    .filter((task) => !excluded.has(task.id))
    .map((task) => ({
      value: task.id,
      label: task.title,
      group:
        workspace?.goals.find((goal) =>
          workspace.links.some(
            (link) => link.goal_id === goal.id && link.task_id === task.id,
          ),
        )?.title ?? 'No goal',
    }));
  const parentOptions = taskOptions.filter(
    (task) =>
      (workspace?.links.find((link) => link.task_id === task.value)?.goal_id ??
        '') === fields.goal,
  );
  const inputClass =
    'mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm';
  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open && !busy) setRequest(null);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {request?.id ? 'Edit' : 'New'} {request?.kind}
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm">
            {error}
          </p>
        ) : null}
        {workspace && request ? (
          <form
            onSubmit={(event) => void save(event)}
            className="grid gap-4 sm:grid-cols-2"
          >
            <label className="text-sm sm:col-span-2">
              Title
              <input
                required
                maxLength={request.kind === 'goal' ? 200 : 240}
                className={inputClass}
                value={fields.title}
                onChange={(event) => field('title', event.target.value)}
              />
            </label>
            {request.kind === 'goal' ? (
              <>
                <label className="text-sm sm:col-span-2">
                  Description
                  <textarea
                    className={inputClass}
                    rows={4}
                    value={fields.description}
                    onChange={(event) =>
                      field('description', event.target.value)
                    }
                  />
                </label>
                <label className="text-sm sm:col-span-2">
                  Color
                  <SearchableSelect
                    aria-label="color"
                    value={fields.color}
                    onChange={(value) => field('color', value as GoalColor)}
                    options={goalColors.map((color) => ({
                      value: color.id,
                      label: color.name,
                    }))}
                  />
                  <span
                    className="mt-2 block h-2 rounded"
                    style={{
                      background: goalColors.find(
                        (color) => color.id === fields.color,
                      )?.value,
                    }}
                  />
                </label>
                {request.id ? (
                  <label className="text-sm sm:col-span-2">
                    Status
                    <SearchableSelect
                      aria-label="status"
                      value={fields.status}
                      onChange={(value) => field('status', value)}
                      options={['active', 'completed', 'archived'].map(
                        (value) => ({ value, label: value }),
                      )}
                    />
                  </label>
                ) : null}
              </>
            ) : (
              <label className="text-sm sm:col-span-2">
                Goal
                <SearchableSelect
                  aria-label="goal"
                  value={fields.goal}
                  disabled={
                    request.kind === 'milestone' && Boolean(fields.task)
                  }
                  onChange={(value) => field('goal', value)}
                  options={[
                    { value: '', label: 'No goal' },
                    ...workspace.goals.map((goal) => ({
                      value: goal.id,
                      label: goal.title,
                    })),
                  ]}
                />
              </label>
            )}
            {request.kind === 'milestone' ? (
              <label className="text-sm sm:col-span-2">
                Task (optional; otherwise attached to Goal)
                <SearchableSelect
                  aria-label="task"
                  value={fields.task}
                  onChange={(value) => field('task', value)}
                  options={[
                    { value: '', label: 'Attach to Goal instead' },
                    ...taskOptions,
                  ]}
                />
              </label>
            ) : null}
            <label className="text-sm">
              {request.kind === 'milestone' ? 'Milestone date' : 'Start date'}
              <input
                type="date"
                required={request.kind === 'milestone'}
                min="2000-01-01"
                max="2200-12-31"
                className={inputClass}
                value={fields.start}
                onChange={(event) => field('start', event.target.value)}
              />
            </label>
            {request.kind !== 'milestone' ? (
              <label className="text-sm">
                Deadline
                <input
                  type="date"
                  min={fields.start || '2000-01-01'}
                  max="2200-12-31"
                  className={inputClass}
                  value={fields.end}
                  onChange={(event) => field('end', event.target.value)}
                />
              </label>
            ) : null}
            {request.kind === 'task' ? (
              <>
                <label className="text-sm">
                  Priority
                  <SearchableSelect
                    aria-label="priority"
                    value={fields.priority}
                    onChange={(value) => field('priority', value as Priority)}
                    options={['low', 'medium', 'high', 'urgent'].map(
                      (value) => ({ value, label: value }),
                    )}
                  />
                </label>
                <label className="text-sm">
                  Status
                  <SearchableSelect
                    aria-label="status"
                    value={fields.status}
                    onChange={(value) => field('status', value)}
                    options={workspace.statuses.map((status) => ({
                      value: status.id,
                      label: status.category,
                    }))}
                  />
                </label>
                <label className="text-sm">
                  Parent task
                  <SearchableSelect
                    aria-label="parent"
                    value={fields.parent}
                    onChange={(value) => field('parent', value)}
                    options={[
                      { value: '', label: 'No parent' },
                      ...parentOptions,
                    ]}
                  />
                </label>
                <label className="text-sm">
                  Dependency
                  <SearchableSelect
                    aria-label="dependency"
                    value={fields.dependency}
                    onChange={(value) => field('dependency', value)}
                    options={[
                      { value: '', label: 'No dependency' },
                      ...taskOptions,
                    ]}
                  />
                </label>
                <label className="text-sm">
                  Link URL
                  <input
                    type="url"
                    className={inputClass}
                    value={fields.url}
                    onChange={(event) => field('url', event.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Link label
                  <input
                    className={inputClass}
                    value={fields.label}
                    onChange={(event) => field('label', event.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={fields.isMilestone}
                    onChange={(event) =>
                      field('isMilestone', event.target.checked)
                    }
                  />{' '}
                  Mark task as milestone
                </label>
              </>
            ) : null}
            {request.id &&
            (request.kind === 'task' || request.kind === 'milestone') ? (
              <div className="sm:col-span-2">
                <ItemAnnotations
                  target={{ kind: request.kind, id: request.id }}
                />
              </div>
            ) : null}
            <DialogFooter className="sm:col-span-2">
              {request.id ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {request.kind === 'milestone' ? 'Remove' : 'Move to Trash'}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setRequest(null)}
              >
                Cancel
              </Button>
              <Button disabled={busy} type="submit">
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        ) : !error ? (
          <p className="text-sm">Loading…</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
