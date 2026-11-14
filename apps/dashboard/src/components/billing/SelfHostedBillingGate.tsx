import Link from 'next/link';
import React from 'react';
import { useDeployment } from '@/lib/deployment';

/**
 * Billing pages on a self-hosted install.
 *
 * A self-hosted DeerDawn has every feature for every workspace and no billing
 * (the API answers 404 billing_disabled on /api/v1/billing). The plan page,
 * the upgrade page, the referral page, plan selection and checkout would each
 * render half a screen of prices and then fail on the first request, so they
 * render this instead. Bookmarks and old links still land somewhere sensible.
 *
 * `standalone` pages (select-plan, checkout) render outside the dashboard
 * Layout, so they get their own full-height frame.
 */
export function SelfHostedBillingNotice({ standalone = false }: { standalone?: boolean }) {
  const body = (
    <div className="mx-auto max-w-xl space-y-3 rounded-xl border border-border bg-surface p-6">
      <h1 className="dashboard-title">Billing is not part of this install</h1>
      <p className="text-sm leading-6 text-text-secondary">
        This DeerDawn is self-hosted. Every workspace has every feature, including teams,
        with no seat limits and nothing to pay for.
      </p>
      <p className="text-sm leading-6">
        <Link href="/" className="text-primary hover:underline">Back to your workspace</Link>
        {' · '}
        <Link href="/settings/team" className="text-primary hover:underline">Invite your team</Link>
      </p>
    </div>
  );
  if (!standalone) return body;
  return <div className="flex min-h-full items-center justify-center px-4 py-16">{body}</div>;
}

/**
 * Renders `children` on hosted, the notice on a self-host. A wrapper rather
 * than an early return inside each page, so the page's own hooks are never
 * called conditionally.
 */
export function SelfHostedBillingGate({ children, standalone = false }: { children: React.ReactNode; standalone?: boolean }) {
  const { selfHosted } = useDeployment();
  if (selfHosted) return <SelfHostedBillingNotice standalone={standalone} />;
  return <>{children}</>;
}
