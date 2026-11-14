import Head from 'next/head';
import { BrandLogo } from '@/components/BrandLogo';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useDashboardAuth, authorizedFetch } from '@/lib/dashboardAuth';
import { trackProductEvent } from '@/lib/productAnalytics';
import { AuthorizeSignInPanel } from '@/components/AuthorizeSignInPanel';
import { AuthorizeAccountBadge } from '@/components/AuthorizeAccountBadge';
import { deviceLinkLifetimeCopy } from '@/lib/authorizeFlow';
import { usePageScroll } from '@/hooks';

// The device-code half of the authorization step (`claude mcp add` sends users
// here with ?code=). Shares event names with /oauth/consent so the whole
// "authorize" stage reads as one funnel step, and is separated by `surface`
// because the two flows break in different ways.
const SURFACE = 'mcp_device_code';

type Status = 'idle' | 'authorizing' | 'done' | 'unauthenticated' | 'error';

export default function McpAuthPage() {
  // Renders outside the dashboard shell, whose global `overflow: hidden`
  // would otherwise strand anything below the fold on a short viewport.
  usePageScroll();
  // Without Clerk (local dev, self-hosted) the session is the API cookie:
  // lib/dashboardAuth reads it and calls the API directly. This page used to
  // answer "sign-in unavailable" there, which left a self-host unable to
  // approve any connection.
  return <McpAuthInner />;
}

