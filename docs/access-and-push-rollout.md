# Online approval, quotas, and alarm delivery

## Staged deployment: 2026-09-02

- Web Worker `myplan`: `2492bdb9-e580-4647-979a-3a7161511d18` (approval enabled).
- Push Worker `myplan-push`: `fbbd7f21-58b6-4075-9a75-0bc89a96a52f`.
- Live changes: shared Calendar header/body scrolling and public push setup configuration.
- Migrations 0021/0022 and `pg_net` are now installed in production. All three
  existing accounts remain approved. The verified `lezantrung@gmail.com` account
  has admin access; its RPC permissions and isolation from other users' plans
  have been checked. The approval-enabled frontend is deployed; `/` and `/login`
  production HTML smoke checks passed.
- Both delivery/dead-letter queues exist. Push remains in **cron** mode until
  the operator enters the webhook secret in Supabase and Alarms is activated.
- A private, app-inaccessible same-database snapshot of all 26 public tables and
  schema metadata was taken before migration. It is a rollout rollback aid, not
  an offsite/full database or Auth backup. See `supabase/backup_before_access.sql`.
- Verified: 97 automated tests, typecheck, lint, both Worker dry-runs, isolated
  PostgreSQL access/scheduler/concurrent-quota tests, production HTML smoke checks,
  push health/config and an exact hash match for the deployed Calendar bundle.
- Real-device notification delivery and visual alignment still need a device check.

## Scope

Local/offline SQLite is unchanged. No migration here deletes goals, tasks,
calendar entries, or other planner content. Existing Online users stay approved;
new Auth users are pending. Administrator status is assigned by a database
operator to one verified Auth user, never from editable metadata.

## Database rollout (required before activation)

1. Verify the production Supabase project and take a database backup.
2. Apply only the new migrations in order: `0021_workspace_access.sql`, then
   `0022_push_alarm_scheduler.sql`. Do not rerun `bootstrap_current.sql` on a
   populated project. Fresh installations run the bootstrap followed by 0021/0022.
3. Run `supabase/provision_myplan_admin.sql`. It requires exactly one verified
   `lezantrung@gmail.com` Auth user and returns the assigned User ID. If it fails,
   stop; do not grant admin to a different account or to an unverified email.
4. Enable Supabase's `pg_net` extension. Run `node scripts/prepare-push-webhook.mjs`
   to generate a random webhook secret and upload it to the existing `myplan-push`
   Worker using Wrangler's authenticated session. The operator must paste the
   generated `outputs/push-webhook-setup.sql` into the SQL editor and run it.
   The helper reuses that ignored file on retry, avoiding accidental rotation.
   Do not put the secret in Git, browser variables, URLs, screenshots, logs, or
   chat. Remove the temporary SQL file after verifying both sides are configured.

The webhook only wakes an owner's scheduler. Calendar data, approval status,
subscription keys and current due times are read from Supabase before delivery.
If a webhook is lost, the existing once-per-minute cron reconciles up to ten
durably marked dirty owners. This fallback is not a five-second database scan.

## Worker rollout

Preserve all existing Supabase and VAPID secrets. Never regenerate a VAPID pair
just to rebuild the frontend: that would invalidate existing subscriptions.

```bash
npx wrangler queues create myplan-push-delivery
npx wrangler queues create myplan-push-dead-letter
npx wrangler secret put PUSH_WEBHOOK_SECRET --config push-worker/wrangler.alarms.jsonc
npx wrangler deploy --dry-run --config push-worker/wrangler.alarms.jsonc
npx wrangler deploy --config push-worker/wrangler.alarms.jsonc
```

Check plan support/quotas before creating resources. Do not automatically upgrade
a paid plan. The alarm config adds a SQLite-backed DO per owner and queues one
delivery per consumer invocation, limiting external-request fanout. Dead-letter
messages contain only owner ID, job key and due time, not endpoint/auth keys or
planner titles. Inspect failures before manually replaying dead-letter messages.
Database claim attempts persist across re-enqueues; after six failed delivery
attempts a job is excluded until an operator investigates or its due time changes.

After validating the schema and admin, run `npm run deploy:cloudflare`.
The deployment script pins `NEXT_PUBLIC_ACCESS_APPROVALS_ENABLED=true` for this
production site so later deployments cannot accidentally remove its approval UI.
For other fresh environments, install the database migrations before enabling it.
The public `/config` endpoint exposes only the VAPID **public** key, so Windows
and iPhone setup no longer depend on that key being embedded at build time.

For a staged UI-only deployment, keep approval activation `false` and use the
original `push-worker/wrangler.jsonc` (cron mode). Such a deployment does **not**
activate user approval or alarms. Once alarms are active, use the alarms config
for later push deployments; do not accidentally overwrite bindings with the
legacy config.

## Quotas and retention

Limits default to unset, preserving current use. The Users screen lets the admin
set per-account record limits and defaults for future accounts. The quota counts
goals, tasks, calendar entries, recurrence rules/states, milestones, Pomodoro
sessions, reviews and device subscriptions, including archived/Trash rows. It is
a logical record quota, not an exact MB quota including database indexes.
Concurrent inserts serialize on the owner's membership row. Updates and deletes
remain possible at the limit; upserts resolving to updates do not consume quota.

Delivery-log retention starts disabled. The admin can explicitly select 7–365
days and confirm irreversible deletion of old delivery metadata. Cleanup is
capped at 1000 rows per metadata table per cron run and does not touch planner content. The scheduler
only considers the last 24 hours of overdue notifications, so deleting week-old
deduplication logs cannot replay ancient reminders. Failed-job and expired-lease
metadata follow the same opt-in retention policy; pending future schedules are kept.

## Validation

`npm run typecheck`, `npm test`, `npm run lint`, plus a Worker dry-run check the
client and Worker. To test SQL in a disposable PostgreSQL 16 container with no
network access (no production data):

```bash
docker run --name myplan-access-test-20260902 --network none \
  --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
# In another terminal:
bash scripts/test-cloud-access.sh
```

The tests cover pending-user denial, admin isolation from planner content,
quota/upsert behavior, safe suspension, stale queue cancellation, delivery
leases, deduplication and retry exhaustion. Also test two real accounts and one
real device after activation, including edits, completion, suspension and a
scheduled push while the PWA is closed. Device/network delays can still occur;
alarms do not promise exact-to-the-second display by Windows/iOS.
