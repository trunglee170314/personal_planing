'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { parseRecordLimit, type CloudAccess } from '@/lib/cloud-access';

async function rpc(name: string, args?: Record<string, unknown>) {
  const client = getSupabaseBrowserClient();
  if (!client) throw new Error('Online workspace unavailable.');
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
export function AdminUsers() {
  const [users, setUsers] = useState<CloudAccess[]>([]);
  const [offset, setOffset] = useState(0);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [defaultLimit, setDefaultLimit] = useState('');
  const [retention, setRetention] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const reload = useCallback(async () => {
    const [rows, settings] = await Promise.all([
      rpc('admin_myplan_users', { page_offset: offset }),
      rpc('admin_myplan_settings'),
    ]);
    return { rows: rows as CloudAccess[], settings };
  }, [offset]);
  const applyData = useCallback(
    ({ rows, settings }: Awaited<ReturnType<typeof reload>>) => {
      setUsers(rows);
      setLimits(
        Object.fromEntries(
          rows.map((user: CloudAccess) => [
            user.user_id,
            user.record_limit?.toString() ?? '',
          ]),
        ),
      );
      setDefaultLimit(settings.default_record_limit?.toString() ?? '');
      setRetention(settings.log_retention_days?.toString() ?? '');
    },
    [],
  );
  useEffect(() => {
    let active = true;
    void reload()
      .then((data) => {
        if (active) applyData(data);
      })
      .catch((failure) => {
        if (active) setError(String(failure.message));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [reload, applyData]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      applyData(await reload());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Update failed.');
    } finally {
      setBusy(false);
    }
  }
  function update(
    user: CloudAccess,
    status: 'approved' | 'rejected' | 'suspended',
  ) {
    if (
      status !== 'approved' &&
      !window.confirm(
        `${status === 'suspended' ? 'Pause access for' : 'Reject'} ${user.email}? Their planner data will be kept.`,
      )
    )
      return;
    void perform(() =>
      rpc('admin_myplan_update_user', {
        target_user: user.user_id,
        next_status: status,
        next_limit: parseRecordLimit(limits[user.user_id] ?? ''),
      }),
    );
  }
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">User management</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Approve Online access and manage record limits. Planner contents stay
          private.
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl border p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <fieldset
        disabled={busy}
        className="space-y-3 rounded-2xl border bg-card p-4"
      >
        <legend className="px-2 font-semibold">
          Defaults and notification logs
        </legend>
        <label htmlFor="default-record-limit" className="block text-sm">
          Record limit for new accounts
          <Input
            id="default-record-limit"
            type="number"
            min={1}
            max={1000000}
            value={defaultLimit}
            onChange={(event) => setDefaultLimit(event.target.value)}
            placeholder="Unlimited"
          />
        </label>
        <label htmlFor="delivery-log-retention" className="block text-sm">
          Keep delivery logs for (days)
          <Input
            id="delivery-log-retention"
            type="number"
            min={7}
            max={365}
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            placeholder="Keep indefinitely"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Limits count goals, tasks, calendar records, recurrence state,
          milestones, sessions, reviews and devices, including Trash. They are
          not MB limits. Log cleanup never removes goals or tasks.
        </p>
        <Button
          onClick={() =>
            void perform(async () => {
              const days = retention.trim() ? Number(retention) : null;
              if (
                days !== null &&
                (!Number.isInteger(days) || days < 7 || days > 365)
              )
                throw new Error(
                  'Log retention must be between 7 and 365 days, or blank.',
                );
              if (
                days !== null &&
                !window.confirm(
                  `Allow automatic deletion of delivery logs older than ${days} days? This cannot be undone. Planner data is not deleted.`,
                )
              )
                return;
              await rpc('admin_myplan_save_settings', {
                default_limit: parseRecordLimit(defaultLimit),
                retention_days: days,
              });
            })
          }
        >
          Save policy
        </Button>
      </fieldset>
      <div className="space-y-3">
        {users.map((user) => (
          <article
            key={user.user_id}
            className="space-y-3 rounded-2xl border bg-card p-4"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <strong className="break-all">{user.email}</strong>
              <span className="text-sm">
                {user.is_admin ? 'Admin' : user.status}
              </span>
            </div>
            <label htmlFor={`limit-${user.user_id}`} className="block text-sm">
              Record limit ({user.records_used} used)
              <Input
                id={`limit-${user.user_id}`}
                aria-label={`Record limit for ${user.email}`}
                disabled={busy}
                type="number"
                min={1}
                max={1000000}
                value={limits[user.user_id] ?? ''}
                onChange={(event) =>
                  setLimits((current) => ({
                    ...current,
                    [user.user_id]: event.target.value,
                  }))
                }
                placeholder="Unlimited"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => update(user, 'approved')}>
                {user.status === 'approved' ? 'Save limit' : 'Approve'}
              </Button>
              {!user.is_admin && (
                <>
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => update(user, 'suspended')}
                  >
                    Suspend
                  </Button>
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => update(user, 'rejected')}
                  >
                    Reject
                  </Button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          disabled={busy || offset === 0}
          variant="outline"
          onClick={() => {
            setBusy(true);
            setOffset((value) => Math.max(0, value - 50));
          }}
        >
          Previous
        </Button>
        <Button
          disabled={busy || users.length < 50}
          variant="outline"
          onClick={() => {
            setBusy(true);
            setOffset((value) => value + 50);
          }}
        >
          Next
        </Button>
      </div>
    </section>
  );
}
