'use client';
import './timeline.css';
/* oxlint-disable react/react-compiler -- Pointer capture, virtual focus and frozen drag layouts bridge imperative browser state. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The focusable resizable separator is an interactive widget, rather than a static hr. */
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
  Flag,
  PanelLeftClose,
  PanelLeftOpen,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TaskLink } from '@/components/task-link';
import { openPlanningEditor } from '@/components/planning-editor';
import { useShortcutActions } from '@/components/keyboard-shortcuts';
import { addDays, dateKey, daysBetween, shiftDateKey } from '@/lib/calendar';
import {
  goalColorValue,
  milestoneColorValue,
  neutralChecklistColor,
} from '@/lib/colors';
import {
  getErrorMessage,
  getPlanningRepository,
  type Goal,
  type Task,
  type TimelineMilestone,
  type TimelineWorkspace,
} from '@/lib/data/repository';
import {
  listHolidays,
  listAnnotations,
  type Holiday,
} from '@/lib/data/workspace-extras';
import {
  announceDataChanged,
  dataChangeSource,
  MYPLAN_DATA_CHANGED,
} from '@/lib/data/data-events';
import { readSettledPlanning } from '@/lib/undo-manager';
import {
  buildTimelineRows,
  type TimelineOutlineRow,
} from '@/lib/timeline-outline';
import {
  buildTimelineLayout,
  indexTimeline,
  visibleTimelineRows,
  timelineTreeGuides,
  type TaskLayout,
  type TimelineLayoutRow,
} from '@/lib/timeline-layout';
import {
  TIMELINE_DAY_WIDTHS,
  TIMELINE_ZOOMS,
  createTimelineLoadGuard,
  restoreTimelineEntity,
  timelineEdgeSpeed,
  timelineWheelStep,
  timelineZoomScroll,
  type TimelineZoom,
} from '@/lib/timeline-interactions';
import {
  collectTimelineLabels,
  syncTimelineLabels,
  type TimelineLabel,
} from '@/lib/timeline-labels';
import {
  quantizeTimelineViewport,
  timelineDayWindow,
} from '@/lib/timeline-scroll';
import { matchesPlanningSearch } from '@/lib/planning-context';
import { timelineTodayScrollLeft } from '@/lib/planning-viewport';
import { guardPlanningPointer } from '@/lib/pointer-actions';
import { safeTaskLink } from '@/lib/task-links';
import {
  milestoneMarkerWidth,
  type MilestoneCluster,
} from '@/lib/workspace-view';

type Kind = 'goal' | 'task' | 'milestone';
type Plan = { start: string; end: string };
type Preview = Plan & { kind: Kind; id: string };
type Drag = Plan & {
  kind: Kind;
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  mode: 'move' | 'resize-start' | 'resize-end';
  activated: boolean;
  axis?: 'horizontal' | 'vertical';
  before: Goal | Task | TimelineMilestone;
};
type Creation = {
  row: TimelineLayoutRow;
  task?: Task;
  pointerId: number;
  day: number;
};
type Selection = { kind: 'goal' | 'task'; id: string };
const EMPTY: TimelineWorkspace = {
  goals: [],
  tasks: [],
  links: [],
  milestones: [],
  statuses: [],
};
const MINIMUM_DAYS = { week: 56, month: 180, quarter: 540, year: 1095 };
const HEADER_HEIGHT = 48;
const deadlineKey = (task: Task) =>
  task.due_at?.slice(0, 10) ?? task.planned_end;
const deadlineIso = (day: string) =>
  new Date(`${day}T23:59:00+07:00`).toISOString();

