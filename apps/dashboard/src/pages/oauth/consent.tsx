import Head from 'next/head';
import { BrandLogo } from '@/components/BrandLogo';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useDashboardAuth, authorizedFetch } from '@/lib/dashboardAuth';
import { trackProductEvent } from '@/lib/productAnalytics';
import { AuthorizeSignInPanel } from '@/components/AuthorizeSignInPanel';
import { AuthorizeAccountBadge } from '@/components/AuthorizeAccountBadge';
import { ConsentWorkspaceNotice } from '@/components/ConsentWorkspaceNotice';
import { ConsentNextStep } from '@/components/ConsentNextStep';
import { copyFirstPrompt } from '@/lib/consentNextStep';
import { consentWorkspace, type ConsentWorkspace } from '@/lib/consentWorkspace';
import { describeAuthorizeFailure } from '@/lib/authorizeFlow';
import {
  INVALID_HANDOFF_MESSAGE,
  nativeHandoffHint,
  nativeHandoffMessage,
  nativeHandoffRetryLabel,
  planConsentHandoff,
} from '@/lib/consentHandoff';
import { usePageScroll } from '@/hooks';

// This page is the ONLY mandatory hop between "user pasted our URL into their AI
// tool" and "tool is connected", and until now it emitted nothing at all. Over
// 2026-07-22..08-05, 33 accounts reached onboarding and 6 copied the connect URL,
// yet activation was 0 — and no event anywhere could say whether those 6 ever
// arrived here, bailed at the sign-in wall, or clicked Connect and got an error.
// `surface` distinguishes this (the remote-MCP authorization-code flow, used by
// Claude.ai / ChatGPT / Cursor connectors) from /mcp-auth (the device-code flow
// used by `claude mcp add`), because they fail for different reasons.
const SURFACE = 'oauth_consent';

// `handed_off`: approved and handed to a NATIVE app (cursor://, vscode://),
// which never unloads this page. See lib/consentHandoff.
type Status = 'idle' | 'authorizing' | 'redirecting' | 'handed_off' | 'unauthenticated' | 'error';

// Display-only details of the pending authorization request. `verified` is true
// only for clients whose identity is anchored to an allowlisted origin (CIMD);
// a self-registered (DCR) client is unverified and its destination must be shown
// prominently so the resource owner can spot a phishing redirect before Connect.
type ConsentDetails = {
  client_name: string;
  redirect_host: string | null;
  verified: boolean;
};

export default function OAuthConsentPage() {
  // Renders outside the dashboard shell, whose global `overflow: hidden` would
  // otherwise strand anything below the fold on a short viewport. #252 applied
  // this to /onboarding, /checkout, /select-plan, /invite and /mcp-auth but
  // missed this page — the one every remote-MCP connection has to pass through.
  usePageScroll();
  // Without Clerk (local dev, self-hosted) the session is the API cookie:
  // lib/dashboardAuth reads it and calls the API directly. This page used to
  // answer "sign-in unavailable" there, which left a self-host unable to
  // approve any connection.
  return <OAuthConsentInner />;
}

