'use client';
import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { TaskLink } from '@/components/task-link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { openPlanningEditor } from '@/components/planning-editor';
import { openCalendarEditor } from '@/components/calendar-editor-host';
import { OccurrenceEditor } from '@/components/occurrence-editor';
import { useInsightsWorkspace } from '@/components/use-insights-workspace';
import { useShortcutActions } from '@/components/keyboard-shortcuts';
import { matchesSearch } from '@/lib/workspace-view';
import { vietnamDateKey } from '@/lib/calendar';
import {
  buildWeeklyInsights,
  checklistRows,
  taskRows,
  insightDay,
  insightWeek,
  taskDeadline,
  occurrenceOutcome,
  type InsightOccurrence,
  type InsightRow,
  type WeeklyInsights,
} from '@/lib/insights';

type AttentionKey =
  | 'overdueTasks'
  | 'unscheduledTasks'
  | 'tasksWithoutGoal'
  | 'checklistsWithoutGoal';
type Selection =
  | {
      kind: 'weekly';
      key: 'weekly' | 'done' | 'notNeeded' | 'open' | 'overdue';
    }
  | {
      kind: 'goal';
      id: string | null;
      content: 'items' | 'tasks';
      outcome?: 'Done' | 'Not needed' | 'Open' | 'Overdue';
    }
  | { kind: 'attention'; key: AttentionKey };
function selectedRows(
  data: WeeklyInsights,
  selection: Selection,
): InsightRow[] {
  if (selection.kind === 'weekly') return checklistRows(data[selection.key]);
  if (selection.kind === 'goal') {
    const goal = data.byGoal.find((g) => g.id === selection.id);
    return !goal
      ? []
      : selection.content === 'tasks'
        ? taskRows(goal.tasks)
        : checklistRows(
            goal.items.filter(
              (item) =>
                !selection.outcome ||
                (selection.outcome === 'Overdue'
                  ? !item.completed_at &&
                    !item.not_needed_at &&
                    +new Date(item.ends_at) <= +new Date(data.asOf)
                  : occurrenceOutcome(item) === selection.outcome),
            ),
          );
  }
  return selection.key === 'checklistsWithoutGoal'
    ? checklistRows(data.checklistsWithoutGoal)
    : taskRows(data[selection.key]);
}
function initialWeek(value?: string) {
  try {
    return insightWeek(value);
  } catch {
    return insightWeek();
  }
}
const when = (value: string) =>
  new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Ho_Chi_Minh',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

