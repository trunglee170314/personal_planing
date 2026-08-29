'use client';
import {
  Children,
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
  type CalendarSession,
} from '@/lib/data/repository';
import {
  MYPLAN_DATA_CHANGED,
  announceDataChanged,
  dataChangeSource,
} from '@/lib/data/data-events';
import { goalColorValue } from '@/lib/colors';
import { matchesSearch } from '@/lib/workspace-view';
import { guardPlanningPointer } from '@/lib/pointer-actions';
import { dateKey, nearestRecurringOccurrence } from '@/lib/calendar';
import { patchOccurrence } from '@/lib/occurrence-state';

type Layout = 'horizontal' | 'vertical' | 'radial' | 'outline';

export function MindmapPanel() {
  const repo = getPlanningRepository();
  const [workspace, setWorkspace] = useState<TimelineWorkspace | null>(null);
  const [calendar, setCalendar] = useState<CalendarWorkspace | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [query, setQuery] = useState('');
  const [pendingToggles, setPendingToggles] = useState(new Set<string>());
  const [layout, setLayout] = useState<Layout>(() => {
    if (typeof window === 'undefined') return 'horizontal';
    const saved = window.localStorage.getItem(
      'myplan-mindmap-layout',
    ) as Layout | null;
    return saved &&
      ['horizontal', 'vertical', 'radial', 'outline'].includes(saved)
      ? saved
      : 'horizontal';
  });
  const viewport = useRef<HTMLDivElement>(null);
  const loadRequestRef = useRef(0);
  const pendingToggleRef = useRef(new Set<string>());
  const pan = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const load = useCallback(async () => {
    if (!repo) return;
    const request = ++loadRequestRef.current;
    try {
      const [tree, items] = await Promise.all([
        repo.getTimelineWorkspace(),
        repo.getCalendarWorkspace(),
      ]);
      if (request !== loadRequestRef.current) return;
      setWorkspace(tree);
      setCalendar(items);
    } catch (cause) {
      if (request === loadRequestRef.current) setError(getErrorMessage(cause));
    }
  }, [repo]);
  useEffect(
    () => window.localStorage.setItem('myplan-mindmap-layout', layout),
    [layout],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const sync = (event: Event) => {
      if (
        dataChangeSource(event) !== 'mindmap' &&
        pendingToggleRef.current.size === 0
      )
        void load();
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
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
      await load();
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }
  async function toggleTask(task: Task) {
    if (!repo || !workspace) return;
    const pendingKey = `task:${task.id}`;
    if (pendingToggleRef.current.size) return;
    const completed = Boolean(task.completed_at);
    if (
      !completed &&
      task.active_checklist_count > task.checklist_resolved_count &&
      !window.confirm(
        `Complete “${task.title}”? Its unfinished checklists will be marked Not needed.`,
      )
    )
      return;
    pendingToggleRef.current.add(pendingKey);
    loadRequestRef.current += 1;
    setPendingToggles((current) => new Set(current).add(pendingKey));
    setWorkspace({
      ...workspace,
      tasks: workspace.tasks.map((item) =>
        item.id === task.id
          ? {
              ...item,
              completed_at: completed ? null : new Date().toISOString(),
              progress: completed ? item.progress : 100,
              workflow_status_id: completed
                ? (item.previous_status_id ??
                  workspace.statuses.find(
                    (status) => status.category === 'planned',
                  )?.id ??
                  item.workflow_status_id)
                : (workspace.statuses.find(
                    (status) => status.category === 'completed',
                  )?.id ?? item.workflow_status_id),
              previous_status_id: completed ? null : item.workflow_status_id,
            }
          : item,
      ),
    });
    try {
      await repo.setTaskCompletion(task.id, !completed);
      announceDataChanged('mindmap');
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      pendingToggleRef.current.delete(pendingKey);
      setPendingToggles((current) => {
        const next = new Set(current);
        next.delete(pendingKey);
        return next;
      });
      await load();
    }
  }
  function checklistTarget(session: CalendarSession) {
    if (!calendar) return null;
    if (session.recurrence === 'none')
      return {
        occurrence_start: session.starts_at,
        completed_at: session.completed_at,
      };
    return nearestRecurringOccurrence(
      session,
      new Date(`${dateKey(new Date())}T00:00:00+07:00`),
      calendar.occurrence_states,
    );
  }
  async function toggleChecklist(session: CalendarSession) {
    if (!repo || !calendar) return;
    const pendingKey = `checklist:${session.id}`;
    if (pendingToggleRef.current.size) return;
    const target = checklistTarget(session);
    if (!target) {
      setError('No current or future occurrence is available.');
      return;
    }
    const completed = Boolean(target.completed_at);
    const completedAt = completed ? null : new Date().toISOString();
    pendingToggleRef.current.add(pendingKey);
    loadRequestRef.current += 1;
    setPendingToggles((current) => new Set(current).add(pendingKey));
    setCalendar((current) =>
      !current
        ? current
        : session.recurrence === 'none'
          ? {
              ...current,
              sessions: current.sessions.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      completed_at: completedAt,
                      not_needed_at: null,
                    }
                  : item,
              ),
            }
          : {
              ...current,
              occurrence_states: patchOccurrence(
                current.occurrence_states,
                session.id,
                target.occurrence_start,
                { completed_at: completedAt, not_needed_at: null },
              ),
            },
    );
    try {
      if (session.recurrence === 'none')
        await repo.updateCalendarSession(session.id, {
          completed_at: completedAt,
          not_needed_at: null,
        });
      else
        await repo.updateCalendarOccurrence(
          session.id,
          target.occurrence_start,
          { completed_at: completedAt, not_needed_at: null },
        );
      announceDataChanged('mindmap');
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      pendingToggleRef.current.delete(pendingKey);
      setPendingToggles((current) => {
        const next = new Set(current);
        next.delete(pendingKey);
        return next;
      });
      await load();
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
    resolved = false,
  ) {
    const wrapper =
      layout === 'horizontal'
        ? 'flex items-center gap-6'
        : layout === 'vertical'
          ? 'flex flex-col items-center gap-4'
          : layout === 'radial'
            ? 'flex flex-col items-center gap-5'
            : 'flex items-start gap-3';
    const branch =
      layout === 'horizontal'
        ? 'relative grid gap-4 border-l-2 pl-6'
        : layout === 'vertical'
          ? 'relative flex items-start gap-4 border-t-2 pt-5'
          : layout === 'radial'
            ? 'relative grid grid-cols-2 items-start gap-8 rounded-full border-t-2 pt-5'
            : 'relative grid gap-2 border-l-2 pl-4';
    const node = (
      <div
        data-node
        className={`${layout === 'outline' ? 'w-56 p-2' : 'w-64 p-3'} shrink-0 rounded-xl border bg-card shadow-sm ${resolved ? 'opacity-65' : ''} ${query && !matchesSearch(query, title, kind) ? 'opacity-40' : ''}`}
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
          className={`w-full break-words text-left text-sm font-semibold ${resolved ? 'line-through' : ''}`}
          title={title}
        >
          {title}
        </button>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">{actions}</div>
      </div>
    );
    if (
      layout === 'radial' &&
      id === 'myplan' &&
      children &&
      !collapsed.has(id)
    ) {
      const branches = Children.toArray(children);
      const radius = Math.max(300, branches.length * 54);
      const size = radius * 2 + 360;
      return (
        <div
          key={id}
          className="relative shrink-0"
          style={{ width: size, height: size }}
        >
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            {node}
          </div>
          {branches.map((child, index) => {
            const angle = (index * 360) / Math.max(1, branches.length) - 90;
            return (
              <div
                key={index}
                className="absolute left-1/2 top-1/2 origin-left"
                style={{
                  transform: `rotate(${angle}deg) translateX(${radius}px) rotate(${-angle}deg)`,
                }}
              >
                {child}
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div key={id} className={wrapper}>
        {node}
        {children && !collapsed.has(id) ? (
          <div className={branch}>{children}</div>
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
        <label className="flex items-center gap-1 font-medium">
          <input
            type="checkbox"
            checked={Boolean(task.completed_at)}
            disabled={pendingToggles.size > 0}
            onChange={() => void toggleTask(task)}
          />
          {workspace?.statuses
            .find((status) => status.id === task.workflow_status_id)
            ?.category.replaceAll('_', ' ') ?? task.workflow_status_id}
        </label>
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
              <>
                <label className="flex items-center gap-1 font-medium">
                  <input
                    type="checkbox"
                    checked={Boolean(checklistTarget(item)?.completed_at)}
                    disabled={pendingToggles.size > 0}
                    onChange={() => void toggleChecklist(item)}
                  />{' '}
                  Done
                </label>
                <button
                  type="button"
                  onClick={() => void remove('checklist', item.id, item.title)}
                >
                  Remove
                </button>
              </>,
              undefined,
              Boolean(checklistTarget(item)?.completed_at),
            ),
          )}
        </>
      ) : undefined,
      Boolean(task.completed_at),
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
      <fieldset
        className="mb-4 flex flex-wrap gap-2"
        aria-label="Mindmap layout"
      >
        {(['horizontal', 'vertical', 'radial', 'outline'] as Layout[]).map(
          (item) => (
            <Button
              key={item}
              size="sm"
              variant={layout === item ? 'default' : 'outline'}
              aria-pressed={layout === item}
              onClick={() => setLayout(item)}
              className="capitalize"
            >
              {item}
            </Button>
          ),
        )}
      </fieldset>
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
                'The Plan',
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
