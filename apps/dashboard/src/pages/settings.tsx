import { PRO_PLAN_NAME } from '@/lib/planCopy';
import Head from 'next/head';
import { buildInviteLink } from '@/lib/referral';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { PageScaffold } from '@/components/dashboard/PageScaffold';
import { DeleteAccountDialog } from '@/components/dashboard/DeleteAccountDialog';
import { describeClosedWorkspaces, type ClosedWorkspace } from '@/lib/accountClose';
import { useSafeSignOut } from '@/lib/useSafeSignOut';
import { api } from '@/lib/api';
import { showToast } from '@/components/ui/Toast';
import { trackProductEvent } from '@/lib/productAnalytics';
import { siteConfig } from '@/lib/siteConfig';
import { planBadgeLabel } from '@/lib/planLabels';
import { DEFAULT_SOURCE_CODE_URL, useDeployment } from '@/lib/deployment';

// ─── helpers ──────────────────────────────────────────────────────────────────

// Small chevron affordance for navigable rows.
function ChevronRight() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-text-muted transition-colors group-hover:text-text-primary"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

// Emphasis level 2. Settings was seven equal-weight cards, so nothing on it read
// as more or less important than anything else; a list of destinations is a list,
// not seven panels.
function LinkRow({ href, title, detail }: { href: string; title: string; detail: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 border-t border-border-subtle py-3.5 no-underline transition-colors hover:bg-overlay-hover"
    >
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-text-primary">{title}</div>
        <div className="truncate text-[12.5px] text-text-muted">{detail}</div>
      </div>
      <span className="ml-auto shrink-0"><ChevronRight /></span>
    </Link>
  );
}

