import { PRO_PLAN_NAME } from '@/lib/planCopy';
import Link from 'next/link';
import { BrandLogo } from '@/components/BrandLogo';
import { ThemeToggle } from '@/components/ui';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useSafeSignOut } from '@/lib/useSafeSignOut';
import {
  api,
  getActiveWorkspace,
  getWorkspaceFallbackKey,
  onWorkspaceFallback,
  onWorkspaceListing,
  PERSONAL_SWITCH_FAILED_MESSAGE,
  setActiveWorkspace,
  switchToPersonalWorkspace,
  type WorkspaceSummary,
  type WorkspacesListing,
} from '@/lib/api';
import {
  fallbackReasonSentence,
  fallbackShortReason,
  servedWorkspace,
  type WorkspaceFallbackSignal,
} from '@/lib/workspaceFallback';
import { logger } from '@/lib/logger';
import { domainJoinLabel, joinWorkspaceByDomain } from '@/lib/domainJoin';
import { siteConfig } from '@/lib/siteConfig';
import { useDashboardBootstrap } from '@/components/dashboard/DashboardBootstrapProvider';
import { useDeployment } from '@/lib/deployment';
import { planBadgeLabel, isPaidTier } from '@/lib/planLabels';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { useSidebarIdentity } from './useSidebarIdentity';
import { useWeeklyActivity } from '@/components/dashboard/useWeeklyActivity';
import {
  ActivityIcon,
  BarChartIcon,
  BoxIcon,
  FileTextIcon,
  LayersIcon,
  ScrollIcon,
  ChartIcon,
  CreditCardIcon,
  ShieldIcon,
  SettingsIcon,
  ZapIcon,
  XIcon,
} from '@/components/icons';

type MenuLink = { href: string; label: string; icon: React.ReactNode };

// Ordered by the question each answers. Today leads because "what was I doing"
// is the question that made someone open the tab, and it replaces the
// zero-project empty state as the first thing a returning user sees; the brief
// it displaced now lives at /projects.
//
// BOARD IS BACK. It was demoted to the account dropdown when the primary nav
// was cut to five, on the reasoning that Portfolio and Trails are what the
// product is sold on. That confused what the product is SOLD on with what it is
// USED for: the board is the only surface here that answers "what am I doing
// next", it is the one that changes between sessions, and burying a
// working surface behind a menu means it stops being checked. Sold-on and
// used-daily are different jobs and the nav serves the second.
//
// `badge: 'drift'` marks the one that carries a count — the projects that have
// fallen behind. That count used to be an undismissable amber sentence in a
// shell-wide strip, which meant it appeared on every page, was never actionable,
// and trained people to ignore amber everywhere else. Here it is a number on the
// page that resolves it, and it rides with Projects now that the brief is the
// destination for per-project repair.
const PRIMARY_NAV: { href: string; label: string; badge?: 'drift'; icon: React.ReactNode }[] = [
  { href: '/', label: 'Today', icon: <ActivityIcon /> },
  { href: '/projects', label: 'Projects', badge: 'drift', icon: <FileTextIcon /> },
  // Beside Projects, not beside Connect: both answer "my work", and the board
  // shares its project selection with the brief, so the two read as one pair.
  { href: '/board', label: 'Board', icon: <BoxIcon /> },
  { href: '/portfolio', label: 'Portfolio', icon: <LayersIcon /> },
  { href: '/trails', label: 'Trails', icon: <ScrollIcon /> },
  { href: '/setup', label: 'Connect', icon: <BarChartIcon /> },
];

// Account-only. Nothing here duplicates PRIMARY_NAV — Overview and API keys used
// to appear in both, so the dropdown read as a second, competing navigation.
//
// Memory lives here rather than in the primary nav: it is where you go to
// CORRECT what DeerDawn knows, which is an occasional maintenance errand, not a
// daily read. Board is deliberately absent from this list — it is in
// PRIMARY_NAV, and a destination in both reads as a second, competing
// navigation, which is the exact problem splitting these two lists solved.

/**
 * Workspace switcher.
 *
 * Teams is not a mode — there is no separate team section duplicating every
 * page. One control re-scopes everything below it, so the projects list, board,
 * memory and portfolio are the same screens pointed at a different workspace.
 *
 * Renders nothing for the overwhelming majority of accounts, which belong to
 * exactly one workspace and would gain only a dropdown with one entry.
 */
