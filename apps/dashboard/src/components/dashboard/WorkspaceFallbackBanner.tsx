import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  api,
  getActiveWorkspace,
  getWorkspaceFallbackKey,
  onWorkspaceFallback,
  onWorkspaceListing,
  PERSONAL_SWITCH_FAILED_MESSAGE,
  refreshWorkspaceListing,
  switchToPersonalWorkspace,
  type WorkspacesListing,
} from '@/lib/api';
import {
  fallbackWorkspaceName,
  mayFixFallbackBilling,
  servedWorkspace,
  workspaceFallbackNotice,
  type WorkspaceFallbackSignal,
} from '@/lib/workspaceFallback';
import { Button } from '@/components/ui/Button';
import { CHECK_OUT_AGAIN_LABEL, retryCheckoutHref } from '@/lib/firstPayment';

/**
 * YOU ARE NOT WHERE THE SHELL SAYS YOU ARE, AND NOT ENTIRELY SOMEWHERE ELSE.
 *
 * While the active team is refusing on billing grounds the API answers ordinary
 * reads out of this person's personal workspace. So projects, briefs, the board
 * and context are theirs, and the one thing they cannot work out for themselves
 * is that the work they do here does not reach the team. The banner says that on
 * every authed page and does not offer to be dismissed: a dismissed banner and a
 * correct one are indistinguishable from inside the product, and the cost of
 * being wrong is a week of briefs filed in the wrong place.
 *
 * BUT "you are viewing your own workspace" is only half the page. Every route
 * enforcePlan exempts is never rebound and still acts on the TEAM: keys,
 * billing, org settings, auth. Saying the blanket version let somebody mint a
 * key they were told was their own into a workspace they cannot write to, so the
 * notice now names both halves.
 *
 * It is not an error and not an upsell. There are two things a reader can do
 * about it, and which one depends on who they are: leave for their own
 * workspace (anybody), or pay the bill (an owner of the lapsed workspace).
 */
export function WorkspaceFallbackBanner() {
  const [listing, setListing] = useState<WorkspacesListing | null>(null);
  const [headerKey, setHeaderKey] = useState<string | null>(() => getWorkspaceFallbackKey());
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getWorkspaces()
      .then((res) => { if (!cancelled) setListing(res); })
      .catch(() => { /* a banner that cannot load is simply absent */ });
    // The header can arrive from any request on the page, including one that
    // has already finished, which is why the initial state reads it too.
    const unsubscribeKey = onWorkspaceFallback((key) => { if (!cancelled) setHeaderKey(key); });
    // Any fresh listing, whoever asked for it: the post-write refresh and the
    // switcher's own read both land here, so the two surfaces cannot disagree.
    const unsubscribeListing = onWorkspaceListing((res) => { if (!cancelled) setListing(res); });
    return () => { cancelled = true; unsubscribeKey(); unsubscribeListing(); };
  }, []);

  const { fallback } = servedWorkspace(listing, headerKey, getActiveWorkspace());

  // THE BILL IS PAID IN ANOTHER TAB. Nothing on this page would ever ask again,
  // so the banner outlived the refusal until a full reload. Only while one is
  // actually showing: a workspace that is serving normally owes nobody a GET on
  // every tab switch.
  const showing = Boolean(fallback);
  useEffect(() => {
    if (!showing || typeof window === 'undefined') return undefined;
    const onFocus = () => { void refreshWorkspaceListing(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [showing]);

  if (!fallback) return null;

  return <FallbackNotice fallback={fallback} listing={listing} leaving={leaving} leaveError={leaveError} onLeave={async () => {
    setLeaving(true);
    setLeaveError(null);
    if (!(await switchToPersonalWorkspace())) {
      // Reloading would land back in the workspace being left: the server still
      // has it as active, and this browser now sends no header to override it.
      setLeaving(false);
      setLeaveError(PERSONAL_SWITCH_FAILED_MESSAGE);
      return;
    }
    // A full reload, not a client push: everything already fetched in this tab
    // was scoped to the workspace being left.
    window.location.reload();
  }} />;
}

function FallbackNotice({ fallback, listing, leaving, leaveError, onLeave }: {
  fallback: WorkspaceFallbackSignal;
  listing: WorkspacesListing | null;
  leaving: boolean;
  leaveError: string | null;
  onLeave: () => void;
}) {
  const canFixBilling = mayFixFallbackBilling(listing, fallback);
  // The real name or nothing. "Update Your team workspace billing" is what a
  // sentence-initial label does mid-sentence, and the API sends the literal
  // word "Workspace" for an org row with no name of its own.
  const teamName = fallbackWorkspaceName(fallback);

  return (
    <div
      role="status"
      className="border-b border-border-subtle bg-overlay-subtle px-4 py-3 sm:px-6"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-[16rem] flex-1 text-[13px] leading-6 text-text-primary">
          {workspaceFallbackNotice(fallback)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" disabled={leaving} onClick={onLeave}>
            {leaving ? 'Switching…' : 'Use my own workspace'}
          </Button>
          {canFixBilling && fallback.retryCheckout ? (
            // The first payment never went through: check out again, not billing.
            <Link href={retryCheckoutHref(fallback.retryCheckout)} className="text-[13px] text-primary hover:underline">
              {CHECK_OUT_AGAIN_LABEL}
            </Link>
          ) : canFixBilling ? (
            <Link href="/settings/plan" className="text-[13px] text-primary hover:underline">
              {teamName ? `Update ${teamName} billing` : 'Update billing'}
            </Link>
          ) : null}
        </div>
        {leaveError ? (
          <p role="alert" className="w-full text-[13px] leading-6 text-status-danger-text">{leaveError}</p>
        ) : null}
      </div>
    </div>
  );
}
