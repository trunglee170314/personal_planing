'use client';
import { matchesSearch } from '@/lib/workspace-view';
import { readSettledPlanning } from '@/lib/undo-manager';
import {
  OccurrenceEditor,
  type EditableOccurrence,
} from '@/components/occurrence-editor';

import { RelationSelect } from '@/components/relation-select';
import { ItemAnnotations } from '@/components/item-annotations';

import { patchOccurrence, sameOccurrenceTime } from '@/lib/occurrence-state';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  addDays,
  dateKey,
  expandRecurringSessions,
  startOfMondayWeek,
  toLocalInput,
  vietnamInputToIso,
  type RecurrenceRule,
} from '@/lib/calendar';
import {
  goalColorValue,
  neutralChecklistColor,
  reminderColor,
} from '@/lib/colors';
import {
  getErrorMessage,
  getAppDataMode,
  getPlanningRepository,
  type CalendarItemType,
  type CalendarMoveScope,
  type CalendarSession,
  type CalendarSessionInput,
  type CalendarWorkspace,
} from '@/lib/data/repository';
import {
  announceDataChanged as announceWorkspaceChanged,
  dataChangeSource,
  MYPLAN_DATA_CHANGED,
} from '@/lib/data/data-events';
import { CalendarGridV2 } from './calendar-grid-v2';

type View = 'day' | 'week' | 'month';
type Draft = {
  id?: string;
  original?: CalendarSession;
  item_type: CalendarItemType | null;
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
  is_pinned: boolean;
};
type PendingMove = {
  item: CalendarSession & { occurrence_start: string };
  start: Date;
  end: Date;
};

const notificationChoices = [
  [0, 'At time'],
  [5, '5 minutes before'],
  [15, '15 minutes before'],
  [60, '1 hour before'],
  [1440, '1 day before'],
] as const;

function draftFromRange(start: Date, end: Date): Draft {
  return {
    item_type: null,
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
    is_pinned: false,
  };
}