export function InsightsPanel({
  initialWeek: requestedWeek,
}: {
  initialWeek?: string;
}) {
  const { workspace, loading, error, now, refresh } = useInsightsWorkspace();
  const [week, setWeek] = useState(() => initialWeek(requestedWeek));
  const [drill, setDrill] = useState<{
    selection: Selection;
    title: string;
  } | null>(null);
  const [query, setQuery] = useState(''),
    [visibleCount, setVisibleCount] = useState(50);
  const [editingOccurrence, setEditingOccurrence] =
    useState<InsightOccurrence | null>(null);
  const data = useMemo(
    () => (workspace ? buildWeeklyInsights(workspace, week, now) : null),
    [workspace, week, now],
  );
  function changeWeek(next: string) {
    setWeek(insightWeek(next));
    setDrill(null);
  }
  const canEarlier = week > '2000-01-03',
    canLater = week < '2199-12-23';
  useShortcutActions({
    previous: {
      run: () => changeWeek(insightDay(week, -7)),
      enabled: () => canEarlier && !drill,
    },
    next: {
      run: () => changeWeek(insightDay(week, 7)),
      enabled: () => canLater && !drill,
    },
    today: {
      run: () => changeWeek(vietnamDateKey(now)),
      enabled: () => !drill,
    },
  });
  function show(selection: Selection, title: string) {
    setQuery('');
    setVisibleCount(50);
    setDrill({ selection, title });
  }
  function edit(row: InsightRow) {
    setDrill(null);
    if (row.kind === 'task')
      openPlanningEditor({ kind: 'task', id: row.item.id });
    else if (row.item.recurrence !== 'none') setEditingOccurrence(row.item);
    else openCalendarEditor({ type: 'checklist', id: row.item.id });
  }
  const rows = data && drill ? selectedRows(data, drill.selection) : [];
  const filtered = rows.filter((row) => {
    const task =
      row.kind === 'task'
        ? row.item
        : row.item.task_id
          ? data?.tasksById.get(row.item.task_id)
          : undefined;
    const goal =
      task && data?.goalsById.get(data.goalByTask.get(task.id) ?? '');
    return matchesSearch(query, row.item.title, task?.title, goal?.title);
  });
  return (
    <section aria-labelledby="insights-heading" className="min-w-0">
      <h1
        id="insights-heading"
        className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
      >
        Insights
      </h1>
      <div
        className="mt-6 flex flex-wrap items-center gap-2"
        aria-label="Insights week navigation"
      >
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous insights week"
          disabled={!canEarlier}
          onClick={() => changeWeek(insightDay(week, -7))}
        >
          <ArrowLeft />
        </Button>
        <label className="flex items-center gap-2 text-sm">
          Week of
          <input
            aria-label="Insights week"
            type="date"
            min="2000-01-03"
            max="2199-12-31"
            className="h-9 rounded-lg border bg-card px-2"
            value={week}
            onChange={(e) => {
              if (e.target.value && e.target.validity.valid)
                changeWeek(e.target.value);
            }}
          />
        </label>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next insights week"
          disabled={!canLater}
          onClick={() => changeWeek(insightDay(week, 7))}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="outline"
          onClick={() => changeWeek(vietnamDateKey(now))}
        >
          This week
        </Button>
        <Button variant="ghost" disabled={loading} onClick={refresh}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-5 rounded-xl border p-4 text-sm text-destructive"
        >
          Could not load Insights: {error}{' '}
          <button type="button" className="underline" onClick={refresh}>
            Retry
          </button>
        </p>
      ) : !data ? (
        <p role="status" className="mt-6 text-sm text-muted-foreground">
          Loading Insights…
        </p>
      ) : (
        <>
          {loading && (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              Refreshing insights…
            </p>
          )}
          <section aria-labelledby="weekly-overview-heading" className="mt-7">
            <h2
              id="weekly-overview-heading"
              className="text-lg font-semibold"
              title="Current outcomes for checklists starting in the selected week. Each repeat counts separately; later edits can change earlier weeks."
            >
              Weekly overview
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.week} – {insightDay(data.end, -1)} · Vietnam (UTC+7)
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {(
                [
                  [
                    'weekly',
                    'Scheduled',
                    data.weekly.length,
                    'Checklists starting in this week',
                  ],
                  ['done', 'Done', data.done.length, 'Marked as performed'],
                  [
                    'notNeeded',
                    'Not needed',
                    data.notNeeded.length,
                    'Resolved without being performed',
                  ],
                  [
                    'open',
                    'Open',
                    data.open.length,
                    'Includes overdue and upcoming work',
                  ],
                ] as const
              ).map(([key, title, count, note]) => (
                <button
                  key={key}
                  type="button"
                  aria-label={`View ${title} checklists: ${count}`}
                  title={note}
                  onClick={() =>
                    show({ kind: 'weekly', key }, `${title} checklists`)
                  }
                  className="rounded-2xl border bg-card p-4 text-left transition hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span className="text-xs text-muted-foreground">{title}</span>
                  <strong className="mt-2 block text-3xl font-semibold">
                    {count}
                  </strong>
                </button>
              ))}
            </div>
            <div className="mt-4 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span title="Done / Scheduled. Not needed does not increase this rate.">
                  Performed / scheduled{' '}
                  <strong>
                    {data.completionRate === null
                      ? '—'
                      : `${data.completionRate}%`}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    show(
                      { kind: 'weekly', key: 'overdue' },
                      'Overdue checklists in selected week',
                    )
                  }
                  className="rounded px-2 py-1 text-destructive hover:bg-muted"
                >
                  {data.overdue.length} overdue within Open ↗
                </button>
              </div>
              <div
                className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted"
                aria-hidden="true"
              >
                <span
                  className="bg-primary"
                  style={{ width: `${data.completionRate ?? 0}%` }}
                />
                <span
                  className="bg-amber-400"
                  style={{
                    width: `${data.weekly.length ? (data.notNeeded.length / data.weekly.length) * 100 : 0}%`,
                  }}
                />
              </div>
              {!data.weekly.length && (
                <p className="mt-2 text-sm">
                  No scheduled checklists this week.
                </p>
              )}
            </div>
            {data.excludedSeries > 0 && (
              <p
                className="mt-2 text-xs text-muted-foreground"
                title="Checklist series linked to unavailable or cancelled Tasks are excluded. Reminders are not included."
              >
                {data.excludedSeries} excluded series
              </p>
            )}
          </section>
          <section aria-labelledby="goal-insights-heading" className="mt-8">
            <h2
              id="goal-insights-heading"
              className="text-lg font-semibold"
              title="Checklist outcomes for the selected week, grouped by current Task–Goal links. Current Tasks includes parents and children, not Goal progress percentages."
            >
              By Goal
            </h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border bg-card">
              <table className="w-full min-w-[740px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-4">Goal</th>
                    <th className="p-4">Current Tasks</th>
                    <th className="p-4">Scheduled</th>
                    <th className="p-4">Done</th>
                    <th className="p-4">Not needed</th>
                    <th className="p-4">Open</th>
                    <th
                      className="p-4"
                      title="A subset of Open: scheduled end has passed."
                    >
                      Overdue
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.byGoal.map((g) => (
                    <tr
                      key={g.id ?? 'no-goal'}
                      className="border-b last:border-0"
                    >
                      <th className="p-4 text-left font-medium">{g.title}</th>
                      <td className="p-4">
                        <button
                          type="button"
                          className="rounded px-2 py-1 underline decoration-muted-foreground/40 hover:bg-muted"
                          aria-label={`View current Tasks for ${g.title}: ${g.tasks.length}`}
                          onClick={() =>
                            show(
                              { kind: 'goal', id: g.id, content: 'tasks' },
                              `Current Tasks · ${g.title}`,
                            )
                          }
                        >
                          {g.tasks.length}
                        </button>
                      </td>
                      <td className="p-4">
                        <button
                          type="button"
                          className="rounded px-2 py-1 underline decoration-muted-foreground/40 hover:bg-muted"
                          aria-label={`View scheduled checklists for ${g.title}: ${g.items.length}`}
                          onClick={() =>
                            show(
                              { kind: 'goal', id: g.id, content: 'items' },
                              `Scheduled checklists · ${g.title}`,
                            )
                          }
                        >
                          {g.items.length}
                        </button>
                      </td>
                      {(
                        [
                          ['Done', g.done],
                          ['Not needed', g.notNeeded],
                          ['Open', g.open],
                          ['Overdue', g.overdue],
                        ] as const
                      ).map(([outcome, count]) => (
                        <td key={outcome} className="p-4">
                          <button
                            type="button"
                            className="rounded px-2 py-1 underline decoration-muted-foreground/40 hover:bg-muted"
                            aria-label={`View ${outcome} checklists for ${g.title}: ${count}`}
                            onClick={() =>
                              show(
                                {
                                  kind: 'goal',
                                  id: g.id,
                                  content: 'items',
                                  outcome,
                                },
                                `${outcome} checklists · ${g.title}`,
                              )
                            }
                          >
                            {count}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section aria-labelledby="attention-heading" className="mt-8">
            <h2
              id="attention-heading"
              className="text-lg font-semibold"
              title="Task alerts are current; checklist alerts use the selected week. Lists can overlap."
            >
              Needs attention
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              As of {data.today}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(
                [
                  [
                    'overdueTasks',
                    'Overdue Tasks',
                    data.overdueTasks.length,
                    'Open Tasks with a deadline before today.',
                  ],
                  [
                    'unscheduledTasks',
                    'Due soon, no next step',
                    data.unscheduledTasks.length,
                    `Due ${data.today} – ${insightDay(data.horizonEnd, -1)}, without an open upcoming or ongoing checklist before the deadline.`,
                  ],
                  [
                    'tasksWithoutGoal',
                    'Tasks without a Goal',
                    data.tasksWithoutGoal.length,
                    'Current open Tasks without an available Goal.',
                  ],
                  [
                    'checklistsWithoutGoal',
                    'Checklists without a Goal',
                    data.checklistsWithoutGoal.length,
                    'Checklists scheduled in the selected week without an available Goal, including resolved items.',
                  ],
                ] as const
              ).map(([key, title, count, note]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => show({ kind: 'attention', key }, title)}
                  aria-label={`View ${title}: ${count}`}
                  title={note}
                  className="rounded-2xl border bg-card p-4 text-left hover:border-primary"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <strong className="text-xl">{count}</strong>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      <Dialog
        open={!!drill && !!data}
        onOpenChange={(open) => {
          if (!open) setDrill(null);
        }}
      >
        <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{drill?.title}</DialogTitle>
            <DialogDescription>
              {filtered.length} of {rows.length} items
            </DialogDescription>
          </DialogHeader>
          <input
            aria-label="Filter insight items"
            placeholder="Find a Task, checklist or Goal…"
            className="h-10 shrink-0 rounded-lg border bg-background px-3 text-sm"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleCount(50);
            }}
          />
          <div className="min-h-0 overflow-y-auto" aria-label="Insight items">
            {filtered.slice(0, visibleCount).map((row) => {
              const task =
                row.kind === 'task'
                  ? row.item
                  : row.item.task_id
                    ? data?.tasksById.get(row.item.task_id)
                    : undefined;
              const goal =
                task && data?.goalsById.get(data.goalByTask.get(task.id) ?? '');
              return (
                <article
                  key={
                    row.kind === 'task' ? row.item.id : row.item.occurrence_id
                  }
                  className="border-b py-4 last:border-0"
                  data-shortcut-item
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="break-words text-sm font-semibold">
                        {row.item.title}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.kind === 'task'
                          ? `Task · ${row.item.completed_at ? 'Completed' : 'Open'} · Deadline: ${taskDeadline(row.item) ?? 'Not set'}`
                          : `Checklist · ${occurrenceOutcome(row.item)} · ${when(row.item.starts_at)} – ${when(row.item.ends_at)}`}
                      </p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        {row.kind === 'checklist' && task
                          ? `${task.title} · `
                          : ''}
                        {goal?.title ?? 'No available Goal'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <TaskLink
                        task={task}
                        compact={false}
                        className="min-h-9 border px-2 text-primary"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        data-shortcut-action="edit"
                        onClick={() => edit(row)}
                      >
                        {row.kind === 'checklist' &&
                        row.item.recurrence !== 'none'
                          ? 'Edit occurrence'
                          : 'Edit'}
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
            {!filtered.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {rows.length
                  ? 'No matching items.'
                  : 'Nothing here. No action needed.'}
              </p>
            )}
            {filtered.length > visibleCount && (
              <Button
                className="my-3"
                variant="outline"
                onClick={() => setVisibleCount((n) => n + 50)}
              >
                Show more ({filtered.length - visibleCount} remaining)
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {editingOccurrence && (
        <OccurrenceEditor
          key={editingOccurrence.occurrence_id}
          item={editingOccurrence}
          task={data?.tasksById.get(editingOccurrence.task_id ?? '')}
          onClose={() => setEditingOccurrence(null)}
          onEditSeries={() => {
            const id = editingOccurrence.id;
            setEditingOccurrence(null);
            openCalendarEditor({ type: 'checklist', id });
          }}
        />
      )}
    </section>
  );
}