function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // The workspace the API declined to serve, when it has said so. Kept apart
  // from `active`: one is the choice, the other is whether the choice is being
  // honoured, and rendering the first as if it were the second is the defect.
  const [fallback, setFallback] = useState<WorkspaceFallbackSignal | null>(null);

  const [joinable, setJoinable] = useState<{ workspace: string; name: string }[]>([]);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // A refused domain join, said out loud. The handler used to reload whatever
  // happened, so a full team or a withdrawn offer looked like a button that
  // did nothing.
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = (res: WorkspacesListing, headerKey: string | null) => {
      const served = servedWorkspace(res, headerKey, getActiveWorkspace());
      setFallback(served.fallback);
      // WHAT IS ANSWERING, not what was chosen. Under the fallback the stored
      // choice is still the team while every request is served by the person's
      // own workspace, and showing the team as current is what let an invited
      // teammate write a week of briefs believing the team could read them.
      // Without a fallback it is the BOUND workspace: this browser's stored
      // choice when the listing still offers it, else the server's `active`.
      setActive(served.served);
    };
    let latest: WorkspacesListing | null = null;
    api.getWorkspaces()
      .then((res) => {
        if (cancelled) return;
        latest = res;
        setWorkspaces(res.workspaces);
        apply(res, getWorkspaceFallbackKey());
      })
      .catch(() => { /* a switcher that cannot load is simply absent */ });
    // A header can arrive from any later request on the page, including on an
    // API whose listing does not carry the `fallback` field yet.
    const unsubscribe = onWorkspaceFallback((key) => {
      if (cancelled || !latest) return;
      apply(latest, key);
    });
    // And a re-read can arrive from anywhere too: the banner asks for one on
    // focus and after a write that succeeds, and the switcher must not go on
    // naming a workspace that has started answering again.
    const unsubscribeListing = onWorkspaceListing((res) => {
      if (cancelled) return;
      latest = res;
      setWorkspaces(res.workspaces);
      apply(res, getWorkspaceFallbackKey());
    });
    // Offered, never joined automatically: joining makes your work visible to
    // other people, and that is a decision a person takes rather than one their
    // email address takes for them.
    api.getJoinableWorkspaces()
      .then((res) => { if (!cancelled) setJoinable(res.joinable || []); })
      .catch(() => { /* no offers is the overwhelmingly common case */ });
    return () => { cancelled = true; unsubscribe(); unsubscribeListing(); };
  }, []);

  // A refusal that also withdrew the last offer must still be read.
  if (workspaces.length < 2 && joinable.length === 0 && !joinError) return null;

  return (
    <div className="border-b border-border-subtle px-4 py-3">
      <label
        htmlFor="workspace-switcher"
        className="block pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted"
      >
        Workspace
      </label>
      <select
        id="workspace-switcher"
        className="w-full rounded-md border border-border-subtle bg-overlay-subtle px-2 py-1.5 text-[13px] text-text-primary"
        value={active || ''}
        onChange={(event) => {
          const next = event.target.value;
          const chosen = workspaces.find((w) => w.workspace === next);
          const previousActive = active;
          setSwitchError(null);
          setActive(next);
          // THIS TAB moves, and the choice becomes the one a new tab opens in.
          // Other open tabs keep the workspace they were loaded for.
          //
          // Personal is stored as no choice (a new tab, and this one once it
          // reloads, then follows the server's active workspace), so it must not
          // half-happen: if the server half fails, the reload would land back in
          // the workspace being left under a switcher that had just said
          // otherwise. switchToPersonalWorkspace puts this tab back exactly where
          // it was, and the switcher says so instead of reloading.
          if (chosen?.personal) {
            void switchToPersonalWorkspace().then((switched) => {
              if (switched) {
                window.location.reload();
                return;
              }
              setActive(previousActive);
              setSwitchError(PERSONAL_SWITCH_FAILED_MESSAGE);
            });
            return;
          }
          // A team is stored by key, so the browser half stands on its own: the
          // reloaded page opens in it and names it. The server half is what the
          // person's agent sessions read, so the reload waits for it; if it
          // fails, the dashboard still switches and the agent keeps its
          // previous workspace.
          setActiveWorkspace(next);
          void api.setActiveWorkspaceOnServer(next)
            .catch(() => undefined)
            .then(() => window.location.reload());
        }}
      >
        {workspaces.map((w) => (
          <option key={w.workspace} value={w.workspace}>
            {/* The lapsed one stays in the list and stays selectable: its owner
                goes there to fix the bill. It is just never the current one. */}
            {w.workspace === fallback?.from
              ? `${w.name} (${fallbackShortReason(fallback)})`
              : w.personal ? `${w.name} (personal)` : w.name}
          </option>
        ))}
      </select>
      {switchError ? (
        <p role="alert" className="mt-2 text-[11px] leading-5 text-status-danger-text">{switchError}</p>
      ) : null}
      {fallback ? (
        <p className="mt-2 text-[11px] leading-5 text-text-muted">
          {/* The reason, not an assumption about it. A locked workspace and a
              workspace over its plan limit were both described as a lapsed
              card, which points its owner at a page that cannot fix either. */}
          {`${fallbackReasonSentence(fallback)} Your projects and briefs are being served by your own workspace.`}
        </p>
      ) : null}
      {joinable.map((offer) => (
        <button
          key={offer.workspace}
          type="button"
          disabled={joining !== null}
          className="mt-2 w-full rounded-md border border-border-subtle px-2 py-1.5 text-left text-[12px] text-text-secondary hover:text-text-primary disabled:opacity-60"
          onClick={() => {
            setJoining(offer.workspace);
            setJoinError(null);
            void joinWorkspaceByDomain(offer).then((outcome) => {
              if (outcome.ok) {
                // A full load, not a re-render: everything already fetched in
                // this tab was scoped to the previous workspace.
                window.location.reload();
                return;
              }
              setJoining(null);
              setJoinError(outcome.message);
              if (outcome.dropOffer) {
                setJoinable((offers) => offers.filter((o) => o.workspace !== offer.workspace));
              }
            });
          }}
        >
          {domainJoinLabel(offer, joining === offer.workspace)}
        </button>
      ))}
      {joinError ? (
        <p role="alert" className="mt-2 text-[11px] leading-5 text-status-danger-text">{joinError}</p>
      ) : null}
    </div>
  );
}

