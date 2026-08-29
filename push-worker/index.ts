import { buildWebPushRequest } from './web-push';
import {
  consumePushBatch,
  reconcileSchedules,
  scheduleHook,
  schedulerRpc,
  type QueueJob,
} from './scheduler';
export { PushScheduler } from './scheduler';

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  PUSH_SCHEDULER_MODE?: string;
  PUSH_WEBHOOK_SECRET?: string;
  SCHEDULER?: DurableObjectNamespace;
  PUSH_QUEUE?: Queue<QueueJob>;
};
export type DueJob = {
  subscription_id: string;
  owner_user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  calendar_entry_id: string;
  occurrence_start: string;
  offset_minutes: number;
  item_type: 'checklist' | 'reminder';
  item_title: string;
};
type PushTarget = Pick<
  DueJob,
  'subscription_id' | 'endpoint' | 'p256dh' | 'auth'
>;

const allowedOrigins = new Set([
  'https://myplan.trungvanle.workers.dev',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function headers(env: Env, extra: Record<string, string> = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function dueJobs(env: Env) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/get_due_push_jobs`,
    {
      method: 'POST',
      headers: headers(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ check_at: new Date().toISOString() }),
    },
  );
  if (!response.ok)
    throw new Error(`Due jobs query failed: ${response.status}`);
  return (await response.json()) as DueJob[];
}

async function claim(env: Env, job: DueJob) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_delivery_log?on_conflict=subscription_id,calendar_entry_id,occurrence_start,offset_minutes`,
    {
      method: 'POST',
      headers: headers(env, {
        'content-type': 'application/json',
        prefer: 'resolution=ignore-duplicates,return=representation',
      }),
      body: JSON.stringify({
        owner_user_id: job.owner_user_id,
        subscription_id: job.subscription_id,
        calendar_entry_id: job.calendar_entry_id,
        occurrence_start: job.occurrence_start,
        offset_minutes: job.offset_minutes,
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Delivery claim failed: ${response.status}`);
  return ((await response.json()) as unknown[]).length === 1;
}

async function disable(env: Env, subscriptionId: string) {
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${subscriptionId}`,
    {
      method: 'PATCH',
      headers: headers(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ disabled_at: new Date().toISOString() }),
    },
  );
}

async function release(env: Env, job: DueJob) {
  const query = new URLSearchParams({
    subscription_id: `eq.${job.subscription_id}`,
    calendar_entry_id: `eq.${job.calendar_entry_id}`,
    occurrence_start: `eq.${job.occurrence_start}`,
    offset_minutes: `eq.${job.offset_minutes}`,
  });
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_delivery_log?${query}`,
    {
      method: 'DELETE',
      headers: headers(env),
    },
  );
  if (!response.ok)
    throw new Error(`Delivery claim release failed: ${response.status}`);
}

export function isTrustedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return false;
    return [
      'googleapis.com',
      'push.apple.com',
      'push.services.mozilla.com',
      'notify.windows.com',
    ].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

export async function sendPush(
  env: Env,
  target: PushTarget,
  data: { title: string; body: string; tag: string; url: string },
) {
  if (!isTrustedPushEndpoint(target.endpoint))
    throw new Error('The saved push endpoint is not trusted.');
  const payload = await buildWebPushRequest(
    JSON.stringify(data),
    {
      endpoint: target.endpoint,
      p256dh: target.p256dh,
      auth: target.auth,
    },
    {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
  );
  return fetch(target.endpoint, {
    ...payload,
    body: payload.body,
    signal: AbortSignal.timeout(15_000),
  });
}

export function notificationCopy(
  item: Pick<DueJob, 'item_type' | 'item_title' | 'offset_minutes'>,
) {
  const label = item.item_type === 'reminder' ? 'Reminder' : 'Checklist';
  const action = item.item_type === 'reminder' ? 'due' : 'starts';
  const timing =
    item.offset_minutes === 0
      ? 'now'
      : item.offset_minutes === 1440
        ? 'in 1 day'
        : item.offset_minutes === 60
          ? 'in 1 hour'
          : `in ${item.offset_minutes} minutes`;
  return {
    title: item.item_title,
    body: `${label} ${action} ${timing}.`,
  };
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') ?? '';
  return {
    'access-control-allow-origin': allowedOrigins.has(origin) ? origin : '',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST,OPTIONS',
    vary: 'Origin',
  };
}

async function finishTestRequest(
  env: Env,
  requestId: string,
  errorCode: string | null,
) {
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_test_requests?id=eq.${requestId}`,
    {
      method: 'PATCH',
      headers: headers(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        delivered_at: new Date().toISOString(),
        error_code: errorCode,
      }),
    },
  );
}

async function testPush(request: Request, env: Env) {
  const responseHeaders = {
    ...corsHeaders(request),
    'content-type': 'application/json',
  };
  const origin = request.headers.get('origin') ?? '';
  if (!allowedOrigins.has(origin))
    return new Response(JSON.stringify({ error: 'Origin is not allowed.' }), {
      status: 403,
      headers: responseHeaders,
    });
  const body = (await request.json().catch(() => null)) as {
    requestId?: string;
  } | null;
  if (!body?.requestId || !/^[0-9a-f-]{36}$/i.test(body.requestId))
    return new Response(
      JSON.stringify({ error: 'The push test request is invalid.' }),
      { status: 400, headers: responseHeaders },
    );
  const claimQuery = new URLSearchParams({
    id: `eq.${body.requestId}`,
    claimed_at: 'is.null',
    delivered_at: 'is.null',
    requested_at: `gte.${new Date(Date.now() - 5 * 60_000).toISOString()}`,
  });
  const claimResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_test_requests?${claimQuery}`,
    {
      method: 'PATCH',
      headers: headers(env, {
        'content-type': 'application/json',
        prefer: 'return=representation',
      }),
      body: JSON.stringify({ claimed_at: new Date().toISOString() }),
    },
  );
  if (!claimResponse.ok)
    return new Response(
      JSON.stringify({ error: 'Could not claim the push test request.' }),
      { status: 502, headers: responseHeaders },
    );
  const claims = (await claimResponse.json()) as Array<{
    subscription_id: string;
    owner_user_id: string;
  }>;
  const claim = claims[0];
  if (!claim)
    return new Response(
      JSON.stringify({ error: 'This push test expired or was already used.' }),
      { status: 409, headers: responseHeaders },
    );
  if (env.PUSH_SCHEDULER_MODE === 'alarms') {
    const allowed = await schedulerRpc<boolean>(
      env,
      'myplan_push_owner_approved',
      { target_owner: claim.owner_user_id },
    );
    if (!allowed)
      return new Response(
        JSON.stringify({ error: 'Workspace access is not approved.' }),
        { status: 403, headers: responseHeaders },
      );
  }
  const subscriptionQuery = new URLSearchParams({
    select: 'id,endpoint,p256dh,auth',
    id: `eq.${claim.subscription_id}`,
    disabled_at: 'is.null',
    limit: '1',
  });
  const subscriptionResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_subscriptions?${subscriptionQuery}`,
    { headers: headers(env) },
  );
  if (!subscriptionResponse.ok) {
    await finishTestRequest(env, body.requestId, 'subscription_query_failed');
    return new Response(
      JSON.stringify({ error: 'Could not verify this device subscription.' }),
      { status: 502, headers: responseHeaders },
    );
  }
  const subscriptions = (await subscriptionResponse.json()) as Array<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>;
  const subscription = subscriptions[0];
  if (!subscription) {
    await finishTestRequest(env, body.requestId, 'subscription_missing');
    return new Response(
      JSON.stringify({ error: 'Enable notifications on this device first.' }),
      { status: 404, headers: responseHeaders },
    );
  }
  const target: PushTarget = {
    subscription_id: subscription.id,
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
  };
  try {
    const delivery = await sendPush(env, target, {
      title: 'myplan test',
      body: 'Background Web Push is working on this device.',
      tag: `myplan-test:${Date.now()}`,
      url: '/?view=Reminders',
    });
    if (delivery.status === 404 || delivery.status === 410) {
      await disable(env, target.subscription_id);
      await finishTestRequest(env, body.requestId, 'subscription_expired');
      return new Response(
        JSON.stringify({
          error: 'This device subscription expired. Enable it again.',
        }),
        { status: 410, headers: responseHeaders },
      );
    }
    if (!delivery.ok)
      throw new Error(`Push provider returned ${delivery.status}.`);
    await finishTestRequest(env, body.requestId, null);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Test push failed', error);
    await finishTestRequest(env, body.requestId, 'provider_rejected');
    return new Response(
      JSON.stringify({
        error: 'The push provider rejected the test notification.',
      }),
      { status: 502, headers: responseHeaders },
    );
  }
}

