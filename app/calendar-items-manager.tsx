'use client';
import { readSettledPlanning } from '@/lib/undo-manager';
import {
  OccurrenceEditor,
  type EditableOccurrence,
} from '@/components/occurrence-editor';

import { RelationSelect } from '@/components/relation-select';
import { ItemAnnotations } from '@/components/item-annotations';
import {
  useWorkspaceList,
  WorkspaceListTools,
} from '@/components/workspace-list-tools';

import { patchOccurrence, sameOccurrenceTime } from '@/lib/occurrence-state';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  addDays,
  expandRecurringSessions,
  toLocalInput,
  vietnamDateKey,
  vietnamInputToIso,
  type RecurrenceRule,
} from '@/lib/calendar';
import {
  getErrorMessage,
  getPlanningRepository,
  type CalendarItemType,
  type CalendarSession,
  type CalendarSessionInput,
  type CalendarWorkspace,
} from '@/lib/data/repository';
import {
  announceDataChanged,
  dataChangeSource,
  MYPLAN_DATA_CHANGED,
} from '@/lib/data/data-events';

type Filter = 'all' | 'overdue' | 'today' | 'upcoming' | 'completed';
type Occurrence = CalendarSession & {
  occurrence_id: string;
  occurrence_start: string;
};
type Draft = {
  id?: string;
  original?: CalendarSession;
  title: string;
  task_id: string;
  starts_at: string;
  ends_at: string;
  recurrence: RecurrenceRule;
  recurrence_until: string;
  recurrence_interval: number;
  notification_offsets: number[];
  completed_at: string | null;
  not_needed_at: string | null;
};

const offsets = [0, 5, 15, 60, 1440];
function sessionDraft(base: CalendarSession): Draft {
  return {
    id: base.id,
    original: base,
    title: base.title,
    task_id: base.task_id ?? '',
    starts_at: toLocalInput(base.starts_at),
    ends_at: toLocalInput(base.ends_at),
    recurrence: base.recurrence,
    recurrence_until: base.recurrence_until ?? '',
    recurrence_interval: base.recurrence_interval || 1,
    notification_offsets: base.notification_offsets ?? [15],
    completed_at: base.completed_at,
    not_needed_at: base.not_needed_at,
  };
}
const offsetLabel = (value: number) =>
  value === 0
    ? 'At time'
    : value === 1440
      ? '1 day before'
      : value === 60
        ? '1 hour before'
        : `${value} minutes before`;

function freshDraft(): Draft {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);
  const end = new Date(start.getTime() + 30 * 60_000);
  return {
    title: '',
    task_id: '',
    starts_at: toLocalInput(start),
    ends_at: toLocalInput(end),
    recurrence: 'none',
    recurrence_until: '',
    recurrence_interval: 2,
    notification_offsets: [15],
    completed_at: null,
    not_needed_at: null,
  };
}