const MENU_SECTIONS: { heading: string; links: MenuLink[] }[] = [
  {
    heading: 'Workspace',
    links: [
      { href: '/memory', label: 'Memory', icon: <LayersIcon /> },
      // In the menu, not PRIMARY_NAV: the primary nav's desktop layout stays as
      // it is, and add-ons are switched on once and then used through the agent.
      { href: '/addons', label: 'Add-ons', icon: <BoxIcon /> },
      { href: '/settings/usage', label: 'Usage & value', icon: <ChartIcon /> },
      { href: '/settings/skills', label: 'Shared Skills', icon: <ScrollIcon /> },
      { href: '/settings/team', label: 'Team', icon: <LayersIcon /> },
      { href: '/settings/audit', label: 'Access log', icon: <ScrollIcon /> },
      { href: '/settings/data', label: 'Your data', icon: <LayersIcon /> },
    ],
  },
  {
    heading: 'Account',
    links: [
      { href: '/settings/plan', label: 'Billing', icon: <CreditCardIcon /> },
      { href: '/settings/refer', label: `Invite & earn ${PRO_PLAN_NAME}`, icon: <ZapIcon /> },
      { href: '/security', label: 'Security', icon: <ShieldIcon /> },
      { href: '/settings', label: 'Settings', icon: <SettingsIcon /> },
    ],
  },
];

// Billing destinations, which a self-hosted install does not have.
const BILLING_MENU_HREFS = new Set(['/settings/plan', '/settings/refer']);

