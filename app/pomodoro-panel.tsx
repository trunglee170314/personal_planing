'use client';
import { matchesSearch } from '@/lib/workspace-view';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Save,
  TimerReset,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  completeIfElapsed,
  createTimer,
  pauseTimer,
  remainingAt,
  resetTimer,
  startTimer,
  type PomodoroTimer,
} from '@/lib/pomodoro';
import { dateKey } from '@/lib/calendar';
import {
  defaultPomodoroSettings,
  getErrorMessage,
  getPlanningRepository,
  type PomodoroSession,
  type PomodoroSettings,
} from '@/lib/data/repository';

type Mode = 'focus' | 'short' | 'long';
const storageKey = 'myplan-active-pomodoro-v2';
function durationFor(mode: Mode, settings: PomodoroSettings) {
  return (
    (mode === 'focus'
      ? settings.focus_minutes
      : mode === 'short'
        ? settings.short_break_minutes
        : settings.long_break_minutes) * 60
  );
}

export function PomodoroPanel({
  initialQuery = '',
}: { initialQuery?: string } = {}) {
  const repository = getPlanningRepository();
  const [settings, setSettings] = useState(defaultPomodoroSettings);
  const [sessions, setSessions] = useState<PomodoroSession[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState<Mode>('focus');
  const [timer, setTimer] = useState<PomodoroTimer>(() => createTimer());
  const [now, setNow] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const recorded = useRef<string | null>(null);
  const recording = useRef(false);
  const load = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    try {
      const data = await repository.getPomodoroWorkspace();
      setSettings(data.settings);
      setSessions(data.sessions);
      setTimer((current) =>
        current.status === 'idle'
          ? createTimer(data.settings.focus_minutes * 60)
          : current,
      );
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
  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            mode: Mode;
            timer: PomodoroTimer;
          };
          setMode(parsed.mode);
          setTimer(parsed.timer);
        }
      } catch {}
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(storageKey, JSON.stringify({ mode, timer }));
  }, [hydrated, mode, timer]);
  useEffect(() => {
    if (timer.status !== 'running') return;
    const interval = window.setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      setTimer((current) => completeIfElapsed(current, tick));
    }, 500);
    return () => window.clearInterval(interval);
  }, [timer.status]);
  useEffect(() => {
    if (
      timer.status !== 'completed' ||
      mode !== 'focus' ||
      !timer.startedAt ||
      recorded.current === String(timer.startedAt) ||
      recording.current ||
      !repository
    )
      return;
    recording.current = true;
    const completed_at = new Date().toISOString();
    void repository
      .recordPomodoroSession({
        client_id: `focus-${timer.startedAt}`,
        started_at: new Date(timer.startedAt).toISOString(),
        completed_at,
        duration_minutes: Math.round(timer.durationSeconds / 60),
      })
      .then(() => {
        recorded.current = String(timer.startedAt);
        recording.current = false;
        setSessions((current) => {
          const id = `focus-${timer.startedAt}`;
          if (current.some((session) => session.id === id)) return current;
          return [
            {
              id,
              started_at: new Date(timer.startedAt!).toISOString(),
              completed_at,
              duration_minutes: Math.round(timer.durationSeconds / 60),
            },
            ...current,
          ];
        });
      })
      .catch((error) => {
        recording.current = false;
        setMessage(`${getErrorMessage(error)} Retrying shortly…`);
        window.setTimeout(() => setTimer((current) => ({ ...current })), 3000);
      });
  }, [mode, repository, timer]);
  const remaining = remainingAt(timer, now);
  const progress =
    ((timer.durationSeconds - remaining) / timer.durationSeconds) * 100;
  const todaySessions = sessions.filter(
    (session) =>
      dateKey(new Date(session.completed_at)) === dateKey(new Date()),
  );
  const todayMinutes = todaySessions.reduce(
    (sum, session) => sum + session.duration_minutes,
    0,
  );
  const targetProgress =
    settings.daily_target_type === 'sessions'
      ? (todaySessions.length / settings.daily_target_value) * 100
      : (todayMinutes / settings.daily_target_value) * 100;
  function selectMode(next: Mode) {
    setMode(next);
    setTimer(createTimer(durationFor(next, settings)));
    recorded.current = null;
  }
  function primary() {
    if (timer.status === 'running')
      setTimer((current) => pauseTimer(current, Date.now()));
    else {
      setTimer((current) => startTimer(current, Date.now()));
      setNow(Date.now());
    }
  }
  async function saveSettings() {
    if (!repository) return;
    setMessage('');
    try {
      await repository.savePomodoroSettings(settings);
      setTimer((current) =>
        current.status === 'idle'
          ? createTimer(durationFor(mode, settings))
          : current,
      );
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
  const seconds = String(remaining % 60).padStart(2, '0');
  return (
    <section aria-labelledby="pomodoro-heading">
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
          Independent focus space
        </p>
        <h1
          id="pomodoro-heading"
          className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
        >
          Pomodoro
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          No link to goals, tasks, Gantt or Calendar. Only completed focus
          sessions count.
        </p>
      </div>
      {message ? (
        <p className="mt-4 rounded-xl border bg-muted p-3 text-xs">{message}</p>
      ) : null}
      {loading ? (
        <div className="grid min-h-[360px] place-items-center">
          <LoaderCircle className="animate-spin text-primary" />
        </div>
      ) : (
        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="border bg-card shadow-sm">
            <CardContent className="flex min-h-[480px] flex-col items-center justify-center py-10">
              <div className="mb-6 flex gap-2">
                {(['focus', 'short', 'long'] as Mode[]).map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={mode === item ? 'default' : 'outline'}
                    onClick={() => selectMode(item)}
                  >
                    {item === 'focus'
                      ? 'Focus'
                      : item === 'short'
                        ? 'Short break'
                        : 'Long break'}
                  </Button>
                ))}
              </div>
              <TimerReset className="size-10 text-primary" />
              <time className="mt-5 text-[clamp(68px,11vw,112px)] font-semibold leading-none tracking-[-.07em] tabular-nums">
                {minutes}:{seconds}
              </time>
              <Progress value={progress} className="mt-8 max-w-lg" />
              <div className="mt-8 flex gap-3">
                <Button size="lg" onClick={primary}>
                  {timer.status === 'running' ? <Pause /> : <Play />}
                  {timer.status === 'running'
                    ? 'Pause'
                    : timer.status === 'paused'
                      ? 'Resume'
                      : 'Start'}
                </Button>
                <Button
                  variant="outline"
                  size="icon-lg"
                  onClick={() => {
                    setTimer((current) => resetTimer(current));
                    recorded.current = null;
                  }}
                >
                  <RotateCcw />
                </Button>
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-5">
            <Card>
              <CardHeader>
                <CardTitle>Today target</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-end justify-between">
                  <strong className="text-3xl">
                    {settings.daily_target_type === 'sessions'
                      ? todaySessions.length
                      : todayMinutes}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    of {settings.daily_target_value}{' '}
                    {settings.daily_target_type}
                  </span>
                </div>
                <Progress
                  value={Math.min(100, targetProgress)}
                  className="mt-3"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Resets visually each day; history stays saved.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Settings</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['focus_minutes', 'Focus'],
                    ['short_break_minutes', 'Short'],
                    ['long_break_minutes', 'Long'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="text-[10px] font-semibold">
                    {label}
                    <input
                      type="number"
                      min="1"
                      max="240"
                      value={settings[key]}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          [key]: Number(event.target.value),
                        })
                      }
                      className="mt-1 h-9 w-full rounded border bg-background px-2 text-xs"
                    />
                  </label>
                ))}
                <label className="col-span-2 text-[10px] font-semibold">
                  Daily target
                  <select
                    value={settings.daily_target_type}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        daily_target_type: event.target
                          .value as PomodoroSettings['daily_target_type'],
                      })
                    }
                    className="mt-1 h-9 w-full rounded border bg-background px-2 text-xs"
                  >
                    <option value="sessions">Sessions</option>
                    <option value="minutes">Minutes</option>
                  </select>
                </label>
                <label className="text-[10px] font-semibold">
                  Value
                  <input
                    type="number"
                    min="1"
                    max="240"
                    value={settings.daily_target_value}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        daily_target_value: Number(event.target.value),
                      })
                    }
                    className="mt-1 h-9 w-full rounded border bg-background px-2 text-xs"
                  />
                </label>
                <Button
                  className="col-span-3"
                  variant="outline"
                  onClick={() => void saveSettings()}
                >
                  <Save />
                  Save settings
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Recent completed sessions</CardTitle>
                <input
                  type="search"
                  aria-label="Search focus sessions"
                  placeholder="Search date or duration…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="rounded-lg border bg-background px-3 py-2 text-sm"
                />
              </CardHeader>
              <CardContent>
                {sessions.length ? (
                  sessions
                    .filter((session) =>
                      matchesSearch(
                        query,
                        session.completed_at,
                        new Date(session.completed_at).toLocaleString(),
                        String(session.duration_minutes),
                      ),
                    )
                    .slice(0, query ? 100 : 6)
                    .map((session) => (
                      <div
                        key={session.id}
                        className="flex justify-between border-b py-2 text-xs last:border-0"
                      >
                        <span>
                          {new Date(session.completed_at).toLocaleString()}
                        </span>
                        <strong>{session.duration_minutes} min</strong>
                      </div>
                    ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No completed focus sessions yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </section>
  );
}