export function CalendarItemsManager({
  type,
  editorOnly = false,
  openId,
  createTaskId,
}: {
  type: CalendarItemType;
  editorOnly?: boolean;
  openId?: string;
  createTaskId?: string;
}) {
  const openedExternal = useRef(false);
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<CalendarWorkspace>({
    goals: [],
    tasks: [],
    statuses: [],
    sessions: [],
    links: [],
    occurrence_states: [],
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [visibleCount, setVisibleCount] = useState(250);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingOccurrence, setEditingOccurrence] =
    useState<EditableOccurrence | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [sourceId] = useState(
    () => `calendar-items:${type}:${crypto.randomUUID()}`,
  );
  const sourceRef = useRef(sourceId);
  const mutationVersionsRef = useRef(new Map<string, number>());
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());
  const loadRequestRef = useRef(0);

  function nextMutationVersion(key: string) {
    const version = (mutationVersionsRef.current.get(key) ?? 0) + 1;
    mutationVersionsRef.current.set(key, version);
    return version;
  }

  async function enqueueMutation(key: string, action: () => Promise<void>) {
    const previous = mutationQueuesRef.current.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    mutationQueuesRef.current.set(key, next);
    try {
      await next;
    } finally {
      if (mutationQueuesRef.current.get(key) === next)
        mutationQueuesRef.current.delete(key);
    }
  }

  const load = useCallback(async () => {
    if (!repository) return;
    const request = ++loadRequestRef.current;
    try {
      const next = await readSettledPlanning(() =>
        repository.getCalendarWorkspace(),
      );
      if (request === loadRequestRef.current) setWorkspace(next);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [repository]);
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    const sync = (event: Event) => {
      if (dataChangeSource(event) !== sourceRef.current) void load();
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => {
      window.clearTimeout(handle);
      window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
    };
  }, [load]);

  const occurrences = useMemo(() => {
    const now = new Date();
    const earliest = workspace.sessions.reduce(
      (value, item) =>
        new Date(item.starts_at) < value ? new Date(item.starts_at) : value,
      addDays(now, -365),
    );
    const expanded = expandRecurringSessions(
      workspace.sessions.filter((item) => item.item_type === type),
      earliest,
      addDays(now, 730),
      workspace.occurrence_states,
    );
    const today = vietnamDateKey(now);
    return expanded
      .filter((item) => {
        const day = vietnamDateKey(item.starts_at);
        if (filter === 'completed')
          return Boolean(item.completed_at || item.not_needed_at);
        if (item.completed_at || item.not_needed_at) return filter === 'all';
        if (filter === 'overdue') return new Date(item.starts_at) < now;
        if (filter === 'today') return day === today;
        if (filter === 'upcoming') return day > today;
        return true;
      })
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [filter, type, workspace.occurrence_states, workspace.sessions]);

  const listing = useWorkspaceList(
    occurrences.map((item) => ({
      ...item,
      entryId: item.id,
      id: item.occurrence_id,
    })),
    `${type}:${filter}`,
    (item) =>
      workspace.tasks.find((task) => task.id === item.task_id)?.title ??
      'No task',
    (item) => item.title,
    (item) => item.starts_at,
  );
  useEffect(() => {
    if (!editorOnly || loading || openedExternal.current) return;
    const timer = window.setTimeout(() => {
      openedExternal.current = true;
      if (openId) {
        const item = workspace.sessions.find((item) => item.id === openId);
        if (item) setDraft(sessionDraft(item));
        else setMessage('This item is no longer available.');
      } else setDraft({ ...freshDraft(), task_id: createTaskId ?? '' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editorOnly, loading, openId, createTaskId, workspace.sessions]);
  function edit(item: Occurrence, wholeSeries = false) {
    if (!wholeSeries && item.recurrence !== 'none') {
      setEditingOccurrence(item);
      return;
    }
    const base =
      workspace.sessions.find((session) => session.id === item.id) ?? item;
    setDraft(sessionDraft(base));
  }

  async function save(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository || !draft?.title.trim()) return;
    if (type === 'checklist' && !draft.task_id) {
      setMessage('Choose a Task for this checklist.');
      return;
    }
    if (
      type === 'checklist' &&
      draft.recurrence !== 'none' &&
      !draft.recurrence_until
    ) {
      setMessage('Choose an end date for this repeating checklist.');
      return;
    }
    setSaving(true);
    setMessage('');
    const savedDraft = draft;
    const optimisticId = draft.id ?? crypto.randomUUID();
    let previousSession: CalendarSession | undefined;
    let saveFields: Array<keyof CalendarSession> = [];
    let saveVersions = new Map<keyof CalendarSession, number>();
    try {
      const start = new Date(vietnamInputToIso(draft.starts_at));
      const end =
        type === 'reminder'
          ? new Date(start.getTime() + 15 * 60_000)
          : new Date(vietnamInputToIso(draft.ends_at));
      const input: CalendarSessionInput = {
        title: draft.title.trim(),
        task_id: type === 'checklist' ? draft.task_id : null,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        all_day: false,
        timezone: 'Asia/Ho_Chi_Minh',
        recurrence: draft.recurrence,
        recurrence_until: draft.recurrence_until || null,
        recurrence_interval: draft.recurrence_interval,
        item_type: type,
        completed_at: draft.completed_at,
        not_needed_at: draft.not_needed_at,
        notification_offsets: draft.notification_offsets,
        is_pinned: false,
      };
      previousSession = draft.id
        ? workspace.sessions.find((item) => item.id === draft.id)
        : undefined;
      if (previousSession) {
        saveFields = Object.keys(input) as Array<keyof CalendarSession>;
        saveVersions = new Map(
          saveFields.map((field) => [
            field,
            nextMutationVersion(`session:${optimisticId}:${field}`),
          ]),
        );
      }
      const optimisticSession: CalendarSession = {
        id: optimisticId,
        ...input,
        item_type: input.item_type ?? type,
        completed_at: input.completed_at ?? null,
        not_needed_at: input.not_needed_at ?? null,
        notification_offsets: input.notification_offsets ?? [15],
        is_pinned: input.is_pinned ?? false,
      };
      setWorkspace((current) => ({
        ...current,
        sessions: previousSession
          ? current.sessions.map((item) =>
              item.id === optimisticId ? optimisticSession : item,
            )
          : current.sessions,
      }));
      setDraft(null);
      if (draft.id) {
        const base = previousSession;
        if (!base) throw new Error('Calendar item not found.');
        await enqueueMutation(`session:${draft.id}`, async () => {
          await repository.updateCalendarSession(
            draft.id!,
            input,
            draft.original ?? base,
          );
        });
      } else {
        const createdId = await repository.createCalendarSession(input);
        setWorkspace((current) => ({
          ...current,
          sessions: [
            ...current.sessions,
            { ...optimisticSession, id: createdId },
          ],
        }));
      }
      await load();
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setWorkspace((current) => ({
        ...current,
        sessions: previousSession
          ? current.sessions.map((item) => {
              if (item.id !== optimisticId) return item;
              const rollback = { ...item };
              for (const field of saveFields)
                if (
                  mutationVersionsRef.current.get(
                    `session:${optimisticId}:${field}`,
                  ) === saveVersions.get(field)
                )
                  Object.assign(rollback, { [field]: previousSession![field] });
              return rollback;
            })
          : current.sessions.filter((item) => item.id !== optimisticId),
      }));
      if (previousSession)
        try {
          const fresh = await readSettledPlanning(() =>
            repository.getCalendarWorkspace(),
          );
          const serverSession = fresh.sessions.find(
            (item) => item.id === previousSession!.id,
          );
          setWorkspace((current) => ({
            ...current,
            sessions: serverSession
              ? current.sessions.map((item) => {
                  if (item.id !== previousSession!.id) return item;
                  const reconciled = { ...item };
                  for (const field of saveFields)
                    if (
                      mutationVersionsRef.current.get(
                        `session:${previousSession!.id}:${field}`,
                      ) === saveVersions.get(field)
                    )
                      Object.assign(reconciled, {
                        [field]: serverSession[field],
                      });
                  return reconciled;
                })
              : current.sessions,
          }));
        } catch {
          /* keep the targeted optimistic rollback when reconciliation fails */
        }
      setDraft(savedDraft);
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(item: Occurrence) {
    if (!repository) return;
    setMessage('');
    const queueKey = `session:${item.id}`;
    const versionKey =
      item.recurrence === 'none'
        ? queueKey
        : `occurrence:${item.id}:${item.occurrence_start}`;
    const fieldKeys = ['completed_at', 'not_needed_at'] as const;
    const versions = new Map(
      fieldKeys.map((field) => [
        field,
        nextMutationVersion(`${versionKey}:${field}`),
      ]),
    );
    const changes = {
      completed_at: item.completed_at ? null : new Date().toISOString(),
      not_needed_at: null,
    };
    const previousSession = workspace.sessions.find(
      (session) => session.id === item.id,
    );
    const previousOccurrence = workspace.occurrence_states.find(
      (state) =>
        state.calendar_entry_id === item.id &&
        sameOccurrenceTime(state.occurrence_start, item.occurrence_start),
    );
    setWorkspace((current) =>
      item.recurrence === 'none'
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === item.id ? { ...session, ...changes } : session,
            ),
          }
        : {
            ...current,
            occurrence_states: patchOccurrence(
              current.occurrence_states,
              item.id,
              item.occurrence_start,
              changes,
            ),
          },
    );
    try {
      if (item.recurrence === 'none')
        await enqueueMutation(queueKey, () =>
          repository.updateCalendarSession(item.id, changes),
        );
      else
        await enqueueMutation(queueKey, () =>
          repository.updateCalendarOccurrence(
            item.id,
            item.occurrence_start,
            changes,
          ),
        );
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setWorkspace((current) => ({
        ...current,
        sessions: previousSession
          ? current.sessions.map((session) => {
              if (session.id !== item.id) return session;
              const rollback = { ...session };
              for (const field of fieldKeys)
                if (
                  mutationVersionsRef.current.get(`${versionKey}:${field}`) ===
                  versions.get(field)
                )
                  Object.assign(rollback, {
                    [field]: previousSession[field],
                  });
              return rollback;
            })
          : current.sessions,
        occurrence_states:
          item.recurrence !== 'none'
            ? patchOccurrence(
                current.occurrence_states,
                item.id,
                item.occurrence_start,
                Object.fromEntries(
                  fieldKeys
                    .filter(
                      (field) =>
                        mutationVersionsRef.current.get(
                          `${versionKey}:${field}`,
                        ) === versions.get(field),
                    )
                    .map((field) => [
                      field,
                      previousOccurrence?.[field] ?? null,
                    ]),
                ),
              )
            : current.occurrence_states,
      }));
      setMessage(getErrorMessage(error));
    }
  }

  async function remove(item: Occurrence) {
    if (!repository || !window.confirm(`Delete “${item.title}”?`)) return;
    setMessage('');
    const index = workspace.sessions.findIndex(
      (session) => session.id === item.id,
    );
    const previousSession = workspace.sessions[index];
    const previousStates = workspace.occurrence_states.filter(
      (state) => state.calendar_entry_id === item.id,
    );
    setWorkspace((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== item.id),
      occurrence_states: current.occurrence_states.filter(
        (state) => state.calendar_entry_id !== item.id,
      ),
    }));
    try {
      await enqueueMutation(`session:${item.id}`, () =>
        repository.deleteCalendarSession(item.id),
      );
      announceDataChanged(sourceRef.current);
    } catch (error) {
      if (previousSession)
        setWorkspace((current) => ({
          ...current,
          sessions: [
            ...current.sessions.slice(0, Math.max(index, 0)),
            previousSession,
            ...current.sessions.slice(Math.max(index, 0)),
          ],
          occurrence_states: [...current.occurrence_states, ...previousStates],
        }));
      setMessage(getErrorMessage(error));
    }
  }

  const title = type === 'checklist' ? 'Checklists' : 'Reminders';
  return (
    <section
      inert={saving}
      aria-labelledby={`${type}-heading`}
      className={editorOnly ? 'hidden' : undefined}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
            {type === 'checklist'
              ? 'Execute the plan'
              : 'Remember what matters'}
          </p>
          <h1
            id={`${type}-heading`}
            className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
          >
            {title}
          </h1>
        </div>
        <Button size="lg" onClick={() => setDraft(freshDraft())}>
          <Plus /> New {type}
        </Button>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {(['all', 'overdue', 'today', 'upcoming', 'completed'] as Filter[]).map(
          (item) => (
            <Button
              key={item}
              variant={filter === item ? 'default' : 'outline'}
              className="capitalize"
              onClick={() => setFilter(item)}
            >
              {item}
            </Button>
          ),
        )}
      </div>
      {message ? (
        <p
          className="mt-4 rounded-xl border bg-muted p-3 text-xs"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}
      <WorkspaceListTools
        {...listing}
        groupLabel={type === 'checklist' ? 'Task' : 'Title'}
      />
      <Card className="mt-6">
        <CardContent className="pt-2">
          {loading ? (
            <div className="grid min-h-64 place-items-center">
              <LoaderCircle className="animate-spin" />
            </div>
          ) : occurrences.length ? (
            <div className="divide-y">
              {listing.visible.slice(0, visibleCount).map((listed) => {
                const item = { ...listed, id: listed.entryId };
                return (
                  <article
                    key={item.occurrence_id}
                    className="grid gap-3 py-4 sm:grid-cols-[24px_minmax(0,1fr)_auto] sm:items-center"
                  >
                    <Checkbox
                      checked={Boolean(item.completed_at)}
                      onCheckedChange={() => void toggle(item)}
                      aria-label={`Complete ${item.title}`}
                    />
                    <button
                      type="button"
                      onClick={() => edit(item)}
                      className="min-w-0 text-left"
                    >
                      <strong
                        className={`block truncate text-sm ${item.completed_at || item.not_needed_at ? 'line-through opacity-60' : ''}`}
                      >
                        {item.title}
                      </strong>
                      <small className="mt-1 flex items-center gap-1 text-muted-foreground">
                        <Clock3 className="size-3" />
                        {new Date(item.starts_at).toLocaleString([], {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone: 'Asia/Ho_Chi_Minh',
                        })}
                        {item.notification_offsets.length ? (
                          <Bell className="ml-1 size-3" />
                        ) : null}
                      </small>
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => edit(item)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${item.title}`}
                        onClick={() => void remove(item)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </article>
                );
              })}
              {listing.visible.length > visibleCount ? (
                <Button
                  variant="outline"
                  onClick={() => setVisibleCount((count) => count + 250)}
                >
                  Show more ({listing.visible.length - visibleCount} remaining)
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center text-center">
              <div>
                <CheckCircle2 className="mx-auto size-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-semibold">Nothing here</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {editingOccurrence ? (
        <OccurrenceEditor
          key={`${editingOccurrence.id}:${editingOccurrence.occurrence_start}`}
          item={editingOccurrence}
          onClose={() => setEditingOccurrence(null)}
          onEditSeries={() => {
            setDraft(
              sessionDraft(
                workspace.sessions.find(
                  (item) => item.id === editingOccurrence.id,
                ) ?? editingOccurrence,
              ),
            );
            setEditingOccurrence(null);
          }}
        />
      ) : null}
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => !open && setDraft(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? `Edit ${type}` : `New ${type}`}
            </DialogTitle>
          </DialogHeader>
          {draft ? (
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
              {message ? (
                <p
                  role="alert"
                  className="rounded-lg border p-3 text-sm text-destructive sm:col-span-2"
                >
                  {message}
                </p>
              ) : null}
              <label className="text-xs font-semibold sm:col-span-2">
                Title
                <input
                  required
                  value={draft.title}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                />
              </label>
              {type === 'checklist' ? (
                <label className="text-xs font-semibold sm:col-span-2">
                  Task
                  <RelationSelect
                    required
                    value={draft.task_id}
                    onChange={(event) =>
                      setDraft({ ...draft, task_id: event.target.value })
                    }
                    className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                  >
                    <option value="">Choose Task</option>
                    {workspace.tasks.map((task) => (
                      <option
                        key={task.id}
                        value={task.id}
                        data-group={
                          workspace.goals.find((goal) =>
                            workspace.links.some(
                              (link) =>
                                link.task_id === task.id &&
                                link.goal_id === goal.id,
                            ),
                          )?.title ?? 'No goal'
                        }
                      >
                        {task.title}
                      </option>
                    ))}
                  </RelationSelect>
                </label>
              ) : null}
              <label className="text-xs font-semibold">
                Date and time
                <input
                  type="datetime-local"
                  required
                  value={draft.starts_at}
                  onChange={(event) =>
                    setDraft({ ...draft, starts_at: event.target.value })
                  }
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                />
              </label>
              {type === 'checklist' ? (
                <label className="text-xs font-semibold">
                  End time
                  <input
                    type="datetime-local"
                    required
                    value={draft.ends_at}
                    onChange={(event) =>
                      setDraft({ ...draft, ends_at: event.target.value })
                    }
                    className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                  />
                </label>
              ) : (
                <div />
              )}
              <label className="text-xs font-semibold">
                Repeat
                <RelationSelect
                  value={draft.recurrence}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      recurrence: event.target.value as RecurrenceRule,
                    })
                  }
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                >
                  <option value="none">Does not repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="custom">Custom days</option>
                </RelationSelect>
              </label>
              {draft.recurrence !== 'none' ? (
                <label className="text-xs font-semibold">
                  Repeat until
                  <input
                    type="date"
                    required={type === 'checklist'}
                    value={draft.recurrence_until}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        recurrence_until: event.target.value,
                      })
                    }
                    className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
                  />
                </label>
              ) : null}
              <fieldset className="sm:col-span-2">
                <legend className="text-xs font-semibold">Notify me</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {offsets.map((offset) => (
                    <label
                      key={offset}
                      className="flex items-center gap-2 rounded-xl border p-3 text-xs"
                    >
                      <Checkbox
                        checked={draft.notification_offsets.includes(offset)}
                        onCheckedChange={() =>
                          setDraft({
                            ...draft,
                            notification_offsets:
                              draft.notification_offsets.includes(offset)
                                ? draft.notification_offsets.filter(
                                    (item) => item !== offset,
                                  )
                                : [...draft.notification_offsets, offset],
                          })
                        }
                      />
                      {offsetLabel(offset)}
                    </label>
                  ))}
                </div>
              </fieldset>
              {draft.id ? (
                <div className="sm:col-span-2">
                  <ItemAnnotations
                    target={{ kind: 'calendar', id: draft.id }}
                    links
                  />
                </div>
              ) : null}
              <DialogFooter className="sm:col-span-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Plus />
                  )}
                  {draft.id ? 'Save changes' : `Create ${type}`}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={editorOnly && !draft && Boolean(message)}
        onOpenChange={(open) => {
          if (!open) setMessage('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Calendar item unavailable</DialogTitle>
          </DialogHeader>
          <p role="alert">{message}</p>
        </DialogContent>
      </Dialog>
    </section>
  );
}
