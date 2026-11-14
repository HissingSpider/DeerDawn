import { useEffect, useState } from 'react';
import { AuthenticateWithRedirectCallback } from '@clerk/nextjs';
import { useRouter } from 'next/router';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { ClerkAuthUnavailablePage } from '@/components/ClerkAuthPage';
import AuthShell from '@/components/AuthShell';
import { ssoCallbackReturnTo, takeAuthorizeReturn } from '@/lib/authorizeFlow';

// Completes the OAuth handshake after Google redirects back. Clerk reads the
// callback params, finalizes the session, and forwards to the redirectUrlComplete
// passed to authenticateWithRedirect. The fallbacks only apply if that value is
// missing (e.g. a bookmarked callback URL).
//
// Except when Clerk transfers the attempt: a sign-in that is really a NEW
// account becomes a sign-up here (or the reverse), and then redirectUrlComplete
// is not used and the fallbacks decide. So a new account created from an
// authorize screen landed on /select-plan with its AI tool still waiting
// (E-030). The authorize screen therefore leaves its request in two places, and
// when either is present both legs are forced back to it:
//   1. `return_to` on this URL (ssoCallbackPath) — survives a round trip that
//      comes back in another tab or browser context, as an in-app browser can;
//   2. sessionStorage (rememberAuthorizeReturn) — survives Clerk dropping our
//      query on its way back here.
// Each covers the other's failure; the URL wins when both are present.
export default function SsoCallback() {
  const router = useRouter();
  const fromUrl = ssoCallbackReturnTo(router.query.return_to);
  // undefined = not read yet. The callback must not run before this resolves,
  // or it navigates with the fallback before it knows about the request. Read
  // (and so consumed) every time, even when the URL already answers, so a
  // leftover entry can never steer a later, unrelated sign-in.
  const [fromStorage, setFromStorage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { storage = null; }
    setFromStorage(takeAuthorizeReturn(storage, Date.now()));
  }, []);
  const returnTo = fromUrl || fromStorage || undefined;

  if (!isClerkHostedAuthEnabled()) {
    return <ClerkAuthUnavailablePage />;
  }

  return (
    <AuthShell
      mode="login"
      title="Signing you in…"
      subtitle="Finishing up with Google. This only takes a moment."
      alternateAction={null}
    >
      <div className="flex justify-center py-4" role="status" aria-live="polite">
        <svg className="h-6 w-6 animate-spin text-text-secondary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      </div>
      {fromStorage === undefined ? null : (
        <AuthenticateWithRedirectCallback
          signInFallbackRedirectUrl="/"
          signUpFallbackRedirectUrl="/select-plan"
          {...(returnTo ? { signInForceRedirectUrl: returnTo, signUpForceRedirectUrl: returnTo } : {})}
        />
      )}
    </AuthShell>
  );
}

export async function getServerSideProps() {
  return { props: {} };
}
