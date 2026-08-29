'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Flag,
  LoaderCircle,
  Milestone,
  MoveHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { addDays, dateKey, daysBetween, shiftDateKey } from '@/lib/calendar';
import {
  getErrorMessage,
  getPlanningRepository,
  type Goal,
  type Task,
  type TimelineWorkspace,
} from '@/lib/data/repository';

type Zoom = 'week' | 'month' | 'quarter' | 'year';
type Row =
  | { kind: 'goal'; goal: Goal }
  | { kind: 'task'; task: Task; goalId: string | null; depth: number };
type DragState = {
  task: Task;
  x: number;
  resize: boolean;
  pointerId: number;
  delta: number;
};
type DragPreview = {
  taskId: string;
  plannedStart: string;
  plannedEnd: string;
};
const dayWidths: Record<Zoom, number> = {
  week: 46,
  month: 18,
  quarter: 8,
  year: 3,
};
function timelineStartKey(workspace: TimelineWorkspace) {
  const dated = [
    ...workspace.goals.flatMap((goal) => [goal.starts_on, goal.ends_on]),
    ...workspace.tasks.flatMap((task) => [
      task.planned_start,
      task.planned_end,
    ]),
  ].filter(Boolean) as string[];
  const first =
    dated.sort((a, b) => a.localeCompare(b))[0] ?? dateKey(new Date());
  return dateKey(addDays(new Date(`${first}T00:00:00`), -14));
}