function formatRelativeTime(iso: string | null | undefined) {
  if (!iso) return 'No command captured yet';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return 'No command captured yet';
  const diffMs = Date.now() - ts;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── main component ───────────────────────────────────────────────────────────

export default function Settings() {
  const router = useRouter();
  const signOut = useSafeSignOut();
  const { bootstrap } = useDashboardBootstrap();
  // A self-hosted install has no plans, billing or referrals (every workspace
  // has every feature), so none of those rows or cards are drawn there.
  const { deployment, selfHosted } = useDeployment();
  // AGPL-3.0 section 13: every user of the running install can reach its source.
  const sourceCodeUrl = deployment?.source_code_url || DEFAULT_SOURCE_CODE_URL;
  const [referralCode, setReferralCode] = useState('');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  useEffect(() => {
    if (selfHosted) return;
    api.getReferralOverview().then((r) => setReferralCode(r.referral_code || '')).catch(() => {});
  }, [selfHosted]);
  const commandCapture = bootstrap?.sync_health?.command_capture;
  const openTaskCommandCount = commandCapture?.open_task_command_count ?? 0;
  const lastCapturedAt = commandCapture?.last_captured_command_at ?? null;

  const handleAccountDeleted = async ({ export_emailed, closed_workspaces }: { export_emailed: boolean; closed_workspaces: ClosedWorkspace[] }) => {
    setShowDeleteDialog(false);
    const closed = describeClosedWorkspaces(closed_workspaces);
    showToast(
      ['Account deleted.', closed, export_emailed ? 'Your context export is on its way by email.' : null].filter(Boolean).join(' '),
      'success',
    );
    // The Clerk identity is now deleted server-side, so clear the local session
    // and leave the dashboard. useSafeSignOut falls back to a plain redirect when
    // Clerk isn't mounted (dev), so this works in every environment.
    try { await signOut({ redirectUrl: siteConfig.ACTIVE_SITE_URL }); }
    finally { router.push(siteConfig.ACTIVE_SITE_URL); }
  };

  const handleSignOut = async () => {
    try { await api.logout(); } finally { router.push('/login'); }
  };

  return (
    <>
      <Head><title>Settings | DeerDawn</title></Head>

      <PageScaffold title="Settings" description={selfHosted ? 'Account and appearance.' : 'Account, appearance, and billing.'}>
        {referralCode && !selfHosted ? (
          <div className="rounded-2xl border border-primary/20 bg-primary-soft p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Referral</div>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium text-text-primary">Invite a friend: they get a free month of {PRO_PLAN_NAME}, and you get one when their first brief syncs</div>
                <div className="mt-1 truncate font-mono text-sm text-text-primary">{buildInviteLink(referralCode)}</div>
              </div>
              <button
                onClick={() => {
                  // The link, not the bare code: a code gives the friend nowhere to paste it.
                  navigator.clipboard.writeText(buildInviteLink(referralCode));
                  showToast('Copied invite link', 'success');
                  trackProductEvent('referral_link_copied', {
                    source: 'dashboard',
                    path: '/settings',
                    metadata: { surface: 'settings' },
                  });
                }}
                className="inline-flex items-center justify-center rounded-xl border border-primary/30 px-3 py-2 text-xs font-semibold text-primary"
              >
                Copy invite link
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-3">

          {/* Account — identity and the one action that belongs to it. The nested
              "Password sign-in" card explained how sign-in works and offered
              nothing to do, so it's gone. */}
          <div className="flex items-center gap-4 border-t border-border-subtle py-3.5">
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold text-text-primary">{bootstrap?.user.email}</div>
              <div className="truncate text-[12.5px] text-text-muted">{bootstrap?.org.name}</div>
            </div>
            <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>

          <div className="flex items-center gap-4 border-t border-border-subtle py-3.5">
            <div>
              <div className="text-[13.5px] font-semibold text-text-primary">Theme</div>
              <div className="text-[12.5px] text-text-muted">Follows your device unless you override it.</div>
            </div>
            <div className="ml-auto shrink-0"><ThemeToggle /></div>
          </div>

          {!selfHosted && (
            <LinkRow
              href="/settings/plan"
              title="Plan & billing"
              detail={`${planBadgeLabel(bootstrap?.org?.plan_tier)} plan`}
            />
          )}

          <LinkRow
            href="/settings/usage"
            title="Usage"
            detail={`${(bootstrap?.usage?.syncs?.syncs_used ?? 0).toLocaleString()} ${selfHosted ? 'briefs this period' : 'briefs this billing cycle'}`}
          />

          {/* Command capture — state, not an explainer. The retention rule it used
              to spell out in two lines is now the trailing clause. */}
          <div className="flex items-center gap-4 border-t border-border-subtle py-3.5">
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-text-primary">Command capture</div>
              <div className="truncate text-[12.5px] text-text-muted">
                {commandCapture?.active_task_label || 'No active task'} · cleared when the task completes
              </div>
            </div>
            <span className="ml-auto shrink-0 text-[12.5px] text-text-muted">
              {openTaskCommandCount > 0 ? (
                <>
                  <span className="font-semibold tabular-nums text-primary">{openTaskCommandCount.toLocaleString()}</span>{' '}
                  captured · {formatRelativeTime(lastCapturedAt)}
                </>
              ) : (
                'idle'
              )}
            </span>
          </div>

          {/* Connected tools + API keys both live on Setup now. This used to be a
              full "Platform Sync" section here — the tool list, the MCP config
              snippet and three paragraphs of instructions — duplicating Setup
              exactly. Two places describing the same setup is how people end up
              following stale instructions. */}
          <LinkRow
            href="/setup"
            title="Connected tools"
            detail={`${bootstrap?.shell?.counts?.api_keys ?? 0} API ${bootstrap?.shell?.counts?.api_keys === 1 ? 'key' : 'keys'} · MCP config and setup steps`}
          />

          {/* Source code (AGPL-3.0 section 13). The API's source_code_url, which
              an operator running a modified fork sets with SOURCE_CODE_URL, so
              this always offers the source of the version actually running. */}
          <a
            href={sourceCodeUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="source-code-link"
            className="group flex items-center gap-4 border-t border-border-subtle py-3.5 no-underline transition-colors hover:bg-overlay-hover"
          >
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-text-primary">Source code</div>
              <div className="truncate text-[12.5px] text-text-muted">DeerDawn is open source under AGPL-3.0 · {sourceCodeUrl.replace(/^https?:\/\//, '')}</div>
            </div>
            <span className="ml-auto shrink-0"><ChevronRight /></span>
          </a>

          {/* Danger zone */}
          <div className="mt-8">
            <div className="mb-3 text-xs font-medium uppercase tracking-widest text-status-danger/70">Danger zone</div>
            <Button variant="danger" size="sm" onClick={() => setShowDeleteDialog(true)}>Delete account</Button>
          </div>

        </div>
      </PageScaffold>

      {showDeleteDialog && (
        <DeleteAccountDialog
          email={bootstrap?.user.email ?? ''}
          onCancel={() => setShowDeleteDialog(false)}
          onDeleted={handleAccountDeleted}
        />
      )}
    </>
  );
}
