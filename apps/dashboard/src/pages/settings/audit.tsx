import Head from 'next/head';
import { useCallback, useEffect, useState } from 'react';
import { PageScaffold, SurfacePanel } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { api, isApiError, type AuditEntry, type AuditPage, type TeamMember } from '@/lib/api';
import { logger } from '@/lib/logger';
import { accessLogDescription } from '@/lib/accessLog';

/**
 * The access log, read by person.
 *
 * A log that only says "something happened in this workspace" answers a question
 * nobody asks. The one people actually have is "has anyone outside the team
 * opened this?", so the filter that matters is WHO, and the row leads with a
 * name rather than an action code.
 */

// Actions rendered as sentences. An audit log full of snake_case is a database
// export, not a surface — and the reader is often the least technical person in
// the room, checking before they put a client's work in.
const ACTION_COPY: Record<string, string> = {
  context_read: 'read the context',
  context_write: 'wrote to the context',
  context_write_blocked: 'was blocked from writing',
  context_export: 'exported the context',
  project_deleted: 'deleted a project',
  project_moved: 'moved a project in',
  project_moved_out: 'moved a project out',
  subagent_brief_read: 'read a subagent brief',
  share_link_created: 'created a public share link',
  share_link_revoked: 'revoked a public share link',
  share_link_visibility_changed: 'changed a share link',
  sharing_policy_updated: 'changed who can see a project',
  member_invited: 'invited someone',
  invite_accepted: 'accepted an invitation',
  invite_revoked: 'revoked an invitation',
  member_removed: 'removed someone',
  member_left: 'left the workspace',
  role_changed: 'changed a role',
  connection_disconnected_by_owner: 'disconnected an AI tool a teammate had connected',
  workspace_created: 'created this workspace',
  domain_approved: 'approved an email domain',
  domain_revoked: 'revoked an email domain',
  joined_via_domain: 'joined via an approved domain',
};

function describe(entry: AuditEntry): string {
  return ACTION_COPY[entry.action] || entry.action.replace(/_/g, ' ');
}

function actorName(entry: AuditEntry): string {
  if (entry.actor_email) return entry.actor_email;
  // A key-authed action with no resolvable owner, or an entry from before the
  // log recorded people. It belongs to no person, so it reads as the
  // workspace's own rather than an empty cell.
  if (entry.actor_type === 'system') return 'DeerDawn (automated)';
  return entry.actor_user_id ? `Unknown user (${entry.actor_user_id.slice(0, 12)}…)` : 'Workspace';
}

export default function AuditPage_() {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  // The reader's role in this workspace, from the roster. A member or viewer
  // is served a filtered log, and the description has to say so.
  const [role, setRole] = useState<string | null>(null);
  const [person, setPerson] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (actorUserId: string) => {
    setLoading(true);
    try {
      const [logs, roster] = await Promise.all([
        api.getAudit(actorUserId ? { actor_user_id: actorUserId } : {}),
        api.getTeam().catch(() => null),
      ]);
      setPage(logs);
      setMembers(roster?.members || []);
      setRole(roster?.actor_role ?? null);
      setError(null);
    } catch (err) {
      logger.error('Failed to load audit log', err);
      setError(
        isApiError(err) && err.status === 403
          ? 'The access log is part of a shared workspace. Upgrade to a team plan to see it.'
          : 'Could not load the access log. Try again in a moment.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(person); }, [load, person]);

  return (
    <>
      <Head><title>Access log · DeerDawn</title></Head>
      <PageScaffold
        title="Access log"
        description={accessLogDescription(role)}
      >
        {loading && <SurfacePanel className="p-6 text-sm text-text-secondary">Loading…</SurfacePanel>}

        {!loading && error && (
          <SurfacePanel className="p-6">
            <p className="text-sm text-text-secondary">{error}</p>
            <div className="mt-4"><Button onClick={() => void load(person)}>Try again</Button></div>
          </SurfacePanel>
        )}

        {!loading && !error && page && (
          <>
            <SurfacePanel className="p-5 lg:p-6">
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="audit-person" className="text-sm text-text-secondary">Show activity by</label>
                <select
                  id="audit-person"
                  className="rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary"
                  value={person}
                  onChange={(event) => setPerson(event.target.value)}
                >
                  <option value="">Everyone</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.email || member.id}{member.status === 'removed' ? ' (left)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {/* Say how far back this goes. A window that silently truncates is
                  indistinguishable from "nothing happened", which is the worst
                  thing an access log can imply. */}
              <p className="mt-3 text-xs text-text-muted">
                {page.retained_since
                  ? `Showing activity back to ${new Date(page.retained_since).toLocaleDateString()}.`
                  : 'No activity recorded yet.'}
                {page.truncated ? ' Only the most recent entries are shown.' : ''}
              </p>
            </SurfacePanel>

            <SurfacePanel className="p-5 lg:p-6">
              {page.logs.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  Nothing recorded for this filter.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-left">
                    <thead>
                      <tr className="border-b border-border-subtle text-[11px] uppercase tracking-wide text-text-muted">
                        <th className="pb-2 pr-4 font-semibold">Who</th>
                        <th className="pb-2 pr-4 font-semibold">Did what</th>
                        <th className="pb-2 pr-4 font-semibold">From</th>
                        <th className="pb-2 font-semibold">When</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {page.logs.map((entry) => (
                        <tr key={entry.id}>
                          <td className="py-3 pr-4 text-sm text-text-primary">{actorName(entry)}</td>
                          <td className="py-3 pr-4 text-sm text-text-secondary">{describe(entry)}</td>
                          <td className="py-3 pr-4 text-xs text-text-muted">{entry.tool || '—'}</td>
                          <td className="py-3 text-xs text-text-muted tabular-nums">
                            {new Date(entry.created_at).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SurfacePanel>
          </>
        )}
      </PageScaffold>
    </>
  );
}