export async function run(env: Env) {
  let delivered = 0;
  for (const job of await dueJobs(env)) {
    let claimed = false;
    try {
      if (!isTrustedPushEndpoint(job.endpoint)) {
        await disable(env, job.subscription_id);
        continue;
      }
      claimed = await claim(env, job);
      if (!claimed) continue;
      const copy = notificationCopy(job);
      const response = await sendPush(env, job, {
        ...copy,
        tag: `myplan:${job.calendar_entry_id}:${job.occurrence_start}:${job.offset_minutes}`,
        url: `/?view=${job.item_type === 'reminder' ? 'Reminders' : 'Checklists'}`,
      });
      if (response.status === 404 || response.status === 410) {
        await disable(env, job.subscription_id);
        continue;
      }
      if (!response.ok)
        throw new Error(`Push delivery failed: ${response.status}`);
      delivered += 1;
    } catch (error) {
      console.error('Push job failed', job.calendar_entry_id, error);
      if (claimed)
        try {
          await release(env, job);
        } catch (releaseError) {
          console.error(
            'Push claim release failed',
            job.calendar_entry_id,
            releaseError,
          );
        }
    }
  }
  return delivered;
}

const worker = {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(
      env.PUSH_SCHEDULER_MODE === 'alarms' ? reconcileSchedules(env) : run(env),
    );
  },
  async queue(batch: MessageBatch<QueueJob>, env: Env) {
    if (env.PUSH_SCHEDULER_MODE !== 'alarms')
      throw new Error('Alarm delivery is not enabled.');
    await consumePushBatch(batch, env);
  },
  async fetch(request: Request, env: Env) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (new URL(request.url).pathname === '/health')
      return Response.json({
        ok: true,
        service: 'myplan-push',
        scheduler: env.PUSH_SCHEDULER_MODE ?? 'cron',
      });
    if (request.method === 'GET' && new URL(request.url).pathname === '/config')
      return Response.json(
        { vapidPublicKey: env.VAPID_PUBLIC_KEY },
        {
          headers: {
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          },
        },
      );
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/schedule-hook' &&
      env.PUSH_SCHEDULER_MODE === 'alarms'
    )
      return scheduleHook(request, env);
    if (request.method === 'POST' && new URL(request.url).pathname === '/test')
      return testPush(request, env);
    return new Response('Not found', { status: 404 });
  },
};

export default worker;
