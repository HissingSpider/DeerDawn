import { useState } from 'react';
import AuthShell from '@/components/AuthShell';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { getSafeRedirectPath } from '@/lib/redirects';
import { readPendingInvite } from '@/lib/pendingInvite';
import { inviteTokenFromReturnPath, useDeployment } from '@/lib/deployment';

/**
 * Email + password auth for environments WITHOUT Clerk hosted auth — i.e. local
 * dev and self-hosted. It talks to the API's /api/v1/auth/login + /signup, which
 * set the session cookie, so you can sign in and run full end-to-end tests
 * locally instead of hitting a dead-end "sign-in unavailable" screen.
 *
 * In production (Clerk enabled) this is never rendered — login.tsx / signup.tsx
 * choose ClerkAuthPage instead via isClerkHostedAuthEnabled().
 */
export function CredentialAuthPage({
  initialMode = 'login',
  redirectUrl = '/',
}: {
  initialMode?: 'login' | 'signup';
  redirectUrl?: string;
}) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSignup = mode === 'signup';
  // A self-hosted install defaults to SIGNUP_MODE=invite_only: after the first
  // account, the API only creates one for somebody carrying an invitation. The
  // token rides on the return URL the invite page sent them here with, and is
  // parked in this tab as well (lib/pendingInvite).
  const { deployment } = useDeployment();
  const inviteOnly = deployment?.signup_mode === 'invite_only';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (isSignup) {
        const inviteToken = inviteTokenFromReturnPath(redirectUrl) || readPendingInvite();
        await api.signup(email.trim(), password, inviteToken ? { invite_token: inviteToken } : undefined);
      } else {
        await api.login(email.trim(), password);
      }
      // Full navigation (not client routing) so the freshly-set session cookie
      // is read by the cookie-based bootstrap on the destination page.
      // H10: sanitize at the point of consumption — redirectUrl can originate
      // from the ?redirect_url query param (see login.tsx), so only a
      // same-origin relative path is honored here.
      window.location.assign(getSafeRedirectPath(redirectUrl));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      mode={mode}
      title={isSignup ? 'Create your account' : 'Sign in'}
      subtitle={
        isSignup
          ? (inviteOnly
            ? 'Sign-up on this install is by invitation. Use the email address your invitation was sent to.'
            : 'Local / self-hosted sign-up with email and password.')
          : 'Local / self-hosted sign-in with email and password.'
      }
      alternateAction={
        <button
          type="button"
          onClick={() => { setMode(isSignup ? 'login' : 'signup'); setError(null); }}
          className="font-medium text-primary underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-primary-hover"
        >
          {isSignup ? 'Already have an account? Sign in' : "No account? Create one"}
        </button>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && (
          <div
            role="alert"
            className="rounded-lg px-3 py-2 text-xs"
            style={{
              border: '1px solid rgba(239,68,68,0.3)',
              background: 'var(--status-deny-bg)',
              color: 'var(--status-danger-text)',
            }}
          >
            {error}
          </div>
        )}

        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
          fullWidth
        />

        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          minLength={isSignup ? 8 : undefined}
          required
          fullWidth
          helperText={isSignup ? 'At least 8 characters.' : undefined}
        />

        <Button type="submit" variant="primary" size="lg" disabled={submitting} className="w-full">
          {submitting ? 'Working…' : isSignup ? 'Create account' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}

export default CredentialAuthPage;
