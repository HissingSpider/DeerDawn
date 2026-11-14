import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  apiErrorReason,
  isApiError,
  PERSONAL_SWITCH_FAILED_MESSAGE,
  setActiveWorkspace,
  switchToPersonalWorkspace,
} from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { logger } from '@/lib/logger';
import { usePageScroll } from '@/hooks';
import { useAuthPresence } from '@/components/layout/AuthProvider';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { useSafeSignOut } from '@/lib/useSafeSignOut';
import {
  clearPendingInvite,
  inviteAuthPath,
  inviteFailureIsRetryable,
  inviteFailureMessage,
  readPendingInvite,
  stashPendingInvite,
} from '@/lib/pendingInvite';

export default function InviteSetup() {
  // Renders outside the dashboard shell, whose global `overflow: hidden`
  // would otherwise strand anything below the fold on a short viewport.
  usePageScroll();
  const router = useRouter();
  const token = useMemo(() => {
    if (typeof router.query.token !== 'string') return '';
    return router.query.token;
  }, [router.query.token]);
  // Optional warmth: if the invite link carries who invited them / which
  // workspace, show it — a referred user is at peak motivation here.
  const inviter = typeof router.query.inviter === 'string' ? router.query.inviter : '';
  const workspace = typeof router.query.workspace === 'string' ? router.query.workspace : '';
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [wrongAccount, setWrongAccount] = useState(false);
  // Set when the refusal was about the workspace this browser was bound to, not
  // about the invitation: the one fix is to use your own workspace and retry.
  const [boundRefusal, setBoundRefusal] = useState(false);
  const [switching, setSwitching] = useState(false);
  const signOut = useSafeSignOut();

  // Is there a session? Under Clerk, AuthProvider already knows and renders this
  // page for a signed-out reader (it is a preview page), so ask it rather than
  // firing an authed request at someone with no token. Without Clerk there is no
  // provider and presence always reads signed-in, so ask the API instead.
  //
  // The signed-out branch used to be a "choose a password" form posting to the
  // LEGACY /auth/invite/accept, which matches users.invite_token_hash. Workspace
  // invitations live in workspace_invites, so it refused every one of them: a
  // brand-new invitee could not join at all.
  const presence = useAuthPresence();
  const clerk = isClerkHostedAuthEnabled();
  const [probedSignedIn, setProbedSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (clerk) return;
    let cancelled = false;
    api.getCurrentUser()
      .then(() => { if (!cancelled) setProbedSignedIn(true); })
      .catch(() => { if (!cancelled) setProbedSignedIn(false); });
    return () => { cancelled = true; };
  }, [clerk]);
  const signedIn: boolean | null = clerk
    ? (presence === 'loading' ? null : presence === 'signed-in')
    : probedSignedIn;

  const joinWorkspace = useCallback(async () => {
    if (!token) {
      setStatus('error');
      setMessage('Missing invite token.');
      return;
    }
    try {
      setStatus('loading');
      setWrongAccount(false);
      setBoundRefusal(false);
      const result = await api.acceptWorkspaceInvite(token);
      clearPendingInvite();
      // Land IN the workspace. The accept used to be followed by a bare push to
      // /projects, which kept whatever workspace this browser had stored (their
      // own, for a new member) — so a teammate joined and saw an empty product.
      // The server half matters as much as the browser half: agent sessions
      // (MCP, OAuth) send no header and read the membership's active flag. This
      // is also where the accept writes localStorage: the accept request itself
      // never carries the stored choice (see WORKSPACE_UNBOUND_PATHS), but its
      // success replaces that choice with the joined workspace.
      const joined = typeof result?.workspace === 'string' ? result.workspace : null;
      if (joined) {
        setActiveWorkspace(joined);
        await api.setActiveWorkspaceOnServer(joined).catch((err) => {
          // The dashboard still switches (the header carries it); the agent keeps
          // its previous workspace until the switcher is used.
          logger.error('Failed to activate joined workspace on the server', err);
        });
      }
      setStatus('success');
      setMessage('You are in. Opening the workspace…');
      // A full load, not a client push: everything already fetched in this tab
      // was scoped to the previous workspace.
      window.location.assign('/projects');
    } catch (err) {
      logger.error('Failed to join workspace', err);
      setStatus('error');
      // Name the actual failure. "Expired", "already used" and "addressed to a
      // different account" look identical from the outside and need different
      // fixes, and one generic message sends all three to support.
      const reason = apiErrorReason(err);
      // A refusal about the WORKSPACE THIS BROWSER WAS BOUND TO (lapsed, locked,
      // or one they were removed from) says nothing about the link, and the
      // retry below fixes it. The retry reads the token from this page's URL,
      // so nothing is parked for it. Whatever the refusal, the parked token is
      // cleared: a parked token pulls every page back here to redeem it, and
      // one that kept being refused (an older API refusing the retry the same
      // way) held the reader on /invite for hours, away from the billing page
      // that could fix the plan. The emailed link itself stays good either way.
      const retryable = inviteFailureIsRetryable(reason);
      clearPendingInvite();
      setBoundRefusal(retryable);
      const invitedEmail = isApiError(err) && typeof err.data?.invited_email === 'string'
        ? err.data.invited_email
        : undefined;
      setWrongAccount(reason === 'wrong_account');
      const serverMessage = isApiError(err) && typeof err.data?.message === 'string' ? err.data.message : undefined;
      setMessage(inviteFailureMessage(reason, invitedEmail, serverMessage));
    }
  }, [token]);

  // Coming back from sign-up or sign-in for THIS invitation: finish it without
  // asking for a second click. The token was parked before they left, so a
  // match means they already chose to join. A different or absent parked token
  // (a link opened while already signed in) still waits for the button.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (signedIn !== true || !token || autoJoined.current) return;
    if (readPendingInvite() !== token) return;
    autoJoined.current = true;
    void joinWorkspace();
  }, [signedIn, token, joinWorkspace]);

  // Park the token as soon as a signed-out reader arrives, not only on click:
  // the browser's back button or a Google sign-in started elsewhere still gets
  // them back here once they have a session.
  useEffect(() => {
    if (signedIn === false && token) stashPendingInvite(token);
  }, [signedIn, token]);

  // Bind to the reader's own workspace (browser AND server: a header-less
  // request is answered in the server's active workspace, which is the one that
  // refused) and try the same invitation again.
  const retryFromOwnWorkspace = async () => {
    if (!token) return;
    setSwitching(true);
    const switched = await switchToPersonalWorkspace();
    setSwitching(false);
    if (!switched) {
      setMessage(PERSONAL_SWITCH_FAILED_MESSAGE);
      return;
    }
    await joinWorkspace();
  };

  const goToAuth = (mode: 'signup' | 'login') => {
    if (!token) return;
    stashPendingInvite(token);
    // A full navigation: under Clerk the dashboard's /signup hands off to the
    // marketing site, which a client-side push would not follow cleanly.
    window.location.assign(inviteAuthPath(token, mode));
  };

  const switchAccount = async () => {
    if (!token) return;
    stashPendingInvite(token);
    await signOut({ redirectUrl: inviteAuthPath(token, 'login') });
  };

  return (
    <>
      <Head>
        <title>Accept Invite | DeerDawn</title>
      </Head>
      <div className="min-h-screen flex items-center justify-center px-6 py-16">
        <Card className="w-full max-w-md">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">You’re invited to DeerDawn</div>
          <h1 className="text-xl font-semibold mb-2">
            {workspace ? `Join the ${workspace} workspace` : 'Join your team on DeerDawn'}
          </h1>
          {/* WHAT JOINING ACTUALLY DOES TO YOUR TOOLS.
              This promised that "your AI tools load the team's context from the
              next session". True for a hosted connector (Claude.ai, ChatGPT),
              which follows the workspace you have selected, and true for a local
              tool set up AFTER joining. FALSE for a local install that predates
              the invitation: its API key is a credential for the workspace it
              was minted in, by design, and it keeps reading your own until it is
              pointed at the team. Somebody trusting the old sentence files a
              week of work in the wrong place and nothing disagrees with them. */}
          <p className="text-sm text-text-secondary mb-6">
            {inviter ? `${inviter} invited you. ` : ''}
            {signedIn
              ? 'Connectors you use through Claude.ai or ChatGPT follow the workspace you have selected, so they load this team’s context from the next session.'
              : 'Create your account, or sign in, and you land straight in this workspace. Connectors you use through Claude.ai or ChatGPT follow it from the next session.'}
          </p>
          <p className="text-sm text-text-muted mb-6">
            A tool you set up on your own machine before joining keeps using your own workspace until you connect it to
            the team.{' '}
            <Link href="/setup" className="text-primary hover:underline">Connect a local tool</Link>.
          </p>

          {!token && (
            <p className="text-sm text-[#F87171]">This link is missing its invitation token. Open the link from the invitation again.</p>
          )}

          {token && signedIn === null && (
            <p className="text-sm text-text-muted">Checking your account…</p>
          )}

          {token && signedIn === true && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                You are signed in to DeerDawn. Joining this workspace does not touch your own projects; they stay private to you.
              </p>
              {message && (
                <p className={status === 'success' ? 'text-sm text-primary' : 'text-sm text-[#F87171]'}>
                  {message}
                </p>
              )}
              <Button
                type="button"
                onClick={() => void joinWorkspace()}
                disabled={status === 'loading' || status === 'success'}
                className="w-full"
              >
                {status === 'loading' ? 'Joining…' : 'Join workspace'}
              </Button>
              {boundRefusal && status === 'error' && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void retryFromOwnWorkspace()}
                  disabled={switching}
                  className="w-full"
                >
                  {switching ? 'Switching…' : 'Use my own workspace and try again'}
                </Button>
              )}
              {wrongAccount && (
                <Button type="button" variant="ghost" onClick={() => void switchAccount()} className="w-full">
                  Sign out and use a different account
                </Button>
              )}
            </div>
          )}

          {token && signedIn === false && (
            <div className="space-y-3">
              <Button type="button" onClick={() => goToAuth('signup')} className="w-full">
                Create your account
              </Button>
              <Button type="button" variant="ghost" onClick={() => goToAuth('login')} className="w-full">
                I already have an account
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export async function getServerSideProps() {
  return { props: {} };
}
