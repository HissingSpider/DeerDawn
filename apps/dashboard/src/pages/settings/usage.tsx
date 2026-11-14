import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { WeeklyActivityPanel } from '@/components/dashboard/WeeklyActivity';
import { DisclosureRow } from '@/components/dashboard/brief/DisclosureRow';
import { api, type OrgUsageSummary, type ProductEventSummary } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { showToast } from '@/components/ui/Toast';
import { PRO_PLAN_NAME } from '@/lib/planCopy';
import { usagePlanLine } from '@/lib/usagePlanLine';
import { useDeployment } from '@/lib/deployment';

const TOKENS_SAVED_PER_SYNC = 220;
const SECONDS_SAVED_PER_BRIEF = 45;

// Emphasis level 2 — a hairline row. Replaces the nested `rounded-2xl border`
// card each of these numbers used to sit in.
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-4 border-t border-border-subtle py-3 last:border-b">
      <span className="text-[13.5px] text-text-secondary">{label}</span>
      <span className="ml-auto font-mono text-[13px] tabular-nums text-text-primary">{value}</span>
    </div>
  );
}

function formatTimeSaved(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = totalSeconds / 3600;
  const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

export default function SettingsUsagePage() {
  // A self-hosted install has no plans: every workspace has every feature and
  // nothing ages out, so the plan label, the plan line and the upgrade card
  // (all read off the org row's hosted plan) are not drawn there.
  const { selfHosted } = useDeployment();
  const [usage, setUsage] = useState<OrgUsageSummary | null>(null);
  const [events, setEvents] = useState<ProductEventSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.getUsage(), api.getProductEventSummary()])
      .then(([orgUsage, eventSummary]) => {
        setUsage(orgUsage);
        setEvents(eventSummary);
      })
      .catch((err) => {
        showToast(err instanceof Error ? err.message : 'Could not load usage metrics', 'error');
      })
      .finally(() => setLoading(false));
  }, []);

  // Never-forgets model: briefs are uncapped on every plan, so there is no
  // meter, no denominator, and no usage-triggered upgrade nag on this page.
  // Free's real boundary is the memory window (workspaces + history days) —
  // the upsell is permanence, not throttling.
  const briefsThisCycle = usage?.ledger?.briefs_this_period ?? 0;
  const briefsAllTime = usage?.ledger?.briefs_all_time ?? briefsThisCycle;
  const planLabel = usage?.plan?.public_name || usage?.plan?.tier || 'Free';
  const isFreeTier = (usage?.plan?.tier ?? 'free') === 'free';
  const historyDays = usage?.limits?.history_days ?? null;
  const projectLimit = usage?.limits?.projects ?? null;

  // null is UNCAPPED, never a default number. See lib/usagePlanLine.
  const planPromiseLine = usagePlanLine({ isFreeTier, planLabel, historyDays, projectLimit });

  const dailyUsed = useMemo(() => {
    const recent = events?.recent ?? [];
    if (!recent.length) return 0;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return recent.filter((entry) => {
      const name = entry.event_name || '';
      const ts = entry.created_at ? new Date(entry.created_at) : null;
      if (!ts || Number.isNaN(ts.getTime()) || ts < start) return false;
      return name === 'mcp_tool_call_succeeded' || name === 'mcp_start_session_succeeded';
    }).length;
  }, [events]);

  const estimatedTokensSaved = briefsThisCycle * TOKENS_SAVED_PER_SYNC;
  const coldStartsAvoided = briefsThisCycle;
  const timeSavedLabel = formatTimeSaved(coldStartsAvoided * SECONDS_SAVED_PER_BRIEF);

  return (
    <>
      <Head>
        <title>Usage & Value | DeerDawn</title>
      </Head>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="dashboard-title">Usage</h1>
          {!selfHosted && <span className="text-[13px] text-text-muted">{planLabel}</span>}
          {/* WHICH workspace these numbers are for. GET /orgs/usage used to read
              the personal org regardless of the workspace switcher, so this page
              could show a solo account's briefs while the reader believed they
              were looking at their team's. */}
          {usage?.org_name ? (
            <span className="text-[13px] text-text-muted">· {usage.org_name}</span>
          ) : null}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg border border-border-subtle bg-overlay-subtle" />
            ))}
          </div>
        ) : (
          <>
            {/* The headline this page exists to deliver. Previously two competing
                2xl headings plus a paragraph of framing; the number is the point. */}
            <p className="text-[15px] leading-7 text-text-secondary">
              {coldStartsAvoided > 0 ? (
                <>
                  DeerDawn has saved you about{' '}
                  <span className="font-semibold text-text-primary">{timeSavedLabel}</span> of re-explaining
                  context this cycle.
                </>
              ) : (
                'DeerDawn starts saving you time with your first brief.'
              )}
            </p>

            {/* Level-2 rows. These were five nested cards inside two panels — three
                levels of box for six numbers. */}
            <div className="flex flex-col">
              <Row label="Briefs this cycle" value={`${briefsThisCycle.toLocaleString()}`} />
              <Row label="Briefs today" value={`${dailyUsed.toLocaleString()}`} />
              <Row label="Briefs all time" value={`${briefsAllTime.toLocaleString()}`} />
              <Row label="Cold starts avoided" value={coldStartsAvoided.toLocaleString()} />
              <Row label="Estimated tokens saved" value={estimatedTokensSaved.toLocaleString()} />
            </div>

            {!selfHosted && (
              <p className="text-[13px] text-text-muted">
                Briefs are unlimited on every plan: no monthly cap, no daily cap. {planPromiseLine}
              </p>
            )}

            {isFreeTier && !selfHosted ? (
              <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
                <div className="text-sm font-semibold text-text-primary">
                  {historyDays
                    ? `Memory older than ${historyDays} days ages out of your briefs.`
                    : 'Older memory ages out of your briefs.'}
                </div>
                <p className="mt-1 text-[13px] leading-6 text-text-secondary">
                  Your briefs stay unlimited either way. {PRO_PLAN_NAME} keeps every decision and every
                  workspace in your brief permanently.
                </p>
                <Link href="/settings/plan" className="mt-3 inline-block">
                  <Button size="sm">Upgrade plan</Button>
                </Link>
              </div>
            ) : null}

            {/* Re-homed from the app shell, where it repeated above every route. */}
            <WeeklyActivityPanel />

            {/* Methodology used to be a permanent third of the page. It answers a
                question you ask once, so it collapses. */}
            <DisclosureRow label="How these numbers are calculated" meta="directional, not billing-grade">
              <ul className="space-y-2 text-[13px] leading-6 text-text-secondary">
                <li>Each brief delivered counts as one avoided cold start — a session you did not have to re-brief by hand.</li>
                <li>Time saved assumes about {SECONDS_SAVED_PER_BRIEF} seconds to re-type project context per session.</li>
                <li>Token savings use {TOKENS_SAVED_PER_SYNC} tokens avoided per brief.</li>
                <li>Brief counts come from delivered-brief events in your current billing cycle.</li>
                <li>Daily briefs come from today&apos;s successful MCP briefing events.</li>
              </ul>
            </DisclosureRow>
          </>
        )}
      </div>
    </>
  );
}
