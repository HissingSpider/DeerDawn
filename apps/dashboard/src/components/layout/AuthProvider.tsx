import { useAuth } from '@clerk/nextjs';
import { useEffect } from 'react';
import React from 'react';
import { useRouter } from 'next/router';
import { WorkspaceLoadingScreen } from '@/components/dashboard/WorkspaceLoadingScreen';

/**
 * Whether a session exists, from the one place that already knows.
 *
 * Pages behind AuthProvider have never needed this: reaching them at all proved
 * a session. Preview pages (below) are the exception — they render for both
 * kinds of reader and must show different things, and they cannot call Clerk's
 * `useAuth` themselves because the provider only exists in Clerk mode
 * (`_app.tsx` mounts neither ClerkProvider nor AuthProvider when Clerk is off,
 * for local dev and self-hosting).
 *
 * The default is `signed-in`, which is what "there is no gate in this
 * deployment" means: without AuthProvider above them, pages behave exactly as
 * they do today rather than all quietly switching to their signed-out branch.
 */
export type AuthPresence = 'loading' | 'signed-in' | 'signed-out';

const AuthPresenceContext = React.createContext<AuthPresence>('signed-in');

export const useAuthPresence = (): AuthPresence => React.useContext(AuthPresenceContext);

/**
 * Pages that render something real for a signed-out visitor instead of bouncing
 * to /login. Exact pathname match — a prefix would also open every route below
 * it, and these are opened one at a time, deliberately.
 *
 * /onboarding is here because the thing it exists to hand over — the connector
 * URL and the one-command setup — is identical for every account (see
 * `src/lib/onboardingPreview.ts`, and `connectCopy.ts` for the values). The
 * public /connect page shows both to anyone; the dashboard's own setup flow
 * asked for an account first, which is a signup form standing in front of two
 * strings it does not scope.
 *
 * The condition for adding a page here is not "it looks harmless": it is that
 * the page has an explicit, tested signed-out branch that issues NO
 * authenticated request. Without that, this list re-creates the defect the
 * original gate fixed — a signed-out reader reaching an authed page and being
 * shown a confusing "session expired" error instead of being sent to sign in.
 */
//
// /invite is here because the person most likely to open an invite link is the
// one with no account yet. Bounced to /login, they saw a sign-in form with no
// mention of the workspace and, choosing "create one", lost the invitation. The
// page's signed-out branch parks the token and offers sign-up or sign-in with
// the way back attached; it issues no authenticated request.
const PREVIEW_PAGES = ['/onboarding', '/invite'];

/**
 * AuthProvider - route protection for dashboard sessions.
 * The API client reads Clerk directly, so this provider only gates rendering.
 */
export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const [isReady, setIsReady] = React.useState(false);
  const [isDelayed, setIsDelayed] = React.useState(false);

  const publicPages = ['/login', '/signup', '/404', '/mcp-auth', '/forgot-password'];
  const isPublicPage = publicPages.some(p => router.pathname.startsWith(p));
  // Bug 5 fix: onboarding/checkout/select-plan require an active session.
  // Previously they were in the bypass list, so signed-out users could reach
  // them and see a confusing "session expired" error instead of being sent to login.
  const isAuthPage = isPublicPage;
  // ...with one narrowing: a preview page renders for a signed-out reader too,
  // but unlike the bypass list it is still handed the presence below, so the
  // page shows its preview rather than firing authed calls at a reader who has
  // no token. /checkout and /select-plan are NOT preview pages and still bounce.
  const isPreviewPage = PREVIEW_PAGES.includes(router.pathname);
  const rendersWithoutSession = isAuthPage || isPreviewPage;

  const presence: AuthPresence = !isLoaded ? 'loading' : isSignedIn ? 'signed-in' : 'signed-out';

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn || rendersWithoutSession) {
      setIsReady(true);
      return;
    }
    // Bug 4 fix: do NOT set isReady before the redirect fires. Setting it to
    // true here caused a blank flash — isReady=true + isSignedIn=false rendered
    // null for a frame before navigation completed. Keep the loading screen up
    // until the route change takes the user away.
    const redirectTarget = router.pathname !== '/'
      ? `/login?redirect_url=${encodeURIComponent(router.asPath)}`
      : '/login';
    router.replace(redirectTarget);
  }, [isLoaded, isSignedIn, rendersWithoutSession, router]);

  useEffect(() => {
    // Bug 9 fix: previously the timer re-ran on every isLoaded/isReady change,
    // including route transitions where isReady briefly resets. That could show
    // the "Go to sign in" link to authenticated users mid-navigation. Only arm
    // the delay timer when we're genuinely waiting for initial auth resolution
    // (not signed in yet, not on a public page).
    if (isLoaded && isReady) {
      setIsDelayed(false);
      return;
    }
    if (isSignedIn || rendersWithoutSession) {
      setIsDelayed(false);
      return;
    }

    const timer = window.setTimeout(() => setIsDelayed(true), 6000);
    return () => window.clearTimeout(timer);
  }, [isLoaded, isReady, isSignedIn, rendersWithoutSession]);

  if (!isLoaded || !isReady) {
    return (
      <WorkspaceLoadingScreen
        eyebrow="Session restore"
        title="Restoring your workspace"
        description="Validating your DeerDawn session, reattaching the workspace shell, and preparing the next dashboard view."
        delayed={isDelayed}
        delayedLabel="If this keeps hanging, jump back through sign in and start a fresh dashboard session."
        primaryHref={isDelayed ? '/login' : undefined}
        primaryLabel={isDelayed ? 'Go to sign in' : undefined}
      />
    );
  }

  // Children only ever mount once Clerk has answered (the gate above), so a
  // preview page reads a settled presence on its first render — it never starts
  // an authed effect and then discovers there was no session.
  return <AuthPresenceContext.Provider value={presence}>{children}</AuthPresenceContext.Provider>;
};
