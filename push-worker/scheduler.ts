import {
  isTrustedPushEndpoint,
  notificationCopy,
  sendPush,
  type Env,
  type DueJob,
} from './index';

export type QueueJob = {
  job_key: string;
  owner_user_id: string;
  due_at: string;
};
type Schedule = { revision: number; jobs: QueueJob[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validQueueJob(value: unknown): value is QueueJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as QueueJob;
  return (
    uuid.test(job.owner_user_id) &&
    /^[a-f0-9]{32}$/.test(job.job_key) &&
    Number.isFinite(Date.parse(job.due_at))
  );
}
export async function schedulerRpc<T>(
  env: Env,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`${name} failed (HTTP ${response.status}).`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

export class PushScheduler {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      owner_user_id?: string;
      delivered_key?: string;
    };
    if (!body.owner_user_id || !uuid.test(body.owner_user_id))
      return new Response('Invalid owner', { status: 400 });
    await this.state.blockConcurrencyWhile(async () => {
      const current = await this.state.storage.get<string>('owner');
      if (current && current !== body.owner_user_id)
        throw new Error('Scheduler owner mismatch.');
      await this.state.storage.put('owner', body.owner_user_id!);
      if (body.delivered_key) {
        const queued =
          (await this.state.storage.get<Record<string, number>>('queued')) ??
          {};
        delete queued[body.delivered_key];
        await this.state.storage.put('queued', queued);
      }
      await this.refresh(body.owner_user_id!);
    });
    return Response.json({ ok: true });
  }
  async alarm() {
    const owner = await this.state.storage.get<string>('owner');
    if (!owner) return;
    try {
      await this.state.blockConcurrencyWhile(() => this.refresh(owner));
      await this.state.storage.delete('failures');
    } catch (error) {
      const failures = Math.min(
        8,
        ((await this.state.storage.get<number>('failures')) ?? 0) + 1,
      );
      await this.state.storage.put('failures', failures);
      await this.state.storage.setAlarm(
        Date.now() + Math.min(300_000, 5_000 * 2 ** failures),
      );
      console.error('Push schedule refresh deferred', String(error));
    }
  }
  private async refresh(owner: string) {
    if (!this.env.PUSH_QUEUE) throw new Error('Push queue binding is missing.');
    const now = Date.now();
    const previous =
      (await this.state.storage.get<Record<string, number>>('queued')) ?? {};
    let queued = Object.fromEntries(
      Object.entries(previous).filter(([, at]) => at > now - 15 * 60_000),
    );
    let schedule = await schedulerRpc<Schedule>(
      this.env,
      'get_myplan_push_schedule',
      {
        target_owner: owner,
        excluded_keys: Object.keys(queued),
      },
    );
    const previousRevision = await this.state.storage.get<number>('revision');
    if (previousRevision !== schedule.revision && Object.keys(queued).length) {
      // Edits can change due_at without changing the occurrence's job key.
      // Discard exclusions on revision changes; the DB revalidates queued copies.
      queued = {};
      schedule = await schedulerRpc<Schedule>(
        this.env,
        'get_myplan_push_schedule',
        { target_owner: owner, excluded_keys: [] },
      );
    }
    const capacity = Math.max(0, 1000 - Object.keys(queued).length);
    const due = schedule.jobs
      .filter((job) => Date.parse(job.due_at) <= now)
      .slice(0, capacity);
    for (let start = 0; start < due.length; start += 100) {
      const chunk = due.slice(start, start + 100);
      await this.env.PUSH_QUEUE.sendBatch(
        chunk.map((job) => ({ body: job, contentType: 'json' as const })),
      );
      for (const job of chunk) queued[job.job_key] = now;
    }
    // Persist after enqueue: a crash can duplicate a message, but cannot lose it.
    // The database lease + delivery ledger handle duplicate queue delivery.
    await this.state.storage.put('queued', queued);
    await this.state.storage.put('revision', schedule.revision);
    const remaining = schedule.jobs.filter((job) => !queued[job.job_key]);
    let wake = remaining.length
      ? Math.max(now + 1000, Date.parse(remaining[0].due_at))
      : Infinity;
    if (schedule.jobs.length === 200 && due.length)
      wake = Math.min(wake, now + 1000);
    if (!capacity) wake = now + 60_000;
    if (Object.keys(queued).length) wake = Math.min(wake, now + 15 * 60_000);
    if (Number.isFinite(wake)) await this.state.storage.setAlarm(wake);
    else await this.state.storage.deleteAlarm();
    await schedulerRpc(this.env, 'myplan_push_reconciled', {
      target_owner: owner,
      expected_revision: schedule.revision,
    });
  }
}

