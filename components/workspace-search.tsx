'use client';
import { TaskLink } from './task-link';
import { calendarSearchItems } from '@/lib/calendar-search';
import type { TaskLinkSource } from '@/lib/task-links';
import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getPlanningRepository, getErrorMessage } from '@/lib/data/repository';
import {
  matchesPlanningSearch,
  planningContext,
  planningBreadcrumb,
} from '@/lib/planning-context';
import { openPlanningEditor } from './planning-editor';
import { openCalendarEditor } from './calendar-editor-host';
import { useShortcutActions } from './keyboard-shortcuts';
type Result = {
  id: string;
  type: string;
  title: string;
  context: string;
  goal?: string;
  parentTask?: string;
  open: () => void;
  inactive?: boolean;
  task?: TaskLinkSource;
};
export type SearchFocus = {
  mapId?: string;
  view?: 'active' | 'archived' | 'trash';
  query?: string;
  week?: string;
  key?: number;
};
export function WorkspaceSearch({
  navigate,
  hidden = false,
}: {
  navigate: (section: string, focus?: SearchFocus) => void;
  hidden?: boolean;
}) {
  const repo = getPlanningRepository();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [inactive, setInactive] = useState(false);
  const [results, setResults] = useState<Result[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  useShortcutActions({
    search: {
      run: () => {
        setLoading(true);
        setError('');
        setOpen(true);
      },
    },
  });
  useEffect(() => {
    if (!open || !repo) return;
    let active = true;
    void Promise.all([
      repo.getTimelineWorkspace(),
      repo.getCalendarWorkspace(),
      repo.getPomodoroWorkspace(),
      repo.getReviewsWorkspace('2000-01-01', '2200-12-31'),
      inactive
        ? Promise.all([
            repo.listGoals('archived'),
            repo.listGoals('trash'),
            repo.getTaskWorkspace('archived'),
            repo.getTaskWorkspace('trash'),
          ])
        : null,
    ])
      .then(([tree, calendar, pomodoro, reviews, extras]) => {
        if (!active) return;
        const goalName = (taskId: string) =>
          tree.goals.find((goal) =>
            tree.links.some(
              (link) => link.task_id === taskId && link.goal_id === goal.id,
            ),
          )?.title ?? 'No goal';
        const rows: Result[] = [
          ...tree.goals.map((goal) => ({
            id: goal.id,
            type: 'Goal',
            title: goal.title,
            context: goal.description ?? '',
            goal: goal.title,
            open: () => openPlanningEditor({ kind: 'goal', id: goal.id }),
          })),
          ...tree.tasks.map((task) => ({
            id: task.id,
            type: 'Task',
            task,
            title: task.title,
            context: goalName(task.id),
            goal: planningContext(tree, task.id).goal,
            parentTask: task.title,
            open: () => openPlanningEditor({ kind: 'task', id: task.id }),
          })),
          ...calendarSearchItems(calendar).map((item) => ({
            id: item.search_id,
            type: item.item_type === 'checklist' ? 'Checklist' : 'Reminder',
            task:
              item.item_type === 'checklist'
                ? calendar.tasks.find((task) => task.id === item.task_id)
                : undefined,
            title: item.title,
            context: [
              planningBreadcrumb(planningContext(calendar, item.task_id)),
              item.starts_at,
            ]
              .filter(Boolean)
              .join(' · '),
            goal: planningContext(calendar, item.task_id).goal,
            parentTask: planningContext(calendar, item.task_id).task,
            open: () =>
              openCalendarEditor({
                type: item.item_type,
                id: item.id,
                occurrenceStart: item.occurrence_start,
              }),
          })),
          ...tree.milestones.map((item) => ({
            id: item.id,
            type: 'Milestone',
            task: tree.tasks.find((task) => task.id === item.task_id),
            title: item.title,
            goal:
              tree.goals.find((goal) => goal.id === item.goal_id)?.title ??
              planningContext(tree, item.task_id).goal,
            parentTask: planningContext(tree, item.task_id).task,
            context: [
              tree.tasks.find((task) => task.id === item.task_id)?.title,
              tree.goals.find((goal) => goal.id === item.goal_id)?.title,
              item.milestone_on,
            ]
              .filter(Boolean)
              .join(' · '),
            open: () => openPlanningEditor({ kind: 'milestone', id: item.id }),
          })),
          ...reviews.reviews.map((review) => ({
            id: review.id,
            type: 'Review',
            title: `Week ${review.week_start}`,
            context: [
              review.wins,
              review.challenges,
              review.next_week_focus,
            ].join(' · '),
            open: () => navigate('Reviews', { week: review.week_start }),
          })),
          ...pomodoro.sessions.map((item) => ({
            id: item.id,
            type: 'Pomodoro',
            title: `Focus · ${item.duration_minutes} min`,
            context: item.completed_at,
            open: () => navigate('Pomodoro', { query: item.completed_at }),
          })),
          ...[
            'Today',
            'Calendar',
            'Timeline',
            'Mindmap',
            'Insights',
            'Settings',
          ].map((section) => ({
            id: section,
            type: 'Section',
            title: section,
            context:
              section === 'Settings'
                ? 'Notifications, device, holidays, days off'
                : '',
            open: () => navigate(section),
          })),
        ];
        if (extras) {
          const inactiveTree = {
            goals: [
              ...tree.goals,
              ...extras[0],
              ...extras[1],
              ...extras[2].goals,
              ...extras[3].goals,
            ],
            tasks: [...extras[2].tasks, ...extras[3].tasks],
            links: [...extras[2].links, ...extras[3].links],
          };
          for (const goal of [...extras[0], ...extras[1]])
            rows.push({
              id: goal.id,
              type: 'Goal',
              title: goal.title,
              context: goal.deleted_at ? 'Trash' : 'Archived',
              goal: goal.title,
              inactive: true,
              open: () =>
                navigate('Goals', {
                  view: goal.deleted_at ? 'trash' : 'archived',
                  query: goal.title,
                }),
            });
          for (const task of [...extras[2].tasks, ...extras[3].tasks])
            rows.push({
              id: task.id,
              type: 'Task',
              task,
              title: task.title,
              context: [
                task.deleted_at ? 'Trash' : 'Archived',
                planningBreadcrumb(planningContext(inactiveTree, task.id)),
              ]
                .filter(Boolean)
                .join(' · '),
              goal: planningContext(inactiveTree, task.id).goal,
              parentTask: task.title,
              inactive: true,
              open: () =>
                navigate('Tasks', {
                  view: task.deleted_at ? 'trash' : 'archived',
                  query: task.title,
                }),
            });
        }
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
  }, [open, repo, inactive, navigate]);
  const filtered = results.filter((item) =>
    matchesPlanningSearch(
      query,
      { goal: item.goal, task: item.parentTask },
      item.type,
      item.title,
      item.context,
    ),
  );
  return (
    <>
      <button
        hidden={hidden}
        type="button"
        onClick={() => {
          setLoading(true);
          setError('');
          setOpen(true);
        }}
        className="mb-3 w-full rounded-xl border bg-card px-4 py-2 text-left text-sm text-muted-foreground"
      >
        Search all sections…
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Search workspace</DialogTitle>
          </DialogHeader>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder='Search title, Goal, Task or goal:"Career"…'
            aria-label="Search all sections"
            className="rounded-lg border bg-background p-3"
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={inactive}
              onChange={(event) => setInactive(event.target.checked)}
            />{' '}
            Include Archived and Trash (open section to restore)
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <div className="max-h-[55dvh] overflow-auto">
            {loading ? (
              <p className="p-4 text-sm">Loading workspace…</p>
            ) : filtered.length ? (
              filtered.slice(0, 100).map((item) => (
                <div
                  key={`${item.type}:${item.id}`}
                  className="flex items-center border-b pr-3 hover:bg-muted"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      item.open();
                    }}
                    className="block min-w-0 flex-1 p-3 text-left"
                  >
                    <span className="text-[10px] uppercase text-muted-foreground">
                      {item.type}
                    </span>
                    <strong className="block text-sm">{item.title}</strong>
                    <small className="block truncate text-muted-foreground">
                      {item.context}
                    </small>
                  </button>
                  <TaskLink task={item.task} />
                </div>
              ))
            ) : (
              <p className="p-4 text-sm">No matches.</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {filtered.length} matches
            {filtered.length > 100
              ? ' · Showing first 100; narrow your search.'
              : ''}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
