'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import type { CloudAccess } from '@/lib/cloud-access';

export function CloudAccessGate({
  userId,
  onSignOut,
  children,
}: {
  userId: string;
  onSignOut: () => void;
  children: (access: CloudAccess) => ReactNode;
}) {
  const [access, setAccess] = useState<CloudAccess | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const client = getSupabaseBrowserClient();
        if (!client) throw new Error('Online workspace is unavailable.');
        const { data, error: resultError } =
          await client.rpc('get_myplan_access');
        if (resultError) throw new Error(resultError.message);
        if (!data || data.user_id !== userId)
          throw new Error('Could not verify workspace access.');
        if (active) {
          setAccess(data);
          setError('');
        }
      } catch (failure) {
        if (active) {
          setAccess(null); // Fail closed, including during an expired/revoked session.
          setError(
            failure instanceof Error
              ? failure.message
              : 'Could not verify access.',
          );
        }
      } finally {
        checking = false;
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [userId, retry]);

  if (access?.user_id === userId && access.status === 'approved')
    return children(access);
  const title =
    access?.status === 'pending'
      ? 'Waiting for approval'
      : access?.status === 'rejected'
        ? 'Registration not approved'
        : access?.status === 'suspended'
          ? 'Workspace access paused'
          : error
            ? 'Could not verify access'
            : 'Checking your workspace';
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{access?.email}</p>
        <output className="block text-sm">
          {error ||
            (access
              ? 'An administrator manages access to this Online workspace. Your existing data has not been deleted.'
              : 'Please wait…')}
        </output>
        <div className="flex gap-2">
          <Button onClick={() => setRetry((value) => value + 1)}>
            Check again
          </Button>
          <Button variant="outline" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </section>
    </main>
  );
}
