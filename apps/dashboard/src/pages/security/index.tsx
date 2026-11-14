import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageScaffold, SurfacePanel, InlineErrorState } from '@/components/dashboard/PageScaffold';
import { DisclosureRow } from '@/components/dashboard/brief/DisclosureRow';
import { Button } from '@/components/ui/Button';
import { api, isApiError } from '@/lib/api';
import {
  ACCOUNT_ERASURE_PHRASE,
  describeErasedRows,
  describeErasureFailure,
  erasurePhraseMatches,
} from '@/lib/accountErasure';

type AuditLog = {
  id: string;
  project_id: string | null;
  action: string;
  actor_type: string | null;
  tool: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const ACTION_LABELS: Record<string, string> = {
  context_read: 'Read',
  context_write: 'Write',
  context_export: 'Export',
  context_delete: 'Delete',
  context_ttl_expired: 'TTL Expired',
};

const ACTION_COLORS: Record<string, string> = {
  context_read: 'text-text-secondary',
  context_write: 'text-primary',
  context_export: 'text-text-secondary',
  context_delete: 'text-status-danger',
  context_ttl_expired: 'text-orange-400',
};

export default function SecurityPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<{ rows: string | null; subscriptionCancelled: boolean } | null>(null);

  useEffect(() => {
    api.getAuditLog({ limit: 100 })
      .then((r) => setLogs(r.logs))
      .catch((err) => setError(err?.message || 'Failed to load audit log'))
      .finally(() => setLoading(false));
  }, []);

  // IRREVERSIBLE, AND NEVER RETRIED AUTOMATICALLY. The request is only built
  // once the phrase has been typed out, the canonical constant is what is sent
  // (so invisible whitespace cannot turn a correct confirmation into a 400),
  // and a failure leaves the typed phrase in place for the person to decide
  // about rather than firing again on its own.
  async function handleDelete() {
    if (!erasurePhraseMatches(typed) || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api.deleteAccount(ACCOUNT_ERASURE_PHRASE);
      if (!result?.deleted) {
        setDeleteError('The server did not confirm the deletion. Nothing has been assumed: reload and check before trying again.');
        return;
      }
      setDeleted({
        rows: describeErasedRows(result.deleted_counts),
        subscriptionCancelled: Boolean(result.subscription_cancelled),
      });
      setLogs([]);
      setTyped('');
      setDeleteArmed(false);
    } catch (err: unknown) {
      setDeleteError(
        isApiError(err)
          ? describeErasureFailure(err.status, err.data)
          : describeErasureFailure(0, null),
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Head>
        <title>Security | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Security"
        description="Review what data DeerDawn has stored for you, export it, or delete it."
      >
        {error && (
          <InlineErrorState
            title="Error"
            description={error}
            onRetry={() => { setError(null); setLoading(true); api.getAuditLog({ limit: 100 }).then((r) => setLogs(r.logs)).catch((e) => setError(e?.message)).finally(() => setLoading(false)); }}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <SurfacePanel className="p-6">
            <div className="dashboard-eyebrow">Access log</div>
            <p className="mt-1 text-sm text-text-secondary">Every time your context was read, written, or exported.</p>

            {loading ? (
              <div className="mt-6 space-y-2">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="h-12 rounded-xl bg-overlay-subtle animate-pulse" />
                ))}
              </div>
            ) : logs.length === 0 ? (
              <div className="mt-6 text-sm text-text-secondary">No access events recorded yet.</div>
            ) : (
              <div className="mt-4 space-y-2">
                {logs.map((log) => (
                  <div key={log.id} className="flex items-center justify-between rounded-xl border border-border-subtle bg-overlay-subtle px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-semibold uppercase tracking-widest ${ACTION_COLORS[log.action] || 'text-text-muted'}`}>
                        {ACTION_LABELS[log.action] || log.action}
                      </span>
                      {log.tool && (
                        <span className="text-xs text-text-muted">{log.tool}</span>
                      )}
                      {log.actor_type && (
                        <span className="text-xs text-text-muted">via {log.actor_type}</span>
                      )}
                    </div>
                    <div className="text-xs text-text-muted">
                      {new Date(log.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SurfacePanel>

          <div className="flex flex-col gap-4">
            {/* Export lives on Your data, which is the page built for it — this was
                a second, less capable copy of the same action (JSON only, no
                Markdown, no summary of what's included). */}
            <Link
              href="/settings/data"
              className="group flex items-center gap-4 border-t border-border-subtle py-3.5 no-underline transition-colors hover:bg-overlay-hover"
            >
              <div>
                <div className="text-[13.5px] font-semibold text-text-primary">Export your data</div>
                <div className="text-[12.5px] text-text-muted">Projects, context and this audit log</div>
              </div>
              <span className="ml-auto shrink-0 text-text-muted transition-colors group-hover:text-text-primary">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
            </Link>

            {/* Encryption is a fact with nothing to do about it — it answers a
                question you ask once, so it collapses instead of occupying a
                permanent panel. */}
            <DisclosureRow label="Encryption" meta="how your context is stored">
              <p className="text-[13px] leading-6 text-text-secondary">
                Context data for paid plans is encrypted at rest using AES-256-GCM with
                per-account keys. Free plans use transport-layer encryption only.
              </p>
            </DisclosureRow>

            {/* Danger zone. Distinct from Delete account in Settings: this empties
                the workspace and keeps the account. Red is earned here.

                The copy is what DELETE /api/v1/context/account actually does,
                read to the end of the route: it cancels the Stripe subscription
                FIRST (and refuses to delete anything if that fails), then purges
                every owner-scoped table — projects, briefs, sessions, the memory
                graph, shared skills, integration credentials, the roster, and
                this audit log — and revokes every API key. The users row, the
                organizations row and the Clerk identity survive it. It needs
                context:admin AND workspace-owner, and refuses outright while the
                workspace still has other members. */}
            <div className="mt-2 border-t border-status-danger/25 pt-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-status-danger/70">
                Danger zone
              </div>
              <p className="mt-2 text-[13px] leading-6 text-text-secondary">
                Permanently deletes everything this workspace holds: projects and their briefs,
                sessions, the memory graph, shared skills, connected-tool credentials, the member
                roster, and this audit log. Every API key issued for this workspace is revoked, so any
                agent still using one stops immediately. An active subscription is cancelled first, and if that fails
                nothing is deleted.
              </p>
              <p className="mt-2 text-[13px] leading-6 text-text-secondary">
                Your sign-in still works afterwards and lands you in an empty workspace. Teams you
                belong to are not affected: you stay a member, and your keys there keep working. Only a
                workspace owner can do this, and not while other people are still members. It cannot
                be undone, so export your data first if you might want it.
              </p>

              {deleted ? (
                <div className="mt-3 rounded-lg border border-border-subtle bg-overlay-subtle px-4 py-3 text-sm leading-6 text-text-secondary">
                  <span className="font-semibold text-text-primary">This workspace is empty.</span>{' '}
                  {deleted.rows ? `${deleted.rows} ` : ''}
                  Every API key it held has been revoked
                  {deleted.subscriptionCancelled ? ', and the subscription was cancelled' : ''}.
                  Your account still exists, you are still signed in, and any team you belong to
                  is unchanged.
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {!deleteArmed ? (
                    <Button onClick={() => setDeleteArmed(true)} variant="danger" size="sm">
                      Delete all my data
                    </Button>
                  ) : (
                    <>
                      <label htmlFor="erasure-confirm" className="block text-[13px] leading-6 text-text-secondary">
                        Type <span className="font-mono text-text-primary">{ACCOUNT_ERASURE_PHRASE}</span> to confirm.
                      </label>
                      <input
                        id="erasure-confirm"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                        placeholder={ACCOUNT_ERASURE_PHRASE}
                        className="w-full rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 font-mono text-[13px] text-text-primary"
                      />
                      <div className="flex items-center gap-3">
                        <Button
                          onClick={handleDelete}
                          disabled={deleting || !erasurePhraseMatches(typed)}
                          variant="danger"
                          size="sm"
                        >
                          {deleting ? 'Deleting…' : 'Delete everything permanently'}
                        </Button>
                        <button
                          onClick={() => { setDeleteArmed(false); setTyped(''); setDeleteError(null); }}
                          className="text-xs text-text-muted underline"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                  {deleteError && (
                    <p role="alert" className="text-sm leading-6 text-status-danger">{deleteError}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </PageScaffold>
    </>
  );
}
