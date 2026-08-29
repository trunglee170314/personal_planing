import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumePushBatch,
  PushScheduler,
  scheduleHook,
  validQueueJob,
  type QueueJob,
} from '../push-worker/scheduler';
import type { Env } from '../push-worker/index';

const owner = '00000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-09-02T10:00:00Z');
const env: Env = {
  SUPABASE_URL: 'https://database.example',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: 'mailto:test@example.test',
};
function setup(jobs: QueueJob[]) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const state = {
    storage,
    blockConcurrencyWhile: async (callback: () => Promise<unknown>) =>
      callback(),
  } as unknown as DurableObjectState;
  const sendBatch = vi.fn(async (_messages: unknown[]) => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith('get_myplan_push_schedule') ? { revision: 1, jobs } : null,
      ),
    ),
  );
  const scheduler = new PushScheduler(state, {
    ...env,
    PUSH_QUEUE: { sendBatch } as unknown as Queue<QueueJob>,
  });
  return { scheduler, storage, sendBatch, values };
}
const refresh = () =>
  new Request('https://scheduler.internal/refresh', {
    method: 'POST',
    body: JSON.stringify({ owner_user_id: owner }),
  });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('per-owner alarm scheduling', () => {
  it('sets the alarm at the exact next due timestamp, not the next minute', async () => {
    const due = new Date(now + 5_000).toISOString();
    const { scheduler, storage, sendBatch } = setup([
      { owner_user_id: owner, job_key: 'a'.repeat(32), due_at: due },
    ]);
    await scheduler.fetch(refresh());
    expect(storage.setAlarm).toHaveBeenCalledWith(now + 5_000);
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it('does not keep polling an empty schedule', async () => {
    const { scheduler, storage } = setup([]);
    await scheduler.fetch(refresh());
    expect(storage.deleteAlarm).toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });
  it('queues only ids/times, persists after enqueue and requests the next page for a full due batch', async () => {
    const jobs = Array.from({ length: 200 }, (_, index) => ({
      owner_user_id: owner,
      job_key: index.toString(16).padStart(32, '0'),
      due_at: new Date(now - 1000).toISOString(),
    }));
    const { scheduler, sendBatch, storage, values } = setup(jobs);
    await scheduler.fetch(refresh());
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(Object.keys(values.get('queued') as object)).toHaveLength(200);
    expect(storage.setAlarm).toHaveBeenCalledWith(now + 1000);
    expect(sendBatch.mock.calls[0]?.[0]).toBeDefined();
  });
  it('never marks a schedule reconciled if enqueue failed', async () => {
    const { scheduler, sendBatch } = setup([
      {
        owner_user_id: owner,
        job_key: 'a'.repeat(32),
        due_at: new Date(now).toISOString(),
      },
    ]);
    sendBatch.mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(scheduler.fetch(refresh())).rejects.toThrow(
      'Queue unavailable',
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url]) =>
            typeof url === 'string' && url.endsWith('myplan_push_reconciled'),
        ),
    ).toBe(false);
  });
  it('rechecks an already queued key immediately when an edit changes its due time', async () => {
    const key = 'a'.repeat(32);
    const due = new Date(now + 5000).toISOString();
    const { scheduler, storage, values, sendBatch } = setup([]);
    values.set('queued', { [key]: now - 1000 });
    values.set('revision', 1);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('get_myplan_push_schedule')) return Response.json(null);
      const args = JSON.parse(init?.body as string) as {
        excluded_keys: string[];
      };
      return Response.json({
        revision: 2,
        jobs: args.excluded_keys.length
          ? []
          : [{ owner_user_id: owner, job_key: key, due_at: due }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await scheduler.fetch(refresh());
    expect(storage.setAlarm).toHaveBeenCalledWith(now + 5000);
    expect(values.get('queued')).toEqual({});
    expect(values.get('revision')).toBe(2);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
describe('queue safety', () => {
  it('rejects malformed queue identifiers', () => {
    expect(validQueueJob({})).toBe(false);
    expect(
      validQueueJob({
        owner_user_id: owner,
        job_key: 'a'.repeat(32),
        due_at: 'bad',
      }),
    ).toBe(false);
  });
  it('rejects unauthenticated schedule hooks before any database call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      (
        await scheduleHook(
          new Request('https://worker.example/schedule-hook', {
            method: 'POST',
            body: '{}',
          }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('acknowledges cancelled or moved jobs without sending a notification', async () => {
    const fetchMock = vi.fn(async () => Response.json({ state: 'skip' }));
    vi.stubGlobal('fetch', fetchMock);
    const message = {
      body: {
        owner_user_id: owner,
        job_key: 'a'.repeat(32),
        due_at: new Date(now).toISOString(),
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumePushBatch(
      { messages: [message] } as unknown as MessageBatch<QueueJob>,
      env,
    );
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
