'use client';
import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getPlanningRepository, getErrorMessage } from '@/lib/data/repository';
import { matchesSearch } from '@/lib/workspace-view';
import { openPlanningEditor } from './planning-editor';
import { openCalendarEditor } from './calendar-editor-host';
type Result = {
  id: string;
  type: string;
  title: string;
  context: string;
  open: () => void;
  inactive?: boolean;
};
export type SearchFocus = {
  view?: 'active' | 'archived' | 'trash';
  query?: string;
  week?: string;
  key?: number;
};
export function WorkspaceSearch({
  navigate,
}: {
  navigate: (section: string, focus?: SearchFocus) => void;
}) {
  const repo = getPlanningRepository();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [inactive, setInactive] = useState(false);
  const [results, setResults] = useState<Result[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
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
            open: () => openPlanningEditor({ kind: 'goal', id: goal.id }),
          })),
          ...tree.tasks.map((task) => ({
            id: task.id,
            type: 'Task',
            title: task.title,
            context: goalName(task.id),
            open: () => openPlanningEditor({ kind: 'task', id: task.id }),
          })),
          ...calendar.sessions.map((item) => ({
            id: item.id,
            type: item.item_type === 'checklist' ? 'Checklist' : 'Reminder',
            title: item.title,
            context: [
              calendar.tasks.find((task) => task.id === item.task_id)?.title,
              item.task_id ? goalName(item.task_id) : '',
              item.starts_at,
            ]
              .filter(Boolean)
              .join(' · '),
            open: () =>
              openCalendarEditor({ type: item.item_type, id: item.id }),
          })),
          ...tree.milestones.map((item) => ({
            id: item.id,
            type: 'Milestone',
            title: item.title,
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
          ...['Today', 'Calendar', 'Timeline', 'Mindmap', 'Settings'].map(
            (section) => ({
              id: section,
              type: 'Section',
              title: section,
              context:
                section === 'Settings'
                  ? 'Notifications, device, holidays, days off'
                  : '',
              open: () => navigate(section),
            }),
          ),
        ];
        if (extras) {
          for (const goal of [...extras[0], ...extras[1]])
            rows.push({
              id: goal.id,
              type: 'Goal',
              title: goal.title,
              context: goal.deleted_at ? 'Trash' : 'Archived',
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
              title: task.title,
              context: task.deleted_at ? 'Trash' : 'Archived',
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
    matchesSearch(query, item.type, item.title, item.context),
  );
  return (
    <>
      <button
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
            placeholder="Search name, parent, date or review…"
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
                <button
                  key={`${item.type}:${item.id}`}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    item.open();
                  }}
                  className="block w-full border-b p-3 text-left hover:bg-muted"
                >
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {item.type}
                  </span>
                  <strong className="block text-sm">{item.title}</strong>
                  <small className="block truncate text-muted-foreground">
                    {item.context}
                  </small>
                </button>
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
