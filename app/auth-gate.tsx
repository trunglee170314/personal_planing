'use client';

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { LoaderCircle } from 'lucide-react';
import { getAppDataMode } from '@/lib/data/repository';
import {
  getSupabaseBrowserClient,
  hasSupabaseConfig,
} from '@/lib/supabase/client';
import { TodayDashboard } from './today-dashboard';
import { AuthPage } from './auth-page';
import { CloudAccessGate } from './cloud-access-gate';

export function AuthGate() {
  const dataMode = getAppDataMode();
  const supabase = dataMode === 'cloud' ? getSupabaseBrowserClient() : null;
  const [session, setSession] = useState<Session | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(
    dataMode === 'cloud' && Boolean(supabase),
  );

  useEffect(() => {
    const handle = window.setTimeout(() => setHydrated(true), 0);
    return () => window.clearTimeout(handle);
  }, []);

  useEffect(() => {
    if (dataMode === 'local' || !supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, [dataMode, supabase]);

  useEffect(() => {
    if (
      dataMode !== 'cloud' ||
      !supabase ||
      !session ||
      !('serviceWorker' in navigator)
    )
      return;
    let active = true;
    const client = supabase;
    const userId = session.user.id;
    let currentSubscription: PushSubscription | null = null;
    async function protectAccountBoundary() {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        currentSubscription = subscription ?? null;
        if (!subscription) return;
        const { data, error } = await client
          .from('push_subscriptions')
          .select('id')
          .eq('owner_user_id', userId)
          .eq('endpoint', subscription.endpoint)
          .is('disabled_at', null)
          .maybeSingle();
        if (error) throw error;
        if (active && !data) await subscription.unsubscribe();
      } catch (error) {
        console.error('Could not verify this device push subscription.', error);
        if (active && currentSubscription)
          try {
            await currentSubscription.unsubscribe();
          } catch (unsubscribeError) {
            console.error(
              'Could not remove an unverified push subscription.',
              unsubscribeError,
            );
          }
      }
    }
    void protectAccountBoundary();
    return () => {
      active = false;
    };
  }, [dataMode, session, supabase]);

  async function signOutSafely() {
    if (!supabase || !session) return;
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          // A suspended account cannot update subscription rows through RLS.
          // Unsubscribe the browser first, so it can still safely sign out.
          await subscription.unsubscribe();
          const { error } = await supabase
            .from('push_subscriptions')
            .update({ disabled_at: new Date().toISOString() })
            .eq('owner_user_id', session.user.id)
            .eq('endpoint', subscription.endpoint);
          if (error)
            console.warn('Device unsubscribed; server cleanup deferred.');
        }
      }
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      window.alert(
        error instanceof Error
          ? `Could not safely sign out: ${error.message}`
          : 'Could not safely sign out. Try again.',
      );
    }
  }

  if (!hydrated || loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <LoaderCircle className="size-6 animate-spin text-primary" />
        <span className="sr-only">Loading your workspace</span>
      </div>
    );
  }

  if (dataMode === 'local') {
    return <TodayDashboard firstName="" accountKey="local" dataMode="local" />;
  }

  if (!supabase || !hasSupabaseConfig()) return <AuthPage mode="login" />;
  if (!session) return <AuthPage mode="login" />;

  const email = session.user.email ?? 'user@gmail.com';
  const name =
    typeof session.user.user_metadata.display_name === 'string'
      ? session.user.user_metadata.display_name
      : email.split('@')[0];
  if (process.env.NEXT_PUBLIC_ACCESS_APPROVALS_ENABLED === 'true') {
    return (
      <CloudAccessGate
        key={session.user.id}
        userId={session.user.id}
        onSignOut={() => void signOutSafely()}
      >
        {(access) => (
          <TodayDashboard
            firstName={name}
            accountKey={session.user.id}
            dataMode="cloud"
            isAdmin={access.is_admin}
            onSignOut={() => void signOutSafely()}
          />
        )}
      </CloudAccessGate>
    );
  }
  return (
    <TodayDashboard
      key={session.user.id}
      firstName={name}
      accountKey={session.user.id}
      dataMode="cloud"
      onSignOut={() => void signOutSafely()}
    />
  );
}
