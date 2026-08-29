import { describe, expect, it } from 'vitest';

import {
  completeIfElapsed,
  createTimer,
  pauseTimer,
  remainingAt,
  resetTimer,
  startTimer,
} from '../lib/pomodoro';

describe('pomodoro timestamp model', () => {
  it('derives remaining time from the expected end timestamp', () => {
    const timer = startTimer(createTimer(1500), 1_000);
    expect(remainingAt(timer, 66_000)).toBe(1435);
    expect(remainingAt(timer, 1_600_000)).toBe(0);
  });

  it('excludes paused time and accumulates it on resume', () => {
    const started = startTimer(createTimer(1500), 1_000);
    const paused = pauseTimer(started, 66_000);
    expect(paused.remainingSeconds).toBe(1435);

    const resumed = startTimer(paused, 96_000);
    expect(resumed.accumulatedPauseSeconds).toBe(30);
    expect(resumed.expectedEndAt).toBe(96_000 + 1_435_000);
    expect(remainingAt(resumed, 106_000)).toBe(1425);
  });

  it('completes an expired session once and starts a fresh session afterward', () => {
    const started = startTimer(createTimer(60), 1_000);
    const completed = completeIfElapsed(started, 61_000);
    expect(completed.status).toBe('completed');
    expect(completeIfElapsed(completed, 90_000)).toEqual(completed);

    const restarted = startTimer(completed, 100_000);
    expect(restarted.startedAt).toBe(100_000);
    expect(restarted.expectedEndAt).toBe(160_000);
  });

  it('reset preserves the configured duration and clears session timestamps', () => {
    const running = startTimer(createTimer(45 * 60), 5_000);
    expect(resetTimer(running)).toEqual(createTimer(45 * 60));
  });
});