export function PlannerCalendar({ embedded = false }: { embedded?: boolean }) {
  const [query, setQuery] = useState('');
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<CalendarWorkspace>({
    goals: [],
    tasks: [],
    statuses: [],
    sessions: [],
    links: [],
    occurrence_states: [],
  });
  const [anchor, setAnchor] = useState(
    () => new Date(`${toLocalInput(new Date()).slice(0, 10)}T12:00:00`),
  );
  const viewStorageKey = embedded
    ? 'myplan-today-calendar-view'
    : 'myplan-main-calendar-view';
  const [view, setView] = useState<View>(() => {
    if (embedded || typeof window === 'undefined') return 'day';
    const saved = window.localStorage.getItem(viewStorageKey) as View | null;
    return saved && ['day', 'week', 'month'].includes(saved) ? saved : 'week';
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingOccurrence, setEditingOccurrence] =
    useState<EditableOccurrence | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [monthMoreDay, setMonthMoreDay] = useState<Date | null>(null);
  const [message, setMessage] = useState('');
  const storageKey = embedded
    ? 'myplan-today-calendar-height'
    : 'myplan-calendar-height';
  const [height, setHeight] = useState(() =>
    typeof window === 'undefined'
      ? 560
      : Number(window.localStorage.getItem(storageKey)) ||
        Math.max(420, window.innerHeight - (embedded ? 365 : 320)),
  );
  const syncSourceRef = useRef(
    embedded ? 'planner-calendar:today' : 'planner-calendar:main',
  );
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());
  const mutationVersionsRef = useRef(new Map<string, number>());
  const deferredSyncRef = useRef(false);
  const silentLoadRef = useRef<(() => Promise<void>) | null>(null);
  const mutationEpochRef = useRef(0);

  function nextMutationVersion(key: string) {
    mutationEpochRef.current += 1;
    const version = (mutationVersionsRef.current.get(key) ?? 0) + 1;
    mutationVersionsRef.current.set(key, version);
    return version;
  }

  async function enqueueMutation(key: string, action: () => Promise<void>) {
    const previous = mutationQueuesRef.current.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    mutationQueuesRef.current.set(key, current);
    try {
      await current;
    } finally {
      if (mutationQueuesRef.current.get(key) === current)
        mutationQueuesRef.current.delete(key);
      if (mutationQueuesRef.current.size === 0 && deferredSyncRef.current) {
        deferredSyncRef.current = false;
        void silentLoadRef.current?.();
      }
    }
  }

  function announceDataChanged() {
    announceWorkspaceChanged(syncSourceRef.current);
  }

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!repository) return;
      if (!options?.silent) setLoading(true);
      const startedAtEpoch = mutationEpochRef.current;
      try {
        const next = await readSettledPlanning(() =>
          repository.getCalendarWorkspace(),
        );
        if (
          startedAtEpoch !== mutationEpochRef.current ||
          mutationQueuesRef.current.size > 0
        ) {
          deferredSyncRef.current = true;
          return;
        }
        setWorkspace(next);
      } catch (error) {
        setMessage(getErrorMessage(error));
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [repository],
  );
  useEffect(() => {
    silentLoadRef.current = () => load({ silent: true });
  }, [load]);
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    const sync = (event: Event) => {
      if (dataChangeSource(event) === syncSourceRef.current) return;
      if (mutationQueuesRef.current.size > 0) {
        deferredSyncRef.current = true;
        return;
      }
      void load({ silent: true });
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => {
      window.clearTimeout(handle);
      window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
    };
  }, [load]);
  useEffect(() => {
    const resize = () => {
      if (!window.localStorage.getItem(storageKey))
        setHeight(Math.max(420, window.innerHeight - (embedded ? 365 : 320)));
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [storageKey, embedded]);
  useEffect(() => {
    if (!embedded) window.localStorage.setItem(viewStorageKey, view);
  }, [embedded, view, viewStorageKey]);
  useEffect(() => {
    if (getAppDataMode() === 'cloud') return;
    if (
      !('Notification' in window) ||
      Notification.permission !== 'granted' ||
      !('serviceWorker' in navigator)
    )
      return;
    const notifyDue = async () => {
      const now = Date.now();
      const registration = await navigator.serviceWorker.ready;
      const dueItems = expandRecurringSessions(
        workspace.sessions,
        new Date(now - 2 * 86_400_000),
        new Date(now + 2 * 86_400_000),
        workspace.occurrence_states,
      );
      for (const item of dueItems) {
        if (item.completed_at || item.not_needed_at) continue;
        for (const offset of item.notification_offsets ?? []) {
          const trigger = new Date(item.starts_at).getTime() - offset * 60_000;
          if (now < trigger || now >= trigger + 60_000) continue;
          const key = `myplan-notified:${item.occurrence_id}:${offset}:${trigger}`;
          if (window.localStorage.getItem(key)) continue;
          window.localStorage.setItem(key, '1');
          await registration.showNotification(item.title, {
            body:
              offset === 0
                ? 'Scheduled now'
                : `Starts in ${offset >= 60 ? `${offset / 60} hour${offset === 60 ? '' : 's'}` : `${offset} minutes`}`,
            icon: '/favicon.svg',
            tag: key,
            data: { url: '/' },
          });
        }
      }
    };
    void notifyDue();
    const handle = window.setInterval(() => void notifyDue(), 30_000);
    return () => window.clearInterval(handle);
  }, [workspace.occurrence_states, workspace.sessions]);

  const goalMap = useMemo(
    () => new Map(workspace.goals.map((goal) => [goal.id, goal])),
    [workspace.goals],
  );
  const taskMap = useMemo(
    () => new Map(workspace.tasks.map((task) => [task.id, task])),
    [workspace.tasks],
  );
  const linkMap = useMemo(
    () => new Map(workspace.links.map((link) => [link.task_id, link.goal_id])),
    [workspace.links],
  );
  function colorFor(item: CalendarSession) {
    if (item.item_type === 'reminder') return reminderColor;
    const goalId = item.task_id ? linkMap.get(item.task_id) : null;
    return goalId
      ? goalColorValue(goalMap.get(goalId)?.color_key)
      : neutralChecklistColor;
  }
  // Task goal links are kept separately in older schemas. Use the task's
  // current goal color when exposed; otherwise the neutral Jade tone is safe.

  function openCreate(start: Date, end: Date) {
    setDraft(draftFromRange(start, end));
  }
  function openEdit(item: CalendarSession, wholeSeries = false) {
    if (
      !wholeSeries &&
      item.recurrence !== 'none' &&
      'occurrence_start' in item
    ) {
      setEditingOccurrence(item as EditableOccurrence);
      return;
    }
    const base =
      workspace.sessions.find((session) => session.id === item.id) ?? item;
    setDraft({
      id: base.id,
      original: base,
      item_type: base.item_type,
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
      is_pinned: base.is_pinned,
    });
  }
  async function save(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository || !draft?.item_type || !draft.title.trim()) return;
    if (draft.item_type === 'checklist' && !draft.task_id) {
      setMessage('Choose a Task for this checklist.');
      return;
    }
    if (
      draft.item_type === 'checklist' &&
      draft.recurrence !== 'none' &&
      !draft.recurrence_until
    ) {
      setMessage('Choose an end date for this repeating checklist.');
      return;
    }
    setSaving(true);
    setMessage('');
    const start = new Date(vietnamInputToIso(draft.starts_at));
    const end =
      draft.item_type === 'reminder'
        ? new Date(start.getTime() + 15 * 60_000)
        : new Date(vietnamInputToIso(draft.ends_at));
    const input: CalendarSessionInput = {
      title: draft.title.trim(),
      task_id: draft.item_type === 'checklist' ? draft.task_id || null : null,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      all_day: false,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: draft.recurrence,
      recurrence_until: draft.recurrence_until || null,
      recurrence_interval: draft.recurrence_interval,
      item_type: draft.item_type,
      completed_at:
        draft.recurrence === 'none'
          ? draft.completed_at
          : (draft.original?.completed_at ?? null),
      not_needed_at:
        draft.recurrence === 'none'
          ? draft.not_needed_at
          : (draft.original?.not_needed_at ?? null),
      notification_offsets: draft.notification_offsets,
      is_pinned: draft.is_pinned,
    };
    const savedDraft = draft;
    const optimisticId = draft.id ?? crypto.randomUUID();
    const previousSession = draft.id
      ? workspace.sessions.find((session) => session.id === draft.id)
      : undefined;
    const saveFields = previousSession
      ? (Object.keys(input) as Array<keyof CalendarSession>)
      : [];
    const saveVersions = new Map(
      saveFields.map((field) => [
        field,
        nextMutationVersion(`session:${optimisticId}:${field}`),
      ]),
    );
    if (!previousSession) mutationEpochRef.current += 1;
    const optimisticSession: CalendarSession = {
      id: optimisticId,
      ...input,
      item_type: input.item_type ?? draft.item_type,
      completed_at: input.completed_at ?? null,
      not_needed_at: input.not_needed_at ?? null,
      notification_offsets: input.notification_offsets ?? [15],
      is_pinned: input.is_pinned ?? false,
    };
    setWorkspace((current) => ({
      ...current,
      sessions: previousSession
        ? current.sessions.map((session) =>
            session.id === optimisticId ? optimisticSession : session,
          )
        : current.sessions,
    }));
    setDraft(null);
    try {
      if (draft.id) {
        if (!previousSession) throw new Error('Calendar item not found.');
        await enqueueMutation(`session:${draft.id}`, async () => {
          await repository.updateCalendarSession(
            draft.id!,
            input,
            draft.original ?? previousSession,
          );
        });
      } else {
        let createdId = '';
        await enqueueMutation(`create:${optimisticId}`, async () => {
          createdId = await repository.createCalendarSession(input);
        });
        setWorkspace((current) => ({
          ...current,
          sessions: [
            ...current.sessions,
            { ...optimisticSession, id: createdId },
          ],
        }));
      }
      await load({ silent: true });
      announceDataChanged();
    } catch (error) {
      setWorkspace((current) => ({
        ...current,
        sessions: previousSession
          ? current.sessions.map((session) => {
              if (session.id !== optimisticId) return session;
              const rollback = { ...session };
              for (const field of saveFields)
                if (
                  mutationVersionsRef.current.get(
                    `session:${optimisticId}:${field}`,
                  ) === saveVersions.get(field)
                )
                  Object.assign(rollback, { [field]: previousSession[field] });
              return rollback;
            })
          : current.sessions.filter((session) => session.id !== optimisticId),
      }));
      if (previousSession)
        try {
          const fresh = await readSettledPlanning(() =>
            repository.getCalendarWorkspace(),
          );
          const serverSession = fresh.sessions.find(
            (session) => session.id === previousSession.id,
          );
          setWorkspace((current) => ({
            ...current,
            sessions: serverSession
              ? current.sessions.map((session) => {
                  if (session.id !== previousSession.id) return session;
                  const reconciled = { ...session };
                  for (const field of saveFields)
                    if (
                      mutationVersionsRef.current.get(
                        `session:${previousSession.id}:${field}`,
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
  async function updateItem(
    item: CalendarSession,
    changes: Partial<CalendarSessionInput>,
    _success: string,
  ) {
    if (!repository) return;
    const before = workspace.sessions.find((session) => session.id === item.id);
    if (!before) return;
    setMessage('');
    const queueKey = `session:${item.id}`;
    const fields = Object.keys(changes) as Array<keyof CalendarSession>;
    const versions = new Map(
      fields.map((field) => [
        field,
        nextMutationVersion(`${queueKey}:${field}`),
      ]),
    );
    setWorkspace((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === item.id ? { ...session, ...changes } : session,
      ),
    }));
    try {
      await enqueueMutation(queueKey, () =>
        repository.updateCalendarSession(item.id, changes),
      );
      announceDataChanged();
    } catch (error) {
      setWorkspace((current) => ({
        ...current,
        sessions: current.sessions.map((session) => {
          if (session.id !== item.id) return session;
          const rollback = { ...session };
          for (const field of fields)
            if (
              mutationVersionsRef.current.get(`${queueKey}:${field}`) ===
              versions.get(field)
            )
              Object.assign(rollback, { [field]: before[field] });
          return rollback;
        }),
      }));
      setMessage(getErrorMessage(error));
    }
  }
  async function toggleOccurrence(
    item: CalendarSession & { occurrence_start?: string },
  ) {
    if (!repository) return;
    const changes = {
      completed_at: item.completed_at ? null : new Date().toISOString(),
      not_needed_at: null,
    };
    if (item.recurrence === 'none' || !item.occurrence_start) {
      await updateItem(
        item,
        changes,
        item.completed_at ? 'Item reopened.' : 'Item completed.',
      );
      return;
    }
    setMessage('');
    const queueKey = `session:${item.id}`;
    const mutationKey = `occurrence:${item.id}:${item.occurrence_start}`;
    const version = nextMutationVersion(mutationKey);
    const previous = workspace.occurrence_states.find(
      (state) =>
        state.calendar_entry_id === item.id &&
        sameOccurrenceTime(state.occurrence_start, item.occurrence_start),
    );
    setWorkspace((current) => ({
      ...current,
      occurrence_states: patchOccurrence(
        current.occurrence_states,
        item.id,
        item.occurrence_start!,
        changes,
      ),
    }));
    try {
      await enqueueMutation(queueKey, () =>
        repository.updateCalendarOccurrence(
          item.id,
          item.occurrence_start!,
          changes,
        ),
      );
      announceDataChanged();
    } catch (error) {
      if (mutationVersionsRef.current.get(mutationKey) === version)
        setWorkspace((current) => ({
          ...current,
          occurrence_states: patchOccurrence(
            current.occurrence_states,
            item.id,
            item.occurrence_start!,
            {
              completed_at: previous?.completed_at ?? null,
              not_needed_at: previous?.not_needed_at ?? null,
            },
          ),
        }));
      setMessage(getErrorMessage(error));
    }
  }
  async function moveItem(
    item: CalendarSession & { occurrence_start?: string },
    start: Date,
    end: Date,
  ) {
    if (!repository) return;
    const base = workspace.sessions.find((session) => session.id === item.id);
    if (!base) return;
    const changes = {
      starts_at: start.toISOString(),
      ends_at:
        item.item_type === 'reminder'
          ? new Date(start.getTime() + 15 * 60_000).toISOString()
          : end.toISOString(),
    };
    if (item.recurrence === 'none') {
      await updateItem(base, changes, 'Time updated.');
      return;
    }
    if (
      !item.occurrence_start ||
      (base.item_type === 'checklist' && !base.recurrence_until)
    ) {
      setMessage(
        'Set a repeat-until date before moving this repeating checklist.',
      );
      return;
    }
    setPendingMove({
      item: { ...item, occurrence_start: item.occurrence_start },
      start,
      end: new Date(changes.ends_at),
    });
  }
  async function confirmRecurringMove(scope: CalendarMoveScope) {
    if (!repository || !pendingMove) return;
    const { item, start, end } = pendingMove;
    const base = workspace.sessions.find((session) => session.id === item.id);
    if (!base) return;
    if (scope === 'future' && !base.recurrence_until) {
      setMessage('Set a repeat-until date before moving future occurrences.');
      return;
    }
    setSaving(true);
    setMessage('');
    const deltaStart = start.getTime() - new Date(item.starts_at).getTime();
    const deltaEnd = end.getTime() - new Date(item.ends_at).getTime();
    const occurrences =
      scope === 'series'
        ? []
        : scope === 'occurrence'
          ? [item]
          : expandRecurringSessions(
              [base],
              new Date(item.occurrence_start),
              new Date(`${base.recurrence_until}T17:00:00.000Z`),
              workspace.occurrence_states,
            );
    const movedStates = occurrences.map((occurrence) => ({
      calendar_entry_id: base.id,
      occurrence_start: occurrence.occurrence_start,
      override_starts_at: new Date(
        new Date(occurrence.starts_at).getTime() + deltaStart,
      ).toISOString(),
      override_ends_at: new Date(
        new Date(occurrence.ends_at).getTime() + deltaEnd,
      ).toISOString(),
      completed_at: occurrence.completed_at,
      not_needed_at: occurrence.not_needed_at,
    }));
    const movedKeys = new Set(
      movedStates.map(
        (state) =>
          `${state.calendar_entry_id}:${new Date(state.occurrence_start).toISOString()}`,
      ),
    );
    const previousStates = workspace.occurrence_states.filter((state) =>
      movedKeys.has(
        `${state.calendar_entry_id}:${new Date(state.occurrence_start).toISOString()}`,
      ),
    );
    const moveVersions = new Map<string, number>();
    if (scope === 'series') {
      for (const field of ['starts_at', 'ends_at']) {
        const key = `session:${base.id}:${field}`;
        moveVersions.set(key, nextMutationVersion(key));
      }
    } else {
      for (const state of movedStates)
        for (const field of ['override_starts_at', 'override_ends_at']) {
          const key = `occurrence:${base.id}:${state.occurrence_start}:${field}`;
          moveVersions.set(key, nextMutationVersion(key));
        }
    }
    setWorkspace((current) =>
      scope === 'series'
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === base.id
                ? {
                    ...session,
                    starts_at: new Date(
                      new Date(session.starts_at).getTime() + deltaStart,
                    ).toISOString(),
                    ends_at: new Date(
                      new Date(session.ends_at).getTime() + deltaEnd,
                    ).toISOString(),
                  }
                : session,
            ),
          }
        : {
            ...current,
            occurrence_states: movedStates.reduce(
              (states, moved) =>
                patchOccurrence(
                  states,
                  moved.calendar_entry_id,
                  moved.occurrence_start,
                  {
                    override_starts_at: moved.override_starts_at,
                    override_ends_at: moved.override_ends_at,
                  },
                ),
              current.occurrence_states,
            ),
          },
    );
    setPendingMove(null);
    try {
      if (scope === 'series') {
        await enqueueMutation(`session:${base.id}`, () =>
          repository.moveCalendarSeries(
            base.id,
            item.starts_at,
            item.ends_at,
            start.toISOString(),
            end.toISOString(),
          ),
        );
      } else {
        await enqueueMutation(`session:${base.id}`, () =>
          repository.moveCalendarOccurrences(
            base.id,
            movedStates.map((state) => ({
              occurrence_start: state.occurrence_start,
              override_starts_at: state.override_starts_at,
              override_ends_at: state.override_ends_at,
            })),
          ),
        );
      }
      announceDataChanged();
    } catch (error) {
      setWorkspace((current) =>
        scope === 'series'
          ? {
              ...current,
              sessions: current.sessions.map((session) => {
                if (session.id !== base.id) return session;
                const rollback = { ...session };
                for (const field of ['starts_at', 'ends_at'] as const) {
                  const key = `session:${base.id}:${field}`;
                  if (
                    mutationVersionsRef.current.get(key) ===
                    moveVersions.get(key)
                  )
                    rollback[field] = base[field];
                }
                return rollback;
              }),
            }
          : {
              ...current,
              occurrence_states: current.occurrence_states.map((state) => {
                const stateKey = `${state.calendar_entry_id}:${new Date(state.occurrence_start).toISOString()}`;
                if (!movedKeys.has(stateKey)) return state;
                const previous = previousStates.find(
                  (item) =>
                    item.calendar_entry_id === state.calendar_entry_id &&
                    sameOccurrenceTime(
                      item.occurrence_start,
                      state.occurrence_start,
                    ),
                );
                const rollback = { ...state };
                for (const field of [
                  'override_starts_at',
                  'override_ends_at',
                ] as const) {
                  const key = `occurrence:${base.id}:${state.occurrence_start}:${field}`;
                  if (
                    mutationVersionsRef.current.get(key) ===
                    moveVersions.get(key)
                  )
                    rollback[field] = previous?.[field] ?? null;
                }
                return rollback;
              }),
            },
      );
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!repository || !draft?.id) return;
    const removed = workspace.sessions.find(
      (session) => session.id === draft.id,
    );
    const index = workspace.sessions.findIndex(
      (session) => session.id === draft.id,
    );
    const removedStates = workspace.occurrence_states.filter(
      (state) => state.calendar_entry_id === draft.id,
    );
    setMessage('');
    setWorkspace((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== draft.id),
      occurrence_states: current.occurrence_states.filter(
        (state) => state.calendar_entry_id !== draft.id,
      ),
    }));
    setDraft(null);
    mutationEpochRef.current += 1;
    try {
      await enqueueMutation(`session:${draft.id}`, () =>
        repository.deleteCalendarSession(draft.id!),
      );
      announceDataChanged();
    } catch (error) {
      if (removed)
        setWorkspace((current) => ({
          ...current,
          sessions: [
            ...current.sessions.slice(0, Math.max(index, 0)),
            removed,
            ...current.sessions.slice(Math.max(index, 0)),
          ],
          occurrence_states: [...current.occurrence_states, ...removedStates],
        }));
      setMessage(getErrorMessage(error));
    }
  }
  function navigate(direction: number) {
    const next = new Date(anchor);
    if (view === 'month') next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * (view === 'week' ? 7 : 1));
    setAnchor(next);
  }
  function toggleOffset(offset: number) {
    if (!draft) return;
    if (
      !draft.notification_offsets.includes(offset) &&
      'Notification' in window &&
      Notification.permission === 'default'
    )
      void Notification.requestPermission();
    setDraft({
      ...draft,
      notification_offsets: draft.notification_offsets.includes(offset)
        ? draft.notification_offsets.filter((value) => value !== offset)
        : [...draft.notification_offsets, offset].sort((a, b) => b - a),
    });
  }
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const monthGridStart = startOfMondayWeek(monthStart);
  const visibleSessions = workspace.sessions.filter((item) => {
    const task = workspace.tasks.find((task) => task.id === item.task_id);
    const goal = workspace.goals.find((goal) =>
      workspace.links.some(
        (link) => link.task_id === item.task_id && link.goal_id === goal.id,
      ),
    );
    return matchesSearch(
      query,
      item.title,
      task?.title ?? '',
      goal?.title ?? '',
    );
  });
  const monthItems = expandRecurringSessions(
    visibleSessions,
    monthGridStart,
    addDays(monthGridStart, 42),
    workspace.occurrence_states,
  );

  return (
    <section
      className={embedded ? 'flex h-full min-h-0 flex-col' : undefined}
      aria-label={embedded ? 'Today calendar' : 'Calendar'}
      inert={saving}
    >
      {message ? (
        <p
          className="mb-3 rounded-xl border bg-muted p-3 text-xs"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}
      <div className="relative mb-3 flex flex-wrap items-center gap-1">
        {!embedded ? (
          <input
            type="search"
            aria-label="Search Calendar"
            placeholder="Find checklist, reminder, task or goal…"
            className="mr-2 min-w-48 rounded-lg border bg-background px-3 py-2 text-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAnchor(new Date())}
        >
          Today
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous date range"
          onClick={() => navigate(-1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next date range"
          onClick={() => navigate(1)}
        >
          <ChevronRight />
        </Button>
        <button
          type="button"
          onClick={() => setDatePickerOpen((open) => !open)}
          className="rounded-lg px-2 py-1 text-sm font-semibold hover:bg-muted"
        >
          {anchor.toLocaleDateString(undefined, {
            month: 'long',
            day: view === 'day' ? 'numeric' : undefined,
            year: 'numeric',
          })}
        </button>
        {datePickerOpen ? (
          <div className="absolute left-0 top-11 z-50 rounded-2xl border bg-popover p-2 shadow-xl">
            <Calendar
              mode="single"
              selected={anchor}
              onSelect={(date) => {
                if (date) setAnchor(date);
                setDatePickerOpen(false);
              }}
            />
          </div>
        ) : null}
        <div className="ml-auto flex gap-1">
          {(['day', 'week', ...(embedded ? [] : ['month'])] as View[]).map(
            (item) => (
              <Button
                key={item}
                size="sm"
                variant={view === item ? 'default' : 'outline'}
                className="capitalize"
                onClick={() => setView(item)}
              >
                {item}
              </Button>
            ),
          )}
        </div>
      </div>
      {loading ? (
        <div className="grid min-h-[420px] place-items-center">
          <LoaderCircle className="animate-spin text-primary" />
        </div>
      ) : view === 'month' ? (
        <div className="grid grid-cols-7 overflow-hidden rounded-2xl border bg-card">
          {Array.from({ length: 42 }, (_, index) =>
            addDays(monthGridStart, index),
          ).map((day) => {
            const dayStart = new Date(`${dateKey(day)}T00:00:00`);
            const dayEnd = addDays(dayStart, 1);
            const items = monthItems.filter(
              (item) =>
                new Date(item.starts_at) < dayEnd &&
                new Date(item.ends_at) > dayStart,
            );
            return (
              <div
                key={dateKey(day)}
                className={`min-h-28 border-b border-r p-2 ${day.getMonth() !== anchor.getMonth() ? 'bg-muted/25 text-muted-foreground' : ''}`}
                onDoubleClick={() =>
                  openCreate(
                    new Date(`${dateKey(day)}T09:00:00`),
                    new Date(`${dateKey(day)}T09:30:00`),
                  )
                }
              >
                <button
                  type="button"
                  className="text-xs font-semibold"
                  onClick={() => {
                    setAnchor(day);
                    setView('day');
                  }}
                >
                  {day.getDate()}
                </button>
                {items.slice(0, 4).map((item) => (
                  <button
                    type="button"
                    key={item.occurrence_id}
                    onClick={() => openEdit(item)}
                    className={`mt-1 block w-full truncate rounded px-1.5 py-1 text-left text-[10px] text-white ${item.completed_at ? 'line-through opacity-55' : ''}`}
                    style={{ background: colorFor(item) }}
                  >
                    {item.title}
                  </button>
                ))}
                {items.length > 4 ? (
                  <button
                    type="button"
                    className="mt-1 text-[10px] font-semibold text-primary hover:underline"
                    onClick={() => setMonthMoreDay(day)}
                  >
                    +{items.length - 4} more
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <CalendarGridV2
          anchor={anchor}
          dayCount={view === 'day' ? 1 : 7}
          sessions={visibleSessions}
          occurrenceStates={workspace.occurrence_states}
          height={height}
          colorFor={colorFor}
          detailsFor={(item) => {
            const task = workspace.tasks.find(
              (task) => task.id === item.task_id,
            );
            const goal = workspace.goals.find((goal) =>
              workspace.links.some(
                (link) => link.task_id === task?.id && link.goal_id === goal.id,
              ),
            );
            return [
              task && `Task: ${task.title}`,
              goal && `Goal: ${goal.title}`,
            ]
              .filter(Boolean)
              .join('\n');
          }}
          onHeightChange={(next) => {
            setHeight(next);
            window.localStorage.setItem(storageKey, String(next));
          }}
          onCreate={openCreate}
          onEdit={openEdit}
          onToggle={(item) => void toggleOccurrence(item)}
          onMove={(item, start, end) => void moveItem(item, start, end)}
        />
      )}

      <Dialog
        open={Boolean(monthMoreDay)}
        onOpenChange={(open) => !open && setMonthMoreDay(null)}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {monthMoreDay?.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            {monthMoreDay
              ? monthItems
                  .filter(
                    (item) =>
                      dateKey(new Date(item.starts_at)) ===
                      dateKey(monthMoreDay),
                  )
                  .map((item) => (
                    <button
                      type="button"
                      key={item.occurrence_id}
                      aria-label={`Edit ${item.title}`}
                      onClick={() => {
                        setMonthMoreDay(null);
                        openEdit(item);
                      }}
                      className="flex items-center gap-3 rounded-xl border p-3 text-left hover:bg-muted"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: colorFor(item) }}
                      />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm">
                          {item.title}
                        </strong>
                        <small className="text-muted-foreground">
                          {new Date(item.starts_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'Asia/Ho_Chi_Minh',
                          })}
                          {' · '}
                          {item.item_type}
                        </small>
                      </span>
                    </button>
                  ))
              : null}
          </div>
        </DialogContent>
      </Dialog>

      {editingOccurrence ? (
        <OccurrenceEditor
          key={`${editingOccurrence.id}:${editingOccurrence.occurrence_start}`}
          item={editingOccurrence}
          onClose={() => setEditingOccurrence(null)}
          onEditSeries={() => {
            openEdit(editingOccurrence, true);
            setEditingOccurrence(null);
          }}
        />
      ) : null}
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => !open && setDraft(null)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {draft?.id
                ? draft.recurrence !== 'none'
                  ? 'Edit repeating series'
                  : 'Edit item'
                : draft?.item_type
                  ? `New ${draft.item_type}`
                  : 'What are you adding?'}
            </DialogTitle>
          </DialogHeader>
          {draft && !draft.item_type ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setDraft({ ...draft, item_type: 'checklist' })}
                className="rounded-2xl border p-5 text-left hover:border-primary hover:bg-secondary"
              >
                <strong className="block">Checklist</strong>
                <span className="text-xs text-muted-foreground">
                  Scheduled work linked to a Task.
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    item_type: 'reminder',
                    ends_at: toLocalInput(
                      new Date(
                        new Date(vietnamInputToIso(draft.starts_at)).getTime() +
                          15 * 60_000,
                      ),
                    ),
                  })
                }
                className="rounded-2xl border p-5 text-left hover:border-destructive hover:bg-destructive/10"
              >
                <strong className="block">Reminder</strong>
                <span className="text-xs text-muted-foreground">
                  A point-in-time reminder that stays until handled.
                </span>
              </button>
            </div>
          ) : null}
          {draft?.item_type ? (
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
              {draft.id && draft.recurrence !== 'none' ? (
                <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground sm:col-span-2">
                  Saving this form edits the entire repeating series. Drag or
                  resize an occurrence when you only want to change one date or
                  future dates.
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
                  className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                />
              </label>
              {draft.item_type === 'checklist' ? (
                <label className="text-xs font-semibold sm:col-span-2">
                  Task
                  <RelationSelect
                    required={draft.item_type === 'checklist'}
                    value={draft.task_id}
                    onChange={(event) => {
                      const task = taskMap.get(event.target.value);
                      setDraft({
                        ...draft,
                        task_id: event.target.value,
                        title: draft.title || task?.title || '',
                      });
                    }}
                    className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                  >
                    <option value="">Choose a Task</option>
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
                {draft.item_type === 'reminder' ? 'Reminder time' : 'Start'}
                <input
                  type="datetime-local"
                  required
                  value={draft.starts_at}
                  onChange={(event) =>
                    setDraft({ ...draft, starts_at: event.target.value })
                  }
                  className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                />
              </label>
              {draft.item_type === 'checklist' ? (
                <label className="text-xs font-semibold">
                  End
                  <input
                    type="datetime-local"
                    required
                    min={draft.starts_at}
                    value={draft.ends_at}
                    onChange={(event) =>
                      setDraft({ ...draft, ends_at: event.target.value })
                    }
                    className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                  />
                </label>
              ) : (
                <p className="self-end rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                  Reminder has no end time.
                </p>
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
                  className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
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
                    required
                    min={draft.starts_at.slice(0, 10)}
                    value={draft.recurrence_until}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        recurrence_until: event.target.value,
                      })
                    }
                    className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                  />
                </label>
              ) : null}
              <fieldset className="sm:col-span-2">
                <legend className="flex items-center gap-1 text-xs font-semibold">
                  <Bell className="size-3.5" />
                  Notifications
                </legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {notificationChoices.map(([offset, label]) => (
                    <label
                      key={offset}
                      className="flex min-h-10 items-center gap-2 rounded-lg border px-3 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={draft.notification_offsets.includes(offset)}
                        onChange={() => toggleOffset(offset)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Timezone: Vietnam · each notification is sent once.
                </p>
              </fieldset>
              {draft.id && draft.recurrence === 'none' ? (
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        completed_at: draft.completed_at
                          ? null
                          : new Date().toISOString(),
                        not_needed_at: null,
                      })
                    }
                  >
                    {draft.completed_at ? 'Reopen' : 'Done'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        not_needed_at: draft.not_needed_at
                          ? null
                          : new Date().toISOString(),
                        completed_at: null,
                      })
                    }
                  >
                    {draft.not_needed_at ? 'Restore' : 'Not needed'}
                  </Button>
                </div>
              ) : null}
              {draft.id ? (
                <div className="sm:col-span-2">
                  <ItemAnnotations
                    target={{ kind: 'calendar', id: draft.id }}
                    links
                  />
                </div>
              ) : null}
              <DialogFooter className="sm:col-span-2">
                {draft.id ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void remove()}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                ) : null}
                <Button type="submit" disabled={saving}>
                  {saving ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <CalendarDays />
                  )}
                  Save
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingMove)}
        onOpenChange={(open) => !open && setPendingMove(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply this time change to…</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Choose the scope before changing a repeating item.
          </p>
          <div className="grid gap-2">
            <Button
              variant="outline"
              onClick={() => void confirmRecurringMove('occurrence')}
              disabled={saving}
            >
              This occurrence only
            </Button>
            <Button
              variant="outline"
              onClick={() => void confirmRecurringMove('future')}
              disabled={
                saving ||
                !workspace.sessions.find(
                  (item) => item.id === pendingMove?.item.id,
                )?.recurrence_until
              }
            >
              This and future occurrences
            </Button>
            <Button
              onClick={() => void confirmRecurringMove('series')}
              disabled={saving}
            >
              Entire series
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
