import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSignIn, useAuth } from '@clerk/nextjs';
import AuthShell from '@/components/AuthShell';
import { ClerkAuthUnavailablePage } from '@/components/ClerkAuthPage';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { Button } from '@/components/ui/Button';

const MIN_PASSWORD_LENGTH = 8;

function formatClerkError(err: unknown) {
  const clerkErr = err as { errors?: { message?: string; longMessage?: string }[]; message?: string };
  return clerkErr.errors?.[0]?.longMessage
    || clerkErr.errors?.[0]?.message
    || clerkErr.message
    || 'We could not reset your password.';
}

function AuthMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm leading-6 text-text-secondary">
      {children}
    </div>
  );
}

function ResetPasswordFlow() {
  const router = useRouter();
  const { isLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();

  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (authLoaded && isSignedIn) {
      router.replace('/');
    }
  }, [authLoaded, isSignedIn, router]);

  const handleRequest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isLoaded) return;
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Enter your email to continue.');
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      await signIn!.create({ strategy: 'reset_password_email_code', identifier: normalizedEmail });
      setStep('reset');
    } catch (err: unknown) {
      setError(formatClerkError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isLoaded) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const result = await signIn!.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code: code.trim(),
        password,
      });
      if (result.status === 'complete' && result.createdSessionId) {
        await setActive!({ session: result.createdSessionId });
        await router.push('/');
        return;
      }
      setError(`Password reset is incomplete (${result.status}). Please try again.`);
    } catch (err: unknown) {
      setError(formatClerkError(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      mode="login"
      title={step === 'request' ? 'Reset your password' : 'Enter your code'}
      subtitle={step === 'request'
        ? 'Enter your email and we will send a one-time code to reset your password.'
        : `We sent a code to ${email}. Enter it with your new password.`}
      alternateAction={(
        <Link href="/login" className="font-medium text-text-secondary underline decoration-border-strong underline-offset-4 transition-colors hover:text-text-primary">
          Back to sign in
        </Link>
      )}
    >
      {step === 'request' ? (
        <form onSubmit={handleRequest} noValidate className="space-y-5">
          {error ? <AuthMessage>{error}</AuthMessage> : null}
          <div className="space-y-2">
            <label htmlFor="reset-email" className="dashboard-eyebrow block">Email</label>
            <input
              id="reset-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              autoComplete="email"
              autoFocus
              className="dashboard-input"
            />
          </div>
          <Button type="submit" isLoading={isLoading} className="w-full">Send reset code</Button>
        </form>
      ) : (
        <form onSubmit={handleReset} noValidate className="space-y-5">
          {error ? <AuthMessage>{error}</AuthMessage> : null}
          <div className="space-y-2">
            <label htmlFor="reset-code" className="dashboard-eyebrow block">Verification code</label>
            <input
              id="reset-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter the 6-digit code"
              inputMode="numeric"
              autoFocus
              className="dashboard-input"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="reset-password" className="dashboard-eyebrow block">New password</label>
            <input
              id="reset-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoComplete="new-password"
              className="dashboard-input"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="reset-confirm" className="dashboard-eyebrow block">Confirm new password</label>
            <input
              id="reset-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your new password"
              autoComplete="new-password"
              className="dashboard-input"
            />
          </div>
          <Button type="submit" isLoading={isLoading} disabled={!code.trim()} className="w-full">
            Set new password
          </Button>
          <button
            type="button"
            onClick={() => { setStep('request'); setCode(''); setError(''); }}
            className="w-full text-center text-sm font-medium text-text-secondary underline decoration-border-strong underline-offset-4 transition-colors hover:text-text-primary"
          >
            Use a different email
          </button>
        </form>
      )}
    </AuthShell>
  );
}

export default function ForgotPasswordPage() {
  if (isClerkHostedAuthEnabled()) {
    return <ResetPasswordFlow />;
  }
  return <ClerkAuthUnavailablePage />;
}

export async function getServerSideProps() {
  return { props: {} };
}
