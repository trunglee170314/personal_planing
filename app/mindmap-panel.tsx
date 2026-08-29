'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { openPlanningEditor } from '@/components/planning-editor';
import { openCalendarEditor } from '@/components/calendar-editor-host';
import {
  getPlanningRepository,
  getErrorMessage,
  type CalendarWorkspace,
  type TimelineWorkspace,
  type Task,
} from '@/lib/data/repository';
import {
  MYPLAN_DATA_CHANGED,
  announceDataChanged,
} from '@/lib/data/data-events';
import { goalColorValue } from '@/lib/colors';
import { matchesSearch, preserveItemOrder } from '@/lib/workspace-view';
import { guardPlanningPointer } from '@/lib/pointer-actions';

export function MindmapPanel() {
  const repo = getPlanningRepository();
  const [workspace, setWorkspace] = useState<TimelineWorkspace | null>(null);
  const [calendar, setCalendar] = useState<CalendarWorkspace | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [query, setQuery] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const load = useCallback(async () => {
    if (!repo) return;
    try {
      const [tree, items] = await Promise.all([
        repo.getTimelineWorkspace(),
        repo.getCalendarWorkspace(),
      ]);
      setWorkspace((old) => ({
        ...tree,
        goals: preserveItemOrder(old?.goals ?? [], tree.goals),
        tasks: preserveItemOrder(old?.tasks ?? [], tree.tasks),
      }));
      setCalendar(items);
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }, [repo]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    window.addEventListener(MYPLAN_DATA_CHANGED, load);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(MYPLAN_DATA_CHANGED, load);
    };
  }, [load]);
  function toggle(id: string) {
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function remove(
    kind: 'goal' | 'task' | 'checklist',
    id: string,
    title: string,
  ) {
    if (
      !repo ||
      !window.confirm(
        kind === 'checklist'
          ? `Permanently delete checklist “${title}”, all its occurrences and comments?`
          : `Move ${kind} “${title}” to Trash? Children are kept.`,
      )
    )
      return;
    try {
      if (kind === 'checklist') await repo.deleteCalendarSession(id);
      else if (kind === 'task')
        await repo.updateTask(id, { deleted_at: new Date().toISOString() });
      else await repo.updateGoal(id, { deleted_at: new Date().toISOString() });
      announceDataChanged('mindmap');
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }
  function card(
    id: string,
    title: string,
    kind: string,
    color: string,
    edit: () => void,
    actions: ReactNode,
    children?: ReactNode,
  ) {
    return (
      <div key={id} className="flex items-center gap-6">
        <div
          data-node
          className={`w-64 shrink-0 rounded-xl border bg-card p-3 shadow-sm ${query && !matchesSearch(query, title, kind) ? 'opacity-40' : ''}`}
          style={{ borderLeft: `4px solid ${color}` }}
        >
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase text-muted-foreground">
            <span>{kind}</span>
            {children ? (
              <button
                type="button"
                aria-label={`${collapsed.has(id) ? 'Expand' : 'Collapse'} ${title}`}
                onClick={() => toggle(id)}
              >
                {collapsed.has(id) ? '+' : '−'}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={edit}
            className="w-full break-words text-left text-sm font-semibold"
            title={title}
          >
            {title}
          </button>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">{actions}</div>
        </div>
        {children && !collapsed.has(id) ? (
          <div className="relative grid gap-4 border-l-2 pl-6">{children}</div>
        ) : null}
      </div>
    );
  }
  const goals = workspace?.goals ?? [];
  const tasks = workspace?.tasks ?? [];
  const goalFor = (id: string) => {
    const linked = workspace?.links.find(
      (link) => link.task_id === id,
    )?.goal_id;
    return goals.some((goal) => goal.id === linked) ? linked : null;
  };
  const shown = new Set<string>();
  function taskNode(task: Task): ReactNode {
    if (shown.has(task.id)) return null;
    shown.add(task.id);
    const goalId = goalFor(task.id);
    const color = goalColorValue(
      goals.find((goal) => goal.id === goalId)?.color_key,
    );
    const children = tasks
      .filter(
        (item) =>
          item.parent_task_id === task.id && goalFor(item.id) === goalId,
      )
      .map(taskNode);
    const checklists =
      calendar?.sessions.filter(
        (item) => item.item_type === 'checklist' && item.task_id === task.id,
      ) ?? [];
    return card(
      `task:${task.id}`,
      task.title,
      'Task',
      color,
      () => openPlanningEditor({ kind: 'task', id: task.id }),
      <>
        <button
          type="button"
          onClick={() =>
            openPlanningEditor({
              kind: 'task',
              taskId: task.id,
              goalId: goalId ?? undefined,
            })
          }
        >
          + Task
        </button>
        <button
          type="button"
          onClick={() =>
            openCalendarEditor({ type: 'checklist', taskId: task.id })
          }
        >
          + Checklist
        </button>
        <button
          type="button"
          onClick={() =>
            openPlanningEditor({ kind: 'milestone', taskId: task.id })
          }
        >
          + Milestone
        </button>
        <button
          type="button"
          onClick={() => void remove('task', task.id, task.title)}
        >
          Trash
        </button>
      </>,
      children.length || checklists.length ? (
        <>
          {children}
          {checklists.map((item) =>
            card(
              `checklist:${item.id}`,
              item.title,
              'Checklist',
              color,
              () => openCalendarEditor({ type: 'checklist', id: item.id }),
              <button
                type="button"
                onClick={() => void remove('checklist', item.id, item.title)}
              >
                Remove
              </button>,
            ),
          )}
        </>
      ) : undefined,
    );
  }
  const branches = [
    ...goals,
    { id: 'inbox', title: 'Unclassified', color_key: 'slate' as const },
  ].map((goal) => {
    const members = tasks.filter(
      (task) => goalFor(task.id) === (goal.id === 'inbox' ? null : goal.id),
    );
    const ids = new Set(members.map((task) => task.id));
    const roots = members.filter(
      (task) => !task.parent_task_id || !ids.has(task.parent_task_id),
    );
    const nodes = roots.map(taskNode);
    for (const task of members)
      if (!shown.has(task.id)) nodes.push(taskNode(task));
    return card(
      `goal:${goal.id}`,
      goal.title,
      'Goal',
      goalColorValue(goal.color_key),
      () => {
        if (goal.id !== 'inbox')
          openPlanningEditor({ kind: 'goal', id: goal.id });
      },
      <>
        <button
          type="button"
          onClick={() =>
            openPlanningEditor({
              kind: 'task',
              goalId: goal.id === 'inbox' ? undefined : goal.id,
            })
          }
        >
          + Task
        </button>
        {goal.id !== 'inbox' ? (
          <button
            type="button"
            onClick={() => void remove('goal', goal.id, goal.title)}
          >
            Trash
          </button>
        ) : null}
      </>,
      nodes.length ? nodes : undefined,
    );
  });
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl font-semibold">Mindmap</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setZoom((value) => Math.max(0.4, value - 0.1))}
          >
            −
          </Button>
          <Button variant="outline" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            variant="outline"
            onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}
          >
            +
          </Button>
          <Button onClick={() => openPlanningEditor({ kind: 'goal' })}>
            Create goal
          </Button>
        </div>
      </div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Highlight a goal, task or checklist…"
        aria-label="Search Mindmap"
        className="my-4 w-full rounded-lg border bg-background p-3 text-sm"
      />
      {error ? <p role="alert">{error}</p> : null}
      <div
        ref={viewport}
        className="h-[max(480px,calc(100dvh-250px))] overflow-auto rounded-xl border bg-muted/20"
        onPointerDownCapture={guardPlanningPointer}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('[data-node]')) return;
          const node = event.currentTarget;
          node.setPointerCapture(event.pointerId);
          pan.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: node.scrollLeft,
            top: node.scrollTop,
          };
        }}
        onPointerMove={(event) => {
          if (pan.current?.id !== event.pointerId) return;
          event.currentTarget.scrollLeft =
            pan.current.left - (event.clientX - pan.current.x);
          event.currentTarget.scrollTop =
            pan.current.top - (event.clientY - pan.current.y);
        }}
        onPointerUp={(event) => {
          if (pan.current?.id === event.pointerId) pan.current = null;
        }}
        onPointerCancel={(event) => {
          if (pan.current?.id === event.pointerId) pan.current = null;
        }}
      >
        <div className="min-w-max p-8" style={{ zoom }}>
          {workspace
            ? card(
                'myplan',
                'Myplan',
                'Workspace',
                'var(--primary)',
                () => {},
                <button
                  type="button"
                  onClick={() => openPlanningEditor({ kind: 'goal' })}
                >
                  + Goal
                </button>,
                branches,
              )
            : 'Loading…'}
        </div>
      </div>
    </section>
  );
}