export function TopNav() {
  const router = useRouter();
  const signOut = useSafeSignOut();
  const isClerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const { email, orgName } = useSidebarIdentity(isClerkEnabled);
  const { bootstrap } = useDashboardBootstrap();
  const planTier = bootstrap?.org.plan_tier ?? null;
  const planLabel = planBadgeLabel(planTier, bootstrap?.org.plan_label);
  const planIsPaid = isPaidTier(planTier);
  // Self-hosted: every feature is on and nothing is for sale, so no plan badge
  // and no Billing / referral entries.
  const { selfHosted: selfHostedDeployment } = useDeployment();
  const selfHosted = selfHostedDeployment || Boolean(bootstrap?.deployment?.self_hosted);
  const menuSections = selfHosted
    ? MENU_SECTIONS.map((section) => ({ ...section, links: section.links.filter((link) => !BILLING_MENU_HREFS.has(link.href)) }))
    : MENU_SECTIONS;
  const isMobile = useIsMobile();
  const weekly = useWeeklyActivity();
  const driftCount = weekly?.stale_projects ?? 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside-click or Escape. The desktop popover lives inside
  // menuRef, so the mousedown-outside check is desktop-only; the mobile drawer is
  // rendered outside menuRef and dismisses itself via its own backdrop/close
  // button, so skipping the outside-click listener there avoids it closing the
  // drawer on every in-drawer tap. Escape stays wired for both.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    if (!isMobile) document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, isMobile]);

  // Close the menu whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [router.pathname]);

  const handleLogout = async () => {
    if (isClerkEnabled) {
      await signOut();
      router.push(siteConfig.ACTIVE_SITE_URL);
    } else {
      try {
        await api.logout();
      } catch (error) {
        logger.error('topnav_logout_failed', error);
      }
      router.push(siteConfig.ACTIVE_SITE_URL);
    }
  };

  const avatarLetter = (email || 'O').charAt(0).toUpperCase();

  return (
    <>
    <header className="dashboard-topnav">
      {/* Brand + persistent primary nav (nav is desktop-only) */}
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2.5 text-text-primary no-underline">
          <span className="relative h-6 w-6 opacity-90">
            <BrandLogo alt="DeerDawn" sizes="24px" className="object-contain" />
          </span>
          <span className="text-base font-bold tracking-[-0.01em]">DeerDawn</span>
        </Link>

        {/* Inline primary nav — hidden on mobile so the existing mobile topnav
            (avatar drawer) is unchanged. These two utilities are the ONLY thing
            deciding its display: `.dashboard-nav-links` must not declare one,
            because an unlayered rule in globals.css outranks them both. */}
        <nav className="dashboard-nav-links hidden md:flex" aria-label="Primary">
          {PRIMARY_NAV.map((link) => {
            const isActive =
              router.pathname === link.href ||
              (link.href !== '/' && router.pathname.startsWith(link.href + '/'));
            const showBadge = link.badge === 'drift' && driftCount > 0;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? 'page' : undefined}
                className={`dashboard-nav-link no-underline ${isActive ? 'dashboard-nav-link-active' : ''}`}
              >
                {link.label}
                {showBadge && (
                  <span
                    title={`${driftCount} project${driftCount === 1 ? '' : 's'} drifting from your latest work — open ${driftCount === 1 ? 'it' : 'them'} in your AI tool and DeerDawn refreshes automatically`}
                    className="ml-1.5 rounded-full bg-[var(--status-escalate-bg)] px-1.5 py-px text-[10px] font-bold tabular-nums text-status-warning"
                  >
                    {driftCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-2">
        {/* Theme toggle — desktop only; mobile users set it in Settings so the
            compact mobile top bar stays uncrowded. `max-sm:hidden`, not
            `hidden sm:inline-flex`: the toggle's root already carries
            `inline-flex`, and a bare `hidden` beside it loses on Tailwind's sort
            order, so the toggle showed on phones. A variant is emitted after
            every base utility, so it wins without depending on that order. */}
        <ThemeToggle className="max-sm:hidden" />

        {/* Plan badge — quick "you're on X" indicator, links to billing.
            Not on a self-hosted install, which has no plans. */}
        {selfHosted ? null : <Link
          href="/settings/plan"
          aria-label={`Current plan: ${planLabel}`}
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] no-underline transition-colors ${
            planIsPaid
              ? 'bg-primary/[0.12] text-primary hover:bg-primary/[0.18]'
              : 'border border-border text-text-secondary hover:border-border-strong hover:text-text-primary'
          }`}
        >
          {planLabel}
        </Link>}

        <Link
          href="/settings"
          aria-label="Settings"
          className={`flex h-9 w-9 items-center justify-center rounded-full border border-border-subtle text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary ${
            router.pathname === '/settings' ? 'text-text-primary' : ''
          }`}
        >
          <SettingsIcon />
        </Link>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Account menu"
            aria-expanded={menuOpen}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-hover text-sm font-semibold text-text-primary transition-[box-shadow] hover:ring-2 hover:ring-border-strong"
          >
            {avatarLetter}
          </button>

          {/* Desktop (>=768px): 264px account popover — unchanged. */}
          {!isMobile && menuOpen && (
            <div className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-64 overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
              {/* Identity header */}
              <div className="border-b border-border-subtle px-4 py-3.5">
                <div className="truncate text-[13px] font-semibold text-text-primary">{email || 'Operator'}</div>
                {orgName ? <div className="mt-0.5 truncate text-[11px] text-text-muted">{orgName}</div> : null}
              </div>

              <WorkspaceSwitcher />

              <div className="max-h-[60vh] overflow-y-auto py-2">
                {menuSections.map((section) => (
                  <div key={section.heading} className="px-2 pb-1.5">
                    <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                      {section.heading}
                    </div>
                    {section.links.map((link) => {
                      const isActive =
                        router.pathname === link.href ||
                        (link.href !== '/' && router.pathname.startsWith(link.href + '/'));
                      return (
                        <Link
                          key={link.href}
                          href={link.href}
                          className={`flex items-center gap-3 rounded-lg px-2 py-2 text-[13px] no-underline transition-colors ${
                            isActive
                              ? 'bg-overlay-active text-text-primary'
                              : 'text-text-secondary hover:bg-overlay-hover hover:text-text-primary'
                          }`}
                        >
                          <span className={`flex w-4 justify-center ${isActive ? 'text-primary' : 'opacity-70'}`}>
                            {link.icon}
                          </span>
                          {link.label}
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </div>

              <div className="border-t border-border-subtle p-2">
                <button
                  onClick={handleLogout}
                  className="w-full rounded-lg px-2 py-2 text-left text-[13px] text-text-muted transition-colors hover:bg-overlay-hover hover:text-text-secondary"
                >
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>

      {/* Mobile (<768px): full-width bottom-sheet drawer with larger tap rows.
          Rendered only when isMobile, so it never paints on desktop.

          A SIBLING of the header, not a child. `.dashboard-topnav` has
          `backdrop-filter`, and that makes the header the containing block for
          any `position: fixed` descendant — so inside it, `fixed inset-0`
          covered the 64px header instead of the screen, and the bottom sheet
          anchored to the header's bottom edge and hung off the top of the
          viewport. Out here its containing block is the viewport again. */}
      {isMobile && menuOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Account menu">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-[var(--scrim)]"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-border-subtle bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-24px_80px_rgba(0,0,0,0.5)]">
            {/* Grab handle */}
            <div className="flex justify-center pt-2.5">
              <span className="h-1 w-9 rounded-full bg-overlay-strong" />
            </div>

            {/* Identity header + close */}
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-text-primary">{email || 'Operator'}</div>
                {orgName ? <div className="mt-0.5 truncate text-xs text-text-muted">{orgName}</div> : null}
              </div>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border-subtle text-text-secondary"
              >
                <XIcon />
              </button>
            </div>

            {/* The switcher was desktop-only, so on a phone a teammate who landed in
                the wrong workspace had no way into the right one. */}
            <WorkspaceSwitcher />

            <div className="py-2">
              {/* The inline primary nav is desktop-only (`hidden md:flex`), so the
                  drawer is where phones reach Today / Projects / Portfolio / Trails / Connect. */}
              <div className="px-3 pb-2">
                <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  Go to
                </div>
                {PRIMARY_NAV.map((link) => {
                  const isActive =
                    router.pathname === link.href ||
                    (link.href !== '/' && router.pathname.startsWith(link.href + '/'));
                  const showBadge = link.badge === 'drift' && driftCount > 0;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setMenuOpen(false)}
                      className={`flex items-center gap-3.5 rounded-xl px-3 py-3.5 text-[15px] no-underline transition-colors ${
                        isActive
                          ? 'bg-overlay-active text-text-primary'
                          : 'text-text-secondary hover:bg-overlay-hover hover:text-text-primary'
                      }`}
                    >
                      <span className={`flex w-5 justify-center ${isActive ? 'text-primary' : 'opacity-70'}`}>
                        {link.icon}
                      </span>
                      {link.label}
                      {showBadge && (
                        <span className="ml-auto rounded-full bg-[var(--status-escalate-bg)] px-2 py-0.5 text-[11px] font-bold tabular-nums text-status-warning">
                          {driftCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>

              {menuSections.map((section) => (
                <div key={section.heading} className="px-3 pb-2">
                  <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                    {section.heading}
                  </div>
                  {section.links.map((link) => {
                    const isActive =
                      router.pathname === link.href ||
                      (link.href !== '/' && router.pathname.startsWith(link.href + '/'));
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={() => setMenuOpen(false)}
                        className={`flex items-center gap-3.5 rounded-xl px-3 py-3.5 text-[15px] no-underline transition-colors ${
                          isActive
                            ? 'bg-overlay-active text-text-primary'
                            : 'text-text-secondary hover:bg-overlay-hover hover:text-text-primary'
                        }`}
                      >
                        <span className={`flex w-5 justify-center ${isActive ? 'text-primary' : 'opacity-70'}`}>
                          {link.icon}
                        </span>
                        {link.label}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="border-t border-border-subtle px-3 py-2">
              <button
                onClick={handleLogout}
                className="w-full rounded-xl px-3 py-3.5 text-left text-[15px] text-text-muted transition-colors hover:bg-overlay-hover hover:text-text-secondary"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
