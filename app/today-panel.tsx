'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, LoaderCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  dateKey,
  expandRecurringSessions,
  startOfMondayWeek,
} from '@/lib/calendar';
import {
  getErrorMessage,
  getPlanningRepository,
  type Task,
  type TodayWorkspace,
} from '@/lib/data/repository';
import { CalendarWeekGrid } from './calendar-week-grid';

export function TodayPanel({
  firstName,
  onOpenTasks,
  onOpenCalendar,
}: {
  firstName: string;
  onOpenTasks: () => void;
  onOpenCalendar: () => void;
}) {
  const repository = getPlanningRepository();
  const [today] = useState(() => new Date());
  const weekStart = useMemo(() => startOfMondayWeek(today), [today]);
  const [workspace, setWorkspace] = useState<TodayWorkspace>({
    goals: [],
    tasks: [],
    statuses: [],
    sessions: [],
    links: [],
    occurrence_states: [],
  });
  const [selectedDay, setSelectedDay] = useState(today);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    try {
      setWorkspace(await repository.getTodayWorkspace());
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
  const todaySessionTaskIds = useMemo(() => {
    const dayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const dayEnd = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + 1,
    );
    return new Set(
      expandRecurringSessions(workspace.sessions, dayStart, dayEnd)
        .map((session) => session.task_id)
        .filter(Boolean),
    );
  }, [today, workspace.sessions]);
  const checklist = workspace.tasks.filter(
    (task) =>
      (task.due_at && dateKey(new Date(task.due_at)) === dateKey(today)) ||
      todaySessionTaskIds.has(task.id),
  );
  async function toggle(task: Task) {
    if (!repository) return;
    const done = Boolean(task.completed_at);
    const next = done
      ? (workspace.statuses.find(
          (status) => status.id === task.previous_status_id,
        ) ?? workspace.statuses.find((status) => status.category === 'planned'))
      : workspace.statuses.find((status) => status.category === 'completed');
    if (!next) return;
    try {
      await repository.updateTask(task.id, {
        workflow_status_id: next.id,
        previous_status_id: done ? null : task.workflow_status_id,
        completed_at: done ? null : new Date().toISOString(),
      });
      await load();
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  return (
    <section aria-labelledby="today-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
            {today.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </p>
          <h1
            id="today-heading"
            className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
          >
            {firstName ? `Hello, ${firstName}.` : 'Hello.'}
          </h1>
        </div>
        <Button onClick={onOpenTasks}>
          <Plus />
          Create task
        </Button>
      </div>
      {message ? (
        <p className="mt-4 rounded-xl border bg-muted p-3 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      {loading ? (
        <div className="grid min-h-[360px] place-items-center">
          <LoaderCircle className="animate-spin text-primary" />
        </div>
      ) : (
        <div className="mt-6 grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="h-fit border bg-card shadow-sm">
            <CardHeader className="border-b">
              <CardTitle>Today reminders</CardTitle>
              <p className="text-xs text-muted-foreground">
                Due today or scheduled in today’s calendar.
              </p>
            </CardHeader>
            <CardContent className="pt-2">
              {checklist.length ? (
                checklist.map((task) => (
                  <label
                    key={task.id}
                    className="flex cursor-pointer items-start gap-3 border-b py-4 last:border-0"
                  >
                    <Checkbox
                      checked={Boolean(task.completed_at)}
                      onCheckedChange={() => void toggle(task)}
                    />
                    <span
                      className={`text-sm font-semibold ${task.completed_at ? 'text-muted-foreground line-through' : ''}`}
                    >
                      {task.title}
                    </span>
                  </label>
                ))
              ) : (
                <div className="grid min-h-48 place-items-center text-center">
                  <div>
                    <CheckCircle2 className="mx-auto size-8 text-primary" />
                    <h2 className="mt-3 text-sm font-semibold">
                      Today is clear
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Add a deadline or calendar session when you are ready.
                    </p>
                    <Button
                      className="mt-4"
                      variant="outline"
                      onClick={onOpenTasks}
                    >
                      Open tasks
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <CalendarClock className="size-4 text-primary" />
                This week
              </h2>
              <Button variant="ghost" size="sm" onClick={onOpenCalendar}>
                Full calendar
              </Button>
            </div>
            <CalendarWeekGrid
              compact
              weekStart={weekStart}
              sessions={workspace.sessions}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
            />
          </div>
        </div>
      )}
    </section>
  );
}
