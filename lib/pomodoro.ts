export type TimerStatus = 'idle' | 'running' | 'paused' | 'completed';

export type PomodoroTimer = {
  status: TimerStatus;
  durationSeconds: number;
  remainingSeconds: number;
  startedAt: number | null;
  expectedEndAt: number | null;
  pausedAt: number | null;
  accumulatedPauseSeconds: number;
};

export function createTimer(durationSeconds = 25 * 60): PomodoroTimer {
  return {
    status: 'idle',
    durationSeconds,
    remainingSeconds: durationSeconds,
    startedAt: null,
    expectedEndAt: null,
    pausedAt: null,
    accumulatedPauseSeconds: 0,
  };
}

export function remainingAt(timer: PomodoroTimer, now: number): number {
  if (timer.status !== 'running' || timer.expectedEndAt === null) {
    return timer.remainingSeconds;
  }
  return Math.max(0, Math.ceil((timer.expectedEndAt - now) / 1000));
}

export function startTimer(timer: PomodoroTimer, now: number): PomodoroTimer {
  if (timer.status === 'completed') {
    return {
      ...createTimer(timer.durationSeconds),
      status: 'running',
      startedAt: now,
      expectedEndAt: now + timer.durationSeconds * 1000,
    };
  }
  const pausedSeconds =
    timer.pausedAt === null
      ? 0
      : Math.max(0, Math.floor((now - timer.pausedAt) / 1000));
  const remaining = timer.remainingSeconds;
  return {
    ...timer,
    status: 'running',
    remainingSeconds: remaining,
    startedAt: timer.startedAt ?? now,
    expectedEndAt: now + remaining * 1000,
    pausedAt: null,
    accumulatedPauseSeconds: timer.accumulatedPauseSeconds + pausedSeconds,
  };
}

export function pauseTimer(timer: PomodoroTimer, now: number): PomodoroTimer {
  const remainingSeconds = remainingAt(timer, now);
  return {
    ...timer,
    status: 'paused',
    remainingSeconds,
    expectedEndAt: null,
    pausedAt: now,
  };
}

export function completeIfElapsed(
  timer: PomodoroTimer,
  now: number,
): PomodoroTimer {
  if (timer.status !== 'running' || remainingAt(timer, now) > 0) return timer;
  return {
    ...timer,
    status: 'completed',
    remainingSeconds: 0,
    expectedEndAt: null,
    pausedAt: null,
  };
}

export function resetTimer(timer: PomodoroTimer): PomodoroTimer {
  return createTimer(timer.durationSeconds);
}
