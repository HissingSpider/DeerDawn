import { useState } from 'react';
import { useUser, SignInButton } from '@clerk/nextjs';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { useSafeSignOut } from '@/lib/useSafeSignOut';
import { authorizeReturnUrl } from '@/lib/authorizeFlow';
import { trackProductEvent } from '@/lib/productAnalytics';
import { PRODUCT_EVENTS } from '@/lib/analyticsEvents';

// The corner badge on the two authorize screens (/mcp-auth, /oauth/consent).
//
// It used to be two copies of one component, and both showed a FIRST NAME. That
// is the wrong identifier for this screen. Pressing Connect hands an AI tool
// standing access to one account's projects, and somebody with a work and a
// personal account is "John" in both: the badge could not tell them which one
// they were about to connect. Nor could they change it. The only exit was to
// open the dashboard in another tab, sign out there, and hope the request was
// still alive when they came back.
//
// So it names the account by its full email address, and offers the switch in
// place. Switching signs out and returns to THIS url, query included, because
// the query is the request (`?req=` / `?code=`). The page then shows its own
// sign-in panel, which already carries the same url through the sign-in.

export interface AccountBadgeViewProps {
  /** The signed-in account's primary email. The identifier people recognise. */
  email: string;
  /** Used only for the avatar fallback initials and the image alt text. */
  name?: string;
  avatarUrl?: string;
  onSwitch: () => void;
  switching?: boolean;
}

/** Presentational half, free of Clerk so it can be rendered in a test. */
export function AccountBadgeView({ email, name, avatarUrl, onSwitch, switching = false }: AccountBadgeViewProps) {
  const label = email || name || '';
  const initials = (name || email || '').slice(0, 2).toUpperCase();
  return (
    <div className="flex max-w-full items-start gap-2 rounded-2xl border border-border-subtle bg-overlay-active py-1.5 pl-2 pr-3">
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-full object-cover" />
      ) : (
        <div className="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary/30 text-[10px] font-bold text-primary">{initials}</div>
      )}
      <div className="min-w-0 text-left">
        {/* Wrapped, never truncated. A clipped address hides its domain, which is
            the half that tells a work account from a personal one. */}
        <div className="break-all text-[12px] leading-[1.35] text-text-secondary" data-testid="authorize-account-email">
          <span className="sr-only">Signed in as </span>
          {label}
        </div>
        <button
          type="button"
          onClick={onSwitch}
          disabled={switching}
          className="ui-focus mt-0.5 cursor-pointer border-none bg-transparent p-0 text-left text-[12px] font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          {switching ? 'Signing out…' : 'Not you? Switch account'}
        </button>
      </div>
    </div>
  );
}

// Without Clerk there is no account switcher to offer: the sign-in panel below
// the card is the way to change who is signed in.
export function AuthorizeAccountBadge(props: { surface: string; path: string }) {
  return isClerkHostedAuthEnabled() ? <ClerkAuthorizeAccountBadge {...props} /> : null;
}

function ClerkAuthorizeAccountBadge({ surface, path }: { surface: string; path: string }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const signOut = useSafeSignOut();
  const [switching, setSwitching] = useState(false);
  if (!isLoaded) return null;

  if (!isSignedIn) {
    // Carries this page's URL, query included, through the sign-in. Without it
    // this pill returned people to the dashboard root and lost the request.
    const here = typeof window !== 'undefined' ? window.location.href : undefined;
    return (
      <SignInButton mode="redirect" forceRedirectUrl={here} signUpForceRedirectUrl={here}>
        <button className="flex cursor-pointer items-center gap-[7px] rounded-[20px] border border-border-subtle bg-overlay-active px-3 py-1.5 text-[13px] font-medium text-text-secondary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          Sign in
        </button>
      </SignInButton>
    );
  }

  const email = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || '';
  const name = user?.fullName || user?.firstName || '';

  const switchAccount = async () => {
    if (switching) return;
    const returnUrl = authorizeReturnUrl(typeof window !== 'undefined' ? window.location.href : null);
    // No parseable URL means no safe place to come back to. Do nothing rather
    // than sign the user out into the dashboard root with the request gone.
    if (!returnUrl) return;
    setSwitching(true);
    // Fire-and-forget. trackProductEvent posts with the CURRENT session's token,
    // so it has to be sent before that session is destroyed, and it must never be
    // the reason the switch does not happen.
    void Promise.resolve(
      trackProductEvent(PRODUCT_EVENTS.oauthConsentSwitchAccountClicked, { source: 'dashboard', path, metadata: { surface } }),
    ).catch(() => undefined);
    try {
      await signOut({ redirectUrl: returnUrl });
    } catch {
      setSwitching(false);
    }
  };

  return (
    <AccountBadgeView
      email={email}
      name={name}
      avatarUrl={user?.imageUrl}
      onSwitch={() => void switchAccount()}
      switching={switching}
    />
  );
}