function OAuthConsentInner() {
  const router = useRouter();
  const { getToken, isSignedIn, isLoaded } = useDashboardAuth();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // Whether this request can still work. An expired (or malformed) request is
  // dead: approving it again can only return the same 404, and the only exit is
  // a new request from the tool. "Try again" for those was a loop with no way
  // out. Same rule, and same reason, as `errorTerminal` on /mcp-auth.
  const [errorTerminal, setErrorTerminal] = useState(false);
  // Set when the DETAILS fetch already says the request is dead, so the failure
  // event can wait for Clerk (see the view effect below for why it must).
  const [deadOnArrival, setDeadOnArrival] = useState<string | null>(null);
  const deadFired = useRef(false);
  const requestId = router.query.req as string | undefined;
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  // The workspace this approval will pin the connection to (permanent), read
  // once the person is signed in. Null until known, and when it cannot be read.
  const [pinnedTo, setPinnedTo] = useState<ConsentWorkspace | null>(null);
  // The native-app redirect, kept so the hand-off can be tried again without a
  // reload (a reload reads the approved request as no longer valid).
  const [handoffHref, setHandoffHref] = useState<string | null>(null);
  // Whether Connect managed to copy the first message (see lib/consentNextStep).
  const [promptCopied, setPromptCopied] = useState(false);
  const [detailsStatus, setDetailsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
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

  // Fetch who is asking and where the code will be delivered so the user can
  // make an informed decision. This fails CLOSED: if we can't confirm the
  // client's identity — network error, non-OK response, or a client we can't
  // verify — the consent screen shows the unverified-client warning rather than
  // the clean generic copy. A phishing client that suppresses this side fetch
  // must not thereby suppress its own warning.
  useEffect(() => {
    if (!router.isReady) return;
    if (!requestId) {
      setDetailsStatus('error');
      return;
    }
    let cancelled = false;
    setDetailsStatus('loading');
    fetch(`/api/oauth-consent?req=${encodeURIComponent(requestId)}`)
      .then(async (res) => {
        if (res.ok) return res.json();
        // Read the refusal instead of discarding it. This used to return null
        // for every non-200, so an EXPIRED request fell into the generic branch
        // below: an "Unverified connection" warning over a Connect button that
        // could only 404. Say what the API said, before anyone signs in or
        // presses anything for a request that is already gone.
        const failure = describeAuthorizeFailure(res.status, await res.json().catch(() => ({})));
        if (failure.terminal && !cancelled) {
          setErrorMsg(failure.message);
          setErrorTerminal(true);
          // Only from idle: never yank the page out from under an approve that
          // is already in flight or has already succeeded.
          setStatus((current) => (current === 'idle' ? 'error' : current));
          setDeadOnArrival(failure.reason);
        }
        return null;
      })
      .then((body) => {
        if (cancelled) return;
        if (!body || typeof body.client_name !== 'string') {
          setDetailsStatus('error');
          return;
        }
        setDetails({
          client_name: body.client_name,
          redirect_host: typeof body.redirect_host === 'string' ? body.redirect_host : null,
          verified: Boolean(body.verified),
        });
        setDetailsStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setDetailsStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [router.isReady, requestId]);

  // One arrival = one row. Waits for router.isReady so `req` is actually
  // populated — on the first render Next has not parsed the query string yet,
  // and a view logged before then would report has_request:0 for every visit.
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
      path: '/oauth/consent',
      metadata: {
        surface: SURFACE,
        // A missing `req` means the tool sent them here without an authorization
        // request — a broken hand-off, not a user who changed their mind.
        has_request: requestId ? 1 : 0,
        signed_in: isSignedIn ? 1 : 0,
      },
    });
  }, [router.isReady, isLoaded, requestId, isSignedIn]);

  const trackOutcome = (event: string, metadata: Record<string, unknown> = {}) =>
    trackProductEvent(event, {
      source: 'dashboard',
      path: '/oauth/consent',
      metadata: { surface: SURFACE, ...metadata },
    });

  // A request that was dead on arrival, reported once, and only after Clerk has
  // answered: an event sent before then carries no bearer token and is filed
  // under an anonymous person, the same split the view event above waits out.
  useEffect(() => {
    if (!deadOnArrival || !isLoaded || deadFired.current) return;
    deadFired.current = true;
    trackOutcome('oauth_consent_failed', { reason: deadOnArrival, at: 'details', signed_in: isSignedIn ? 1 : 0 });
  }, [deadOnArrival, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!sessionResolved || !isSignedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await authorizedFetch(token, '/api/oauth-workspaces', '/api/v1/teams/workspaces');
        if (!res.ok || cancelled) return;
        setPinnedTo(consentWorkspace(await res.json()));
      } catch {
        // The screen still says where the connection will work, without a name.
      }
    })();
    return () => { cancelled = true; };
  }, [sessionResolved, isSignedIn, getToken]);

  async function authorize() {
    if (!requestId) {
      setErrorMsg('Missing authorization request. Restart the connection from your AI tool.');
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
    // Before any await: the clipboard write needs the click's user activation.
    const copied = copyFirstPrompt();
    setStatus('authorizing');
    setErrorTerminal(false);
    try {
      const token = await getToken();
      if (!token) {
        setStatus('unauthenticated');
        trackOutcome('oauth_consent_signin_required', { at: 'no_token' });
        return;
      }
      const res = await authorizedFetch(token, '/api/oauth-approve', '/api/v1/oauth/approve', {
        method: 'POST',
        body: JSON.stringify({ req: requestId }),
      });
      if (res.status === 401) {
        setStatus('unauthenticated');
        trackOutcome('oauth_consent_signin_required', { at: 'approve_401' });
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.redirect) {
        const failure = describeAuthorizeFailure(res.status, body);
        setErrorTerminal(failure.terminal);
        throw new Error(failure.message);
      }
      const handoff = planConsentHandoff(body.redirect);
      if (handoff.kind === 'invalid') {
        setErrorTerminal(true);
        throw new Error(INVALID_HANDOFF_MESSAGE);
      }
      // Bounded like the event below: a clipboard that never answers must not
      // hold the person here.
      const didCopy = await Promise.race([
        copied,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      setPromptCopied(didCopy);
      setStatus('redirecting');
      // This is the one event that proves a connection actually succeeded, and
      // the redirect below tears the page down — an un-awaited request can be
      // cancelled in flight, which would leave the success case as invisible as
      // it is today. Awaited, but bounded: a slow or down API must never strand
      // the user on "Returning to your AI tool…" instead of handing them back.
      await Promise.race([
        trackOutcome('oauth_consent_approved', { http_status: res.status, prompt_copied: didCopy ? 1 : 0 }),
        new Promise((resolve) => setTimeout(resolve, 800)),
      ]);
      // A native app's scheme opens the app (or an OS prompt) and leaves this
      // page exactly where it is, so "Returning to your AI tool…" would stay up
      // forever. Follow up once it should have opened, with a way to retry.
      if (handoff.kind === 'native') {
        setHandoffHref(handoff.href);
        window.setTimeout(() => {
          setStatus((current) => (current === 'redirecting' ? 'handed_off' : current));
        }, handoff.followUpAfterMs);
      }
      // Hand the browser back to the AI tool with the authorization code.
      window.location.href = handoff.href;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Authorization failed.';
      setErrorMsg(message);
      setStatus('error');
      // The message is ours (server `message`/`error` or an HTTP status), not
      // user-supplied text, so it is safe to keep as a groupable reason.
      trackOutcome('oauth_consent_failed', { reason: 'approve_failed', detail: message.slice(0, 120) });
    }
  }

  return (
    <>
      <Head>
        <title>Authorize AI Tool | DeerDawn</title>
      </Head>
      {/* The badge sits in its own row, not absolutely over the page. It now
          carries a full email address and a second line, and on a 375px screen
          an absolute badge that tall lands on top of the card. The row reserves
          its height so the card does not jump when Clerk resolves. */}
      <div className="flex min-h-screen flex-col bg-background p-4 sm:p-8">
        <div className="flex min-h-[52px] items-start justify-end"><AuthorizeAccountBadge surface={SURFACE} path="/oauth/consent" /></div>
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
            <AuthorizeSignInPanel surface={SURFACE} path="/oauth/consent" />
          )}

          {/* Two independent gates, and the approve UI needs both: the session
              must have resolved before either branch is honest, and the details
              must have loaded before the page can name what is being approved.
              Approving a connection whose requesting tool and redirect host are
              still blank is the one thing this screen exists to prevent. */}
          {sessionResolved && isSignedIn && status === 'idle' && detailsStatus === 'loading' && (
            <p className="text-center text-[14px] text-text-muted">Loading connection details…</p>
          )}

          {sessionResolved && isSignedIn && status === 'idle' && detailsStatus !== 'loading' && (
            <>
              {details && (
                <div className="mb-4 rounded-xl border border-border-subtle bg-overlay-active p-4 text-[13px] leading-[1.6]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="shrink-0 text-text-muted">Requesting tool</span>
                    <span className="max-w-[240px] truncate font-medium text-text-primary" title={details.client_name}>{details.client_name}</span>
                  </div>
                  {details.redirect_host && (
                    <div className="mt-1.5 flex items-baseline justify-between gap-3">
                      <span className="shrink-0 text-text-muted">Sends your authorization to</span>
                      {/* Never truncate the destination: `truncate` clips the END,
                          hiding the rightmost registrable domain — the exact part
                          that exposes a look-alike phishing host. Wrap instead. */}
                      <span className="break-all text-right font-mono text-[12px] text-text-primary">{details.redirect_host}</span>
                    </div>
                  )}
                </div>
              )}
              {(!details || !details.verified) && (
                <div className="mb-6 rounded-xl border border-accent/30 bg-accent/[0.09] p-4 text-[13px] leading-[1.6] text-text-secondary">
                  <p className="m-0 mb-1 font-semibold text-text-primary">Unverified connection</p>
                  {details ? (
                    <>
                      This tool registered itself and we can’t confirm its identity. Only continue if you
                      started this from a tool you trust
                      {details.redirect_host ? <> and recognize <span className="break-all font-mono text-[12px]">{details.redirect_host}</span></> : null}.
                    </>
                  ) : (
                    <>We couldn’t confirm which tool is requesting access or where it will be sent. Only continue if you just started this connection from a tool you trust.</>
                  )}
                  {' '}Approving hands it ongoing access to your projects and context.
                </div>
              )}
              <ConsentWorkspaceNotice workspace={pinnedTo} />
              <ConsentNextStep clientName={details?.client_name} verified={Boolean(details?.verified)} />
              <button
                onClick={authorize}
                className="w-full cursor-pointer rounded-xl border-none bg-primary p-3.5 text-[15px] font-semibold text-on-primary"
              >
                Connect
              </button>
            </>
          )}

          {(status === 'authorizing' || status === 'redirecting') && (
            <p className="text-center text-[14px] text-text-muted">
              {status !== 'redirecting'
                ? 'Authorizing…'
                : promptCopied
                  ? 'Message copied. Returning to your AI tool: paste it into a new chat.'
                  : 'Returning to your AI tool…'}
            </p>
          )}

          {status === 'handed_off' && (
            <div className="text-center">
              <p className="m-0 font-medium text-text-primary">{nativeHandoffMessage(details?.client_name)}</p>
              <p className="mt-2 text-[13px] leading-[1.6] text-text-muted">{nativeHandoffHint(details?.client_name)}</p>
              {handoffHref ? (
                <a
                  href={handoffHref}
                  className="ui-press ui-focus mt-4 inline-block rounded-[10px] border border-border-subtle bg-overlay-active px-5 py-2.5 text-[13px] text-text-primary no-underline"
                >
                  {nativeHandoffRetryLabel(details?.client_name)}
                </a>
              ) : null}
            </div>
          )}

          {/* Reachable now only when Clerk claimed a session and the token or the
              approve call then said otherwise. The old copy here asked the user to
              open app.deerdawn.com in another tab, sign in, and come back — a manual
              round trip that nobody in 90 days completed. Same panel as the
              signed-out arrival: it carries this URL through the sign-in. */}
          {status === 'unauthenticated' && (
            <div>
              <AuthorizeSignInPanel surface={SURFACE} path="/oauth/consent" />
              <button
                onClick={authorize}
                className="ui-press ui-focus mt-3 w-full cursor-pointer rounded-[10px] border border-border-subtle bg-overlay-active p-3 text-[14px] text-text-primary"
              >
                Already signed in? Try again
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="text-center">
              <p className="m-0 font-medium text-[#f87171]">
                {errorTerminal ? 'This connection request is no longer valid' : 'Something went wrong'}
              </p>
              <p className="mt-2 text-[13px] text-text-muted">{errorMsg}</p>
              {errorTerminal ? (
                // No retry button on purpose: the one action available here would
                // resend the same dead request. Give the step that actually works.
                <div className="mt-4 rounded-xl border border-border-subtle bg-overlay-active p-4 text-left text-[13px] leading-[1.6] text-text-secondary">
                  <p className="m-0 font-medium text-text-primary">To start again</p>
                  <p className="mb-0 mt-1.5">
                    Go back to your AI tool and connect DeerDawn again from there. It opens a fresh request in a new tab, and you can close this one.
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
