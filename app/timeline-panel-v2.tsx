'use client';

import { RelationSelect } from '@/components/relation-select';
import { guardPlanningPointer } from '@/lib/pointer-actions';
import { openPlanningEditor } from '@/components/planning-editor';
import {
  preserveItemOrder,
  milestoneLevels,
  matchesSearch,
} from '@/lib/workspace-view';
import {
  listHolidays,
  listAnnotations,
  type Holiday,
} from '@/lib/data/workspace-extras';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Flag as MilestoneIcon,
  PanelLeftClose,
  PanelLeftOpen,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { addDays, dateKey, daysBetween, shiftDateKey } from '@/lib/calendar';
import { goalColorValue, neutralChecklistColor } from '@/lib/colors';
import {
  getErrorMessage,
  getPlanningRepository,
  type Goal,
  type Priority,
  type Task,
  type TimelineWorkspace,
} from '@/lib/data/repository';
import {
  announceDataChanged as announceWorkspaceChanged,
  dataChangeSource,
  MYPLAN_DATA_CHANGED,
} from '@/lib/data/data-events';

type Zoom = 'week' | 'month' | 'quarter' | 'year';
type Row =
  | { kind: 'goal'; goal: Goal }
  | { kind: 'task'; task: Task; goalId: string | null; depth: number };
type Draft = {
  id?: string;
  kind: 'goal' | 'task' | 'milestone' | null;
  title: string;
  start: string;
  end: string;
  goalId: string;
  parentTaskId: string;
  description?: string;
  priority?: Priority;
  statusId?: string;
  linkUrl?: string;
};
type Preview = {
  kind: 'goal' | 'task' | 'milestone';
  id: string;
  start: string;
  end: string;
  targetGoal?: string | null;
  moveDays?: number;
};
type Drag = {
  kind: Preview['kind'];
  id: string;
  startX: number;
  startY?: number;
  pointerId: number;
  mode: 'move' | 'resize-start' | 'resize-end';
  start: string;
  end: string;
  activated: boolean;
};

const dayWidths: Record<Zoom, number> = {
  week: 46,
  month: 18,
  quarter: 8,
  year: 3,
};
const minimumDays: Record<Zoom, number> = {
  week: 56,
  month: 180,
  quarter: 540,
  year: 1095,
};
function latestTimelineDate(workspace: TimelineWorkspace, previous: string) {
  return [
    ...workspace.goals.map((goal) => goal.ends_on),
    ...workspace.tasks.map(deadlineKey),
    ...workspace.milestones.map((item) => item.milestone_on),
  ].reduce<string>(
    (latest, day) => (day && day > latest ? day : latest),
    previous,
  );
}
const deadlineKey = (task: Task) =>
  task.due_at?.slice(0, 10) ?? task.planned_end;
const deadlineIso = (key: string | null) =>
  key ? new Date(`${key}T23:59:00+07:00`).toISOString() : null;

