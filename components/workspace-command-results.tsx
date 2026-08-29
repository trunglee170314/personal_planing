'use client';
import { TaskLink } from './task-link';
import { calendarSearchItems } from '@/lib/calendar-search';
import type { TaskLinkSource } from '@/lib/task-links';
import { useEffect, useState } from 'react';
import { getPlanningRepository, getErrorMessage } from '@/lib/data/repository';
import { systemMaps } from '@/lib/data/system-maps';
import {
  matchesPlanningSearch,
  planningContext,
  planningBreadcrumb,
} from '@/lib/planning-context';
import { openPlanningEditor } from './planning-editor';
import { openCalendarEditor } from './calendar-editor-host';
import type { SearchFocus } from './workspace-search';
type Result = {
  id: string;
  title: string;
  context: string;
  goal?: string;
  parentTask?: string;
  kind: string;
  open: () => void;
  task?: TaskLinkSource;
};
export function WorkspaceCommandResults({
  query,
  navigate,
  close,
}: {
  query: string;
  navigate: (section: string, focus?: SearchFocus) => void;
  close: () => void;
}) {
  const repo = getPlanningRepository();
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!repo) return;
    void Promise.all([
      repo.getTimelineWorkspace(),
      repo.getCalendarWorkspace(),
      repo.getReviewsWorkspace('2000-01-01', '2200-12-31'),
      systemMaps.list(),
    ])
      .then(([tree, calendar, reviews, maps]) => {
        if (!active) return;
        const rows: Result[] = [
          ...tree.goals.map((g) => ({
            id: g.id,
            title: g.title,
            context: g.description ?? '',
            goal: g.title,
            kind: 'Goal',
            open: () => openPlanningEditor({ kind: 'goal', id: g.id }),
          })),
          ...tree.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            context:
              tree.goals.find((g) =>
                tree.links.some(
                  (l) => l.goal_id === g.id && l.task_id === t.id,
                ),
              )?.title ?? 'Inbox',
            goal: planningContext(tree, t.id).goal,
            parentTask: t.title,
            kind: 'Task',
            task: t,
            open: () => openPlanningEditor({ kind: 'task', id: t.id }),
          })),
          ...tree.milestones.map((m) => ({
            id: m.id,
            title: m.title,
            context: [
              planningBreadcrumb(planningContext(tree, m.task_id)) ||
                tree.goals.find((goal) => goal.id === m.goal_id)?.title,
              m.milestone_on,
            ]
              .filter(Boolean)
              .join(' · '),
            goal:
              tree.goals.find((goal) => goal.id === m.goal_id)?.title ??
              planningContext(tree, m.task_id).goal,
            parentTask: planningContext(tree, m.task_id).task,
            kind: 'Milestone',
            task: tree.tasks.find((task) => task.id === m.task_id),
            open: () => openPlanningEditor({ kind: 'milestone', id: m.id }),
          })),
          ...calendarSearchItems(calendar).map((s) => ({
            id: s.search_id,
            title: s.title,
            context: [
              planningBreadcrumb(planningContext(calendar, s.task_id)),
              s.starts_at,
            ]
              .filter(Boolean)
              .join(' · '),
            goal: planningContext(calendar, s.task_id).goal,
            parentTask: planningContext(calendar, s.task_id).task,
            kind: s.item_type === 'checklist' ? 'Checklist' : 'Reminder',
            task:
              s.item_type === 'checklist'
                ? calendar.tasks.find((task) => task.id === s.task_id)
                : undefined,
            open: () =>
              openCalendarEditor({
                type: s.item_type,
                id: s.id,
                occurrenceStart: s.occurrence_start,
              }),
          })),
          ...reviews.reviews.map((r) => ({
            id: r.id,
            title: `Week of ${r.week_start}`,
            context: `${r.wins} ${r.challenges} ${r.next_week_focus}`,
            kind: 'Review',
            open: () => navigate('Reviews', { week: r.week_start }),
          })),
          ...maps.map((m) => ({
            id: m.id,
            title: m.name,
            context: 'Independent map',
            kind: 'System Map',
            open: () => navigate('System Map', { mapId: m.id }),
          })),
        ];
        setResults(rows);
      })
      .catch((cause) => {
        if (active) setError(getErrorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repo, navigate]);
  const filtered = results.filter((r) =>
    matchesPlanningSearch(
      query,
      { goal: r.goal, task: r.parentTask },
      r.kind,
      r.title,
      r.context,
    ),
  );
  return (
    <section
      aria-label="Workspace search results"
      className="space-y-2 border-t pt-3"
    >
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">
        Workspace data
      </h3>
      {loading ? (
        <p className="text-sm">Loading workspace…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <>
          {filtered.slice(0, 50).map((r) => (
            <div
              key={`${r.kind}:${r.id}`}
              className="flex items-center rounded-lg pr-3 hover:bg-muted"
            >
              <button
                type="button"
                className="block min-w-0 flex-1 p-3 text-left"
                onClick={() => {
                  close();
                  requestAnimationFrame(r.open);
                }}
              >
                <small className="text-muted-foreground">{r.kind}</small>
                <strong className="block text-sm">{r.title}</strong>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.context}
                </span>
              </button>
              <TaskLink task={r.task} />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {filtered.length} matches
            {filtered.length > 50
              ? ' · Showing first 50; narrow your search.'
              : ''}
          </p>
        </>
      )}
    </section>
  );
}