async function refreshOwner(env: Env, owner: string, delivered_key?: string) {
  if (!env.SCHEDULER) throw new Error('Scheduler binding is missing.');
  const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(owner));
  const response = await stub.fetch('https://scheduler.internal/refresh', {
    method: 'POST',
    body: JSON.stringify({ owner_user_id: owner, delivered_key }),
  });
  if (!response.ok) throw new Error('Scheduler refresh failed.');
}

export async function reconcileSchedules(env: Env) {
  // Only ten dirty owners per invocation, not a scan or push fanout per user.
  const owners = await schedulerRpc<string[]>(env, 'myplan_dirty_push_owners');
  for (const owner of owners) {
    try {
      await refreshOwner(env, owner);
    } catch (error) {
      console.error('Push reconciliation deferred', owner, String(error));
    }
  }
  await schedulerRpc(env, 'cleanup_myplan_push_logs');
}

export async function scheduleHook(request: Request, env: Env) {
  if (
    !env.PUSH_WEBHOOK_SECRET ||
    request.headers.get('authorization') !== `Bearer ${env.PUSH_WEBHOOK_SECRET}`
  )
    return new Response('Unauthorized', { status: 401 });
  if (Number(request.headers.get('content-length') ?? '0') > 1024)
    return new Response('Too large', { status: 413 });
  const text = await request.text();
  if (text.length > 1024) return new Response('Too large', { status: 413 });
  try {
    const body = JSON.parse(text) as { owner_user_id?: string };
    if (!body.owner_user_id || !uuid.test(body.owner_user_id))
      return new Response('Invalid owner', { status: 400 });
    await refreshOwner(env, body.owner_user_id);
    return Response.json({ ok: true });
  } catch {
    return new Response('Schedule refresh failed', { status: 503 });
  }
}

export async function consumePushBatch(
  batch: MessageBatch<QueueJob>,
  env: Env,
) {
  for (const message of batch.messages) {
    if (!validQueueJob(message.body)) {
      message.ack();
      continue;
    }
    const request = message.body;
    let token: string | undefined;
    let job: DueJob | undefined;
    try {
      const claim = await schedulerRpc<{
        state: string;
        token?: string;
        job?: DueJob;
      }>(env, 'claim_myplan_push_job', {
        target_owner: request.owner_user_id,
        target_key: request.job_key,
        expected_due: request.due_at,
      });
      if (claim.state === 'skip') {
        message.ack();
        continue;
      }
      if (claim.state === 'busy') {
        message.retry({ delaySeconds: 120 });
        continue;
      }
      token = claim.token;
      job = claim.job;
      if (!token || !job) throw new Error('Invalid delivery claim.');
      let result = 'disabled';
      if (isTrustedPushEndpoint(job.endpoint)) {
        const response = await sendPush(env, job, {
          ...notificationCopy(job),
          tag: `myplan:${job.calendar_entry_id}:${job.occurrence_start}:${job.offset_minutes}`,
          url: `/?view=${job.item_type === 'reminder' ? 'Reminders' : 'Checklists'}`,
        });
        if (!response.ok && response.status !== 404 && response.status !== 410)
          throw new Error(`Push provider returned ${response.status}.`);
        result = response.ok ? 'sent' : 'disabled';
        await response.body?.cancel();
      }
      await schedulerRpc(env, 'finish_myplan_push_job', {
        target_key: request.job_key,
        lease_token: token,
        delivery: job,
        result,
      });
      message.ack();
      try {
        await refreshOwner(env, request.owner_user_id, request.job_key);
      } catch {
        /* The already-durable alarm and webhook reconciliation recover. */
      }
    } catch (error) {
      if (token && job) {
        try {
          await schedulerRpc(env, 'finish_myplan_push_job', {
            target_key: request.job_key,
            lease_token: token,
            delivery: job,
            result: 'retry',
          });
        } catch {
          /* The bounded lease expires even after a process crash. */
        }
      }
      console.error('Push queue retry', request.job_key, String(error));
      message.retry({
        delaySeconds: Math.min(300, 5 * 2 ** Math.min(message.attempts, 6)),
      });
    }
  }
}
