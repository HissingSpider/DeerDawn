import Link from 'next/link';
import React from 'react';
import { Button } from '@/components/ui/Button';

export function PageScaffold({
  eyebrow,
  title,
  description,
  action,
  aside,
  children,
}: {
  /**
   * An 11px uppercase kicker above the title. Reserved for STATE that explains
   * why you are on this page — /settings/upgrade's "Plan limit reached" is the
   * one caller that qualifies. It used to carry a category word on nearly every
   * page ("Admin", "Revenue", "Transparency", "Connectivity"), which the route,
   * the nav item and the title already said. Under the display title that read
   * as a kicker; under an 18px title it is just a second heading competing with
   * the first, so category eyebrows are gone rather than restyled.
   */
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="dashboard-page-header">
        <div className="space-y-2">
          {eyebrow ? <div className="dashboard-eyebrow">{eyebrow}</div> : null}
          <div className="space-y-1.5">
            <h1 className="dashboard-title">{title}</h1>
            {description ? <p className="dashboard-description">{description}</p> : null}
          </div>
        </div>
        {(action || aside) ? (
          <div className="flex flex-wrap items-center justify-end gap-3">
            {aside}
            {action}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SurfacePanel({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <section className={`dashboard-surface ${className}`.trim()}>{children}</section>;
}

export const DashboardPanel = SurfacePanel;

export function DashboardTableWrap({ children }: { children: React.ReactNode }) {
  return <div className="dashboard-table-wrap">{children}</div>;
}

export function DashboardField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2">
      <span className="dashboard-eyebrow">{label}</span>
      {children}
    </label>
  );
}

// Colour law: a pill is tinted only when it encodes STATE the user may need to
// act on. Neutral counts, types and scores get no tint — `info` is kept as an
// alias for `neutral` so existing callers don't have to change at once, but it
// no longer paints anything blue.
export function DashboardStatusPill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'info';
}) {
  const tones = {
    neutral: 'border-border-subtle bg-overlay-subtle text-text-secondary',
    info: 'border-border-subtle bg-overlay-subtle text-text-secondary',
    success: 'border-primary/20 bg-primary/10 text-primary',
    danger: 'border-status-danger/30 bg-[var(--status-deny-bg)] text-status-danger',
    warning: 'border-status-warning/30 bg-[var(--status-escalate-bg)] text-status-warning',
  };

  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function NextStepPanel({
  title,
  description,
  action,
  eyebrow = 'Next step',
}: {
  title: string;
  description: string;
  action: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <SurfacePanel className="p-5 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="dashboard-eyebrow">{eyebrow}</div>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-text-primary">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-text-secondary">{description}</p>
        </div>
        {action}
      </div>
    </SurfacePanel>
  );
}

export function PanelHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
        {description ? <p className="text-sm text-text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function MetricTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'primary' | 'warning';
}) {
  return (
    <div className={`dashboard-metric dashboard-metric-${tone}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">{label}</div>
      <div className="mt-4 text-[34px] font-semibold tracking-[-0.04em] text-text-primary">{value}</div>
      <div className="mt-2 text-sm text-text-muted">{detail}</div>
    </div>
  );
}

export function EmptyHero({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  tips,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  tips?: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="dashboard-empty">
      {icon ? <div className="dashboard-empty-icon">{icon}</div> : null}
      <div className="mx-auto max-w-2xl space-y-3 text-center">
        <h3 className="text-[28px] font-semibold tracking-[-0.04em] text-text-primary">{title}</h3>
        <p className="mx-auto max-w-xl text-[15px] leading-7 text-text-secondary">{description}</p>
      </div>
      {(primaryAction || secondaryAction) ? (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}
      {tips?.length ? (
        <div className="grid w-full gap-3 md:grid-cols-3">
          {tips.map((tip) => (
            <div key={tip.label} className="rounded-2xl border border-border-subtle bg-overlay-subtle p-4 text-left">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">{tip.label}</div>
              <div className="mt-2 text-sm leading-6 text-text-secondary">{tip.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function InlineErrorState({
  title,
  description,
  onRetry,
  requestId,
  action,
  role,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
  /**
   * The server's id for this failure. It is already in the error body and
   * already in the server logs; showing it turns "it broke" into a log grep.
   * Selectable, muted, and absent when there is none — never a fake id.
   */
  requestId?: string;
  /**
   * The way to act on a failure a retry cannot fix (a refusal names its
   * reason and where to fix it; see lib/loadFailure). Absent for every
   * failure a retry can fix, which render exactly as before.
   */
  action?: React.ReactNode;
  /**
   * A live-region role, for a caller whose state should be announced
   * (RefusalNotice passes `status`). Absent for every other caller, which
   * renders exactly as before: no role attribute at all.
   */
  role?: 'status' | 'alert';
}) {
  return (
    <div role={role} className="rounded-2xl border border-status-danger/25 bg-[var(--status-deny-bg)] p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-status-danger">{title}</div>
          <p className="max-w-2xl text-sm leading-6 text-text-secondary">{description}</p>
          {requestId ? (
            <p className="select-all font-mono text-xs text-text-muted">Reference {requestId}</p>
          ) : null}
        </div>
        {action ?? null}
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function TextLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  // hover was a raw `#4ade80` (green-400): dark-first, no light value, and about
  // 1.8:1 on the white surface. `primary-hover` is the token pair the rest of the
  // product already hovers with.
  return (
    <Link href={href} className="text-sm font-semibold text-primary transition-colors hover:text-primary-hover">
      {children}
    </Link>
  );
}