function McpAuthInner() {
  const router = useRouter();
  const { getToken, isSignedIn, isLoaded } = useDashboardAuth();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // Whether this link can still work. A device code that has expired, been used,
  // or was never issued is dead: re-POSTing it cannot do anything but fail, and
  // the only exit is a fresh link from the tool. Offering "Try again" for those
  // was a loop with no way out, and it was the single most likely thing to
  // happen to this page — the link lives thirty minutes (ten on old clients) and
  // a human has to notice it in a terminal and walk it to a browser.
  const [errorTerminal, setErrorTerminal] = useState(false);
  const userCode = router.query.code as string | undefined;
  const viewFired = useRef(false);
  // True once Clerk has answered, or once 3s have passed without it. The
  // timeout is the safety net: if the Clerk script never loads, falling
  // through to the sign-in panel gives the user a route forward, where the
  // old unconditional Connect button gave them a guaranteed 401.
  const [clerkTimedOut, setClerkTimedOut] = useState(false);
  useEffect(() => {
    if (isLoaded) return;
    const t = setTimeout(() => setClerkTimedOut(true), 3000);
    return () => clearTimeout(t);
  }, [isLoaded]);
  const sessionResolved = isLoaded || clerkTimedOut;

  // Wait for isLoaded, not just router.isReady. Clerk's auth state resolves
  // asynchronously, and trackProductEvent posts server-side — so firing on the
  // first ready render sent the view WITHOUT a bearer token, and the API keyed
  // it to the anonymous id. oauth_consent_approved fires later, after
  // getToken(), under the real user. That is why viewed and approved landed on
  // two different person_ids a second apart and the per-person consent funnel
  // undercounted. Waiting costs a beat and attributes both to one person.
  useEffect(() => {
    if (!router.isReady || !isLoaded || viewFired.current) return;
    viewFired.current = true;
    trackProductEvent('oauth_consent_viewed', {
      source: 'dashboard',
      path: '/mcp-auth',
      metadata: {
        surface: SURFACE,
        has_request: userCode ? 1 : 0,
        signed_in: isSignedIn ? 1 : 0,
      },
    });
  }, [router.isReady, isLoaded, userCode, isSignedIn]);

  const trackOutcome = (event: string, metadata: Record<string, unknown> = {}) => {
    trackProductEvent(event, {
      source: 'dashboard',
      path: '/mcp-auth',
      metadata: { surface: SURFACE, ...metadata },
    });
  };

  async function authorize() {
    if (!userCode) {
      setErrorMsg('This link is missing its sign-in code. Start sign-in again in your AI tool to get a complete link.');
      setErrorTerminal(true);
      setStatus('error');
      trackOutcome('oauth_consent_failed', { reason: 'missing_request' });
      return;
    }
    if (!isSignedIn) {
      setStatus('unauthenticated');
      trackOutcome('oauth_consent_signin_required', { at: 'pre_token' });
      return;
    }
    setStatus('authorizing');
    setErrorTerminal(false);
    try {
      const token = await getToken();
      if (!token) {
        setStatus('unauthenticated');
        trackOutcome('oauth_consent_signin_required', { at: 'no_token' });
        return;
      }
      const res = await authorizedFetch(token, '/api/mcp-authorize', '/api/v1/auth/mcp/authorize', {
        method: 'POST',
        body: JSON.stringify({ user_code: userCode }),
      });
      if (res.status === 401) {
        setStatus('unauthenticated');
        trackOutcome('oauth_consent_signin_required', { at: 'approve_401' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // `HTTP 404` remains only as a last resort, for a failure the API did not
        // describe. It should never be what a user actually reads.
        setErrorTerminal(Boolean(body.terminal) || res.status === 404 || res.status === 409);
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      setStatus('done');
      trackOutcome('oauth_consent_approved', { http_status: res.status });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Authorization failed.';
      setErrorMsg(message);
      setStatus('error');
      trackOutcome('oauth_consent_failed', { reason: 'approve_failed', detail: message.slice(0, 120) });
    }
  }

  return (
    <>
      <Head>
        <title>Authorize AI Tools | DeerDawn</title>
      </Head>
      {/* The badge sits in its own row, not absolutely over the page. It now
          carries a full email address and a second line, and on a 375px screen
          an absolute badge that tall lands on top of the card. The row reserves
          its height so the card does not jump when Clerk resolves. */}
      <div className="flex min-h-screen flex-col bg-background p-4 sm:p-8">
        <div className="flex min-h-[52px] items-start justify-end"><AuthorizeAccountBadge surface={SURFACE} path="/mcp-auth" /></div>
        <div className="flex flex-1 items-center justify-center py-4">
        <div className="w-full max-w-[460px] rounded-[20px] border border-border-subtle bg-overlay-subtle p-6 sm:p-10">

          <div className="mb-8 text-center">
            <div className="mb-3 inline-flex items-center justify-center">
              <div className="relative h-14 w-14 overflow-hidden rounded-2xl border border-primary/20 bg-primary/10">
                <BrandLogo alt="DeerDawn" sizes="56px" priority />
              </div>
            </div>
            <h1 className="m-0 text-[22px] font-semibold text-text-primary">Connect to DeerDawn</h1>
            <p className="mb-0 mt-2 text-[14px] text-text-muted">
              An AI tool wants to connect to your DeerDawn account.
            </p>
          </div>

          {/* Clerk resolves asynchronously. Until it has, neither branch below is
              honest — so wait, rather than flashing a Connect button at a browser
              that turns out to have no session. `sessionResolved` also flips after
              a 3s timeout so a blocked Clerk script lands on the sign-in panel
              (which offers a way forward) instead of stranding the page. */}
          {!sessionResolved && (
            <p className="text-center text-[14px] text-text-muted">Checking your session…</p>
          )}

          {sessionResolved && !isSignedIn && status === 'idle' && (
            <AuthorizeSignInPanel surface={SURFACE} path="/mcp-auth" />
          )}

          {sessionResolved && isSignedIn && status === 'idle' && (
            <>
              <div className="mb-6 rounded-xl border border-primary/20 bg-primary/[0.07] p-4 text-[13px] leading-[1.6] text-text-secondary">
                Your projects, decisions, and context will be available to this tool automatically. You can revoke access any time from your dashboard settings.
              </div>
              <button
                onClick={authorize}
                className="w-full cursor-pointer rounded-xl border-none bg-primary p-3.5 text-[15px] font-semibold text-on-primary"
              >
                Connect
              </button>
            </>
          )}

          {status === 'authorizing' && (
            <p className="text-center text-[14px] text-text-muted">Authorizing…</p>
          )}

          {/* Reachable now only when Clerk claimed a session and the token or the
              approve call then said otherwise. The old copy here asked the user to
              open app.deerdawn.com in another tab, sign in, and come back — a manual
              round trip that nobody in 90 days completed. Same panel as the
              signed-out arrival: it carries this URL through the sign-in. */}
          {status === 'unauthenticated' && (
            <div>
              <AuthorizeSignInPanel surface={SURFACE} path="/mcp-auth" />
              <button
                onClick={authorize}
                className="ui-press ui-focus mt-3 w-full cursor-pointer rounded-[10px] border border-border-subtle bg-overlay-active p-3 text-[14px] text-text-primary"
              >
                Already signed in? Try again
              </button>
            </div>
          )}

          {status === 'done' && (
            <div className="text-center">
              <div className="mb-3 text-[36px]">✓</div>
              <p className="m-0 text-[16px] font-semibold text-primary">Authorized</p>
              {/* "You can close this tab" was the whole page, so a person who had
                  just finished the one step they were asked to do had no idea
                  what to do after it. This link is only ever opened from the npm
                  server: `setup` in a terminal, or a sign-in started inside the
                  AI tool (the session hook, get_auth_status). Both are covered,
                  with the exact thing to do next. */}
              <div className="mt-4 rounded-xl border border-border-subtle bg-overlay-active p-4 text-left text-[13px] leading-[1.6] text-text-secondary">
                <p className="m-0 font-medium text-text-primary">Next, go back to your terminal or AI tool</p>
                <p className="mb-0 mt-2">
                  <span className="font-medium text-text-primary">Ran setup in a terminal?</span>{' '}
                  It finishes by itself and prints your brief. Then start a new Claude Code session in your project: the brief loads before the first reply.
                </p>
                <p className="mb-0 mt-2">
                  <span className="font-medium text-text-primary">Signed in from Claude Code, Cursor or Codex?</span>{' '}
                  That session is connected now. Type:
                </p>
                <p className="mb-0 mt-1.5 rounded-lg border border-border-subtle bg-surface px-3 py-2 font-mono text-[12px] text-text-primary">
                  Set up a DeerDawn brief for this project
                </p>
                <p className="mb-0 mt-1.5">
                  {'Already have one? Type "Where did I leave off? Check DeerDawn".'}
                </p>
              </div>
              <p className="mt-3 text-[12px] text-text-muted">You can close this tab.</p>
            </div>
          )}

          {status === 'error' && (
            <div className="text-center">
              <p className="m-0 font-medium text-[#f87171]">
                {errorTerminal ? 'This sign-in link is no longer valid' : 'Something went wrong'}
              </p>
              <p className="mt-2 text-[13px] text-text-muted">{errorMsg}</p>
              {errorTerminal ? (
                // No retry button on purpose: the one action available here would
                // resend the same dead code. Give the step that actually works.
                <div className="mt-4 rounded-xl border border-border-subtle bg-overlay-active p-4 text-left text-[13px] leading-[1.6] text-text-secondary">
                  <p className="m-0 font-medium text-text-primary">To get a new link</p>
                  <p className="mb-0 mt-1.5">
                    {/* One string: a JSX expression followed by text across a line
                        break loses its space, and the lifetime comes from the same
                        constants the API's TTLs are pinned to. */}
                    {`Go back to your AI tool and start a DeerDawn session again. It will print a fresh sign-in link, ${deviceLinkLifetimeCopy()}. Nothing on this page needs to be undone first.`}
                  </p>
                </div>
              ) : (
                <button
                  onClick={() => setStatus('idle')}
                  className="mt-4 cursor-pointer rounded-[10px] border border-border-subtle bg-overlay-active px-5 py-2.5 text-[13px] text-text-primary"
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
        </div>
      </div>
    </>
  );
}
