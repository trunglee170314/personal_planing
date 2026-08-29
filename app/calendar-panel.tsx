'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  addDays,
  dateKey,
  expandRecurringSessions,
  startOfMondayWeek,
  toLocalInput,
  type RecurrenceRule,
} from '@/lib/calendar';
import {
  getErrorMessage,
  getPlanningRepository,
  type CalendarSession,
  type CalendarSessionInput,
  type CalendarWorkspace,
} from '@/lib/data/repository';
import { CalendarWeekGrid } from './calendar-week-grid';

type View = 'day' | 'week' | 'month';
type Draft = {
  id?: string;
  title: string;
  task_id: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  recurrence: RecurrenceRule;
  recurrence_until: string;
  recurrence_interval: number;
};
const emptyDraft = (): Draft => {
  const start = new Date();
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  return {
    title: '',
    task_id: '',
    starts_at: toLocalInput(start),
    ends_at: toLocalInput(new Date(start.getTime() + 3_600_000)),
    all_day: false,
    recurrence: 'none',
    recurrence_until: '',
    recurrence_interval: 2,
  };
};

export function CalendarPanel() {
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<CalendarWorkspace>({
    goals: [],
    tasks: [],
    statuses: [],
    sessions: [],
    links: [],
    occurrence_states: [],
  });
  const [anchor, setAnchor] = useState(new Date());
  const [view, setView] = useState<View>('week');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const weekStart = useMemo(() => startOfMondayWeek(anchor), [anchor]);
  const draftPlanWarning = useMemo(() => {
    if (!draft?.task_id) return false;
    const task = workspace.tasks.find((item) => item.id === draft.task_id);
    if (!task?.planned_start || !task.planned_end) return false;
    const sessionStart = draft.starts_at.slice(0, 10);
    const sessionEnd = draft.ends_at.slice(0, 10);
    return sessionStart < task.planned_start || sessionEnd > task.planned_end;
  }, [draft, workspace.tasks]);

  const load = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    try {
      setWorkspace(await repository.getCalendarWorkspace());
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
  function openCreate(start = new Date(), end = addDays(new Date(), 0)) {
    const next = emptyDraft();
    next.starts_at = toLocalInput(start);
    next.ends_at = toLocalInput(
      end.getTime() > start.getTime()
        ? end
        : new Date(start.getTime() + 3_600_000),
    );
    setDraft(next);
  }
  function openEdit(session: CalendarSession) {
    const baseSession =
      workspace.sessions.find((item) => item.id === session.id) ?? session;
    setDraft({
      id: baseSession.id,
      title: baseSession.title,
      task_id: baseSession.task_id ?? '',
      starts_at: toLocalInput(baseSession.starts_at),
      ends_at: toLocalInput(baseSession.ends_at),
      all_day: baseSession.all_day,
      recurrence: baseSession.recurrence,
      recurrence_until: baseSession.recurrence_until ?? '',
      recurrence_interval: baseSession.recurrence_interval || 1,
    });
  }
  async function save(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository || !draft) return;
    setSaving(true);
    setMessage('');
    const input: CalendarSessionInput = {
      title: draft.title.trim(),
      task_id: draft.task_id || null,
      starts_at: new Date(draft.starts_at).toISOString(),
      ends_at: new Date(draft.ends_at).toISOString(),
      all_day: draft.all_day,
      timezone: 'Asia/Ho_Chi_Minh',
      recurrence: draft.recurrence,
      recurrence_until: draft.recurrence_until || null,
      recurrence_interval: draft.recurrence_interval,
    };
    try {
      if (draft.id) await repository.updateCalendarSession(draft.id, input);
      else await repository.createCalendarSession(input);
      setDraft(null);
      await load();
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!repository || !draft?.id) return;
    await repository.deleteCalendarSession(draft.id);
    setDraft(null);
    await load();
  }
  async function move(session: CalendarSession, start: Date, end: Date) {
    if (!repository) return;
    try {
      await repository.updateCalendarSession(session.id, {
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
      });
      await load();
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  function navigate(direction: number) {
    const next = new Date(anchor);
    if (view === 'month') next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * (view === 'week' ? 7 : 1));
    setAnchor(next);
  }

  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const monthGridStart = startOfMondayWeek(monthStart);
  const monthEnd = addDays(monthGridStart, 42);
  const monthSessions = expandRecurringSessions(
    workspace.sessions,
    monthGridStart,
    monthEnd,
  );
  return (
    <section aria-labelledby="calendar-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
            Commitments in real time
          </p>
          <h1
            id="calendar-heading"
            className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
          >
            Calendar
          </h1>
        </div>
        <Button
          onClick={() =>
            openCreate(new Date(), new Date(Date.now() + 3_600_000))
          }
        >
          <Plus />
          New session
        </Button>
      </div>
      {message ? (
        <p className="mt-4 rounded-xl border bg-muted p-3 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setAnchor(new Date())}>
          Today
        </Button>
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => navigate(1)}>
          <ChevronRight />
        </Button>
        <strong className="mr-auto text-sm">
          {anchor.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          })}
        </strong>
        {(['day', 'week', 'month'] as View[]).map((item) => (
          <Button
            key={item}
            variant={view === item ? 'default' : 'outline'}
            size="sm"
            className="capitalize"
            onClick={() => setView(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      {loading ? (
        <div className="grid min-h-[360px] place-items-center">
          <LoaderCircle className="animate-spin text-primary" />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[270px_minmax(0,1fr)]">
          <aside className="hidden xl:block">
            <div className="rounded-2xl border bg-card p-3">
              <Calendar
                mode="single"
                selected={anchor}
                onSelect={(date) => date && setAnchor(date)}
              />
            </div>
            <p className="mt-3 rounded-xl bg-secondary p-3 text-xs text-secondary-foreground">
              Timezone: Asia/Ho_Chi_Minh · Snap: 15 minutes · Sessions may cross
              midnight.
            </p>
          </aside>
          <div className="min-w-0">
            {view === 'week' ? (
              <CalendarWeekGrid
                weekStart={weekStart}
                sessions={workspace.sessions}
                selectedDay={anchor}
                onSelectDay={setAnchor}
                onCreate={openCreate}
                onEdit={openEdit}
                onMove={move}
              />
            ) : null}
            {view === 'day' ? (
              <CalendarWeekGrid
                dayCount={1}
                weekStart={
                  new Date(
                    anchor.getFullYear(),
                    anchor.getMonth(),
                    anchor.getDate(),
                  )
                }
                sessions={workspace.sessions}
                selectedDay={anchor}
                onCreate={openCreate}
                onEdit={openEdit}
                onMove={move}
              />
            ) : null}
            {view === 'month' ? (
              <div className="grid grid-cols-7 overflow-hidden rounded-2xl border bg-card">
                {Array.from({ length: 42 }, (_, index) =>
                  addDays(monthGridStart, index),
                ).map((day) => {
                  const events = monthSessions.filter(
                    (session) =>
                      dateKey(new Date(session.starts_at)) === dateKey(day),
                  );
                  return (
                    <div
                      key={dateKey(day)}
                      className={`min-h-28 border-b border-r p-2 text-left ${day.getMonth() !== anchor.getMonth() ? 'bg-muted/30 text-muted-foreground' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setAnchor(day);
                          setView('day');
                        }}
                        className="text-xs font-semibold"
                      >
                        {day.getDate()}
                      </button>
                      {events.slice(0, 3).map((session) => (
                        <button
                          type="button"
                          key={session.occurrence_id}
                          onClick={() => openEdit(session)}
                          className="mt-1 block w-full truncate rounded bg-primary px-1.5 py-1 text-left text-[10px] text-primary-foreground"
                        >
                          {session.title}
                        </button>
                      ))}
                      {events.length > 3 ? (
                        <small>+{events.length - 3} more</small>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      )}
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => !open && setDraft(null)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? 'Edit session' : 'New calendar session'}
            </DialogTitle>
            <DialogDescription>
              Schedule a real work block; this does not change the task deadline
              or Gantt dates.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
              <label className="text-xs font-semibold sm:col-span-2">
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
              <label className="text-xs font-semibold sm:col-span-2">
                Task (optional)
                <select
                  value={draft.task_id}
                  onChange={(event) => {
                    const task = workspace.tasks.find(
                      (item) => item.id === event.target.value,
                    );
                    setDraft({
                      ...draft,
                      task_id: event.target.value,
                      title: draft.title || task?.title || '',
                    });
                  }}
                  className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                >
                  <option value="">Standalone session</option>
                  {workspace.tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold">
                Start
                <input
                  type="datetime-local"
                  step="60"
                  required
                  value={draft.starts_at}
                  onChange={(event) =>
                    setDraft({ ...draft, starts_at: event.target.value })
                  }
                  className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                />
              </label>
              <label className="text-xs font-semibold">
                End
                <input
                  type="datetime-local"
                  step="60"
                  required
                  min={draft.starts_at}
                  value={draft.ends_at}
                  onChange={(event) =>
                    setDraft({ ...draft, ends_at: event.target.value })
                  }
                  className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold">
                <input
                  type="checkbox"
                  checked={draft.all_day}
                  onChange={(event) =>
                    setDraft({ ...draft, all_day: event.target.checked })
                  }
                />
                All day
              </label>
              <label className="text-xs font-semibold">
                Repeat
                <select
                  value={draft.recurrence}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      recurrence: event.target.value as RecurrenceRule,
                    })
                  }
                  className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                >
                  <option value="none">Does not repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="custom">Custom interval</option>
                </select>
              </label>
              {draft.recurrence === 'custom' ? (
                <label className="text-xs font-semibold">
                  Repeat every (days)
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={draft.recurrence_interval}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        recurrence_interval: Number(event.target.value),
                      })
                    }
                    className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                  />
                </label>
              ) : null}
              {draft.recurrence !== 'none' ? (
                <label className="text-xs font-semibold sm:col-span-2">
                  Repeat until
                  <input
                    type="date"
                    value={draft.recurrence_until}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        recurrence_until: event.target.value,
                      })
                    }
                    className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
                  />
                </label>
              ) : null}
              <p className="text-xs text-muted-foreground sm:col-span-2">
                <CalendarDays className="mr-1 inline size-3" />
                Asia/Ho_Chi_Minh
              </p>
              {draftPlanWarning ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 sm:col-span-2">
                  This session is outside the task’s planned Gantt range. It is
                  allowed and will not change that range.
                </p>
              ) : null}
              <DialogFooter className="sm:col-span-2">
                {draft.id ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void remove()}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                ) : null}
                <Button type="submit" disabled={saving}>
                  {saving ? <LoaderCircle className="animate-spin" /> : null}
                  Save session
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
