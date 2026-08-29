'use client';

import { useEffect, useState } from 'react';
import { BellRing, CheckCircle2, Info, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
const PUSH_WORKER_URL =
  process.env.NEXT_PUBLIC_PUSH_WORKER_URL ??
  'https://myplan-push.trungvanle.workers.dev';

function errorDetails(error: unknown) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [record.name, record.message, record.code, record.details]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      )
      .filter((value, index, values) => values.indexOf(value) === index);
    if (parts.length) return parts.join(' · ');
  }
  return 'Unknown browser error.';
}

function applicationServerKey(value: string) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

export function NotificationSettings({
  dataMode,
}: {
  dataMode: 'local' | 'cloud';
}) {
  const [supported] = useState(
    () =>
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window,
  );
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'default' : Notification.permission,
  );
  const [standalone] = useState(() =>
    typeof window === 'undefined' ? false : isStandalone(),
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [publicKey, setPublicKey] = useState(VAPID_PUBLIC_KEY);
  const [checking, setChecking] = useState(dataMode === 'cloud' && supported);

  useEffect(() => {
    if (dataMode !== 'cloud' || publicKey) return;
    const controller = new AbortController();
    void fetch(`${PUSH_WORKER_URL}/config`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('Notification configuration unavailable.');
        const data = (await response.json()) as { vapidPublicKey?: string };
        const key = data.vapidPublicKey;
        if (!key || applicationServerKey(key).length !== 65)
          throw new Error('Invalid notification public key.');
        setPublicKey(key);
      })
      .catch(() => {
        /* Enable gives an actionable error; no private key is needed in the browser. */
      });
    return () => controller.abort();
  }, [dataMode, publicKey]);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    async function checkCurrentAccount() {
      setChecking(true);
      try {
        if (dataMode === 'local') {
          if (active) setSubscribed(Notification.permission === 'granted');
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription || dataMode !== 'cloud') {
          if (active) setSubscribed(false);
          return;
        }
        const supabase = getSupabaseBrowserClient();
        if (!supabase) return;
        const { data: userData, error: userError } =
          await supabase.auth.getUser();
        if (userError) throw userError;
        if (!userData.user) return;
        const { data, error } = await supabase
          .from('push_subscriptions')
          .select('id')
          .eq('owner_user_id', userData.user.id)
          .eq('endpoint', subscription.endpoint)
          .is('disabled_at', null)
          .maybeSingle();
        if (error) throw error;
        if (active) setSubscribed(Boolean(data));
      } catch (error) {
        if (active) {
          setSubscribed(false);
          setMessage(`Status check failed: ${errorDetails(error)}`);
        }
      } finally {
        if (active) setChecking(false);
      }
    }
    void checkCurrentAccount();
    return () => {
      active = false;
    };
  }, [dataMode, supported]);

  async function enable() {
    if (dataMode !== 'cloud') {
      try {
        const result = await Notification.requestPermission();
        setPermission(result);
        setSubscribed(result === 'granted');
        setMessage(
          result === 'granted'
            ? 'Local browser notifications enabled. Keep myplan and its local server running; this is not remote Web Push.'
            : 'Allow notifications in the browser site permissions.',
        );
      } catch (error) {
        setMessage(errorDetails(error));
      }
      return;
    }
    if (!supported || !publicKey) {
      setMessage(
        !supported
          ? 'This browser does not support Web Push.'
          : 'Notification setup is unavailable. Check your connection and reopen Settings.',
      );
      return;
    }
    setBusy(true);
    setMessage('');
    let stage = 'permission request';
    try {
      if (/iPhone|iPad|iPod/i.test(navigator.userAgent) && !isStandalone())
        throw new Error('Open myplan from its Home Screen icon, then retry.');
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== 'granted')
        throw new Error('Notification permission was not granted.');
      stage = 'service worker';
      const registration = await navigator.serviceWorker.ready;
      stage = 'browser push subscription';
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        }));
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
        throw new Error(
          'The browser returned an incomplete push subscription.',
        );
      const supabase = getSupabaseBrowserClient();
      if (!supabase) throw new Error('Online workspace is unavailable.');
      stage = 'account verification';
      const { data: userData, error: userError } =
        await supabase.auth.getUser();
      if (userError || !userData.user)
        throw userError ?? new Error('Sign in before enabling notifications.');
      stage = 'saving this device';
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          owner_user_id: userData.user.id,
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
          user_agent: navigator.userAgent,
          disabled_at: null,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'owner_user_id,endpoint' },
      );
      if (error) throw error;
      setSubscribed(true);
    } catch (error) {
      setMessage(`Enable failed at ${stage}: ${errorDetails(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMessage('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const supabase = getSupabaseBrowserClient();
        if (supabase)
          await supabase
            .from('push_subscriptions')
            .update({ disabled_at: new Date().toISOString() })
            .eq('endpoint', subscription.endpoint);
        await subscription.unsubscribe();
      }
      setSubscribed(false);
    } catch (error) {
      setMessage(`Disable failed: ${errorDetails(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function testNotification() {
    if (Notification.permission !== 'granted') {
      setMessage('Enable notifications first.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription)
        throw new Error('This device has no active push subscription.');
      const supabase = getSupabaseBrowserClient();
      if (!supabase) throw new Error('Online workspace is unavailable.');
      const { data: requestId, error } = await supabase.rpc(
        'request_myplan_push_test',
        { target_endpoint: subscription.endpoint },
      );
      if (error || !requestId)
        throw error ?? new Error('Could not create a push test request.');
      const response = await fetch(`${PUSH_WORKER_URL}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          result?.error || `Push test failed (${response.status}).`,
        );
      setMessage(
        'Remote push request accepted. This does not confirm delivery. If no notification appears, try “Test on this device” to check browser/Windows display separately.',
      );
    } catch (error) {
      setMessage(`Test failed: ${errorDetails(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function testOnDevice() {
    setBusy(true);
    setMessage('');
    try {
      const permissionValue = await Notification.requestPermission();
      setPermission(permissionValue);
      if (permissionValue !== 'granted')
        throw new Error('Allow notifications in this browser first.');
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification('myplan — Device notification test', {
        body: 'This checks notification display on this device, without contacting the push server.',
        tag: 'myplan-device-test',
        icon: '/icon-192.png',
      });
      setMessage(
        'Notification display requested on this device. If nothing appears, check Windows Notification Center, Do not disturb/Focus and Edge notification permissions. This test does not verify remote delivery.',
      );
    } catch (error) {
      setMessage(`Device test failed: ${errorDetails(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-6 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <p className="eyebrow">Account & device</p>
        <h1 className="page-title">Settings</h1>
      </div>
      <div className="w-full rounded-3xl border bg-card p-5 shadow-sm sm:p-7">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <BellRing className="size-5" />
          </span>
          <div>
            <h2 className="text-lg font-semibold">Push notifications</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {dataMode === 'cloud'
                ? 'Receive checklist and reminder alerts even when myplan is closed.'
                : 'Local notifications require the local server and myplan to remain running.'}
              Each phone or computer is enabled separately.
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void (subscribed && dataMode === 'cloud' ? disable() : enable())
            }
            disabled={busy || checking || (dataMode === 'local' && subscribed)}
          >
            {subscribed
              ? dataMode === 'cloud'
                ? 'Disable on this device'
                : 'Local notifications enabled'
              : 'Enable on this device'}
          </Button>
          <Button
            variant="outline"
            onClick={() => void testNotification()}
            disabled={dataMode !== 'cloud' || !subscribed || busy || checking}
          >
            Send remote push test
          </Button>
          <Button
            variant="outline"
            disabled={!supported || busy || checking}
            onClick={() => void testOnDevice()}
          >
            Test on this device
          </Button>
        </div>
        <div className="mt-5 flex items-center gap-2 text-sm">
          {subscribed ? (
            <CheckCircle2 className="size-4 text-primary" />
          ) : (
            <Info className="size-4 text-muted-foreground" />
          )}
          <span>
            {subscribed
              ? 'Enabled for this device'
              : permission === 'denied'
                ? 'Blocked in browser or system notification settings'
                : 'Not enabled on this device'}
          </span>
        </div>
        {message ? (
          <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm">
            {message}
          </p>
        ) : null}
      </div>
      <div className="w-full rounded-3xl border bg-card p-5 sm:p-7">
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 size-5 text-primary" />
          <div>
            <h2 className="font-semibold">iPhone setup</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                Open myplan in Safari, then choose Share → Add to Home Screen.
              </li>
              <li>Open myplan from the new Home Screen icon and sign in.</li>
              <li>Return here and tap Enable on this device.</li>
            </ol>
            {!standalone ? (
              <p className="mt-3 text-sm font-medium text-amber-700 dark:text-amber-300">
                This page is not currently running as a Home Screen app.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
