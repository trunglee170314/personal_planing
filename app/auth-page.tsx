'use client';

import {
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  KeyRound,
  LoaderCircle,
  LogIn,
  Mail,
  UserPlus,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  authRedirectUrl,
  normalizeDisplayName,
  passwordRequirements,
  validatePassword,
} from '@/lib/auth';
import { getAppDataMode } from '@/lib/data/repository';
import {
  getSupabaseBrowserClient,
  hasSupabaseConfig,
} from '@/lib/supabase/client';

type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

const content: Record<
  AuthMode,
  { eyebrow: string; title: string; description: string }
> = {
  login: {
    eyebrow: 'Your private planning workspace',
    title: 'Welcome back',
    description: 'Sign in to continue with your goals, tasks, and calendar.',
  },
  register: {
    eyebrow: 'Create your own workspace',
    title: 'Create an account',
    description:
      'Your planning data is private and separated from every other account.',
  },
  forgot: {
    eyebrow: 'Account recovery',
    title: 'Reset your password',
    description: 'We will send a secure recovery link to your email address.',
  },
  reset: {
    eyebrow: 'Choose a new password',
    title: 'Set your password',
    description: 'Enter a new password for your myplan account.',
  },
};

export function AuthPage({ mode }: { mode: AuthMode }) {
  const dataMode = getAppDataMode();
  const supabase = getSupabaseBrowserClient();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(mode !== 'reset');

  useEffect(() => {
    if (dataMode === 'local') {
      window.location.replace('/');
      return;
    }
    if (!supabase) return;
    if (mode !== 'reset') {
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) window.location.replace('/');
        else if (
          mode === 'login' &&
          new URLSearchParams(window.location.search).get('confirmed') === '1'
        ) {
          setMessage('Email confirmed. You can sign in now.');
        }
      });
      return;
    }

    void supabase.auth.getSession().then(({ data }) => {
      if (new URLSearchParams(window.location.search).get('error')) {
        setIsError(true);
        setMessage(
          'This recovery link is invalid or has expired. Request a new one.',
        );
      }
      setRecoveryReady(Boolean(data.session));
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setRecoveryReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, [dataMode, mode, supabase]);

  function showError(value: string) {
    setIsError(true);
    setMessage(value);
  }

  function showSuccess(value: string) {
    setIsError(false);
    setMessage(value);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setSubmitting(true);
    setMessage('');
    setIsError(false);

    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      setSubmitting(false);
      if (error) showError(error.message);
      else window.location.replace('/');
      return;
    }

    if (mode === 'register') {
      const name = normalizeDisplayName(displayName);
      const passwordError = validatePassword(password);
      if (name.length < 2) {
        setSubmitting(false);
        showError('Enter a display name with at least 2 characters.');
        return;
      }
      if (passwordError) {
        setSubmitting(false);
        showError(passwordError);
        return;
      }
      if (password !== confirmPassword) {
        setSubmitting(false);
        showError('The two passwords do not match.');
        return;
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: { display_name: name },
          emailRedirectTo: authRedirectUrl(
            window.location.origin,
            '/login?confirmed=1',
          ),
        },
      });
      setSubmitting(false);
      if (error) showError(error.message);
      else if (data.session) window.location.replace('/');
      else
        showSuccess(
          'Account created. Check your email and confirm the account before signing in.',
        );
      return;
    }

    if (mode === 'forgot') {
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        {
          redirectTo: authRedirectUrl(
            window.location.origin,
            '/reset-password',
          ),
        },
      );
      setSubmitting(false);
      if (error) showError(error.message);
      else
        showSuccess(
          'If an account exists for this email, a recovery link is on its way.',
        );
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      setSubmitting(false);
      showError(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setSubmitting(false);
      showError('The two passwords do not match.');
      return;
    }
    if (!recoveryReady) {
      setSubmitting(false);
      showError(
        'This recovery link is invalid or has expired. Request a new one.',
      );
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (error) showError(error.message);
    else window.location.replace('/');
  }

  const copy = content[mode];
  const setupRequired = !supabase || !hasSupabaseConfig();

  if (dataMode === 'local') {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <LoaderCircle className="size-6 animate-spin text-primary" />
        <span className="sr-only">Opening your local workspace</span>
      </div>
    );
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-5 py-10 text-foreground">
      <div className="pointer-events-none absolute inset-0 auth-backdrop" />
      <Card className="relative w-full max-w-[450px] border bg-card/95 shadow-2xl shadow-foreground/10 backdrop-blur-xl">
        <CardContent className="px-7 py-8 sm:px-9">
          <HardNavigationLink
            href="/"
            className="mb-8 flex w-fit items-center gap-3 text-xl font-bold tracking-[-.04em]"
          >
            <span className="grid size-10 place-items-center rounded-[13px_13px_13px_4px] bg-primary text-primary-foreground">
              <Check className="size-5" />
            </span>
            myplan
          </HardNavigationLink>
          <p className="text-[10px] font-bold uppercase tracking-[.15em] text-primary">
            {copy.eyebrow}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-.045em]">
            {copy.title}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {copy.description}
          </p>

          {setupRequired ? (
            <div className="mt-7 rounded-xl border border-primary/20 bg-secondary p-4 text-sm">
              Authentication is not configured for this build.
            </div>
          ) : (
            <form className="mt-7 space-y-4" onSubmit={submit}>
              {mode === 'register' ? (
                <AuthField label="Display name" htmlFor="display-name">
                  <Input
                    id="display-name"
                    required
                    autoComplete="name"
                    placeholder="Your name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    className="mt-2 h-11 rounded-xl"
                  />
                </AuthField>
              ) : null}

              {mode !== 'reset' ? (
                <AuthField label="Email address" htmlFor="email">
                  <Input
                    id="email"
                    required
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="mt-2 h-11 rounded-xl"
                  />
                </AuthField>
              ) : null}

              {mode === 'login' || mode === 'register' || mode === 'reset' ? (
                <AuthField
                  label={mode === 'reset' ? 'New password' : 'Password'}
                  htmlFor="password"
                >
                  <Input
                    id="password"
                    required
                    type="password"
                    minLength={8}
                    autoComplete={
                      mode === 'login' ? 'current-password' : 'new-password'
                    }
                    placeholder="Enter your password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="mt-2 h-11 rounded-xl"
                  />
                </AuthField>
              ) : null}

              {mode === 'register' || mode === 'reset' ? (
                <>
                  <AuthField
                    label="Confirm password"
                    htmlFor="confirm-password"
                  >
                    <Input
                      id="confirm-password"
                      required
                      type="password"
                      minLength={8}
                      autoComplete="new-password"
                      placeholder="Enter it again"
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      className="mt-2 h-11 rounded-xl"
                    />
                  </AuthField>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {passwordRequirements}
                  </p>
                </>
              ) : null}

              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={submitting || (mode === 'reset' && !recoveryReady)}
              >
                {submitting ? (
                  <LoaderCircle className="animate-spin" />
                ) : mode === 'register' ? (
                  <UserPlus />
                ) : mode === 'forgot' ? (
                  <Mail />
                ) : mode === 'reset' ? (
                  <KeyRound />
                ) : (
                  <LogIn />
                )}
                {mode === 'register'
                  ? 'Create account'
                  : mode === 'forgot'
                    ? 'Send recovery link'
                    : mode === 'reset'
                      ? 'Save new password'
                      : 'Sign in'}
              </Button>

              {message ? (
                <p
                  aria-live="polite"
                  className={`rounded-lg p-3 text-xs ${
                    isError
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-secondary text-secondary-foreground'
                  }`}
                >
                  {message}
                </p>
              ) : null}
            </form>
          )}

          <AuthLinks mode={mode} />
          <p className="mt-7 border-t pt-5 text-center text-[11px] text-muted-foreground">
            Each account has a private workspace protected by Supabase Row Level
            Security.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function AuthField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="text-xs font-semibold">
        {label}
      </Label>
      {children}
    </div>
  );
}

function AuthLinks({ mode }: { mode: AuthMode }) {
  if (mode === 'login') {
    return (
      <div className="mt-5 flex items-center justify-between gap-4 text-xs font-semibold">
        <HardNavigationLink
          href="/forgot-password"
          className="text-muted-foreground hover:text-foreground"
        >
          Forgot password?
        </HardNavigationLink>
        <HardNavigationLink
          href="/register"
          className="text-primary hover:underline"
        >
          Create account
        </HardNavigationLink>
      </div>
    );
  }
  return (
    <HardNavigationLink
      href="/login"
      className="mt-5 flex items-center justify-center gap-2 text-xs font-semibold text-primary hover:underline"
    >
      <ArrowLeft className="size-3.5" /> Back to sign in
    </HardNavigationLink>
  );
}

function HardNavigationLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    window.location.assign(href);
  }

  return (
    <Link href={href} className={className} onClick={navigate}>
      {children}
    </Link>
  );
}