export function TimelinePanelV2() {
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<TimelineWorkspace>({
    goals: [],
    tasks: [],
    links: [],
    milestones: [],
    statuses: [],
  });
  const [zoom, setZoom] = useState<Zoom>(() => {
    if (typeof window === 'undefined') return 'month';
    const saved = window.localStorage.getItem(
      'myplan-timeline-zoom',
    ) as Zoom | null;
    return saved && ['week', 'month', 'quarter', 'year'].includes(saved)
      ? saved
      : 'month';
  });
  const [outlineOpen, setOutlineOpen] = useState(() =>
    typeof window === 'undefined'
      ? true
      : window.localStorage.getItem('myplan-timeline-outline') !== 'closed',
  );
  const [outlineWidth, setOutlineWidth] = useState(() => {
    if (typeof window === 'undefined') return 240;
    const saved = Number(
      window.localStorage.getItem('myplan-timeline-outline-width'),
    );
    return Number.isFinite(saved) ? Math.min(360, Math.max(220, saved)) : 240;
  });
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [moving, setMoving] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const queuedPreviewRef = useRef<Preview | null>(null);
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());
  const mutationVersionsRef = useRef(new Map<string, number>());
  const mutationEpochRef = useRef(0);
  const deferredSyncRef = useRef(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const createRef = useRef<{
    row: Row;
    startX: number;
    pointerId: number;
  } | null>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const [rangeStart, setRangeStart] = useState<Date | null>(null);
  const [extraDays, setExtraDays] = useState(0);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const noteRequests = useRef(new Set<string>());
  const [viewport, setViewport] = useState({ left: 0, width: 1600 });
  const previousScrollLeft = useRef(0);
  const pendingScrollShift = useRef<number | null>(null);
  const [latestSeen, setLatestSeen] = useState(dateKey(new Date()));
  const syncSourceRef = useRef('timeline');
  const outlineResizeRef = useRef<{
    pointerId: number;
    startX: number;
    width: number;
  } | null>(null);

  const load = useCallback(async () => {
    if (!repository) return;
    const startedAtEpoch = mutationEpochRef.current;
    try {
      const next = await repository.getTimelineWorkspace();
      if (
        startedAtEpoch !== mutationEpochRef.current ||
        mutationQueuesRef.current.size > 0
      ) {
        deferredSyncRef.current = true;
        return;
      }
      setRangeStart((current) => current ?? timelineRangeStart(next));
      setLatestSeen((current) => latestTimelineDate(next, current));
      setWorkspace((current) => ({
        ...next,
        goals: preserveItemOrder(current.goals, next.goals),
        tasks: preserveItemOrder(current.tasks, next.tasks),
        milestones: preserveItemOrder(current.milestones, next.milestones),
      }));
      setNotes({});
      noteRequests.current.clear();
      setHolidays(await listHolidays());
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [repository]);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  function announceDataChanged() {
    announceWorkspaceChanged(syncSourceRef.current);
  }
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
        void loadRef.current?.();
      }
    }
  }
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    const sync = (event: Event) => {
      if (dataChangeSource(event) === syncSourceRef.current) return;
      if (mutationQueuesRef.current.size > 0) {
        deferredSyncRef.current = true;
        return;
      }
      void load();
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => {
      window.clearTimeout(handle);
      window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
      if (previewFrameRef.current !== null)
        window.cancelAnimationFrame(previewFrameRef.current);
    };
  }, [load]);
  useEffect(() => {
    window.localStorage.setItem('myplan-timeline-zoom', zoom);
  }, [zoom]);
  useEffect(() => {
    window.localStorage.setItem(
      'myplan-timeline-outline',
      outlineOpen ? 'open' : 'closed',
    );
  }, [outlineOpen]);
  useEffect(() => {
    window.localStorage.setItem(
      'myplan-timeline-outline-width',
      String(outlineWidth),
    );
  }, [outlineWidth]);

  const linkMap = useMemo(
    () => new Map(workspace.links.map((link) => [link.task_id, link.goal_id])),
    [workspace.links],
  );
  const [query, setQuery] = useState('');
  const rows = useMemo(
    () =>
      filterTimelineRows(
        buildRows(workspace, linkMap, query ? new Set() : collapsed),
        workspace,
        query,
      ),
    [collapsed, linkMap, workspace, query],
  );
  const range = makeTimelineRange(
    rangeStart ?? timelineRangeStart(workspace),
    workspace,
    latestSeen,
    zoom,
    extraDays,
  );
  const dayWidth = dayWidths[zoom];
  const chartWidth = range.days * dayWidth;
  const visibleDayStart = Math.max(
    0,
    Math.floor(viewport.left / dayWidth) - 30,
  );
  const visibleDayEnd = Math.min(
    range.days,
    Math.ceil((viewport.left + viewport.width) / dayWidth) + 30,
  );
  const visibleDays = Array.from(
    { length: Math.max(0, visibleDayEnd - visibleDayStart) },
    (_, index) => visibleDayStart + index,
  );
  useEffect(() => {
    const board = boardScrollRef.current;
    if (!board) return;
    const observer = new ResizeObserver(() =>
      setViewport({ left: board.scrollLeft, width: board.clientWidth }),
    );
    observer.observe(board);
    return () => observer.disconnect();
  }, [loading]);
  function milestoneNotes(id: string) {
    if (noteRequests.current.has(id)) return;
    noteRequests.current.add(id);
    void listAnnotations({ kind: 'milestone', id })
      .then((items) =>
        setNotes((old) => ({
          ...old,
          [id]: items
            .filter((item) => item.kind === 'comment')
            .slice(-3)
            .map((item) => item.body)
            .join('\n'),
        })),
      )
      .catch(() => {
        noteRequests.current.delete(id);
      });
  }
  useLayoutEffect(() => {
    if (pendingScrollShift.current !== null && boardScrollRef.current) {
      boardScrollRef.current.scrollLeft = pendingScrollShift.current;
      pendingScrollShift.current = null;
    }
  }, [rangeStart, extraDays]);
  function extendEarlier() {
    const amount = Math.min(
      90,
      daysBetween('2000-01-01', dateKey(range.start)),
    );
    if (amount <= 0) return;
    pendingScrollShift.current =
      (boardScrollRef.current?.scrollLeft ?? 0) + amount * dayWidth;
    setRangeStart((current) => addDays(current ?? range.start, -amount));
  }
  function extendLater() {
    if (range.days < daysBetween(dateKey(range.start), '2201-01-01'))
      setExtraDays((value) => value + 90);
  }
  function rowMilestones(row: Row) {
    return workspace.milestones.filter((item) =>
      row.kind === 'task'
        ? item.task_id === row.task.id
        : !item.task_id &&
          item.goal_id === (row.goal.id === 'inbox' ? null : row.goal.id),
    );
  }
  function rowHeight(row: Row) {
    const levels = milestoneLevels(rowMilestones(row), dayWidth);
    return (
      (row.kind === 'goal' ? 56 : 42) +
      (levels.size ? (Math.max(...levels.values()) + 1) * 24 : 0)
    );
  }

  function rangeForGoal(goal: Goal) {
    if (goal.starts_on && goal.ends_on)
      return { start: goal.starts_on, end: goal.ends_on };
    const children = workspace.tasks.filter(
      (task) => linkMap.get(task.id) === goal.id,
    );
    const starts = [
      goal.starts_on,
      ...children.map((task) => task.planned_start),
    ]
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b))) as string[];
    const ends = [goal.ends_on, ...children.map(deadlineKey)]
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b))) as string[];
    return { start: starts[0] ?? null, end: ends.at(-1) ?? null };
  }
  function entityPlan(row: Row) {
    const base =
      row.kind === 'goal'
        ? rangeForGoal(row.goal)
        : { start: row.task.planned_start, end: deadlineKey(row.task) };
    if (
      preview?.kind === 'goal' &&
      preview.moveDays !== undefined &&
      row.kind === 'task' &&
      row.goalId === preview.id
    ) {
      const delta = preview.moveDays;
      return {
        start: base.start ? shiftDateKey(base.start, delta) : null,
        end: base.end ? shiftDateKey(base.end, delta) : null,
      };
    }
    if (
      preview &&
      preview.id === (row.kind === 'goal' ? row.goal.id : row.task.id) &&
      preview.kind === row.kind
    )
      return { start: preview.start, end: preview.end };
    return base;
  }
  function dragPlan(state: Drag, clientX: number) {
    const delta = Math.round((clientX - state.startX) / dayWidth);
    let start = state.start;
    let end = state.end;
    if (state.mode === 'move') {
      start = shiftDateKey(start, delta);
      end = shiftDateKey(end, delta);
    }
    if (state.mode === 'resize-start')
      start = shiftDateKey(start, Math.min(delta, daysBetween(start, end)));
    if (state.mode === 'resize-end')
      end = shiftDateKey(end, Math.max(delta, -daysBetween(start, end)));
    return {
      kind: state.kind,
      id: state.id,
      start,
      end,
      moveDays: state.mode === 'move' ? delta : undefined,
    } as Preview;
  }
  function pointerMove(event: React.PointerEvent) {
    if (!dragRef.current || event.pointerId !== dragRef.current.pointerId)
      return;
    const state = dragRef.current;
    if (!state.activated) {
      const distance = Math.max(
        Math.abs(event.clientX - state.startX),
        state.startY === undefined ? 0 : Math.abs(event.clientY - state.startY),
      );
      if (distance < 4) return;
      state.activated = true;
    }
    queuedPreviewRef.current = {
      ...dragPlan(state, event.clientX),
      ...(state.kind === 'task' && state.mode === 'move'
        ? {
            targetGoal:
              dropGoal(event.clientX, event.clientY) ??
              linkMap.get(state.id) ??
              null,
          }
        : {}),
    };
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = window.requestAnimationFrame(() => {
      setPreview(queuedPreviewRef.current);
      queuedPreviewRef.current = null;
      previewFrameRef.current = null;
    });
  }
  function clearQueuedPreview() {
    queuedPreviewRef.current = null;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
  }
  function dropGoal(x: number, y: number) {
    const row = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>('[data-timeline-goal]');
    return row ? row.dataset.timelineGoal || null : undefined;
  }
  async function finishMove(
    state: Drag,
    next: Preview,
    targetGoal: string | null | undefined,
  ) {
    if (!repository || moving) return;
    const days = daysBetween(state.start, next.start);
    const task = workspace.tasks.find((item) => item.id === state.id);
    const oldGoal = linkMap.get(state.id) ?? null;
    const nextGoal = targetGoal === undefined ? oldGoal : targetGoal;
    if (!days && (state.kind !== 'task' || nextGoal === oldGoal)) return;
    setMoving(true);
    setMessage('');
    try {
      if (state.kind === 'goal') {
        const affected = await repository.previewTimelineGroup(state.id);
        if (
          !window.confirm(
            `Move this Goal by ${days} day(s), together with ${affected.tasks} tasks, ${affected.milestones} milestones and ${affected.calendar} calendar series? Completed items and occurrence overrides in this group move too. Unscheduled items remain unscheduled.`,
          )
        )
          return;
        await enqueueMutation(`group:${state.id}`, () =>
          repository.moveTimelineGroup(state.id, days, affected.version),
        );
      } else if (task) {
        if (
          nextGoal !== oldGoal &&
          !window.confirm(
            `Move “${task.title}” to ${workspace.goals.find((goal) => goal.id === nextGoal)?.title ?? 'Inbox'}? Only this task moves. Its child tasks stay in the original Goal; its linked checklists and milestones keep their dates.`,
          )
        )
          return;
        await enqueueMutation(`task:${state.id}`, () =>
          repository.moveTimelineTask(state.id, {
            days,
            goal_id: nextGoal,
            expected_goal: oldGoal,
            expected_parent: task.parent_task_id,
            expected_start: task.planned_start,
            expected_due: task.due_at,
          }),
        );
      }
      mutationEpochRef.current++;
      await load();
      announceDataChanged();
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setMoving(false);
    }
  }
  async function pointerUp(event: React.PointerEvent) {
    clearQueuedPreview();
    if (dragRef.current && event.pointerId === dragRef.current.pointerId) {
      const state = dragRef.current;
      const next = dragPlan(state, event.clientX);
      dragRef.current = null;
      setPreview(null);
      if (!state.activated) {
        openInspector(state.kind, state.id);
        return;
      }
      if (state.mode === 'move' && state.kind !== 'milestone') {
        const outlineTarget = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest('[data-timeline-outline-target]');
        await finishMove(
          state,
          state.kind === 'task' && outlineTarget
            ? { ...next, start: state.start }
            : next,
          dropGoal(event.clientX, event.clientY),
        );
        return;
      }
      const mutationKey = `${state.kind}:${state.id}`;
      const fields =
        state.kind === 'task'
          ? ['planned_start', 'due_at', 'planned_end']
          : state.kind === 'goal'
            ? ['starts_on', 'ends_on']
            : ['milestone_on'];
      const versions = new Map(
        fields.map((field) => [
          field,
          nextMutationVersion(`${mutationKey}:${field}`),
        ]),
      );
      setWorkspace((current) => applyTimelinePlan(current, state, next));
      try {
        await enqueueMutation(mutationKey, async () => {
          if (state.kind === 'task')
            await repository?.updateTask(state.id, {
              planned_start: next.start,
              due_at: deadlineIso(next.end),
              planned_end: null,
            });
          if (state.kind === 'goal')
            await repository?.updateGoal(state.id, {
              starts_on: next.start,
              ends_on: next.end,
            });
          if (state.kind === 'milestone')
            await repository?.updateTimelineMilestone(state.id, {
              milestone_on: next.start,
            });
        });
        announceDataChanged();
      } catch (error) {
        setWorkspace((current) => {
          if (state.kind === 'task')
            return {
              ...current,
              tasks: current.tasks.map((task) => {
                if (task.id !== state.id) return task;
                const rollback = { ...task };
                if (
                  mutationVersionsRef.current.get(
                    `${mutationKey}:planned_start`,
                  ) === versions.get('planned_start')
                )
                  rollback.planned_start = state.start;
                if (
                  mutationVersionsRef.current.get(`${mutationKey}:due_at`) ===
                  versions.get('due_at')
                )
                  rollback.due_at = deadlineIso(state.end);
                if (
                  mutationVersionsRef.current.get(
                    `${mutationKey}:planned_end`,
                  ) === versions.get('planned_end')
                )
                  rollback.planned_end = null;
                return rollback;
              }),
            };
          if (state.kind === 'goal')
            return {
              ...current,
              goals: current.goals.map((goal) => {
                if (goal.id !== state.id) return goal;
                const rollback = { ...goal };
                if (
                  mutationVersionsRef.current.get(
                    `${mutationKey}:starts_on`,
                  ) === versions.get('starts_on')
                )
                  rollback.starts_on = state.start;
                if (
                  mutationVersionsRef.current.get(`${mutationKey}:ends_on`) ===
                  versions.get('ends_on')
                )
                  rollback.ends_on = state.end;
                return rollback;
              }),
            };
          return {
            ...current,
            milestones: current.milestones.map((milestone) =>
              milestone.id === state.id &&
              mutationVersionsRef.current.get(`${mutationKey}:milestone_on`) ===
                versions.get('milestone_on')
                ? { ...milestone, milestone_on: state.start }
                : milestone,
            ),
          };
        });
        setMessage(getErrorMessage(error));
      }
      return;
    }
    const creation = createRef.current;
    if (!creation || event.pointerId !== creation.pointerId) return;
    createRef.current = null;
    const column = Math.round((event.clientX - creation.startX) / dayWidth);
    const firstX = Math.min(creation.startX, event.clientX);
    const board = event.currentTarget.getBoundingClientRect();
    const startOffset = Math.max(
      0,
      Math.round((firstX - board.left) / dayWidth),
    );
    const start = dateKey(addDays(range.start, startOffset));
    const end = shiftDateKey(start, Math.max(0, Math.abs(column)));
    if (
      creation.row.kind === 'task' &&
      !creation.row.task.planned_start &&
      !deadlineKey(creation.row.task)
    ) {
      const taskId = creation.row.task.id;
      const mutationKey = `task:${taskId}`;
      const fields = ['planned_start', 'due_at', 'planned_end'];
      const versions = new Map(
        fields.map((field) => [
          field,
          nextMutationVersion(`${mutationKey}:${field}`),
        ]),
      );
      const beforeTask = creation.row.task;
      setWorkspace((current) => ({
        ...current,
        tasks: current.tasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                planned_start: start,
                due_at: deadlineIso(end),
                planned_end: null,
              }
            : task,
        ),
      }));
      try {
        await enqueueMutation(mutationKey, async () => {
          await repository?.updateTask(taskId, {
            planned_start: start,
            due_at: deadlineIso(end),
            planned_end: null,
          });
        });
        announceDataChanged();
      } catch (error) {
        setWorkspace((current) => ({
          ...current,
          tasks: current.tasks.map((task) => {
            if (task.id !== taskId) return task;
            const rollback = { ...task };
            for (const field of fields)
              if (
                mutationVersionsRef.current.get(`${mutationKey}:${field}`) ===
                versions.get(field)
              )
                Object.assign(rollback, {
                  [field]: beforeTask[field as keyof Task],
                });
            return rollback;
          }),
        }));
        setMessage(getErrorMessage(error));
      }
      return;
    }
    setDraft({
      kind: null,
      title: '',
      start,
      end,
      goalId:
        creation.row.kind === 'goal' && creation.row.goal.id !== 'inbox'
          ? creation.row.goal.id
          : creation.row.kind === 'task'
            ? (creation.row.goalId ?? '')
            : '',
      parentTaskId: creation.row.kind === 'task' ? creation.row.task.id : '',
    });
  }

  function changeZoom(next: Zoom) {
    if (next === zoom) return;
    const scroll = boardScrollRef.current;
    const outline = outlineOpen ? outlineWidth : 0;
    const centerDay = scroll
      ? Math.max(
          0,
          (scroll.scrollLeft + scroll.clientWidth / 2 - outline) / dayWidth,
        )
      : 0;
    setZoom(next);
    window.requestAnimationFrame(() => {
      const current = boardScrollRef.current;
      if (!current) return;
      current.scrollLeft = Math.max(
        0,
        outline + centerDay * dayWidths[next] - current.clientWidth / 2,
      );
    });
  }

  function openInspector(kind: Preview['kind'], id: string) {
    openPlanningEditor({ kind, id });
  }
  async function saveDraft(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository || !draft?.kind || !draft.title.trim()) return;
    setMessage('');
    if (draft.id && draft.kind === 'milestone') {
      const saved = draft;
      const previous = workspace.milestones.find(
        (item) => item.id === draft.id,
      );
      if (!previous) return;
      const changes = {
        title: draft.title.trim(),
        milestone_on: draft.start,
        goal_id: draft.goalId || null,
      };
      const key = `milestone:${draft.id}`;
      const fields = ['title', 'milestone_on', 'goal_id'] as const;
      const versions = new Map(
        fields.map((field) => [field, nextMutationVersion(`${key}:${field}`)]),
      );
      setWorkspace((current) => ({
        ...current,
        milestones: current.milestones.map((item) =>
          item.id === saved.id ? { ...item, ...changes } : item,
        ),
      }));
      setDraft(null);
      try {
        await enqueueMutation(key, () =>
          repository.updateTimelineMilestone(saved.id!, changes),
        );
        announceDataChanged();
      } catch (error) {
        setWorkspace((current) => ({
          ...current,
          milestones: current.milestones.map((item) => {
            if (item.id !== saved.id) return item;
            const rollback = { ...item };
            for (const field of fields)
              if (
                mutationVersionsRef.current.get(`${key}:${field}`) ===
                versions.get(field)
              )
                Object.assign(rollback, { [field]: previous[field] });
            return rollback;
          }),
        }));
        setMessage(getErrorMessage(error));
      }
      return;
    }
    if (draft.id && draft.kind === 'goal') {
      const saved = draft;
      const previous = workspace.goals.find((goal) => goal.id === draft.id);
      if (!previous) return;
      const changes = {
        title: draft.title.trim(),
        description: draft.description?.trim() || null,
        starts_on: draft.start || null,
        ends_on: draft.end || null,
      };
      const key = `goal:${draft.id}`;
      const fields = Object.keys(changes) as Array<keyof Goal>;
      const versions = new Map(
        fields.map((field) => [field, nextMutationVersion(`${key}:${field}`)]),
      );
      setWorkspace((current) => ({
        ...current,
        goals: current.goals.map((goal) =>
          goal.id === saved.id ? { ...goal, ...changes } : goal,
        ),
      }));
      setDraft(null);
      try {
        await enqueueMutation(key, () =>
          repository.updateGoal(saved.id!, changes),
        );
        announceDataChanged();
      } catch (error) {
        setWorkspace((current) => ({
          ...current,
          goals: current.goals.map((goal) => {
            if (goal.id !== saved.id) return goal;
            const rollback = { ...goal };
            for (const field of fields)
              if (
                mutationVersionsRef.current.get(`${key}:${field}`) ===
                versions.get(field)
              )
                Object.assign(rollback, { [field]: previous[field] });
            return rollback;
          }),
        }));
        setMessage(getErrorMessage(error));
      }
      return;
    }
    if (draft.id && draft.kind === 'task') {
      const saved = draft;
      const previous = workspace.tasks.find((item) => item.id === draft.id);
      const previousGoalId = linkMap.get(draft.id) ?? null;
      const selectedStatus = workspace.statuses.find(
        (item) => item.id === draft.statusId,
      );
      if (!previous) return;
      if (
        !previous.completed_at &&
        selectedStatus?.category === 'completed' &&
        previous.checklist_resolved_count < previous.active_checklist_count &&
        !window.confirm(
          'Complete this Task and mark its unfinished checklist items Not needed?',
        )
      )
        return;
      const changes = {
        title: draft.title.trim(),
        priority: draft.priority ?? previous.priority,
        planned_start: draft.start || null,
        due_at: deadlineIso(draft.end || null),
        planned_end: null,
        goal_id: draft.goalId || null,
        link_url: draft.linkUrl?.trim() || null,
        ...(selectedStatus?.category === 'completed'
          ? {}
          : { workflow_status_id: selectedStatus?.id }),
      };
      const optimistic = {
        ...previous,
        ...changes,
        workflow_status_id: selectedStatus?.id ?? previous.workflow_status_id,
        completed_at:
          selectedStatus?.category === 'completed'
            ? (previous.completed_at ?? new Date().toISOString())
            : null,
        progress:
          selectedStatus?.category === 'completed' ? 100 : previous.progress,
      };
      const key = `task:${draft.id}`;
      const fields = [
        ...Object.keys(changes).filter((field) => field !== 'goal_id'),
        'workflow_status_id',
        'completed_at',
        'progress',
        'goal-link',
      ];
      const versions = new Map(
        fields.map((field) => [field, nextMutationVersion(`${key}:${field}`)]),
      );
      setWorkspace((current) => ({
        ...current,
        tasks: current.tasks.map((item) =>
          item.id === saved.id ? optimistic : item,
        ),
        links: [
          ...current.links.filter((link) => link.task_id !== saved.id),
          ...(saved.goalId
            ? [{ task_id: saved.id!, goal_id: saved.goalId }]
            : []),
        ],
      }));
      setDraft(null);
      try {
        await enqueueMutation(key, async () => {
          try {
            if (
              previous.completed_at &&
              selectedStatus?.category !== 'completed'
            )
              await repository.setTaskCompletion(saved.id!, false);
            await repository.updateTask(saved.id!, changes);
            if (
              !previous.completed_at &&
              selectedStatus?.category === 'completed'
            )
              await repository.setTaskCompletion(saved.id!, true);
          } catch (error) {
            try {
              await repository.setTaskCompletion(
                saved.id!,
                Boolean(previous.completed_at),
              );
              await repository.updateTask(saved.id!, {
                title: previous.title,
                priority: previous.priority,
                planned_start: previous.planned_start,
                due_at: previous.due_at,
                planned_end: previous.planned_end,
                goal_id: previousGoalId,
                link_url: previous.link_url,
              });
            } catch {
              /* original failure remains the actionable error */
            }
            throw error;
          }
        });
        announceDataChanged();
      } catch (error) {
        setWorkspace((current) => ({
          ...current,
          tasks: current.tasks.map((item) => {
            if (item.id !== saved.id) return item;
            const rollback = { ...item };
            for (const field of fields) {
              if (
                field === 'goal-link' ||
                mutationVersionsRef.current.get(`${key}:${field}`) !==
                  versions.get(field)
              )
                continue;
              Object.assign(rollback, {
                [field]: previous[field as keyof Task],
              });
            }
            return rollback;
          }),
          links:
            mutationVersionsRef.current.get(`${key}:goal-link`) ===
            versions.get('goal-link')
              ? [
                  ...current.links.filter((link) => link.task_id !== saved.id),
                  ...(previousGoalId
                    ? [{ task_id: saved.id!, goal_id: previousGoalId }]
                    : []),
                ]
              : current.links,
        }));
        try {
          const fresh = await repository.getTimelineWorkspace();
          const serverTask = fresh.tasks.find((item) => item.id === saved.id);
          const serverLink = fresh.links.find(
            (link) => link.task_id === saved.id,
          );
          if (serverTask)
            setWorkspace((current) => {
              const goalLinkIsLatest =
                mutationVersionsRef.current.get(`${key}:goal-link`) ===
                versions.get('goal-link');
              return {
                ...current,
                tasks: current.tasks.map((item) => {
                  if (item.id !== saved.id) return item;
                  const reconciled = { ...item };
                  for (const field of fields) {
                    if (
                      field === 'goal-link' ||
                      mutationVersionsRef.current.get(`${key}:${field}`) !==
                        versions.get(field)
                    )
                      continue;
                    Object.assign(reconciled, {
                      [field]: serverTask[field as keyof Task],
                    });
                  }
                  return reconciled;
                }),
                links: goalLinkIsLatest
                  ? [
                      ...current.links.filter(
                        (link) => link.task_id !== saved.id,
                      ),
                      ...(serverLink ? [serverLink] : []),
                    ]
                  : current.links,
              };
            });
        } catch {
          /* keep the targeted optimistic rollback when reconciliation fails */
        }
        setMessage(getErrorMessage(error));
      }
      return;
    }
    try {
      if (draft.id && draft.kind === 'milestone') {
        await repository.updateTimelineMilestone(draft.id, {
          title: draft.title.trim(),
          milestone_on: draft.start,
          goal_id: draft.goalId || null,
        });
        setWorkspace((current) => ({
          ...current,
          milestones: current.milestones.map((item) =>
            item.id === draft.id
              ? {
                  ...item,
                  title: draft.title.trim(),
                  milestone_on: draft.start,
                  goal_id: draft.goalId || null,
                }
              : item,
          ),
        }));
      } else if (draft.id && draft.kind === 'goal') {
        await repository.updateGoal(draft.id, {
          title: draft.title.trim(),
          description: draft.description?.trim() || null,
          starts_on: draft.start || null,
          ends_on: draft.end || null,
        });
        setWorkspace((current) => ({
          ...current,
          goals: current.goals.map((goal) =>
            goal.id === draft.id
              ? {
                  ...goal,
                  title: draft.title.trim(),
                  description: draft.description?.trim() || null,
                  starts_on: draft.start || null,
                  ends_on: draft.end || null,
                }
              : goal,
          ),
        }));
      } else if (draft.id && draft.kind === 'task') {
        const task = workspace.tasks.find((item) => item.id === draft.id);
        const selectedStatus = workspace.statuses.find(
          (item) => item.id === draft.statusId,
        );
        if (
          task &&
          !task.completed_at &&
          selectedStatus?.category === 'completed' &&
          task.checklist_resolved_count < task.active_checklist_count &&
          !window.confirm(
            'Complete this Task and mark its unfinished checklist items Not needed?',
          )
        )
          return;
        if (task?.completed_at && selectedStatus?.category !== 'completed')
          await repository.setTaskCompletion(draft.id, false);
        await repository.updateTask(draft.id, {
          title: draft.title.trim(),
          priority: draft.priority ?? task?.priority ?? 'medium',
          planned_start: draft.start || null,
          due_at: deadlineIso(draft.end || null),
          planned_end: null,
          goal_id: draft.goalId || null,
          link_url: draft.linkUrl?.trim() || null,
          ...(selectedStatus?.category === 'completed'
            ? {}
            : { workflow_status_id: selectedStatus?.id }),
        });
        if (!task?.completed_at && selectedStatus?.category === 'completed')
          await repository.setTaskCompletion(draft.id, true);
        setWorkspace((current) => ({
          ...current,
          tasks: current.tasks.map((item) =>
            item.id === draft.id
              ? {
                  ...item,
                  title: draft.title.trim(),
                  priority: draft.priority ?? item.priority,
                  planned_start: draft.start || null,
                  due_at: deadlineIso(draft.end || null),
                  planned_end: null,
                  link_url: draft.linkUrl?.trim() || null,
                  workflow_status_id:
                    selectedStatus?.id ?? item.workflow_status_id,
                  completed_at:
                    selectedStatus?.category === 'completed'
                      ? (item.completed_at ?? new Date().toISOString())
                      : null,
                  progress:
                    selectedStatus?.category === 'completed'
                      ? 100
                      : item.progress,
                }
              : item,
          ),
          links: [
            ...current.links.filter((link) => link.task_id !== draft.id),
            ...(draft.goalId
              ? [{ task_id: draft.id!, goal_id: draft.goalId }]
              : []),
          ],
        }));
      } else if (draft.kind === 'goal') {
        const id = await repository.createGoal({
          title: draft.title.trim(),
          description: null,
          starts_on: draft.start,
          ends_on: draft.end,
          color_key: 'jade',
        });
        setWorkspace((current) => ({
          ...current,
          goals: [
            ...current.goals,
            {
              id,
              title: draft.title.trim(),
              description: null,
              starts_on: draft.start,
              ends_on: draft.end,
              color_key: 'jade',
              progress: 0,
              status: 'active',
              archived_at: null,
              deleted_at: null,
              task_count: 0,
              completed_task_count: 0,
            },
          ],
        }));
      } else if (draft.kind === 'task') {
        const status =
          workspace.statuses.find((item) => item.category === 'planned') ??
          workspace.statuses[0];
        if (!status) throw new Error('No workflow status is available.');
        const id = await repository.createTask({
          title: draft.title.trim(),
          priority: 'medium',
          due_at: deadlineIso(draft.end),
          workflow_status_id: status.id,
          planned_start: draft.start,
          planned_end: null,
          progress: 0,
          parent_task_id: draft.parentTaskId || null,
          dependency_task_id: null,
          is_milestone: false,
          goal_id: draft.goalId || undefined,
        });
        setWorkspace((current) => ({
          ...current,
          tasks: [
            ...current.tasks,
            {
              id,
              title: draft.title.trim(),
              priority: 'medium',
              due_at: deadlineIso(draft.end),
              completed_at: null,
              workflow_status_id: status.id,
              previous_status_id: null,
              planned_start: draft.start,
              planned_end: null,
              progress: 0,
              parent_task_id: draft.parentTaskId || null,
              dependency_task_id: null,
              is_milestone: false,
              archived_at: null,
              deleted_at: null,
              link_url: null,
              link_label: null,
              active_checklist_count: 0,
              checklist_resolved_count: 0,
              checklist_done_count: 0,
            },
          ],
          links: draft.goalId
            ? [...current.links, { task_id: id, goal_id: draft.goalId }]
            : current.links,
        }));
      } else {
        const id = await repository.createTimelineMilestone({
          title: draft.title.trim(),
          milestone_on: draft.start,
          goal_id: draft.goalId || null,
        });
        setWorkspace((current) => ({
          ...current,
          milestones: [
            ...current.milestones,
            {
              id,
              title: draft.title.trim(),
              milestone_on: draft.start,
              goal_id: draft.goalId || null,
            },
          ],
        }));
      }
      setDraft(null);
      announceDataChanged();
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  async function removeMilestone() {
    if (!repository || !draft?.id) return;
    const target = workspace.milestones.find((item) => item.id === draft.id);
    const index = workspace.milestones.findIndex(
      (item) => item.id === draft.id,
    );
    const id = draft.id;
    setWorkspace((current) => ({
      ...current,
      milestones: current.milestones.filter((item) => item.id !== id),
    }));
    setDraft(null);
    try {
      await repository.deleteTimelineMilestone(id);
      announceDataChanged();
    } catch (error) {
      if (target)
        setWorkspace((current) => ({
          ...current,
          milestones: [
            ...current.milestones.slice(0, Math.max(index, 0)),
            target,
            ...current.milestones.slice(Math.max(index, 0)),
          ],
        }));
      setMessage(getErrorMessage(error));
    }
  }

  const todayLeft =
    daysBetween(dateKey(range.start), dateKey(new Date())) * dayWidth;
  return (
    <section
      aria-labelledby="timeline-heading"
      onPointerDownCapture={guardPlanningPointer}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
            Plan the horizon
          </p>
          <h1
            id="timeline-heading"
            className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
          >
            Gantt timeline
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <input
            type="search"
            aria-label="Search Timeline"
            placeholder="Find goal, task or milestone…"
            className="mr-2 rounded-lg border bg-background px-3 py-2 text-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={outlineOpen ? 'Hide outline' : 'Show outline'}
            onClick={() => setOutlineOpen((open) => !open)}
          >
            {outlineOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Zoom out"
            disabled={zoom === 'year'}
            onClick={() => {
              const levels: Zoom[] = ['week', 'month', 'quarter', 'year'];
              changeZoom(
                levels[Math.min(levels.length - 1, levels.indexOf(zoom) + 1)],
              );
            }}
          >
            <ZoomOut />
          </Button>
          {(['week', 'month', 'quarter', 'year'] as Zoom[]).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={zoom === item ? 'default' : 'outline'}
              className="capitalize"
              onClick={() => changeZoom(item)}
            >
              {item}
            </Button>
          ))}
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Zoom in"
            disabled={zoom === 'week'}
            onClick={() => {
              const levels: Zoom[] = ['week', 'month', 'quarter', 'year'];
              changeZoom(levels[Math.max(0, levels.indexOf(zoom) - 1)]);
            }}
          >
            <ZoomIn />
          </Button>
        </div>
      </div>
      {message ? (
        <p
          className="mt-4 rounded-xl border bg-muted p-3 text-xs"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}
      {loading ? (
        <div className="grid min-h-[420px] place-items-center">
          <LoaderCircle className="animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={extendEarlier}>
              ← Earlier
            </Button>
            <Button variant="outline" onClick={extendLater}>
              Later →
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const board = boardScrollRef.current;
                if (board)
                  board.scrollLeft = Math.max(
                    0,
                    daysBetween(dateKey(range.start), dateKey(new Date())) *
                      dayWidth -
                      board.clientWidth / 3,
                  );
              }}
            >
              Today
            </Button>
            <Button
              variant="outline"
              onClick={() => openPlanningEditor({ kind: 'milestone' })}
            >
              Add milestone
            </Button>
            {moving ? (
              <output className="text-sm text-muted-foreground">
                Saving group change…
              </output>
            ) : null}
          </div>
          <div
            ref={boardScrollRef}
            className="mt-3 h-[max(480px,calc(100dvh-250px))] overflow-auto rounded-2xl border bg-card shadow-sm"
            onScroll={(event) => {
              const node = event.currentTarget;
              setViewport({ left: node.scrollLeft, width: node.clientWidth });
              const horizontal = node.scrollLeft !== previousScrollLeft.current;
              previousScrollLeft.current = node.scrollLeft;
              if (
                !horizontal ||
                pendingScrollShift.current !== null ||
                dragRef.current ||
                createRef.current
              )
                return;
              if (node.scrollLeft < 2) extendEarlier();
              else if (
                node.scrollLeft + node.clientWidth >
                node.scrollWidth - 80
              )
                extendLater();
            }}
            onWheel={(event) => {
              if (!event.ctrlKey && !event.metaKey) return;
              event.preventDefault();
              const levels: Zoom[] = ['week', 'month', 'quarter', 'year'];
              const direction = event.deltaY > 0 ? 1 : -1;
              changeZoom(
                levels[
                  Math.max(
                    0,
                    Math.min(
                      levels.length - 1,
                      levels.indexOf(zoom) + direction,
                    ),
                  )
                ],
              );
            }}
          >
            <div className="flex min-w-max" inert={moving}>
              <div
                className={`sticky left-0 z-30 shrink-0 overflow-hidden bg-card transition-[width] ${outlineOpen ? 'border-r' : 'w-0 border-r-0'}`}
                style={{ width: outlineOpen ? outlineWidth : 0 }}
              >
                <div className="sticky top-0 z-30 h-12 border-b bg-card px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Goal / Task
                </div>
                {rows.map((row) =>
                  row.kind === 'goal' ? (
                    <button
                      type="button"
                      key={`left-${row.goal.id}`}
                      data-timeline-goal={
                        row.goal.id === 'inbox' ? '' : row.goal.id
                      }
                      data-timeline-outline-target="true"
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(row.goal.id)) next.delete(row.goal.id);
                          else next.add(row.goal.id);
                          return next;
                        })
                      }
                      className="flex h-14 w-full items-center gap-2 border-b bg-muted/30 px-3 text-left text-sm font-semibold"
                      style={{ height: rowHeight(row) }}
                    >
                      {collapsed.has(row.goal.id) ? (
                        <ChevronRight className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                      <span
                        className="size-2.5 rounded-full"
                        style={{
                          background: goalColorValue(row.goal.color_key),
                        }}
                      />
                      {row.goal.title}
                    </button>
                  ) : (
                    <button
                      type="button"
                      key={`left-${row.task.id}`}
                      data-timeline-goal={row.goalId ?? ''}
                      data-timeline-outline-target="true"
                      onClick={() => openInspector('task', row.task.id)}
                      className="flex h-[42px] w-full items-center border-b px-3 text-left hover:bg-muted/40"
                      style={{
                        paddingLeft: 16 + row.depth * 16,
                        height: rowHeight(row),
                      }}
                    >
                      <span className="block min-w-0 truncate text-xs font-semibold">
                        {row.task.title}
                      </span>
                    </button>
                  ),
                )}
                {outlineOpen ? (
                  <hr
                    aria-orientation="vertical"
                    aria-label="Resize timeline outline"
                    className="absolute inset-y-0 right-0 z-40 h-auto w-2 cursor-ew-resize touch-none border-0 hover:bg-primary/20"
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      outlineResizeRef.current = {
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        width: outlineWidth,
                      };
                    }}
                    onPointerMove={(event) => {
                      const resizing = outlineResizeRef.current;
                      if (!resizing || resizing.pointerId !== event.pointerId)
                        return;
                      setOutlineWidth(
                        Math.min(
                          360,
                          Math.max(
                            220,
                            resizing.width + event.clientX - resizing.startX,
                          ),
                        ),
                      );
                    }}
                    onPointerUp={(event) => {
                      if (
                        outlineResizeRef.current?.pointerId === event.pointerId
                      )
                        outlineResizeRef.current = null;
                    }}
                    onPointerCancel={(event) => {
                      if (
                        outlineResizeRef.current?.pointerId === event.pointerId
                      )
                        outlineResizeRef.current = null;
                    }}
                  />
                ) : null}
              </div>
              <div
                className="relative shrink-0 overflow-clip"
                style={{ width: chartWidth }}
                onPointerMove={pointerMove}
                onPointerUp={(event) => void pointerUp(event)}
                onPointerCancel={(event) => {
                  if (
                    event.pointerId !==
                    (dragRef.current ?? createRef.current)?.pointerId
                  )
                    return;
                  clearQueuedPreview();
                  dragRef.current = null;
                  createRef.current = null;
                  setPreview(null);
                }}
              >
                <div
                  className="sticky top-0 z-20 h-12 border-b bg-card"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to right,transparent 0,transparent ${dayWidth - 1}px,var(--border) ${dayWidth - 1}px,var(--border) ${dayWidth}px)`,
                  }}
                >
                  {visibleDays
                    .filter(
                      (index) =>
                        zoom === 'week' ||
                        zoom === 'month' ||
                        index % Math.max(1, Math.round(90 / dayWidth)) === 0,
                    )
                    .map((index) => (
                      <span
                        key={index}
                        className="absolute top-1 text-center text-[9px] text-muted-foreground"
                        title={[
                          addDays(range.start, index).toLocaleDateString(
                            undefined,
                            {
                              weekday: 'long',
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric',
                            },
                          ),
                          ...holidays
                            .filter(
                              (holiday) =>
                                holiday.starts_on <=
                                  dateKey(addDays(range.start, index)) &&
                                holiday.ends_on >=
                                  dateKey(addDays(range.start, index)),
                            )
                            .map((holiday) => holiday.title),
                        ].join('\n')}
                        style={{
                          left: index * dayWidth,
                          width:
                            zoom === 'week' || zoom === 'month' ? dayWidth : 90,
                        }}
                      >
                        {zoom === 'week' || zoom === 'month' ? (
                          <>
                            <span className="block text-[8px]">
                              {
                                ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][
                                  addDays(range.start, index).getDay()
                                ]
                              }
                            </span>
                            <strong className="block">
                              {addDays(range.start, index).getDate()}
                            </strong>
                            {zoom === 'week' ||
                            addDays(range.start, index).getDate() === 1 ? (
                              <small>
                                {addDays(range.start, index).toLocaleDateString(
                                  undefined,
                                  { month: 'short' },
                                )}
                              </small>
                            ) : null}
                          </>
                        ) : (
                          addDays(range.start, index).toLocaleDateString(
                            undefined,
                            { month: 'short', day: 'numeric' },
                          )
                        )}
                      </span>
                    ))}
                </div>
                {visibleDays.map((index) => {
                  const day = addDays(range.start, index);
                  const key = dateKey(day);
                  const holiday = holidays.find(
                    (item) => item.starts_on <= key && item.ends_on >= key,
                  );
                  if (!holiday && day.getDay() !== 0 && day.getDay() !== 6)
                    return null;
                  return (
                    <div
                      key={`off-${key}`}
                      className={`pointer-events-none absolute bottom-0 top-12 ${holiday ? 'bg-amber-500/10' : 'bg-foreground/5'}`}
                      style={{ left: index * dayWidth, width: dayWidth }}
                    />
                  );
                })}
                {rows.map((row) => {
                  const plan = entityPlan(row);
                  const left = plan.start
                    ? daysBetween(dateKey(range.start), plan.start) * dayWidth
                    : 0;
                  const width =
                    plan.start && plan.end
                      ? Math.max(
                          10,
                          (daysBetween(plan.start, plan.end) + 1) * dayWidth,
                        )
                      : 0;
                  const baseColor =
                    row.kind === 'goal'
                      ? goalColorValue(row.goal.color_key)
                      : row.goalId
                        ? goalColorValue(
                            workspace.goals.find(
                              (goal) => goal.id === row.goalId,
                            )?.color_key,
                          )
                        : neutralChecklistColor;
                  const color =
                    row.kind === 'goal'
                      ? baseColor
                      : `color-mix(in srgb, ${baseColor} ${row.depth > 0 ? 58 : 72}%, var(--card))`;
                  const milestones = rowMilestones(row);
                  const levels = milestoneLevels(milestones, dayWidth);
                  return (
                    <div
                      key={`chart-${row.kind === 'goal' ? row.goal.id : row.task.id}`}
                      data-timeline-goal={
                        row.kind === 'goal'
                          ? row.goal.id === 'inbox'
                            ? ''
                            : row.goal.id
                          : (row.goalId ?? '')
                      }
                      className={`relative border-b ${row.kind === 'goal' ? 'h-14 bg-muted/20' : 'h-[42px]'}`}
                      style={{
                        height: rowHeight(row),
                        backgroundImage: `repeating-linear-gradient(to right,transparent 0,transparent ${dayWidth - 1}px,var(--border) ${dayWidth - 1}px,var(--border) ${dayWidth}px)`,
                      }}
                      onPointerDown={(event) => {
                        if ((event.target as HTMLElement).closest('[data-bar]'))
                          return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        createRef.current = {
                          row,
                          startX: event.clientX,
                          pointerId: event.pointerId,
                        };
                      }}
                    >
                      {plan.start && plan.end ? (
                        <button
                          type="button"
                          data-bar
                          aria-label={`Edit ${row.kind} ${row.kind === 'goal' ? row.goal.title : row.task.title}`}
                          title={`${row.kind === 'goal' ? row.goal.title : row.task.title}\n${plan.start} → ${plan.end}${row.kind === 'task' ? `\nGoal: ${workspace.goals.find((goal) => goal.id === row.goalId)?.title ?? 'Inbox'}` : ''}`}
                          className={`absolute touch-none rounded-md text-[10px] font-semibold shadow-sm will-change-transform hover:brightness-95 active:brightness-90 ${row.kind === 'goal' ? 'top-2.5 h-9 text-white' : 'top-[11px] h-5 text-foreground'}`}
                          style={{
                            top:
                              rowHeight(row) - (row.kind === 'goal' ? 46 : 31),
                            left,
                            width,
                            background: color,
                            borderColor: baseColor,
                          }}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                            dragRef.current = {
                              kind: row.kind,
                              id:
                                row.kind === 'goal' ? row.goal.id : row.task.id,
                              startX: event.clientX,
                              startY: event.clientY,
                              pointerId: event.pointerId,
                              mode: 'move',
                              start: plan.start!,
                              end: plan.end!,
                              activated: false,
                            };
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ')
                              return;
                            event.preventDefault();
                            openInspector(
                              row.kind,
                              row.kind === 'goal' ? row.goal.id : row.task.id,
                            );
                          }}
                        >
                          <span
                            className={`block truncate px-2 ${row.kind === 'goal' ? 'py-2.5' : 'leading-5'}`}
                          >
                            {row.kind === 'goal'
                              ? row.goal.title
                              : row.task.title}
                          </span>
                          <span
                            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              dragRef.current = {
                                kind: row.kind,
                                id:
                                  row.kind === 'goal'
                                    ? row.goal.id
                                    : row.task.id,
                                startX: event.clientX,
                                pointerId: event.pointerId,
                                mode: 'resize-start',
                                start: plan.start!,
                                end: plan.end!,
                                activated: false,
                              };
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                            }}
                          />
                          <span
                            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-black/15"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              dragRef.current = {
                                kind: row.kind,
                                id:
                                  row.kind === 'goal'
                                    ? row.goal.id
                                    : row.task.id,
                                startX: event.clientX,
                                pointerId: event.pointerId,
                                mode: 'resize-end',
                                start: plan.start!,
                                end: plan.end!,
                                activated: false,
                              };
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                            }}
                          />
                        </button>
                      ) : row.kind === 'task' ? (
                        <span className="absolute left-3 top-3.5 text-[10px] text-muted-foreground">
                          Drag here to set Start date → Deadline
                        </span>
                      ) : null}
                      {milestones.map((item) => {
                        const day =
                          preview?.kind === 'milestone' &&
                          preview.id === item.id
                            ? preview.start
                            : item.milestone_on;
                        const milestoneLeft =
                          daysBetween(dateKey(range.start), day) * dayWidth;
                        return (
                          <button
                            data-bar
                            type="button"
                            key={item.id}
                            title={`${item.title}\n${item.milestone_on}\n${row.kind === 'goal' ? row.goal.title : row.task.title}${notes[item.id] ? `\n${notes[item.id]}` : ''}`}
                            onMouseEnter={() => milestoneNotes(item.id)}
                            onFocus={() => milestoneNotes(item.id)}
                            aria-label={`Edit milestone ${item.title}`}
                            className="absolute z-10 grid size-6 place-items-center rounded-sm text-foreground hover:bg-muted focus-visible:outline-2"
                            style={{
                              left: milestoneLeft,
                              top: 2 + (levels.get(item.id) ?? 0) * 24,
                              color: baseColor,
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                openInspector('milestone', item.id);
                              }
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                              dragRef.current = {
                                kind: 'milestone',
                                id: item.id,
                                startX: event.clientX,
                                pointerId: event.pointerId,
                                mode: 'move',
                                start: item.milestone_on,
                                end: item.milestone_on,
                                activated: false,
                              };
                            }}
                          >
                            <MilestoneIcon className="size-5 fill-current" />
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {todayLeft >= 0 && todayLeft <= chartWidth ? (
                  <span
                    className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-destructive"
                    style={{ left: todayLeft }}
                  >
                    <span className="absolute top-0 -translate-x-1/2 rounded bg-destructive px-1 text-[9px] text-white">
                      Today
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </>
      )}
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => !open && setDraft(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {draft?.id
                ? `Edit ${draft.kind}`
                : draft?.kind
                  ? `New ${draft.kind}`
                  : 'What are you planning?'}
            </DialogTitle>
          </DialogHeader>
          {draft && !draft.kind ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {(['goal', 'task', 'milestone'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    openPlanningEditor({
                      kind,
                      goalId: draft.goalId,
                      taskId: draft.parentTaskId,
                      date: draft.start,
                      endDate: draft.end,
                    });
                    setDraft(null);
                  }}
                  className="rounded-xl border p-4 text-left capitalize hover:border-primary hover:bg-secondary"
                >
                  {kind}
                </button>
              ))}
            </div>
          ) : null}
          {draft?.kind ? (
            <form className="grid gap-4" onSubmit={saveDraft}>
              <label className="text-xs font-semibold">
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
              {draft.kind === 'goal' ? (
                <label className="text-xs font-semibold">
                  Why this matters
                  <textarea
                    value={draft.description ?? ''}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                    className="mt-1 min-h-20 w-full rounded-lg border bg-background p-3"
                  />
                </label>
              ) : null}
              {draft.kind !== 'milestone' ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-semibold">
                    Start
                    <input
                      type="date"
                      min="2000-01-01"
                      max="2200-12-31"
                      value={draft.start}
                      onChange={(event) =>
                        setDraft({ ...draft, start: event.target.value })
                      }
                      className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                    />
                  </label>
                  <label className="text-xs font-semibold">
                    Deadline
                    <input
                      type="date"
                      min={draft.start}
                      max="2200-12-31"
                      value={draft.end}
                      onChange={(event) =>
                        setDraft({ ...draft, end: event.target.value })
                      }
                      className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                    />
                  </label>
                </div>
              ) : (
                <label className="text-xs font-semibold">
                  Date
                  <input
                    type="date"
                    min="2000-01-01"
                    max="2200-12-31"
                    value={draft.start}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        start: event.target.value,
                        end: event.target.value,
                      })
                    }
                    className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                  />
                </label>
              )}
              {draft.kind !== 'goal' ? (
                <label className="text-xs font-semibold">
                  Goal
                  <RelationSelect
                    value={draft.goalId}
                    onChange={(event) =>
                      setDraft({ ...draft, goalId: event.target.value })
                    }
                    className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                  >
                    <option value="">Inbox — no goal</option>
                    {workspace.goals.map((goal) => (
                      <option key={goal.id} value={goal.id}>
                        {goal.title}
                      </option>
                    ))}
                  </RelationSelect>
                </label>
              ) : null}
              {draft.kind === 'task' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold">
                    Status
                    <RelationSelect
                      value={draft.statusId ?? ''}
                      onChange={(event) =>
                        setDraft({ ...draft, statusId: event.target.value })
                      }
                      className="mt-1 h-10 w-full rounded-lg border bg-background px-3 capitalize"
                    >
                      {workspace.statuses.map((status) => (
                        <option key={status.id} value={status.id}>
                          {status.category.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </RelationSelect>
                  </label>
                  <label className="text-xs font-semibold">
                    Priority
                    <RelationSelect
                      value={draft.priority ?? 'medium'}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          priority: event.target.value as Priority,
                        })
                      }
                      className="mt-1 h-10 w-full rounded-lg border bg-background px-3 capitalize"
                    >
                      {(['low', 'medium', 'high', 'urgent'] as Priority[]).map(
                        (priority) => (
                          <option key={priority} value={priority}>
                            {priority}
                          </option>
                        ),
                      )}
                    </RelationSelect>
                  </label>
                  <label className="text-xs font-semibold sm:col-span-2">
                    Link
                    <input
                      type="url"
                      value={draft.linkUrl ?? ''}
                      onChange={(event) =>
                        setDraft({ ...draft, linkUrl: event.target.value })
                      }
                      placeholder="https://…"
                      className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                    />
                  </label>
                </div>
              ) : null}
              <DialogFooter>
                {draft.id && draft.kind === 'milestone' ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void removeMilestone()}
                  >
                    Delete milestone
                  </Button>
                ) : null}
                <Button type="submit">Save</Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function buildRows(
  workspace: TimelineWorkspace,
  linkMap: Map<string, string>,
  collapsed: Set<string>,
) {
  const rows: Row[] = [];
  const activeGoals = new Set(workspace.goals.map((goal) => goal.id));
  const effectiveGoal = (task: Task) => {
    const id = linkMap.get(task.id);
    return id && activeGoals.has(id) ? id : null;
  };
  const append = (
    task: Task,
    goalId: string | null,
    depth: number,
    seen: Set<string>,
  ) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    rows.push({ kind: 'task', task, goalId, depth });
    workspace.tasks
      .filter(
        (item) =>
          item.parent_task_id === task.id && effectiveGoal(item) === goalId,
      )
      .forEach((child) => append(child, goalId, depth + 1, seen));
  };
  const appendGroup = (goalId: string | null) => {
    const tasks = workspace.tasks.filter(
        (task) => effectiveGoal(task) === goalId,
      ),
      ids = new Set(tasks.map((task) => task.id)),
      seen = new Set<string>();
    tasks
      .filter((task) => !task.parent_task_id || !ids.has(task.parent_task_id))
      .forEach((task) => append(task, goalId, 0, seen));
    // Legacy orphan/cyclic parents must not make active tasks disappear.
    tasks.forEach((task) => append(task, goalId, 0, seen));
  };
  for (const goal of workspace.goals) {
    rows.push({ kind: 'goal', goal });
    if (!collapsed.has(goal.id)) appendGroup(goal.id);
  }
  const inboxGoal: Goal = {
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
  rows.push({ kind: 'goal', goal: inboxGoal });
  if (!collapsed.has('inbox')) appendGroup(null);
  return rows;
}

function makeTimelineRange(
  start: Date,
  workspace: TimelineWorkspace,
  latestSeen: string,
  zoom: Zoom,
  extraDays: number,
) {
  const latest = latestTimelineDate(workspace, latestSeen);
  const endLimit = daysBetween(dateKey(start), '2201-01-01');
  const requestedDays =
    Math.max(minimumDays[zoom], daysBetween(dateKey(start), latest) + 30) +
    extraDays;
  return { start, days: Math.min(endLimit, requestedDays) };
}

function filterTimelineRows(
  rows: Row[],
  workspace: TimelineWorkspace,
  query: string,
) {
  if (!query.trim()) return rows;
  const goals = new Set<string>(),
    tasks = new Set<string>();
  for (const row of rows) {
    if (
      row.kind === 'goal' &&
      matchesSearch(
        query,
        row.goal.title,
        row.goal.description,
        ...workspace.milestones
          .filter((mark) => !mark.task_id && mark.goal_id === row.goal.id)
          .map((mark) => mark.title),
      )
    )
      goals.add(row.goal.id);
    if (
      row.kind === 'task' &&
      matchesSearch(
        query,
        row.task.title,
        ...workspace.milestones
          .filter((mark) => mark.task_id === row.task.id)
          .map((mark) => mark.title),
      )
    )
      tasks.add(row.task.id);
  }
  const contextGoals = new Set(goals);
  for (const row of rows)
    if (row.kind === 'task' && tasks.has(row.task.id)) {
      contextGoals.add(row.goalId ?? 'inbox');
      const visited = new Set<string>();
      let parent = row.task.parent_task_id;
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        tasks.add(parent);
        parent =
          workspace.tasks.find((task) => task.id === parent)?.parent_task_id ??
          null;
      }
    }
  return rows.filter((row) =>
    row.kind === 'goal'
      ? contextGoals.has(row.goal.id)
      : tasks.has(row.task.id) || goals.has(row.goalId ?? 'inbox'),
  );
}

function timelineRangeStart(workspace: TimelineWorkspace) {
  const dates = [
    ...workspace.goals.flatMap((goal) => [goal.starts_on, goal.ends_on]),
    ...workspace.tasks.flatMap((task) => [
      task.planned_start,
      deadlineKey(task),
    ]),
    ...workspace.milestones.map((item) => item.milestone_on),
  ].filter(Boolean) as string[];
  const earliest = [dateKey(new Date()), ...dates].sort((a, b) =>
    a.localeCompare(b),
  )[0];
  const start = addDays(new Date(`${earliest}T00:00:00`), -14);
  return start < new Date('2000-01-01T00:00:00')
    ? new Date('2000-01-01T00:00:00')
    : start;
}

function applyTimelinePlan(
  workspace: TimelineWorkspace,
  state: Drag,
  next: Preview,
): TimelineWorkspace {
  if (state.kind === 'goal')
    return {
      ...workspace,
      goals: workspace.goals.map((goal) =>
        goal.id === state.id
          ? { ...goal, starts_on: next.start, ends_on: next.end }
          : goal,
      ),
    };
  if (state.kind === 'task')
    return {
      ...workspace,
      tasks: workspace.tasks.map((task) =>
        task.id === state.id
          ? {
              ...task,
              planned_start: next.start,
              due_at: deadlineIso(next.end),
              planned_end: null,
            }
          : task,
      ),
    };
  return {
    ...workspace,
    milestones: workspace.milestones.map((milestone) =>
      milestone.id === state.id
        ? { ...milestone, milestone_on: next.start }
        : milestone,
    ),
  };
}
