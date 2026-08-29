'use client';

import { patchOccurrence, sameOccurrenceTime } from '@/lib/occurrence-state';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Clock3, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  addDays,
  expandRecurringSessions,
  vietnamDateKey,
  vietnamInputToIso,
} from '@/lib/calendar';
import {
  getErrorMessage,
  getPlanningRepository,
  type CalendarSession,
  type TodayWorkspace,
} from '@/lib/data/repository';
import {
  announceDataChanged,
  dataChangeSource,
  MYPLAN_DATA_CHANGED,
} from '@/lib/data/data-events';
import { PlannerCalendar } from './planner-calendar';

export function TodayPanelV2({
  firstName,
  onOpenCalendar,
}: {
  firstName: string;
  onOpenCalendar: () => void;
}) {
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<TodayWorkspace>({
    goals: [],
    tasks: [],
    statuses: [],
    sessions: [],
    links: [],
    occurrence_states: [],
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [today, setToday] = useState(() => new Date());
  const sourceRef = useRef('today-reminders');
  const mutationVersionsRef = useRef(new Map<string, number>());
  const mutationEpochRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const deferredSyncRef = useRef(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const load = useCallback(async () => {
    if (!repository) return;
    const startedAtEpoch = mutationEpochRef.current;
    try {
      const next = await repository.getTodayWorkspace();
      if (
        startedAtEpoch !== mutationEpochRef.current ||
        pendingMutationsRef.current > 0
      ) {
        deferredSyncRef.current = true;
        return;
      }
      setWorkspace(next);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [repository]);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    const sync = (event: Event) => {
      if (dataChangeSource(event) === sourceRef.current) return;
      if (pendingMutationsRef.current > 0) {
        deferredSyncRef.current = true;
        return;
      }
      void load();
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => {
      window.clearTimeout(handle);
      window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
    };
  }, [load]);
  useEffect(() => {
    const handle = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(handle);
  }, []);
  const outstanding = useMemo(() => {
    const tomorrow = addDays(
      new Date(vietnamInputToIso(`${vietnamDateKey(today)}T00:00`)),
      1,
    );
    const oldest = workspace.sessions.reduce(
      (minimum, item) => Math.min(minimum, new Date(item.starts_at).getTime()),
      today.getTime(),
    );
    return expandRecurringSessions(
      workspace.sessions,
      new Date(oldest),
      tomorrow,
      workspace.occurrence_states,
    )
      .filter(
        (item) =>
          !item.completed_at &&
          !item.not_needed_at &&
          vietnamDateKey(item.starts_at) <= vietnamDateKey(today),
      )
      .sort(
        (a, b) =>
          Number(b.is_pinned) - Number(a.is_pinned) ||
          new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
      );
  }, [today, workspace.occurrence_states, workspace.sessions]);
  async function toggle(item: CalendarSession & { occurrence_start?: string }) {
    if (!repository) return;
    setMessage('');
    const mutationKey = `${item.id}:${item.occurrence_start ?? item.starts_at}`;
    const version = (mutationVersionsRef.current.get(mutationKey) ?? 0) + 1;
    mutationVersionsRef.current.set(mutationKey, version);
    mutationEpochRef.current += 1;
    pendingMutationsRef.current += 1;
    const previousSession = workspace.sessions.find(
      (session) => session.id === item.id,
    );
    const previousOccurrence = workspace.occurrence_states.find(
      (state) =>
        state.calendar_entry_id === item.id &&
        sameOccurrenceTime(state.occurrence_start, item.occurrence_start),
    );
    const completed_at = new Date().toISOString();
    setWorkspace((current) =>
      item.recurrence !== 'none' && item.occurrence_start
        ? {
            ...current,
            occurrence_states: patchOccurrence(
              current.occurrence_states,
              item.id,
              item.occurrence_start,
              { completed_at, not_needed_at: null },
            ),
          }
        : {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === item.id ? { ...session, completed_at } : session,
            ),
          },
    );
    try {
      if (item.recurrence !== 'none' && item.occurrence_start)
        await repository.updateCalendarOccurrence(
          item.id,
          item.occurrence_start,
          { completed_at, not_needed_at: null },
        );
      else
        await repository.updateCalendarSession(item.id, {
          completed_at,
          not_needed_at: null,
        });
      announceDataChanged(sourceRef.current);
    } catch (error) {
      if (mutationVersionsRef.current.get(mutationKey) === version)
        setWorkspace((current) => ({
          ...current,
          sessions: previousSession
            ? current.sessions.map((session) =>
                session.id === item.id ? previousSession : session,
              )
            : current.sessions,
          occurrence_states:
            item.recurrence !== 'none' && item.occurrence_start
              ? patchOccurrence(
                  current.occurrence_states,
                  item.id,
                  item.occurrence_start,
                  {
                    completed_at: previousOccurrence?.completed_at ?? null,
                    not_needed_at: previousOccurrence?.not_needed_at ?? null,
                  },
                )
              : current.occurrence_states,
        }));
      setMessage(getErrorMessage(error));
    } finally {
      pendingMutationsRef.current = Math.max(
        0,
        pendingMutationsRef.current - 1,
      );
      if (pendingMutationsRef.current === 0 && deferredSyncRef.current) {
        deferredSyncRef.current = false;
        void loadRef.current?.();
      }
    }
  }
  return (
    <section aria-labelledby="today-heading">
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
      {message ? (
        <p
          className="mt-4 rounded-xl border bg-muted p-3 text-xs"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}
      <div className="mt-6 grid items-stretch gap-5 lg:grid-cols-[minmax(280px,28%)_minmax(0,1fr)]">
        <div className="grid min-h-0 gap-4 lg:h-0 lg:min-h-full lg:grid-rows-2">
          {(['checklist', 'reminder'] as const).map((kind) => {
            const reminders = outstanding.filter(
              (item) => item.item_type === kind,
            );
            const label = kind === 'checklist' ? 'checklists' : 'reminders';
            return (
              <Card
                key={kind}
                className="flex min-h-0 flex-col overflow-hidden border bg-card shadow-sm"
              >
                <CardHeader className="border-b">
                  <CardTitle className="flex items-center gap-2">
                    <BellRing className="size-4 text-destructive" />
                    Today {label}{' '}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {reminders.length}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-y-auto pt-2">
                  {loading ? (
                    <div className="grid min-h-48 place-items-center">
                      <LoaderCircle className="animate-spin text-primary" />
                    </div>
                  ) : reminders.length ? (
                    reminders.slice(0, 100).map((item) => {
                      const overdue = new Date(item.starts_at) < today;
                      return (
                        <div
                          key={item.occurrence_id}
                          className="flex items-start gap-3 border-b py-4 last:border-0"
                        >
                          <Checkbox
                            checked={false}
                            onCheckedChange={() => void toggle(item)}
                            aria-label={`Complete ${item.title}`}
                          />
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-sm">
                              {item.title}
                            </strong>
                            <small
                              className={`mt-1 flex items-center gap-1 ${overdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}
                            >
                              <Clock3 className="size-3" />
                              {overdue ? 'Overdue · ' : ''}
                              {new Date(item.starts_at).toLocaleString([], {
                                month:
                                  vietnamDateKey(item.starts_at) ===
                                  vietnamDateKey(today)
                                    ? undefined
                                    : 'short',
                                day:
                                  vietnamDateKey(item.starts_at) ===
                                  vietnamDateKey(today)
                                    ? undefined
                                    : 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                timeZone: 'Asia/Ho_Chi_Minh',
                              })}
                            </small>
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="grid min-h-48 place-items-center text-center">
                      <div>
                        <BellRing className="mx-auto size-8 text-muted-foreground" />
                        <h2 className="mt-3 text-sm font-semibold">
                          No {label} today
                        </h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                          No unresolved {label} due today or earlier.
                        </p>
                      </div>
                    </div>
                  )}
                  {reminders.length > 100 ? (
                    <Button
                      variant="ghost"
                      className="mt-2 w-full"
                      onClick={onOpenCalendar}
                    >
                      View all {reminders.length} {label}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
        <div className="min-w-0 overflow-hidden">
          <PlannerCalendar embedded />
        </div>
      </div>
    </section>
  );
}