export function TimelinePanel() {
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<TimelineWorkspace>({
    goals: [],
    tasks: [],
    links: [],
    milestones: [],
    statuses: [],
  });
  const [zoom, setZoom] = useState<Zoom>('month');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [rangeStartKey, setRangeStartKey] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const dragFrame = useRef<number | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const load = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    try {
      const nextWorkspace = await repository.getTimelineWorkspace();
      setWorkspace(nextWorkspace);
      setRangeStartKey((current) => current ?? timelineStartKey(nextWorkspace));
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [repository]);
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [load]);
  useEffect(
    () => () => {
      if (dragFrame.current !== null)
        window.cancelAnimationFrame(dragFrame.current);
    },
    [],
  );
  const linkMap = useMemo(
    () => new Map(workspace.links.map((link) => [link.task_id, link.goal_id])),
    [workspace.links],
  );
  const range = useMemo(() => {
    const start = new Date(
      `${rangeStartKey ?? dateKey(addDays(new Date(), -14))}T00:00:00`,
    );
    const defaultDays = { week: 56, month: 180, quarter: 540, year: 1095 }[
      zoom
    ];
    return { start, end: addDays(start, defaultDays), days: defaultDays };
  }, [rangeStartKey, zoom]);
  const rows: Row[] = (() => {
    const result: Row[] = [];
    const appendTree = (
      task: Task,
      goalId: string | null,
      depth: number,
      seen: Set<string>,
    ) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      result.push({ kind: 'task', task, goalId, depth });
      for (const child of workspace.tasks.filter(
        (item) =>
          item.parent_task_id === task.id &&
          (linkMap.get(item.id) ?? null) === goalId,
      ))
        appendTree(child, goalId, depth + 1, seen);
    };
    for (const goal of workspace.goals) {
      result.push({ kind: 'goal', goal });
      if (!collapsed.has(goal.id)) {
        const tasks = workspace.tasks.filter((task) => {
          if (linkMap.get(task.id) !== goal.id) return false;
          const parent = workspace.tasks.find(
            (item) => item.id === task.parent_task_id,
          );
          return !parent || linkMap.get(parent.id) !== goal.id;
        });
        const seen = new Set<string>();
        for (const task of tasks) appendTree(task, goal.id, 0, seen);
      }
    }
    const inbox = workspace.tasks.filter((task) => !linkMap.has(task.id));
    if (inbox.length) {
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
      result.push({ kind: 'goal', goal: inboxGoal });
      if (!collapsed.has('inbox')) {
        const roots = inbox.filter((task) => {
          const parent = workspace.tasks.find(
            (item) => item.id === task.parent_task_id,
          );
          return !parent || linkMap.has(parent.id);
        });
        const seen = new Set<string>();
        for (const task of roots) appendTree(task, null, 0, seen);
      }
    }
    return result;
  })();
  const dayWidth = dayWidths[zoom];
  const chartWidth = range.days * dayWidth;
  function goalRange(goal: Goal) {
    const children = workspace.tasks.filter(
      (task) => linkMap.get(task.id) === goal.id,
    );
    const starts = [
      goal.starts_on,
      ...children.map((task) => task.planned_start),
    ]
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b))) as string[];
    const ends = [goal.ends_on, ...children.map((task) => task.planned_end)]
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b))) as string[];
    return { start: starts[0] ?? null, end: ends.at(-1) ?? null };
  }
  async function updatePlan(task: Task, changes: Partial<Task>) {
    if (!repository) return;
    setMessage('');
    setWorkspace((current) => ({
      ...current,
      tasks: current.tasks.map((item) =>
        item.id === task.id ? { ...item, ...changes } : item,
      ),
    }));
    try {
      await repository.updateTask(task.id, changes);
    } catch (error) {
      setWorkspace((current) => ({
        ...current,
        tasks: current.tasks.map((item) => (item.id === task.id ? task : item)),
      }));
      setMessage(getErrorMessage(error));
    }
  }
  function dragDates(state: DragState, clientX: number) {
    const rawDelta = Math.round((clientX - state.x) / dayWidth);
    const minimumDelta = state.resize
      ? -daysBetween(state.task.planned_start!, state.task.planned_end!)
      : Number.NEGATIVE_INFINITY;
    const delta = Math.max(rawDelta, minimumDelta);
    return {
      delta,
      plannedStart: state.resize
        ? state.task.planned_start!
        : shiftDateKey(state.task.planned_start!, delta),
      plannedEnd: shiftDateKey(state.task.planned_end!, delta),
    };
  }
  function previewDrag(event: React.PointerEvent) {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    const next = dragDates(state, event.clientX);
    if (next.delta === state.delta) return;
    state.delta = next.delta;
    if (dragFrame.current !== null)
      window.cancelAnimationFrame(dragFrame.current);
    dragFrame.current = window.requestAnimationFrame(() => {
      setDragPreview({
        taskId: state.task.id,
        plannedStart: next.plannedStart,
        plannedEnd: next.plannedEnd,
      });
      dragFrame.current = null;
    });
  }
  function finishDrag(event: React.PointerEvent) {
    const state = drag.current;
    if (
      !state ||
      event.pointerId !== state.pointerId ||
      !state.task.planned_start ||
      !state.task.planned_end
    )
      return;
    const next = dragDates(state, event.clientX);
    drag.current = null;
    if (dragFrame.current !== null) {
      window.cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
    }
    setDragPreview(null);
    if (!next.delta) return;
    void updatePlan(
      state.task,
      state.resize
        ? { planned_end: next.plannedEnd }
        : {
            planned_start: next.plannedStart,
            planned_end: next.plannedEnd,
          },
    );
  }
  function cancelDrag() {
    drag.current = null;
    if (dragFrame.current !== null) {
      window.cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
    }
    setDragPreview(null);
  }
  const todayOffset =
    daysBetween(dateKey(range.start), dateKey(new Date())) * dayWidth;
  return (
    <section aria-labelledby="timeline-heading">
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
        <div className="flex gap-1">
          {(['week', 'month', 'quarter', 'year'] as Zoom[]).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={zoom === item ? 'default' : 'outline'}
              className="capitalize"
              onClick={() => setZoom(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      </div>
      {message ? (
        <p className="mt-4 rounded-xl border bg-muted p-3 text-xs">{message}</p>
      ) : null}
      {loading ? (
        <div className="grid min-h-[360px] place-items-center">
          <LoaderCircle className="animate-spin text-primary" />
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex overflow-auto">
            <div className="sticky left-0 z-30 w-[330px] shrink-0 border-r bg-card">
              <div className="h-12 border-b px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Goal / task
              </div>
              {rows.map((row) =>
                row.kind === 'goal' ? (
                  <button
                    type="button"
                    key={`left-${row.goal.id}`}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(row.goal.id)) next.delete(row.goal.id);
                        else next.add(row.goal.id);
                        return next;
                      })
                    }
                    className="flex h-14 w-full items-center gap-2 border-b bg-muted/30 px-3 text-left text-sm font-semibold"
                  >
                    {collapsed.has(row.goal.id) ? (
                      <ChevronRight className="size-4" />
                    ) : (
                      <ChevronDown className="size-4" />
                    )}
                    {row.goal.title}
                  </button>
                ) : (
                  <div
                    key={`left-${row.task.id}`}
                    className="grid h-14 grid-cols-[minmax(0,1fr)_90px] items-center gap-2 border-b px-3"
                    style={{ paddingLeft: 16 + row.depth * 18 }}
                  >
                    <div className="min-w-0">
                      <span className="block truncate text-xs font-semibold">
                        {row.task.is_milestone ? (
                          <Milestone className="mr-1 inline size-3 text-primary" />
                        ) : null}
                        {row.task.title}
                      </span>
                      <small className="text-[10px] text-muted-foreground">
                        {row.task.planned_start ?? 'unscheduled'} →{' '}
                        {row.task.planned_end ?? '—'}
                      </small>
                    </div>
                    <input
                      aria-label={`${row.task.title} progress`}
                      type="number"
                      min="0"
                      max="100"
                      value={row.task.progress}
                      onChange={(event) =>
                        void updatePlan(row.task, {
                          progress: Number(event.target.value),
                        })
                      }
                      className="h-8 rounded-md border bg-background px-2 text-xs"
                    />
                  </div>
                ),
              )}
            </div>
            <div
              className="relative shrink-0"
              style={{ width: chartWidth }}
              onPointerMove={previewDrag}
              onPointerUp={finishDrag}
              onPointerCancel={cancelDrag}
            >
              <div
                className="sticky top-0 z-20 h-12 border-b bg-card"
                style={{
                  backgroundImage: `repeating-linear-gradient(to right,transparent 0,transparent ${dayWidth - 1}px,var(--border) ${dayWidth - 1}px,var(--border) ${dayWidth}px)`,
                }}
              >
                {Array.from({ length: range.days }, (_, index) => index)
                  .filter(
                    (index) =>
                      index % Math.max(1, Math.round(80 / dayWidth)) === 0,
                  )
                  .map((index) => (
                    <span
                      key={index}
                      className="absolute top-3 text-[10px] text-muted-foreground"
                      style={{ left: index * dayWidth + 4 }}
                    >
                      {addDays(range.start, index).toLocaleDateString(
                        undefined,
                        { month: 'short', day: 'numeric' },
                      )}
                    </span>
                  ))}
              </div>
              {rows.map((row) => {
                const plan =
                  row.kind === 'goal'
                    ? goalRange(row.goal)
                    : {
                        start:
                          dragPreview?.taskId === row.task.id
                            ? dragPreview.plannedStart
                            : row.task.planned_start,
                        end:
                          dragPreview?.taskId === row.task.id
                            ? dragPreview.plannedEnd
                            : row.task.planned_end,
                      };
                const left = plan.start
                  ? daysBetween(dateKey(range.start), plan.start) * dayWidth
                  : 0;
                const width =
                  plan.start && plan.end
                    ? Math.max(
                        dayWidth *
                          (row.kind === 'task' && row.task.is_milestone
                            ? 1
                            : daysBetween(plan.start, plan.end) + 1),
                        10,
                      )
                    : 0;
                const dependency =
                  row.kind === 'task' && row.task.dependency_task_id
                    ? workspace.tasks.find(
                        (task) => task.id === row.task.dependency_task_id,
                      )
                    : null;
                const warning = Boolean(
                  row.kind === 'task' &&
                  dependency?.planned_end &&
                  row.task.planned_start &&
                  row.task.planned_start < dependency.planned_end,
                );
                return (
                  <div
                    key={`chart-${row.kind === 'goal' ? row.goal.id : row.task.id}`}
                    className={`relative h-14 border-b ${row.kind === 'goal' ? 'bg-muted/20' : ''}`}
                    style={{
                      backgroundImage: `repeating-linear-gradient(to right,transparent 0,transparent ${dayWidth - 1}px,var(--border) ${dayWidth - 1}px,var(--border) ${dayWidth}px)`,
                    }}
                  >
                    {plan.start && plan.end ? (
                      <button
                        type="button"
                        title={
                          warning
                            ? `Starts before dependency ${dependency?.title} ends`
                            : 'Drag to move; drag right edge to resize'
                        }
                        onPointerDown={(event) => {
                          if (row.kind === 'task') {
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                            drag.current = {
                              task: row.task,
                              x: event.clientX,
                              resize: false,
                              pointerId: event.pointerId,
                              delta: 0,
                            };
                          }
                        }}
                        className={`absolute top-3 h-8 rounded-md text-left text-[10px] font-semibold shadow-sm touch-none ${row.kind === 'goal' ? 'bg-foreground/80 text-background' : 'bg-primary text-primary-foreground'} ${row.kind === 'task' && row.task.is_milestone ? 'rotate-45 rounded-sm' : ''}`}
                        style={{ left, width }}
                      >
                        {row.kind === 'goal' ? (
                          <Progress
                            value={row.goal.progress}
                            className="absolute inset-x-1 bottom-1 h-1"
                          />
                        ) : (
                          <>
                            <span className="block truncate px-2">
                              {warning ? (
                                <AlertTriangle className="mr-1 inline size-3" />
                              ) : null}
                              {row.task.title}
                            </span>
                            <span
                              onPointerDown={(event) => {
                                event.stopPropagation();
                                event.currentTarget.setPointerCapture(
                                  event.pointerId,
                                );
                                drag.current = {
                                  task: row.task,
                                  x: event.clientX,
                                  resize: true,
                                  pointerId: event.pointerId,
                                  delta: 0,
                                };
                              }}
                              className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-black/10"
                            />
                          </>
                        )}
                      </button>
                    ) : row.kind === 'task' ? (
                      <div className="absolute left-3 top-2 flex gap-2">
                        <input
                          type="date"
                          aria-label={`${row.task.title} planned start`}
                          onChange={(event) =>
                            void updatePlan(row.task, {
                              planned_start: event.target.value,
                              planned_end:
                                row.task.planned_end ?? event.target.value,
                            })
                          }
                          className="h-9 rounded border bg-background px-2 text-xs"
                        />
                        <span className="flex items-center text-[10px] text-muted-foreground">
                          <MoveHorizontal className="mr-1 size-3" />
                          Schedule
                        </span>
                      </div>
                    ) : null}
                    {dependency ? (
                      <span
                        className="absolute top-10 text-[9px] text-muted-foreground"
                        style={{ left: Math.max(left, 4) }}
                      >
                        <Flag className="mr-1 inline size-3" />
                        after {dependency.title}
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {todayOffset >= 0 && todayOffset <= chartWidth ? (
                <span
                  className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-destructive"
                  style={{ left: todayOffset }}
                >
                  <span className="absolute top-0 -translate-x-1/2 rounded bg-destructive px-1 text-[9px] text-white">
                    Today
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