export function TimelinePanelV2() {
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<TimelineWorkspace>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [zoom, setZoom] = useState<TimelineZoom>(() => {
    const saved = readPreference('myplan-timeline-zoom');
    return TIMELINE_ZOOMS.includes(saved as TimelineZoom)
      ? (saved as TimelineZoom)
      : 'month';
  });
  const [outlineOpen, setOutlineOpen] = useState(
    () => readPreference('myplan-timeline-outline') !== 'closed',
  );
  const [outlineWidth, setOutlineWidth] = useState(() => {
    const saved = Number(readPreference('myplan-timeline-outline-width'));
    return saved ? Math.min(360, Math.max(220, saved)) : 240;
  });
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [collapsedTasks, setCollapsedTasks] = useState(new Set<string>());
  const [query, setQuery] = useState('');
  const [importantOnly, setImportantOnly] = useState(false);
  const [rangeStart, setRangeStart] = useState<Date | null>(null);
  const [extraDays, setExtraDays] = useState(0);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [moving, setMoving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dropId, setDropId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cluster, setCluster] = useState<{
    items: TimelineMilestone[];
    label: string;
  } | null>(null);
  const [choice, setChoice] = useState<{
    goalId?: string;
    taskId?: string;
    date: string;
    endDate: string;
  } | null>(null);
  const [viewport, setViewport] = useState({
    left: 0,
    top: 0,
    width: 1600,
    height: 600,
  });
  const boardRef = useRef<HTMLDivElement>(null);
  const renderViewportRef = useRef(viewport);
  const labelRegistryRef = useRef<TimelineLabel[]>([]);
  const outlinePixelsRef = useRef(outlineOpen ? outlineWidth : 0);
  const previousScrollLeftRef = useRef(0);
  const chartRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const creationRef = useRef<Creation | null>(null);
  const busyRef = useRef(false);
  const frozenRef = useRef<TimelineWorkspace | null>(null);
  const pinnedRowRef = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const edgeFrameRef = useRef<number | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const guardRef = useRef(createTimelineLoadGuard());
  const noteRequests = useRef(new Set<string>());
  const noteRevision = useRef(0);
  const mountedRef = useRef(false);
  const readingRef = useRef(0);
  const cancelRef = useRef<() => void>(() => {});
  const holidayCache = useRef<Promise<Holiday[] | null> | null>(null);
  const deferredLoad = useRef(false);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const positioned = useRef(false);
  const pendingScroll = useRef<number | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);

  const load = useCallback(async () => {
    if (!repository) {
      setLoading(false);
      return;
    }
    if (busyRef.current || dragRef.current || creationRef.current) {
      deferredLoad.current = true;
      return;
    }
    const current = guardRef.current.begin();
    readingRef.current++;
    try {
      holidayCache.current ??= listHolidays().catch(() => {
        holidayCache.current = null;
        return null;
      });
      void holidayCache.current.then((daysOff) => {
        if (daysOff && current()) setHolidays(daysOff);
      });
      const next = await readSettledPlanning(() =>
        repository.getTimelineWorkspace({ includeChecklistCounts: false }),
      );
      if (!current()) return;
      if (busyRef.current || dragRef.current || creationRef.current) {
        deferredLoad.current = true;
        return;
      }
      const earliest = timelineRangeStart(next);
      setRangeStart((old) => {
        if (!old || earliest >= old) return old ?? earliest;
        pendingScroll.current =
          (boardRef.current?.scrollLeft ?? 0) +
          daysBetween(dateKey(earliest), dateKey(old)) *
            TIMELINE_DAY_WIDTHS[zoom];
        return earliest;
      });
      setWorkspace(next);
      setMessage('');
    } catch (error) {
      if (current()) setMessage(getErrorMessage(error));
    } finally {
      readingRef.current--;
      if (current()) setLoading(false);
    }
  }, [repository, zoom]);
  useLayoutEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    const loadGuard = createTimelineLoadGuard();
    guardRef.current = loadGuard;
    mountedRef.current = true;
    const invalidateNotes = () => {
      noteRevision.current++;
    };
    const timer = window.setTimeout(() => void loadRef.current(), 0);
    const sync = (event: Event) => {
      const source = dataChangeSource(event);
      if (source === 'timeline') return;
      guardRef.current.invalidate();
      if ((dragRef.current || creationRef.current) && !busyRef.current) {
        deferredLoad.current = false;
        cancelRef.current();
      }
      if (source === 'holidays') holidayCache.current = null;
      if (source === 'annotations') {
        noteRevision.current++;
        setNotes({});
        noteRequests.current.clear();
      }
      void loadRef.current();
    };
    const focus = () => {
      if (document.visibilityState === 'visible') void loadRef.current();
    };
    const blur = () => {
      if (!busyRef.current && (dragRef.current || creationRef.current))
        cancelRef.current();
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.clearTimeout(timer);
      loadGuard.dispose();
      mountedRef.current = false;
      invalidateNotes();
      window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', focus);
      for (const ref of [frameRef, viewportFrameRef, edgeFrameRef])
        if (ref.current !== null) window.cancelAnimationFrame(ref.current);
    };
  }, [repository]);
  useEffect(() => {
    writePreference('myplan-timeline-zoom', zoom);
  }, [zoom]);
  useEffect(() => {
    writePreference('myplan-timeline-outline', outlineOpen ? 'open' : 'closed');
  }, [outlineOpen]);
  useEffect(() => {
    writePreference('myplan-timeline-outline-width', String(outlineWidth));
  }, [outlineWidth]);

  const layoutWorkspace = frozenRef.current ?? workspace;
  const index = useMemo(
    () => indexTimeline(layoutWorkspace, importantOnly),
    [layoutWorkspace, importantOnly],
  );
  const links = useMemo(
    () =>
      new Map(
        layoutWorkspace.links.map((link) => [link.task_id, link.goal_id]),
      ),
    [layoutWorkspace.links],
  );
  const outlineRows = useMemo(
    () =>
      filterTimelineRows(
        buildTimelineRows(
          layoutWorkspace,
          links,
          query.trim() ? new Set() : collapsed,
          query.trim() ? new Set() : collapsedTasks,
        ),
        layoutWorkspace,
        query,
      ),
    [layoutWorkspace, links, collapsed, collapsedTasks, query],
  );
  const origin = useMemo(
    () => rangeStart ?? timelineRangeStart(layoutWorkspace),
    [rangeStart, layoutWorkspace],
  );
  const originKey = dateKey(origin),
    dayWidth = TIMELINE_DAY_WIDTHS[zoom];
  const rangeDays = useMemo(
    () =>
      Math.min(
        daysBetween(originKey, '2201-01-01'),
        Math.max(
          MINIMUM_DAYS[zoom],
          daysBetween(originKey, latestTimelineDate(layoutWorkspace)) + 30,
        ) + extraDays,
      ),
    [originKey, layoutWorkspace, zoom, extraDays],
  );
  const chartWidth = rangeDays * dayWidth;
  const layout = useMemo(
    () =>
      buildTimelineLayout(
        outlineRows,
        index,
        originKey,
        dayWidth,
        !outlineOpen,
      ),
    [outlineRows, index, originKey, dayWidth, outlineOpen],
  );
  const goalPlans = useMemo(() => {
    const plans = new Map<
      string,
      { start: string | null; end: string | null }
    >();
    for (const goal of layoutWorkspace.goals)
      plans.set(goal.id, { start: goal.starts_on, end: goal.ends_on });
    for (const task of layoutWorkspace.tasks) {
      const id = links.get(task.id);
      if (!id) continue;
      const goal = index.goalsById.get(id),
        plan = plans.get(id);
      if (!goal || !plan || (goal.starts_on && goal.ends_on)) continue;
      if (
        task.planned_start &&
        (!plan.start || task.planned_start < plan.start)
      )
        plan.start = task.planned_start;
      const end = deadlineKey(task);
      if (end && (!plan.end || end > plan.end)) plan.end = end;
    }
    return plans;
  }, [layoutWorkspace, links, index.goalsById]);
  const tree = useMemo(() => timelineTreeGuides(outlineRows), [outlineRows]);
  const visibleWindow = visibleTimelineRows(
    layout.rows,
    viewport.top,
    viewport.height - HEADER_HEIGHT,
  );
  const rowByItem = useMemo(() => {
    const map = new Map<string, TimelineLayoutRow>();
    for (const row of layout.rows) {
      if (row.goal) map.set(`goal:${row.goal.id}`, row);
      for (const task of row.tasks) {
        map.set(`task:${task.row.task.id}`, row);
        for (const marker of task.milestones)
          map.set(`milestone:${marker.id}`, row);
      }
      if (row.goal)
        for (const marker of row.milestones)
          map.set(`milestone:${marker.id}`, row);
    }
    return map;
  }, [layout.rows]);
  const renderedRows = useMemo(() => {
    const result = new Map(
      layout.rows
        .slice(visibleWindow.start, visibleWindow.end)
        .map((row) => [row.key, row]),
    );
    const pinned = pinnedRowRef.current;
    if (pinned) {
      const row = layout.rows.find((item) => item.key === pinned);
      if (row) result.set(pinned, row);
    }
    if (selection) {
      const row = rowByItem.get(`${selection.kind}:${selection.id}`);
      if (row) result.set(row.key, row);
    }
    return [...result.values()].sort((a, b) => a.top - b.top);
  }, [
    layout.rows,
    visibleWindow.start,
    visibleWindow.end,
    selection,
    rowByItem,
  ]);
  const navigation = useMemo(
    () =>
      layout.rows.flatMap<Selection>((row) =>
        row.goal
          ? [{ kind: 'goal' as const, id: row.goal.id }]
          : row.tasks.map((task) => ({
              kind: 'task' as const,
              id: task.row.task.id,
            })),
      ),
    [layout.rows],
  );

  function updateViewport() {
    const board = boardRef.current;
    if (!board) return;
    const next = quantizeTimelineViewport({
      left: board.scrollLeft,
      top: board.scrollTop,
      width: board.clientWidth,
      height: board.clientHeight,
    });
    syncTimelineLabels(
      labelRegistryRef.current,
      board.scrollLeft,
      board.clientWidth,
      outlinePixelsRef.current,
    );
    const old = renderViewportRef.current;
    if (
      old.left === next.left &&
      old.top === next.top &&
      old.width === next.width &&
      old.height === next.height
    )
      return;
    renderViewportRef.current = next;
    setViewport(next);
  }
  useLayoutEffect(() => {
    outlinePixelsRef.current = outlineOpen ? outlineWidth : 0;
    const board = boardRef.current;
    if (!board) return;
    labelRegistryRef.current = collectTimelineLabels(board);
    syncTimelineLabels(
      labelRegistryRef.current,
      board.scrollLeft,
      board.clientWidth,
      outlinePixelsRef.current,
    );
  });
  function queueViewport() {
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = window.requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      updateViewport();
    });
  }
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const observer = new ResizeObserver(queueViewport);
    observer.observe(board);
    queueViewport();
    return () => observer.disconnect();
  }, [loading]);
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    if (pendingScroll.current !== null) {
      board.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
      updateViewport();
    }
    if (!loading && !positioned.current) {
      positioned.current = true;
      board.scrollLeft = timelineTodayScrollLeft(
        daysBetween(originKey, dateKey(new Date())) * dayWidth,
        board.clientWidth,
        outlineOpen ? outlineWidth : 0,
      );
      updateViewport();
    }
    const maximum = Math.max(
      0,
      layout.totalHeight + HEADER_HEIGHT - board.clientHeight,
    );
    if (board.scrollTop > maximum) {
      board.scrollTop = maximum;
      updateViewport();
    }
  }, [
    loading,
    originKey,
    dayWidth,
    outlineOpen,
    outlineWidth,
    layout.totalHeight,
  ]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const element = boardRef.current?.querySelector<HTMLElement>(
      `[data-timeline-focus="${pendingFocus.current}"]`,
    );
    if (element) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }, [selection, renderedRows, outlineOpen]);
  function extendEarlier() {
    const count = Math.min(90, daysBetween('2000-01-01', originKey));
    if (count <= 0) return;
    pendingScroll.current =
      (boardRef.current?.scrollLeft ?? 0) + count * dayWidth;
    setRangeStart(addDays(origin, -count));
  }
  function extendLater() {
    if (rangeDays < daysBetween(originKey, '2201-01-01'))
      setExtraDays((value) => value + 90);
  }
  function goToday() {
    const board = boardRef.current;
    if (!board) return;
    board.scrollLeft = timelineTodayScrollLeft(
      daysBetween(originKey, dateKey(new Date())) * dayWidth,
      board.clientWidth,
      outlineOpen ? outlineWidth : 0,
    );
    queueViewport();
  }
  function changeZoom(next: TimelineZoom, clientX?: number) {
    if (
      next === zoom ||
      dragRef.current ||
      creationRef.current ||
      busyRef.current
    )
      return;
    const board = boardRef.current;
    if (board) {
      const outline = outlineOpen ? outlineWidth : 0;
      pendingScroll.current = timelineZoomScroll(
        board.scrollLeft,
        clientX === undefined
          ? outline + (board.clientWidth - outline) / 2
          : clientX - board.getBoundingClientRect().left,
        outline,
        dayWidth,
        TIMELINE_DAY_WIDTHS[next],
      );
    }
    setZoom(next);
  }
  const wheelRuntime = useRef({ zoom, changeZoom });
  useLayoutEffect(() => {
    wheelRuntime.current = { zoom, changeZoom };
  });
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    let wheel = { delta: 0, time: 0 };
    const listener = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const now = performance.now();
      const result = timelineWheelStep(
        wheel,
        event.deltaY,
        event.deltaMode,
        now,
      );
      wheel = result.state;
      if (!result.step) return;
      const runtime = wheelRuntime.current;
      runtime.changeZoom(
        TIMELINE_ZOOMS[
          Math.max(
            0,
            Math.min(
              TIMELINE_ZOOMS.length - 1,
              TIMELINE_ZOOMS.indexOf(runtime.zoom) + result.step,
            ),
          )
        ],
        event.clientX,
      );
    };
    board.addEventListener('wheel', listener, { passive: false });
    return () => board.removeEventListener('wheel', listener);
  }, [loading]);

  function toggleGoal(id: string) {
    setCollapsed((old) => toggleSet(old, id));
  }
  function toggleTask(id: string) {
    setCollapsedTasks((old) => toggleSet(old, id));
  }
  function selectRelative(direction: number) {
    const current = selection
      ? navigation.findIndex(
          (item) => item.id === selection.id && item.kind === selection.kind,
        )
      : -1;
    const next =
      navigation[
        Math.max(
          0,
          Math.min(
            navigation.length - 1,
            current < 0 ? 0 : current + direction,
          ),
        )
      ];
    if (!next) return;
    const row = rowByItem.get(`${next.kind}:${next.id}`),
      board = boardRef.current;
    if (row && board) {
      if (row.top < board.scrollTop) board.scrollTop = row.top;
      else if (
        row.top + row.height >
        board.scrollTop + board.clientHeight - HEADER_HEIGHT
      )
        board.scrollTop =
          row.top + row.height + HEADER_HEIGHT - board.clientHeight;
      const task = row.tasks.find((item) => item.row.task.id === next.id);
      if (
        !outlineOpen &&
        task &&
        (task.left + task.width < board.scrollLeft ||
          task.left > board.scrollLeft + board.clientWidth)
      )
        board.scrollLeft = task.left;
      queueViewport();
    }
    pendingFocus.current = `${next.kind}:${next.id}`;
    setSelection(next);
  }
  const selectedTask =
    selection?.kind === 'task' ? index.tasksById.get(selection.id) : undefined;
  useShortcutActions({
    selectPrevious: {
      enabled: () => !moving && !dragging && navigation.length > 0,
      run: () => selectRelative(-1),
    },
    selectNext: {
      enabled: () => !moving && !dragging && navigation.length > 0,
      run: () => selectRelative(1),
    },
    edit: {
      enabled: () =>
        !moving &&
        !dragging &&
        !!selection &&
        selection.id !== 'inbox' &&
        rowByItem.has(`${selection.kind}:${selection.id}`),
      run: () => {
        if (selection) openPlanningEditor(selection);
      },
    },
    openLink: {
      enabled: () =>
        !moving &&
        !dragging &&
        !!selection &&
        rowByItem.has(`task:${selection.id}`) &&
        !!safeTaskLink(selectedTask),
      run: () => {
        const url = safeTaskLink(selectedTask);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    collapse: {
      enabled: () =>
        !moving &&
        !dragging &&
        !query.trim() &&
        !!selection &&
        (selection.kind === 'goal' ||
          (outlineOpen &&
            (layout.plansByTaskId.get(selection.id)?.row.hasChildren ??
              false))),
      run: () => {
        if (selection?.kind === 'goal') toggleGoal(selection.id);
        else if (selection) toggleTask(selection.id);
      },
    },
    create: {
      enabled: () => !moving && !dragging,
      run: () => openPlanningEditor({ kind: 'milestone' }),
    },
    previous: { enabled: () => !moving && !dragging, run: extendEarlier },
    next: { enabled: () => !moving && !dragging, run: extendLater },
    today: { enabled: () => !moving && !dragging, run: goToday },
    cancel: { enabled: () => dragging && !moving, run: () => cancelGesture() },
  });

  function milestoneNotes(id: string) {
    if (noteRequests.current.has(id)) return;
    noteRequests.current.add(id);
    const revision = noteRevision.current;
    void listAnnotations({ kind: 'milestone', id })
      .then((items) => {
        if (!mountedRef.current || revision !== noteRevision.current) return;
        setNotes((old) => ({
          ...old,
          [id]: items
            .filter((item) => item.kind === 'comment')
            .slice(-3)
            .map((item) => item.body)
            .join('\n'),
        }));
      })
      .catch(() => {
        if (revision === noteRevision.current) noteRequests.current.delete(id);
      });
  }
  function beginGesture(row: TimelineLayoutRow) {
    if (readingRef.current > 0) deferredLoad.current = true;
    guardRef.current.invalidate();
    frozenRef.current = workspace;
    pinnedRowRef.current = row.key;
    setDragging(true);
    setMessage('');
  }
  function startDrag(
    event: React.PointerEvent<HTMLElement>,
    row: TimelineLayoutRow,
    kind: Kind,
    id: string,
    plan: Plan,
    mode: Drag['mode'],
  ) {
    if (busyRef.current || dragRef.current || creationRef.current) return;
    const before =
      kind === 'task'
        ? index.tasksById.get(id)
        : kind === 'goal'
          ? index.goalsById.get(id)
          : workspace.milestones.find((item) => item.id === id);
    if (!before) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginGesture(row);
    pointerRef.current = { x: event.clientX, y: event.clientY };
    dragRef.current = {
      ...plan,
      kind,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: boardRef.current?.scrollLeft ?? 0,
      mode,
      activated: false,
      before,
    };
  }
  function dragPlan(state: Drag): Preview {
    const dx =
      pointerRef.current.x -
      state.startX +
      (boardRef.current?.scrollLeft ?? 0) -
      state.scrollLeft;
    const delta = Math.round(dx / dayWidth);
    let { start, end } = state;
    if (state.mode === 'move' && state.axis !== 'vertical') {
      start = shiftDateKey(start, delta);
      end = shiftDateKey(end, delta);
    }
    if (state.mode === 'resize-start')
      start = shiftDateKey(start, Math.min(delta, daysBetween(start, end)));
    if (state.mode === 'resize-end')
      end = shiftDateKey(end, Math.max(delta, -daysBetween(start, end)));
    return { kind: state.kind, id: state.id, start, end };
  }
  function findDropTarget() {
    return (
      document
        .elementFromPoint(pointerRef.current.x, pointerRef.current.y)
        ?.closest<HTMLElement>('[data-timeline-drop]') ?? null
    );
  }
  function updatePreview() {
    const state = dragRef.current;
    if (!state?.activated) return;
    const next = dragPlan(state);
    setPreview((old) =>
      old?.id === next.id &&
      old.kind === next.kind &&
      old.start === next.start &&
      old.end === next.end
        ? old
        : next,
    );
    setDropId(
      state.axis === 'vertical'
        ? (findDropTarget()?.dataset.timelineDrop ?? null)
        : null,
    );
  }
  function queuePreview() {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updatePreview();
    });
  }
  function startEdgeScroll() {
    if (edgeFrameRef.current !== null) return;
    const tick = () => {
      edgeFrameRef.current = null;
      const board = boardRef.current,
        state = dragRef.current;
      if (!board || (!state?.activated && !creationRef.current)) return;
      const rect = board.getBoundingClientRect(),
        horizontal = !state || state.axis !== 'vertical';
      const dx = horizontal
        ? timelineEdgeSpeed(
            pointerRef.current.x,
            rect.left + (outlineOpen ? outlineWidth : 0),
            rect.right,
          )
        : 0;
      const dy = timelineEdgeSpeed(
        pointerRef.current.y,
        rect.top + HEADER_HEIGHT,
        rect.bottom,
      );
      if (dx || dy) {
        board.scrollLeft += dx;
        board.scrollTop += dy;
        queueViewport();
        queuePreview();
      }
      edgeFrameRef.current = window.requestAnimationFrame(tick);
    };
    edgeFrameRef.current = window.requestAnimationFrame(tick);
  }
  function pointerMove(event: React.PointerEvent) {
    const gesture = dragRef.current ?? creationRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    const state = dragRef.current;
    if (state && !state.activated) {
      const dx = Math.abs(event.clientX - state.startX),
        dy = Math.abs(event.clientY - state.startY);
      if (Math.max(dx, dy) < 4) return;
      state.activated = true;
      state.axis =
        outlineOpen &&
        state.mode === 'move' &&
        state.kind !== 'milestone' &&
        dy > dx
          ? 'vertical'
          : 'horizontal';
    }
    queuePreview();
    startEdgeScroll();
  }
  function clearFrames() {
    for (const ref of [frameRef, edgeFrameRef])
      if (ref.current !== null) {
        window.cancelAnimationFrame(ref.current);
        ref.current = null;
      }
  }
  function releaseGesture() {
    clearFrames();
    dragRef.current = null;
    creationRef.current = null;
    pinnedRowRef.current = null;
    frozenRef.current = null;
    setDragging(false);
    setPreview(null);
    setDropId(null);
    if (!busyRef.current && deferredLoad.current) {
      deferredLoad.current = false;
      void loadRef.current();
    }
  }
  function cancelGesture(event?: React.PointerEvent) {
    const state = dragRef.current ?? creationRef.current;
    if (event && state?.pointerId !== event.pointerId) return;
    releaseGesture();
  }
  useLayoutEffect(() => {
    cancelRef.current = () => cancelGesture();
  });
  async function mutate(
    action: () => Promise<void>,
    optimistic?: () => void,
    rollback?: () => void,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    guardRef.current.invalidate();
    setMoving(true);
    setMessage('');
    optimistic?.();
    let succeeded = false;
    try {
      await action();
      succeeded = true;
      announceDataChanged('timeline');
    } catch (error) {
      if (mountedRef.current) {
        rollback?.();
        setMessage(getErrorMessage(error));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setMoving(false);
        if (succeeded) deferredLoad.current = true;
        releaseGesture();
      }
    }
  }
  async function pointerUp(event: React.PointerEvent) {
    const gesture = dragRef.current ?? creationRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    clearFrames();
    const state = dragRef.current;
    if (state) {
      const next = dragPlan(state);
      if (state.activated) setPreview(next);
      if (!state.activated) {
        releaseGesture();
        if (!(state.kind === 'goal' && state.id === 'inbox'))
          openPlanningEditor({ kind: state.kind, id: state.id });
        return;
      }
      if (state.axis === 'vertical') {
        const target = findDropTarget(),
          targetId = target?.dataset.timelineId;
        if (!target || !targetId || targetId === state.id || !repository) {
          cancelGesture();
          return;
        }
        const goalId = target.dataset.timelineGoal || null,
          oldGoal = links.get(state.id) ?? null;
        if (
          state.kind === 'task' &&
          goalId !== oldGoal &&
          !window.confirm(
            `Move “${(state.before as Task).title}” to ${index.goalsById.get(goalId ?? '')?.title ?? 'Inbox'}? Its child tasks stay in the original Goal.`,
          )
        ) {
          cancelGesture();
          return;
        }
        await mutate(() =>
          repository.reorderTimeline({
            kind: state.kind === 'goal' ? 'goal' : 'task',
            id: state.id,
            goal_id: state.kind === 'task' ? goalId : undefined,
            before_id:
              state.kind === 'goal'
                ? target.dataset.timelineKind === 'goal'
                  ? targetId
                  : goalId
                : target.dataset.timelineKind === 'task'
                  ? targetId
                  : null,
          }),
        );
        return;
      }
      if (
        !repository ||
        (state.start === next.start && state.end === next.end)
      ) {
        cancelGesture();
        return;
      }
      await mutate(
        async () => {
          if (state.kind === 'task') {
            const before = state.before as Task;
            if (state.mode === 'move')
              await repository.moveTimelineTask(state.id, {
                days: daysBetween(state.start, next.start),
                goal_id: links.get(state.id) ?? null,
                expected_goal: links.get(state.id) ?? null,
                expected_parent: before.parent_task_id,
                expected_start: before.planned_start,
                expected_due: before.due_at,
              });
            else
              await repository.updateTask(state.id, {
                planned_start: next.start,
                due_at: deadlineIso(next.end),
                planned_end: null,
              });
          } else if (state.kind === 'goal')
            await repository.updateGoal(state.id, {
              starts_on: next.start,
              ends_on: next.end,
            });
          else
            await repository.updateTimelineMilestone(state.id, {
              milestone_on: next.start,
            });
        },
        () => setWorkspace((current) => applyPlan(current, next)),
        () =>
          setWorkspace((current) =>
            restoreTimelineEntity(current, state.kind, state.before),
          ),
      );
      return;
    }
    const creation = creationRef.current,
      chart = chartRef.current;
    if (!creation || !chart) {
      cancelGesture();
      return;
    }
    const lastDay = Math.min(
      rangeDays - 1,
      Math.max(
        0,
        Math.round(
          (event.clientX - chart.getBoundingClientRect().left) / dayWidth,
        ),
      ),
    );
    const start = dateKey(addDays(origin, Math.min(creation.day, lastDay))),
      end = dateKey(addDays(origin, Math.max(creation.day, lastDay))),
      task = creation.task;
    if (task && (!task.planned_start || !deadlineKey(task)) && repository) {
      await mutate(
        () =>
          repository.updateTask(task.id, {
            planned_start: start,
            due_at: deadlineIso(end),
            planned_end: null,
          }),
        () =>
          setWorkspace((current) =>
            applyPlan(current, { kind: 'task', id: task.id, start, end }),
          ),
        () =>
          setWorkspace((current) =>
            restoreTimelineEntity(current, 'task', task),
          ),
      );
    } else {
      const goalId =
        creation.row.goal?.id ??
        (task ? links.get(task.id) : creation.row.tasks[0]?.row.goalId);
      releaseGesture();
      setChoice({
        goalId: goalId === 'inbox' ? undefined : (goalId ?? undefined),
        taskId: task?.id,
        date: start,
        endDate: end,
      });
    }
  }
  function startCreation(
    event: React.PointerEvent<HTMLDivElement>,
    row: TimelineLayoutRow,
  ) {
    if (
      busyRef.current ||
      dragRef.current ||
      creationRef.current ||
      (event.target as HTMLElement).closest('[data-bar]')
    )
      return;
    const chart = chartRef.current;
    if (!chart) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    beginGesture(row);
    pointerRef.current = { x: event.clientX, y: event.clientY };
    creationRef.current = {
      row,
      task: outlineOpen ? row.tasks[0]?.row.task : undefined,
      pointerId: event.pointerId,
      day: Math.min(
        rangeDays - 1,
        Math.max(
          0,
          Math.round(
            (event.clientX - chart.getBoundingClientRect().left) / dayWidth,
          ),
        ),
      ),
    };
  }
  const visibleDays = useMemo(() => {
    const { first, end } = timelineDayWindow(
      rangeDays,
      dayWidth,
      viewport.left,
      viewport.width,
    );
    return Array.from({ length: Math.max(0, end - first) }, (_, i) => {
      const offset = first + i,
        day = addDays(origin, offset),
        key = dateKey(day),
        holiday = holidays.filter(
          (item) => item.starts_on <= key && item.ends_on >= key,
        );
      return {
        offset,
        day,
        key,
        holiday,
        title: [
          day.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
          ...holiday.map((item) => item.title),
        ].join('\n'),
      };
    });
  }, [origin, rangeDays, dayWidth, viewport.left, viewport.width, holidays]);
  const todayLeft = daysBetween(originKey, dateKey(new Date())) * dayWidth,
    isFrozen = dragging || moving;
  function barGeometry(start: string, end: string, task: boolean) {
    const inset = task && !outlineOpen ? 2 : 0;
    return {
      left: daysBetween(originKey, start) * dayWidth + inset,
      width: Math.max(10, (daysBetween(start, end) + 1) * dayWidth - inset * 2),
    };
  }
  function renderBar(
    row: TimelineLayoutRow,
    kind: 'goal' | 'task',
    entity: Goal | Task,
    original: { start: string | null; end: string | null },
    color: string,
    baseColor: string,
  ) {
    const plan =
      preview?.kind === kind && preview.id === entity.id ? preview : original;
    if (!plan.start || !plan.end || (kind === 'goal' && entity.id === 'inbox'))
      return null;
    const { left, width } = barGeometry(plan.start, plan.end, kind === 'task');
    const showTitle = kind === 'goal' || !outlineOpen,
      top = row.height - (kind === 'goal' ? 46 : 31),
      task = kind === 'task' ? (entity as Task) : null;
    const selected = selection?.kind === kind && selection.id === entity.id;
    return (
      <div
        key={`bar:${entity.id}`}
        data-bar
        data-timeline-select={`${kind}:${entity.id}`}
        data-timeline-label={showTitle ? true : undefined}
        data-timeline-label-left={left}
        data-timeline-label-width={width}
        data-timeline-link-fit="false"
        className="timeline-bar group/task absolute"
        style={{ left, top, width, height: kind === 'goal' ? 36 : 22 }}
      >
        <button
          type="button"
          data-bar
          data-timeline-focus={outlineOpen ? undefined : `${kind}:${entity.id}`}
          aria-label={`Edit ${kind} ${entity.title}`}
          title={`${entity.title}\n${plan.start} → ${plan.end}`}
          className={`absolute inset-0 touch-none rounded-md border text-[10px] font-semibold shadow-sm hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selected ? 'ring-2 ring-primary/60' : ''}`}
          style={{
            background: color,
            borderColor: baseColor,
            color: kind === 'goal' ? 'white' : undefined,
          }}
          onPointerDown={(event) =>
            startDrag(event, row, kind, entity.id, plan as Plan, 'move')
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openPlanningEditor({ kind, id: entity.id });
            }
          }}
        >
          <span
            className="absolute inset-y-0 left-0 z-20 cursor-ew-resize"
            style={{ width: Math.min(6, width / 3) }}
            onPointerDown={(event) =>
              startDrag(
                event,
                row,
                kind,
                entity.id,
                plan as Plan,
                'resize-start',
              )
            }
          />
          <span
            className="absolute inset-y-0 right-0 z-20 cursor-ew-resize rounded-r bg-black/15"
            style={{ width: Math.min(6, width / 3) }}
            onPointerDown={(event) =>
              startDrag(event, row, kind, entity.id, plan as Plan, 'resize-end')
            }
          />
        </button>
        {showTitle ? (
          <div
            className="timeline-label-clip"
            style={{ color: kind === 'goal' ? 'white' : undefined }}
          >
            <div className="timeline-sticky-anchor">
              <div className="timeline-label-content">
                <span
                  aria-hidden="true"
                  className="min-w-0 flex-1 truncate text-[10px] font-semibold"
                >
                  {entity.title}
                </span>
                {task && safeTaskLink(task) ? (
                  <TaskLink
                    task={task}
                    className="timeline-label-inline-link pointer-events-auto relative z-30 !min-h-5 !min-w-5 !p-0.5"
                  />
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {task && !outlineOpen && safeTaskLink(task) ? (
          <div className="timeline-sticky-anchor z-40">
            <div
              data-bar
              className="timeline-narrow-popup pointer-events-auto absolute top-full z-40 hidden w-64 items-center gap-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md group-hover/task:flex group-focus-within/task:flex"
              style={{
                transform: 'translateX(var(--timeline-popup-shift, 0px))',
              }}
            >
              <span className="min-w-0 flex-1 break-words text-xs">
                {task.title}
              </span>
              <TaskLink task={task} />
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  function renderMarkers(
    row: TimelineLayoutRow,
    clusters: MilestoneCluster<TimelineMilestone>[],
    label: string,
    inherited: string,
  ) {
    return clusters
      .filter(
        (group) =>
          group.items.some((item) => item.id === dragRef.current?.id) ||
          (daysBetween(originKey, group.day) * dayWidth + group.width >=
            viewport.left - 240 &&
            daysBetween(originKey, group.day) * dayWidth <=
              viewport.left + viewport.width + 240),
      )
      .map((group) => {
        if (group.items.length > 1) {
          const important = group.items.some((item) => item.is_important);
          return (
            <button
              key={`cluster:${group.items[0].id}`}
              type="button"
              data-bar
              aria-label={`Open ${group.items.length} milestones for ${label}${important ? ' (Important)' : ''}`}
              title={`${group.items.length} milestones · ${label}`}
              className={`absolute top-0.5 z-10 flex h-7 items-center justify-center gap-1 rounded-md border bg-card text-xs font-semibold shadow-sm hover:bg-muted ${important ? 'border-2 border-foreground/70' : ''}`}
              style={{
                left: daysBetween(originKey, group.day) * dayWidth,
                width: group.width,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setCluster({ items: group.items, label })}
            >
              {important ? (
                <Star className="size-4 fill-current" aria-hidden="true" />
              ) : (
                <Flag
                  className="size-4"
                  style={{ color: inherited }}
                  aria-hidden="true"
                />
              )}
              {group.items.length}
            </button>
          );
        }
        const item = group.items[0],
          day =
            preview?.kind === 'milestone' && preview.id === item.id
              ? preview.start
              : item.milestone_on;
        return (
          <button
            key={`marker:${item.id}`}
            type="button"
            data-bar
            aria-label={`Edit milestone ${item.title}${item.is_important ? ' (Important)' : ''}`}
            title={`${item.is_important ? '★ Important · ' : ''}${item.title}\n${item.milestone_on}\n${label}${notes[item.id] ? `\n${notes[item.id]}` : ''}`}
            className={`absolute top-0.5 z-10 flex h-7 touch-none items-center gap-1 overflow-hidden rounded-md ${item.is_important ? 'border-2 border-foreground/70 bg-card px-1 text-xs font-semibold shadow-sm' : 'justify-center hover:bg-muted'}`}
            style={{
              left: daysBetween(originKey, day) * dayWidth,
              width: milestoneMarkerWidth(item),
            }}
            onMouseEnter={() => milestoneNotes(item.id)}
            onFocus={() => milestoneNotes(item.id)}
            onPointerDown={(event) =>
              startDrag(
                event,
                row,
                'milestone',
                item.id,
                { start: item.milestone_on, end: item.milestone_on },
                'move',
              )
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPlanningEditor({ kind: 'milestone', id: item.id });
              }
            }}
          >
            {item.is_important ? (
              <Star
                className="size-5 shrink-0 fill-current"
                style={{
                  color: milestoneColorValue(item.color_key, inherited),
                }}
                aria-hidden="true"
              />
            ) : (
              <Flag
                className="size-5 fill-current"
                style={{
                  color: milestoneColorValue(item.color_key, inherited),
                }}
                aria-hidden="true"
              />
            )}
            {item.is_important ? (
              <span className="min-w-0 truncate">{item.title}</span>
            ) : null}
          </button>
        );
      });
  }
  return (
    <section
      aria-labelledby="timeline-heading"
      onPointerDownCapture={guardPlanningPointer}
    >
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
        Plan the horizon
      </p>
      <h1
        id="timeline-heading"
        className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
      >
        Gantt timeline
      </h1>
      <div
        className="mt-4 flex flex-wrap items-center gap-2"
        aria-label="Timeline controls"
      >
        <Button variant="outline" onClick={goToday} disabled={isFrozen}>
          Today
        </Button>
        <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold">
          <input
            type="checkbox"
            checked={importantOnly}
            disabled={isFrozen}
            onChange={(event) => setImportantOnly(event.target.checked)}
          />
          <Star className="size-3.5" aria-hidden="true" />
          Important only
        </label>
        <input
          type="search"
          aria-label="Search Timeline"
          data-shortcut-search
          placeholder="Find goal, task or milestone…"
          value={query}
          disabled={isFrozen}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 rounded-lg border bg-background px-3 py-2 text-sm sm:w-64"
        />
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={outlineOpen ? 'Hide outline' : 'Show outline'}
          aria-pressed={!outlineOpen}
          disabled={isFrozen}
          onClick={() => setOutlineOpen((open) => !open)}
        >
          {outlineOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
        </Button>
        <fieldset
          className="flex flex-wrap items-center gap-1"
          aria-label="Timeline zoom"
          title="Ctrl + mouse wheel to zoom around the pointer"
        >
          {TIMELINE_ZOOMS.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={zoom === item ? 'default' : 'outline'}
              aria-pressed={zoom === item}
              className="capitalize"
              disabled={isFrozen}
              onClick={() => changeZoom(item)}
            >
              {item}
            </Button>
          ))}
        </fieldset>
        {moving ? (
          <output className="text-xs text-muted-foreground">Saving…</output>
        ) : null}
        {importantOnly &&
        !workspace.milestones.some((item) => item.is_important) ? (
          <output className="text-xs text-muted-foreground">
            No important milestones yet.
          </output>
        ) : null}
      </div>
      {message ? (
        <output className="mt-3 block rounded-xl border bg-muted p-3 text-xs">
          {message}
        </output>
      ) : null}
      {loading ? (
        <div className="grid min-h-[420px] place-items-center">
          <LoaderCircle
            className="animate-spin text-primary"
            aria-label="Loading Timeline"
          />
        </div>
      ) : (
        <div
          ref={boardRef}
          className="mt-3 h-[max(480px,calc(100dvh-250px))] overflow-auto rounded-2xl border bg-card shadow-sm"
          data-timeline-board
          style={
            {
              '--timeline-sticky-inset': `${(outlineOpen ? outlineWidth : 0) + 8}px`,
            } as React.CSSProperties
          }
          onScroll={() => {
            const board = boardRef.current;
            if (!board) return;
            syncTimelineLabels(
              labelRegistryRef.current,
              board.scrollLeft,
              board.clientWidth,
              outlinePixelsRef.current,
            );
            queueViewport();
            const horizontal =
              previousScrollLeftRef.current !== board.scrollLeft;
            previousScrollLeftRef.current = board.scrollLeft;
            if (!horizontal || isFrozen || pendingScroll.current !== null)
              return;
            if (board.scrollLeft < 2) extendEarlier();
            else if (
              board.scrollLeft + board.clientWidth >
              board.scrollWidth - 80
            )
              extendLater();
          }}
          onPointerDownCapture={(event) => {
            const value = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-timeline-select]',
            )?.dataset.timelineSelect;
            if (value) {
              const colon = value.indexOf(':');
              setSelection({
                kind: value.slice(0, colon) as Selection['kind'],
                id: value.slice(colon + 1),
              });
            }
          }}
          onFocusCapture={(event) => {
            const value = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-timeline-select]',
            )?.dataset.timelineSelect;
            if (value) {
              const colon = value.indexOf(':');
              setSelection((old) =>
                old?.id === value.slice(colon + 1) &&
                old.kind === value.slice(0, colon)
                  ? old
                  : {
                      kind: value.slice(0, colon) as Selection['kind'],
                      id: value.slice(colon + 1),
                    },
              );
            }
          }}
        >
          <div className="flex min-w-max" inert={moving}>
            {outlineOpen ? (
              <div
                className="sticky left-0 z-30 shrink-0 border-r bg-card"
                style={{ width: outlineWidth }}
                data-timeline-outline
              >
                <div className="sticky top-0 z-30 h-12 border-b bg-card px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Goal / Task
                </div>
                <div
                  className="relative"
                  style={{ height: layout.totalHeight }}
                >
                  {renderedRows.map((row) =>
                    row.goal ? (
                      <div
                        key={row.key}
                        data-timeline-select={`goal:${row.goal.id}`}
                        {...dropAttributes(row)}
                        className={`absolute left-0 flex w-full items-center gap-2 border-b bg-muted/30 px-3 ${dropId === row.key ? 'border-t-2 border-t-primary' : ''}`}
                        style={{ top: row.top, height: row.height }}
                      >
                        <button
                          type="button"
                          disabled={!!query.trim()}
                          aria-label={`${collapsed.has(row.goal.id) ? 'Expand' : 'Collapse'} ${row.goal.title}`}
                          aria-expanded={
                            !!query.trim() || !collapsed.has(row.goal.id)
                          }
                          className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted"
                          onClick={() => toggleGoal(row.goal!.id)}
                        >
                          {collapsed.has(row.goal.id) && !query.trim() ? (
                            <ChevronRight className="size-4" />
                          ) : (
                            <ChevronDown className="size-4" />
                          )}
                        </button>
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{
                            background: goalColorValue(row.goal.color_key),
                          }}
                        />
                        <button
                          type="button"
                          data-timeline-focus={`goal:${row.goal.id}`}
                          className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
                          title={row.goal.title}
                          onClick={() => {
                            if (row.goal!.id === 'inbox') toggleGoal('inbox');
                            else
                              openPlanningEditor({
                                kind: 'goal',
                                id: row.goal!.id,
                              });
                          }}
                        >
                          {row.goal.title}
                        </button>
                      </div>
                    ) : (
                      row.tasks.map((plan) => {
                        const task = plan.row.task,
                          guides = tree.get(task.id) ?? [];
                        return (
                          <div
                            key={row.key}
                            data-shortcut-item
                            data-timeline-select={`task:${task.id}`}
                            {...dropAttributes(row, plan)}
                            className={`absolute left-0 flex w-full items-center border-b pr-2 hover:bg-muted/40 ${dropId === row.key ? 'border-t-2 border-t-primary' : ''}`}
                            style={{
                              top: row.top,
                              height: row.height,
                              paddingLeft: 16 + (plan.row.depth + 1) * 20,
                            }}
                          >
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-y-0 left-4"
                            >
                              {guides.map((last, level) =>
                                last && level < guides.length - 1 ? null : (
                                  <span
                                    key={level}
                                    className="absolute top-0 w-5"
                                    style={{
                                      left: level * 20,
                                      height:
                                        level === guides.length - 1 && last
                                          ? '50%'
                                          : '100%',
                                      borderLeft:
                                        '1px solid color-mix(in srgb, var(--foreground) 30%, transparent)',
                                    }}
                                  >
                                    {level === guides.length - 1 ? (
                                      <span
                                        className="absolute left-0 top-1/2 w-4 border-t"
                                        style={{
                                          top: last ? '100%' : '50%',
                                          borderColor:
                                            'color-mix(in srgb, var(--foreground) 30%, transparent)',
                                        }}
                                      />
                                    ) : null}
                                  </span>
                                ),
                              )}
                            </span>
                            {plan.row.hasChildren ? (
                              <button
                                type="button"
                                disabled={!!query.trim()}
                                className="relative flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted"
                                aria-label={`${collapsedTasks.has(task.id) && !query.trim() ? 'Expand' : 'Collapse'} ${task.title}`}
                                aria-expanded={
                                  !!query.trim() || !collapsedTasks.has(task.id)
                                }
                                onClick={() => toggleTask(task.id)}
                              >
                                {collapsedTasks.has(task.id) &&
                                !query.trim() ? (
                                  <ChevronRight className="size-4" />
                                ) : (
                                  <ChevronDown className="size-4" />
                                )}
                              </button>
                            ) : (
                              <span className="size-6 shrink-0" />
                            )}
                            <button
                              type="button"
                              data-timeline-focus={`task:${task.id}`}
                              className={`h-full min-w-0 flex-1 truncate text-left text-xs ${plan.row.hasChildren ? 'font-semibold' : 'font-medium'}`}
                              title={task.title}
                              onClick={() =>
                                openPlanningEditor({
                                  kind: 'task',
                                  id: task.id,
                                })
                              }
                            >
                              {task.title}
                            </button>
                            <TaskLink task={task} />
                          </div>
                        );
                      })
                    ),
                  )}
                </div>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize timeline outline"
                  tabIndex={0}
                  aria-valuenow={outlineWidth}
                  aria-valuemin={220}
                  aria-valuemax={360}
                  className="absolute inset-y-0 right-0 z-40 h-auto w-2 cursor-ew-resize touch-none border-0 hover:bg-primary/20"
                  onKeyDown={(event) => {
                    if (
                      event.key === 'ArrowLeft' ||
                      event.key === 'ArrowRight'
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      setOutlineWidth((width) =>
                        Math.min(
                          360,
                          Math.max(
                            220,
                            width + (event.key === 'ArrowRight' ? 10 : -10),
                          ),
                        ),
                      );
                    }
                  }}
                  onPointerDown={(event) => {
                    if (isFrozen) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resizeRef.current = {
                      pointerId: event.pointerId,
                      x: event.clientX,
                      width: outlineWidth,
                    };
                  }}
                  onPointerMove={(event) => {
                    const state = resizeRef.current;
                    if (state?.pointerId === event.pointerId)
                      setOutlineWidth(
                        Math.min(
                          360,
                          Math.max(220, state.width + event.clientX - state.x),
                        ),
                      );
                  }}
                  onPointerUp={(event) => {
                    if (resizeRef.current?.pointerId === event.pointerId)
                      resizeRef.current = null;
                  }}
                  onPointerCancel={() => {
                    resizeRef.current = null;
                  }}
                />
              </div>
            ) : null}
            <div
              ref={chartRef}
              className="relative shrink-0"
              style={{ width: chartWidth }}
              onPointerMove={pointerMove}
              onPointerUp={(event) => void pointerUp(event)}
              onPointerCancel={cancelGesture}
              onLostPointerCapture={() => {
                if (
                  !busyRef.current &&
                  (dragRef.current || creationRef.current)
                )
                  cancelGesture();
              }}
            >
              <div
                className="sticky top-0 z-20 h-12 overflow-hidden border-b bg-card"
                style={{ backgroundImage: gridBackground(dayWidth) }}
              >
                {visibleDays
                  .filter(
                    ({ offset }) =>
                      zoom === 'week' ||
                      zoom === 'month' ||
                      offset % Math.max(1, Math.round(90 / dayWidth)) === 0,
                  )
                  .map(({ offset, day, title }) => (
                    <span
                      key={offset}
                      title={title}
                      className="absolute top-1 text-center text-[9px] text-muted-foreground"
                      style={{
                        left: offset * dayWidth,
                        width:
                          zoom === 'week' || zoom === 'month' ? dayWidth : 90,
                      }}
                    >
                      {zoom === 'week' || zoom === 'month' ? (
                        <>
                          <span className="block text-[8px]">
                            {
                              ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
                                day.getDay()
                              ]
                            }
                          </span>
                          <strong className="block">{day.getDate()}</strong>
                          {zoom === 'week' || day.getDate() === 1 ? (
                            <small>
                              {day.toLocaleDateString('en-US', {
                                month: 'short',
                              })}
                            </small>
                          ) : null}
                        </>
                      ) : (
                        day.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })
                      )}
                    </span>
                  ))}
              </div>
              <div
                className="relative"
                style={{
                  height: layout.totalHeight,
                  backgroundImage: gridBackground(dayWidth),
                }}
              >
                {visibleDays.map(({ offset, day, key, holiday }) =>
                  holiday.length || day.getDay() === 0 || day.getDay() === 6 ? (
                    <div
                      key={key}
                      className={`pointer-events-none absolute inset-y-0 ${holiday.length ? 'bg-amber-500/10' : 'bg-foreground/5'}`}
                      style={{ left: offset * dayWidth, width: dayWidth }}
                    />
                  ) : null,
                )}
                {renderedRows.map((row) => (
                  <div
                    key={row.key}
                    {...(outlineOpen || row.goal
                      ? dropAttributes(row, row.tasks[0])
                      : {})}
                    className={`absolute left-0 w-full border-b ${row.goal ? 'bg-muted/20' : ''} ${dropId === row.key ? 'border-t-2 border-t-primary' : ''}`}
                    style={{ top: row.top, height: row.height }}
                    onPointerDown={(event) => startCreation(event, row)}
                  >
                    {row.goal ? (
                      <>
                        {renderBar(
                          row,
                          'goal',
                          row.goal,
                          goalPlans.get(row.goal.id) ?? {
                            start: null,
                            end: null,
                          },
                          goalColorValue(row.goal.color_key),
                          goalColorValue(row.goal.color_key),
                        )}
                        {row.goal.id === 'inbox' ||
                        !goalPlans.get(row.goal.id)?.start ||
                        !goalPlans.get(row.goal.id)?.end ? (
                          <div className="timeline-pinned-anchor">
                            <button
                              type="button"
                              data-bar
                              data-timeline-select={`goal:${row.goal.id}`}
                              data-timeline-focus={
                                outlineOpen ? undefined : `goal:${row.goal.id}`
                              }
                              className="absolute top-3 w-max text-xs font-semibold text-muted-foreground"
                              onClick={() => {
                                if (row.goal!.id === 'inbox')
                                  toggleGoal('inbox');
                                else
                                  openPlanningEditor({
                                    kind: 'goal',
                                    id: row.goal!.id,
                                  });
                              }}
                            >
                              {row.goal.title}
                            </button>
                          </div>
                        ) : null}
                        {renderMarkers(
                          row,
                          row.clusters,
                          row.goal.title,
                          goalColorValue(row.goal.color_key),
                        )}
                      </>
                    ) : (
                      row.tasks
                        .filter(
                          (plan) =>
                            outlineOpen ||
                            selection?.id === plan.row.task.id ||
                            dragRef.current?.id === plan.row.task.id ||
                            plan.milestones.some(
                              (marker) => marker.id === dragRef.current?.id,
                            ) ||
                            plan.footprints.some(
                              (piece) =>
                                piece.right >= viewport.left - 240 &&
                                piece.left <=
                                  viewport.left + viewport.width + 240,
                            ),
                        )
                        .map((plan) => {
                          const task = plan.row.task,
                            base = plan.row.goalId
                              ? goalColorValue(
                                  index.goalsById.get(plan.row.goalId)
                                    ?.color_key,
                                )
                              : neutralChecklistColor;
                          return (
                            <div
                              key={task.id}
                              data-timeline-select={`task:${task.id}`}
                              data-timeline-task={task.id}
                            >
                              {renderBar(
                                row,
                                'task',
                                task,
                                plan,
                                `color-mix(in srgb, ${base} ${plan.row.depth > 0 ? 58 : 72}%, var(--card))`,
                                base,
                              )}
                              {renderMarkers(
                                row,
                                plan.clusters,
                                task.title,
                                base,
                              )}
                              {!plan.start || !plan.end ? (
                                <div className="timeline-pinned-anchor">
                                  <span
                                    data-bar
                                    className="pointer-events-none absolute top-3.5 w-max text-[10px] text-muted-foreground"
                                  >
                                    Drag here to set Start date → Deadline
                                  </span>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                    )}
                  </div>
                ))}
                {todayLeft >= 0 && todayLeft <= chartWidth ? (
                  <span
                    className="pointer-events-none absolute inset-y-0 z-10 w-px bg-destructive"
                    style={{ left: todayLeft }}
                  >
                    <span className="absolute -top-12 -translate-x-1/2 rounded bg-destructive px-1 text-[9px] text-white">
                      Today
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
      <Dialog
        open={!!cluster}
        onOpenChange={(open) => {
          if (!open) setCluster(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Milestones · {cluster?.label}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {cluster?.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted"
                onClick={() => {
                  setCluster(null);
                  openPlanningEditor({ kind: 'milestone', id: item.id });
                }}
              >
                {item.is_important ? (
                  <Star className="size-4 shrink-0 fill-current" />
                ) : (
                  <Flag className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <strong className="block break-words text-sm">
                    {item.title}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {item.milestone_on}
                  </span>
                </span>
                <span className="text-xs font-semibold">Edit</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!choice}
        onOpenChange={(open) => {
          if (!open) setChoice(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>What are you planning?</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-3">
            {(['goal', 'task', 'milestone'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="rounded-xl border p-4 text-left capitalize hover:border-primary hover:bg-secondary"
                onClick={() => {
                  if (choice) openPlanningEditor({ kind, ...choice });
                  setChoice(null);
                }}
              >
                {kind}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
function readPreference(key: string) {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Session controls remain usable without storage. */
  }
}
function toggleSet(old: Set<string>, id: string) {
  const next = new Set(old);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
function gridBackground(width: number) {
  return `repeating-linear-gradient(to right,transparent 0,transparent ${width - 1}px,var(--border) ${width - 1}px,var(--border) ${width}px)`;
}
function dropAttributes(row: TimelineLayoutRow, task?: TaskLayout) {
  return {
    'data-timeline-drop': row.key,
    'data-timeline-kind': row.goal ? 'goal' : 'task',
    'data-timeline-id': row.goal?.id ?? task?.row.task.id,
    'data-timeline-goal': row.goal
      ? row.goal.id === 'inbox'
        ? ''
        : row.goal.id
      : (task?.row.goalId ?? ''),
  };
}
function latestTimelineDate(workspace: TimelineWorkspace) {
  return [
    ...workspace.goals.map((goal) => goal.ends_on),
    ...workspace.tasks.map(deadlineKey),
    ...workspace.milestones.map((item) => item.milestone_on),
  ].reduce<string>(
    (last, day) => (day && day > last ? day : last),
    dateKey(new Date()),
  );
}
function timelineRangeStart(workspace: TimelineWorkspace) {
  const earliest = [
    ...workspace.goals.flatMap((goal) => [goal.starts_on, goal.ends_on]),
    ...workspace.tasks.flatMap((task) => [
      task.planned_start,
      deadlineKey(task),
    ]),
    ...workspace.milestones.map((item) => item.milestone_on),
  ].reduce<string>(
    (first, day) => (day && day < first ? day : first),
    dateKey(new Date()),
  );
  const start = shiftDateKey(earliest, -14);
  return new Date(`${start < '2000-01-01' ? '2000-01-01' : start}T00:00:00`);
}
function filterTimelineRows(
  rows: TimelineOutlineRow[],
  workspace: TimelineWorkspace,
  query: string,
) {
  if (!query.trim()) return rows;
  const index = indexTimeline(workspace),
    goals = new Set<string>(),
    tasks = new Set<string>();
  for (const row of rows) {
    if (
      row.kind === 'goal' &&
      matchesPlanningSearch(
        query,
        { goal: row.goal.title },
        row.goal.title,
        row.goal.description,
        ...(
          index.goalMilestones.get(
            row.goal.id === 'inbox' ? null : row.goal.id,
          ) ?? []
        ).map((mark) => mark.title),
      )
    )
      goals.add(row.goal.id);
    if (
      row.kind === 'task' &&
      matchesPlanningSearch(
        query,
        {
          goal: index.goalsById.get(row.goalId ?? '')?.title,
          task: row.task.title,
        },
        row.task.title,
        ...(index.taskMilestones.get(row.task.id) ?? []).map(
          (mark) => mark.title,
        ),
      )
    )
      tasks.add(row.task.id);
  }
  const contextGoals = new Set(goals);
  for (const row of rows)
    if (row.kind === 'task' && tasks.has(row.task.id)) {
      contextGoals.add(row.goalId ?? 'inbox');
      const seen = new Set<string>();
      let parent = row.task.parent_task_id;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        tasks.add(parent);
        parent = index.tasksById.get(parent)?.parent_task_id ?? null;
      }
    }
  return rows.filter((row) =>
    row.kind === 'goal'
      ? contextGoals.has(row.goal.id)
      : tasks.has(row.task.id) || goals.has(row.goalId ?? 'inbox'),
  );
}
function applyPlan(
  workspace: TimelineWorkspace,
  plan: Preview,
): TimelineWorkspace {
  if (plan.kind === 'goal')
    return {
      ...workspace,
      goals: workspace.goals.map((goal) =>
        goal.id === plan.id
          ? { ...goal, starts_on: plan.start, ends_on: plan.end }
          : goal,
      ),
    };
  if (plan.kind === 'task')
    return {
      ...workspace,
      tasks: workspace.tasks.map((task) =>
        task.id === plan.id
          ? {
              ...task,
              planned_start: plan.start,
              due_at: deadlineIso(plan.end),
              planned_end: null,
            }
          : task,
      ),
    };
  return {
    ...workspace,
    milestones: workspace.milestones.map((item) =>
      item.id === plan.id ? { ...item, milestone_on: plan.start } : item,
    ),
  };
}
