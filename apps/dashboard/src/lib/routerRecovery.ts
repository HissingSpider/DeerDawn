/**
 * Next's Pages Router client throws "Invariant: attempted to hard navigate to
 * the same URL" — rather than silently no-op'ing — when a route transition
 * falls back to a hard navigation whose target is already the current URL:
 * assigning `location.href` to itself does not reliably reload across
 * browsers, so Next throws instead of leaving the page silently stuck. It
 * fires outside React (inside Next's own route loader), so ErrorBoundary
 * never sees it and the SPA is left exactly as broken as whatever triggered
 * the fallback, with no recovery UI.
 *
 * PostHog issue 01a0822c (first seen 2026-09-08, on /onboarding): the same
 * invariant marketing already fixed via this exact mechanism (see
 * apps/marketing/src/lib/routerRecovery.ts, PostHog issue 019ffc63) — but the
 * dashboard never got its own copy, so a user landing on /onboarding straight
 * off a referral from the marketing site hit the unrecovered crash here. A
 * real `.reload()` (not `location.href = url`, the ambiguous no-op Next
 * avoids) gets the user a fresh page regardless of what caused the mismatch.
 */
const HARD_NAVIGATE_SAME_URL = 'attempted to hard navigate to the same URL';

export function isHardNavigateSameUrlInvariant(message: string | undefined | null): boolean {
  return typeof message === 'string' && message.includes(HARD_NAVIGATE_SAME_URL);
}

// Caps the auto-recovery at one reload per tab so a genuine loop (the
// invariant firing again right after reload) surfaces as an uncaught error
// instead of reloading forever.
const RELOAD_GUARD_KEY = 'dd_hard_nav_recovered';

function alreadyRecoveredThisTab(): boolean {
  try {
    return window.sessionStorage.getItem(RELOAD_GUARD_KEY) === '1';
  } catch {
    return false;
  }
}

function markRecovered(): void {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
  } catch {
    // sessionStorage unavailable — proceed without the guard rather than
    // skipping recovery entirely.
  }
}

/** Installs the recovery listener. Returns a cleanup function. */
export function installRouterRecovery(): () => void {
  const onError = (event: ErrorEvent) => {
    if (!isHardNavigateSameUrlInvariant(event.error?.message ?? event.message)) return;
    if (alreadyRecoveredThisTab()) return;
    markRecovered();
    window.location.reload();
  };
  window.addEventListener('error', onError);
  return () => window.removeEventListener('error', onError);
}
