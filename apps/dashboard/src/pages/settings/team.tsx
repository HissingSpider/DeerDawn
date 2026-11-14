import Head from 'next/head';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { PageScaffold, SurfacePanel } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { api, apiErrorReason, getActiveWorkspace, isApiError, switchToPersonalWorkspace, type ProjectSharing, type ProjectVisibility, type TeamInvite, type TeamMember, type TeamConnection, type TeamRoster, type WorkspaceConfig, type WorkspaceDomain } from '@/lib/api';
import { logger } from '@/lib/logger';
import { showToast } from '@/components/ui/Toast';
import { InviteLinkCopy } from '@/components/dashboard/InviteLinkCopy';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { inviteRefusalMessage, inviteWasEmailed, teamLoadRefusal, type TeamLoadRefusal } from '@/lib/teamInvites';
import { boundWorkspaceEntry } from '@/lib/workspaceFallback';
import { leaveWorkspaceConfirmText, removeMemberConfirmText } from '@/lib/workspaceRemoval';
import { effectivePermissions, offeredSections, sectionLabel, sectionRowsFor } from '@/lib/shareSections';
import {
  ASK_AN_OWNER_LINE,
  addSeatConfirmation,
  addSeatRequest,
  canAddSeat,
  inactiveTeamNotice,
  perSeatPriceLine,
  seatPurchaseOutcome,
  seatSummary,
  subscriptionInactive,
} from '@/lib/teamSeats';
import { isPerSeatPlan } from '@/lib/planCopy';
import {
  TEAM_CONNECTIONS_EMPTY,
  TEAM_CONNECTIONS_INTRO,
  connectionPersonName,
  connectionToolName,
  disconnectConfirmation,
} from '@/lib/teamConnections';
import { CHECK_OUT_AGAIN_LABEL, parseRetryCheckout } from '@/lib/firstPayment';
import { billingPageRefusal, type BillingPageRefusal } from '@/lib/billingRefusal';
import { BillingRefusalNotice } from '@/components/billing/BillingRefusalNotice';
import { SeatShortfallNotice } from '@/components/billing/BillingOwnerPanel';

const ROLE_COPY: Record<string, string> = {
  owner: 'Billing and membership',
  member: 'Read and write context',
  viewer: 'Read only',
};

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
      {role}
    </span>
  );
}

/**
 * Seat usage, and the one control that changes it.
 *
 * Nothing here gates a brief. Over the cap the invitation is refused and says
 * why; everyone already in the workspace keeps working, because a paywall that
 * throws inside somebody's agent loop produces a broken loop and a bug report
 * rather than an upgrade.
 *
 * "Upgrade to invite more" used to be the whole answer at the cap, and for a
 * workspace already on Team it pointed at a plan picker whose only entry was
 * the plan it was paying for. Adding a seat is what it actually needed, and
 * there was no way to do it in the product.
 */
function SeatPanel({ roster, busy, onAddSeat }: {
  roster: TeamRoster;
  busy: boolean;
  onAddSeat: () => void;
}) {
  const summary = seatSummary(roster);
  const inactive = subscriptionInactive(roster);
  const mayAdd = canAddSeat(roster);
  const onPerSeatPlan = isPerSeatPlan(roster.billing?.plan_tier);

  return (
    <SurfacePanel className="p-5 lg:p-6">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-semibold tabular-nums text-text-primary">{summary.countLabel}</span>
        {summary.pendingLabel && <span className="text-text-secondary">{summary.pendingLabel}</span>}
      </div>

      {/* More people than paid seats: said to the owner; nobody is locked out. */}
      {roster.actor_role === 'owner' ? (
        <SeatShortfallNotice
          shortfall={roster.billing?.seat_shortfall}
          action={<Link href="/settings/plan" className="text-primary hover:underline">Change seats on the plan page</Link>}
        />
      ) : null}

      {summary.full && !inactive && (
        <p className="mt-2 text-sm text-status-warning-text">
          {mayAdd
            ? 'All seats are taken. Add a seat to invite another person.'
            : `All seats are taken. ${onPerSeatPlan ? ASK_AN_OWNER_LINE : 'Upgrade to add another person.'}`}
        </p>
      )}

      {mayAdd && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {/* A money action: it asks first, names the new total and the price,
                and one click is one seat. Nothing here fires on load or reads a
                seat count out of the URL. */}
            <Button onClick={onAddSeat} disabled={busy}>{busy ? 'Adding a seat…' : 'Add a seat'}</Button>
            <span className="text-xs text-text-muted">{perSeatPriceLine()}.</span>
          </div>
          <p className="mt-2 text-xs text-text-muted">
            The prorated difference goes on your next invoice. To pay for fewer seats, remove people
            first, then change the quantity in{' '}
            <Link href="/settings/plan" className="text-primary hover:underline">billing</Link>.
          </p>
        </>
      )}

      {!mayAdd && !inactive && onPerSeatPlan && (
        <p className="mt-2 text-sm text-text-secondary">{ASK_AN_OWNER_LINE}</p>
      )}
    </SurfacePanel>
  );
}

function MemberRow({
  member,
  canAdminister,
  isSelf,
  canLeave,
  onRole,
  onRemove,
  onLeave,
}: {
  member: TeamMember;
  canAdminister: boolean;
  isSelf: boolean;
  /** Your own row, and not the workspace's only owner. */
  canLeave: boolean;
  onRole: (userId: string, role: string) => void;
  onRemove: (member: TeamMember) => void;
  onLeave: () => void;
}) {
  const removed = member.status === 'removed';
  return (
    <tr className={removed ? 'opacity-60' : undefined}>
      <td className="py-3 pr-4">
        <div className="text-sm text-text-primary">{member.email || member.id}</div>
        {removed && (
          <div className="text-xs text-text-muted">
            Left the team — their contributions stay in the workspace
          </div>
        )}
      </td>
      <td className="py-3 pr-4">
        {canAdminister && !removed && !isSelf ? (
          <select
            aria-label={`Role for ${member.email || member.id}`}
            className="rounded-md border border-border-subtle bg-overlay-subtle px-2 py-1 text-xs text-text-primary"
            value={member.role}
            onChange={(event) => onRole(member.id, event.target.value)}
          >
            {Object.keys(ROLE_COPY).map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
        ) : (
          <RoleBadge role={member.role} />
        )}
      </td>
      <td className="py-3 pr-4 text-xs text-text-muted">{ROLE_COPY[member.role]}</td>
      <td className="py-3 text-right">
        {canAdminister && !removed && !isSelf && (
          <Button variant="ghost" onClick={() => onRemove(member)}>Remove</Button>
        )}
        {canLeave && !removed && (
          <Button variant="ghost" onClick={onLeave}>Leave team</Button>
        )}
      </td>
    </tr>
  );
}

function InviteRow({
  invite,
  canAdminister,
  onRevoke,
}: {
  invite: TeamInvite;
  canAdminister: boolean;
  onRevoke: (inviteId: string) => void;
}) {
  return (
    <tr>
      <td className="py-3 pr-4 text-sm text-text-primary">{invite.email}</td>
      <td className="py-3 pr-4"><RoleBadge role={invite.role} /></td>
      <td className="py-3 pr-4 text-xs text-text-muted">
        Invited — expires {new Date(invite.expires_at).toLocaleDateString()}
      </td>
      <td className="py-3 text-right">
        {canAdminister && (
          <Button variant="ghost" onClick={() => onRevoke(invite.invite_id)}>Revoke</Button>
        )}
      </td>
    </tr>
  );
}


/**
 * The repo-committable connector config.
 *
 * Per-person install friction multiplies across a team rather than adding: a
 * team of five where two never connect produces a half-empty brief that reads as
 * a broken product. One committed file turns N installs into one commit.
 */
function ConnectPanel({ config }: { config: WorkspaceConfig }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(file: { path: string; contents: string }) {
    try {
      await navigator.clipboard.writeText(file.contents);
      setCopied(file.path);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      showToast('Could not copy. Select the text and copy it manually.', 'error');
    }
  }

  return (
    <SurfacePanel className="p-5 lg:p-6">
      <h2 className="text-base font-semibold text-text-primary">Connect the whole team at once</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Commit this to your repo and everyone who clones it gets the connector. Each person signs in as
        themselves the first time their agent uses it, so contributions stay credited to whoever made them.
      </p>
      {!config.contains_secrets && (
        <p className="mt-2 text-xs text-text-muted">
          Safe to commit — it names the server and contains no key.
        </p>
      )}

      {config.files.map((file) => (
        <div key={file.path} className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="text-xs text-text-primary">{file.path}</code>
            <Button variant="ghost" onClick={() => void copy(file)}>
              {copied === file.path ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="mt-1 text-xs text-text-muted">{file.description}</p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border-subtle bg-overlay-subtle p-3 text-xs text-text-secondary">
            {file.contents.trimEnd()}
          </pre>
        </div>
      ))}

      <p className="mt-3 text-xs text-text-muted">{config.verify}</p>
    </SurfacePanel>
  );
}


// The three states, in the words someone choosing between them would use. The
// distinction that matters is the middle one: "private" is not a synonym for
// "mine", it means the org's but not the team's — and an owner can read it.
const VISIBILITY_COPY: Record<ProjectVisibility, { label: string; help: string }> = {
  personal: {
    label: 'Personal',
    help: 'Yours alone. Nobody else in this workspace can open it, including an owner.',
  },
  private: {
    label: 'Private to the org',
    help: 'Not shared with the team, but this is the org\u2019s work — an owner can read it.',
  },
  shared: {
    label: 'Shared with the team',
    help: 'Everyone in the workspace sees it in their brief.',
  },
};

/**
 * Which sections of a shared project travel.
 *
 * Until this existed the dashboard could set a project's visibility and nothing
 * else, so the section policy — which the API has always honoured — could only
 * be configured through the API itself. That is also what made the task board
 * joining the defaults read as unfair: a project with a saved configuration
 * correctly keeps what its author chose, but its author had no screen on which
 * to choose differently.
 *
 * A project with no saved rows shows the defaults, because that is what its
 * teammates actually receive — and it shows them as READ AND WRITE, because
 * that is also what they receive: the API grants the write on every default
 * section a project has no stored row for.
 *
 * TWO COLUMNS, NOT ONE. The first version of this panel offered a single tick
 * per section and wrote `can_edit` from a rule of its own, so it decided about
 * writing while displaying only reading — and with no edit control anywhere, a
 * section turned off and back on came back read-only for good. Anything this
 * panel changes, it has to show.
 */
function SectionPicker({ project, offered, view, edit, busy, onToggle }: {
  project: ProjectSharing;
  offered: string[];
  view: string[];
  edit: string[];
  busy: boolean;
  onToggle: (sectionKey: string, permission: 'view' | 'edit', on: boolean) => void;
}) {
  const canView = new Set(view);
  const canEdit = new Set(edit);
  const configured = Boolean(project.sections?.length);
  return (
    <div className="mt-3 rounded-md border border-border-subtle bg-overlay-subtle p-3">
      <div className="text-xs text-text-secondary">
        {configured
          ? 'What the team sees of this project, and what they can change.'
          : 'What the team sees of this project, and what they can change — the defaults, until you change one.'}
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-2">
        <div className="text-xs text-text-muted">Section</div>
        <div className="text-xs text-text-muted">Read</div>
        <div className="text-xs text-text-muted">Edit</div>
        {offered.map((sectionKey) => (
          <Fragment key={sectionKey}>
            <div className="text-xs text-text-primary">{sectionLabel(sectionKey)}</div>
            <input
              type="checkbox"
              aria-label={`${sectionLabel(sectionKey)}: the team can read it`}
              disabled={busy}
              checked={canView.has(sectionKey)}
              onChange={(event) => onToggle(sectionKey, 'view', event.target.checked)}
            />
            {/* A section nobody can read is never editable — writing into
                content you cannot see is how a writer destroys what they never
                knew was there — so the control says so, rather than offering a
                grant the server would refuse. */}
            <input
              type="checkbox"
              aria-label={`${sectionLabel(sectionKey)}: the team can change it`}
              disabled={busy || !canView.has(sectionKey)}
              checked={canView.has(sectionKey) && canEdit.has(sectionKey)}
              onChange={(event) => onToggle(sectionKey, 'edit', event.target.checked)}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ProjectVisibilityPanel() {
  const [projects, setProjects] = useState<ProjectSharing[] | null>(null);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getProjectSharing();
      setProjects(res.projects || []);
      setAllowlist(res.section_allowlist || []);
      setDefaults(res.defaults || []);
    } catch {
      setProjects(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The saved rows travel with a visibility change. The endpoint now preserves a
  // policy the payload says nothing about — an omitted key is a key the caller
  // is not editing — but sending them keeps this screen's intent explicit, and
  // an older API still needs them or it would publish today's default list over
  // a configuration their author made.
  async function save(
    project: ProjectSharing,
    visibility: ProjectVisibility,
    sections = project.sections,
  ) {
    setBusy(project.project_id);
    try {
      await api.setProjectVisibility(project.project_id, visibility, sections);
      showToast(`Now ${VISIBILITY_COPY[visibility].label.toLowerCase()}`, 'success');
      await load();
    } catch (err) {
      // The server's own sentence. Every refusal here used to read "Could not
      // change that", which is the same message for "you are a viewer", "that
      // is your colleague's project" and "the save failed" — so the one person
      // who COULD act on the answer never saw it.
      const reason = isApiError(err) ? String(err.data?.message || err.message || '') : '';
      showToast(reason || 'Could not change that. Nothing was moved.', 'error');
      if (isApiError(err) && (err.status === 403 || err.status === 404)) await load();
    } finally {
      setBusy(null);
    }
  }

  // Toggling anything writes a row for EVERY offered section, the unshared ones
  // with can_view false — see sectionRowsFor. From then on this project has an
  // explicit configuration, which no later change to the defaults will touch.
  //
  // The set it starts from is what the project ALREADY GRANTS, reads and writes
  // both (effectivePermissions), so the row for a section nobody touched is the
  // permission that section already had. The panel used to start from the
  // readable sections alone and infer the write, which is how its first save
  // made the decision log read-only on a project that had been sharing it
  // writable — silently, and with no control to undo it.
  async function toggleSection(
    project: ProjectSharing,
    sectionKey: string,
    permission: 'view' | 'edit',
    on: boolean,
  ) {
    const offered = offeredSections(allowlist);
    const current = effectivePermissions(project.sections, defaults);
    const view = new Set(current.view);
    const edit = new Set(current.edit);
    if (permission === 'view') {
      if (on) view.add(sectionKey);
      else { view.delete(sectionKey); edit.delete(sectionKey); }
    } else if (on) edit.add(sectionKey);
    else edit.delete(sectionKey);
    await save(project, project.visibility, sectionRowsFor(offered, { view, edit }));
  }

  if (!projects?.length) return null;

  return (
    <SurfacePanel className="p-5 lg:p-6">
      <h2 className="text-base font-semibold text-text-primary">What this team can see</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Projects you had before the team existed stay personal until you move them. Nothing is shared by accident.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {projects.map((project) => (
          <div key={project.project_id} className="border-b border-border-subtle pb-3 last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-text-primary">{project.project_name}</div>
                <div className="text-xs text-text-muted">{VISIBILITY_COPY[project.visibility]?.help}</div>
              </div>
              {/* Offered only to somebody the PATCH would accept. The server
                  decides that — the author of a project may share it whatever
                  their workspace role, and a `personal` project is nobody
                  else's to move — and `undefined` from an older API keeps the
                  control, which is what this screen did before. */}
              <select
                aria-label={`Who can see ${project.project_name}`}
                disabled={busy === project.project_id || project.can_change_visibility === false}
                className="rounded-md border border-border-subtle bg-overlay-subtle px-2 py-1.5 text-xs text-text-primary disabled:opacity-60"
                value={project.visibility}
                onChange={(event) => void save(project, event.target.value as ProjectVisibility)}
              >
                {(Object.keys(VISIBILITY_COPY) as ProjectVisibility[]).map((key) => (
                  <option key={key} value={key}>{VISIBILITY_COPY[key].label}</option>
                ))}
              </select>
            </div>
            {project.can_change_visibility === false && project.visibility_locked_reason && (
              <p className="mt-1 text-xs text-text-muted">{project.visibility_locked_reason}</p>
            )}
            {project.visibility === 'shared' && (
              <SectionPicker
                project={project}
                offered={offeredSections(allowlist)}
                view={effectivePermissions(project.sections, defaults).view}
                edit={effectivePermissions(project.sections, defaults).edit}
                busy={busy === project.project_id || project.can_change_visibility === false}
                onToggle={(sectionKey, permission, on) => void toggleSection(project, sectionKey, permission, on)}
              />
            )}
          </div>
        ))}
      </div>
    </SurfacePanel>
  );
}


/**
 * Approved email domains.
 *
 * Removes the per-person invite for a company that hires. Public providers are
 * refused by the API rather than warned about — approving gmail.com would let
 * anyone on earth in, and the person adding it would not find out until it
 * happened.
 */
function DomainPanel({ canAdminister }: { canAdminister: boolean }) {
  const [domains, setDomains] = useState<WorkspaceDomain[] | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDomains((await api.getWorkspaceDomains()).domains);
    } catch {
      setDomains(null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.addWorkspaceDomain(value.trim());
      setValue('');
      await load();
    } catch (err) {
      // Show the server's reason. "gmail.com is a public email provider" is
      // actionable; "invalid domain" reads as a typo and gets retried.
      const data = (err as { data?: { message?: string } })?.data;
      setProblem(data?.message || 'Could not approve that domain.');
    } finally {
      setBusy(false);
    }
  }

  if (!domains) return null;

  return (
    <SurfacePanel className="p-5 lg:p-6">
      <h2 className="text-base font-semibold text-text-primary">Approved email domains</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Anyone with an email at these domains can join without an invite. They are offered the
        workspace and choose to join — nobody is added automatically.
      </p>

      {domains.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {domains.map((entry) => (
            <li key={entry.domain} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-text-primary">@{entry.domain}</span>
              {canAdminister && (
                <Button
                  variant="ghost"
                  onClick={() => { void api.removeWorkspaceDomain(entry.domain).then(load); }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAdminister && (
        <form className="mt-4 flex flex-wrap items-center gap-3" onSubmit={add}>
          <input
            aria-label="Email domain"
            className="min-w-[200px] flex-1 rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary"
            placeholder="yourcompany.com"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" disabled={busy}>{busy ? 'Approving…' : 'Approve domain'}</Button>
        </form>
      )}
      {problem && <p className="mt-3 text-sm text-status-danger-text">{problem}</p>}
    </SurfacePanel>
  );
}

/**
 * The AI tools people on this team connected to THIS workspace, for its owners.
 *
 * A connection reads and writes the team's memory as the person who approved it,
 * and until now only that person could see or remove it. The list is the
 * connections approved for this workspace: never a member's personal workspace
 * or another team's, and never a token. Disconnecting revokes it for real (its
 * next call is refused, and it cannot renew), after a confirmation.
 */
function TeamConnectionsPanel() {
  const [connections, setConnections] = useState<TeamConnection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections(await api.getTeamConnections());
      setFailed(false);
    } catch (err) {
      logger.error('Failed to load team connections', err);
      setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function disconnect(connection: TeamConnection) {
    if (!window.confirm(disconnectConfirmation(connection))) return;
    setDisconnecting(connection.connection_id);
    try {
      const result = await api.disconnectTeamConnection(connection.connection_id);
      if (result?.remaining?.access_tokens || result?.remaining?.refresh_tokens) {
        showToast('That connection was not fully disconnected. Try again.', 'error');
      } else {
        showToast(`${connectionToolName(connection)} disconnected`, 'success');
      }
    } catch (err) {
      logger.error('Failed to disconnect a team connection', err);
      showToast(
        isApiError(err) && err.status === 404
          ? 'That connection is already gone.'
          : 'Could not disconnect that app. Try again.',
        'error'
      );
    } finally {
      setDisconnecting(null);
      await load();
    }
  }

  if (!connections && !failed) return null;

  return (
    <SurfacePanel className="p-5 lg:p-6">
      <h2 className="text-base font-semibold text-text-primary">Connected AI tools</h2>
      <p className="mt-1 text-sm text-text-secondary">{TEAM_CONNECTIONS_INTRO}</p>

      {failed && !connections && (
        <p className="mt-4 text-sm text-status-danger-text">Could not load the connected tools.</p>
      )}
      {connections && connections.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{TEAM_CONNECTIONS_EMPTY}</p>
      )}
      {connections && connections.length > 0 && (
        <ul className="mt-4 flex flex-col">
          {connections.map((connection) => (
            <li
              key={connection.connection_id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-subtle py-3 first:border-t-0"
            >
              <span className="min-w-0 flex-1 basis-56">
                <span className="text-sm font-semibold text-text-primary">{connectionToolName(connection)}</span>
                <span className="text-sm text-text-muted">{` · ${connectionPersonName(connection)}`}</span>
                <span className="block break-words text-xs text-text-muted">
                  {`authorized ${new Date(connection.first_authorized_at).toLocaleDateString()}`}
                  {' · last used '}
                  {connection.last_used_at ? new Date(connection.last_used_at).toLocaleDateString() : 'never'}
                </span>
              </span>
              <Button
                size="sm"
                variant="danger"
                disabled={disconnecting === connection.connection_id}
                onClick={() => void disconnect(connection)}
              >
                {disconnecting === connection.connection_id ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SurfacePanel>
  );
}

export default function TeamSettingsPage() {
  const [roster, setRoster] = useState<TeamRoster | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorPlanLink, setErrorPlanLink] = useState<TeamLoadRefusal['planLink']>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<{ link: string; hasAccount: boolean; emailed: boolean; resent: boolean; email: string } | null>(null);
  // The refusal stays on the page instead of only in a toast: at the seat cap
  // it is the one place the control that fixes it belongs.
  const [inviteError, setInviteError] = useState<{ status?: number; email: string; role: string } | null>(null);
  const [addingSeat, setAddingSeat] = useState(false);
  // A seat refused because the bank must confirm the payment, or a payment is
  // overdue: said beside the billing page, which is the way through.
  const [seatRefusal, setSeatRefusal] = useState<BillingPageRefusal | null>(null);
  const [openingBilling, setOpeningBilling] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [team, me, cfg] = await Promise.all([
        api.getTeam(),
        api.getCurrentUser().catch(() => null),
        // Additive: the roster is still usable if this fails.
        api.getWorkspaceConfig().catch(() => null),
      ]);
      setRoster(team);
      setSelfId(me?.id || null);
      setConfig(cfg);
      setError(null);
      setErrorPlanLink(null);
    } catch (err) {
      logger.error('Failed to load team', err);
      // Say which wall this is, and who can take it down. An upgrade prompt and
      // an outage need different things from the reader, and a member of a
      // lapsed team cannot upgrade anything: only an owner can.
      const status = isApiError(err) ? err.status : undefined;
      const bound = status === 403
        ? boundWorkspaceEntry(await api.getWorkspaces().catch(() => null), getActiveWorkspace())
        : null;
      const refusal = teamLoadRefusal({
        status,
        reason: apiErrorReason(err),
        role: bound?.role ?? null,
        personal: bound ? bound.personal : null,
        lockReason: isApiError(err) && typeof err.data?.lock_reason === 'string' ? err.data.lock_reason : null,
        retryCheckout: isApiError(err) ? parseRetryCheckout(err.data?.retry_checkout) : null,
      });
      setError(refusal.message);
      setErrorPlanLink(refusal.planLink);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const canAdminister = roster?.actor_role === 'owner';
  const inactive = Boolean(roster && subscriptionInactive(roster));
  // What a refusal may offer this reader. "Upgrade" is wrong for a workspace
  // that already has the per-seat plan: it needs a seat, not a plan.
  const inviteRefusalContext = {
    canAddSeat: Boolean(roster && canAddSeat(roster)),
    onPerSeatPlan: isPerSeatPlan(roster?.billing?.plan_tier),
  };

  async function sendInvite(invitee: string, inviteRole: string): Promise<boolean> {
    setInviting(true);
    try {
      const result = await api.inviteTeamMember(invitee, inviteRole);
      const emailed = inviteWasEmailed(result);
      const resent = result.resent === true;
      setLastInvite({ link: result.invite_link, hasAccount: result.recipient_has_account, emailed, resent, email: invitee });
      setInviteError(null);
      setEmail('');
      // Say "sent" only when the server says the email left. Otherwise the
      // invitation exists but nobody has been told, and the link below is the
      // only way it reaches them. A resend is named as one, because it replaced
      // the token: the link in the earlier email has just stopped working.
      showToast(
        emailed
          ? `Invitation ${resent ? 're-sent' : 'emailed'} to ${invitee}`
          : `Invitation ${resent ? 'refreshed' : 'created'}. Copy the link below and send it to them.`,
        'success'
      );
      await load();
      return true;
    } catch (err) {
      const status = isApiError(err) ? err.status : undefined;
      setInviteError({ status, email: invitee, role: inviteRole });
      showToast(inviteRefusalMessage(status, inviteRefusalContext), 'error');
      return false;
    } finally {
      setInviting(false);
    }
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    await sendInvite(email.trim(), role);
  }

  /**
   * Buy one more seat.
   *
   * Spending money, so it asks first and the question names the new seat total,
   * the per-seat price and when the card is charged. `thenInvite` is the
   * invitation that was just refused for want of this seat: it is sent straight
   * afterwards, and the confirmation says so before anything is bought.
   */
  async function addSeat(thenInvite?: { email: string; role: string }) {
    if (!roster) return;
    const request = addSeatRequest(roster);
    if (!request) return;

    const question = thenInvite
      ? `${addSeatConfirmation(request, roster)}\n\nThe invitation to ${thenInvite.email} is sent as soon as the seat is added.`
      : addSeatConfirmation(request, roster);
    if (!window.confirm(question)) return;

    setAddingSeat(true);
    setSeatRefusal(null);
    try {
      // ONLY `updated: true` IS A PURCHASE. See seatPurchaseOutcome: the other
      // two answers are "go and finish this somewhere else", and both used to
      // read as a green "This workspace now has N seats." while the URL went
      // unopened and the waiting invitation was re-sent into the same cap.
      const outcome = seatPurchaseOutcome(await api.setSeatCount(request.tierId, request.seats));

      if (outcome.kind === 'bought') {
        // The server's own sentence: it is the one that knows whether the money
        // moved now or rides on the next invoice.
        showToast(outcome.message || `This workspace now has ${outcome.seats ?? request.seats} seats.`, 'success');
        setInviteError(null);
        await load();
        if (thenInvite) await sendInvite(thenInvite.email, thenInvite.role);
        return;
      }

      if (outcome.kind === 'finish_elsewhere') {
        showToast(
          outcome.message || (outcome.portal
            ? 'Finish this in the billing portal. Opening it now.'
            : 'Opening Stripe to add the seat. Nothing has been charged yet.'),
          'info',
        );
        // The same guarded redirect every other billing hand-off uses: a URL
        // from the API is still a URL, and this one leaves the app.
        redirectToTrustedUrl(outcome.url);
        return;
      }

      // Neither an in-place change nor somewhere to finish one. Say so, and do
      // not send the invitation that was waiting on the seat.
      showToast(outcome.message || 'The seat was not added. Nothing was charged.', 'error');
    } catch (err) {
      const refusal = billingPageRefusal(err);
      if (refusal) {
        setSeatRefusal(refusal);
        return;
      }
      // The server refuses a seat count below the people already here, in words
      // that name them. Replacing that with "Could not add a seat" hides the
      // only thing the owner could act on.
      const reason = isApiError(err) ? String(err.data?.message || err.message || '') : '';
      showToast(reason || 'Could not add a seat. Nothing was charged.', 'error');
    } finally {
      setAddingSeat(false);
    }
  }

  async function openBillingPage() {
    setOpeningBilling(true);
    try {
      const { url } = await api.getPortalUrl();
      redirectToTrustedUrl(url);
    } catch {
      showToast('Could not open the billing page. Try again from Settings > Plan.', 'error');
      setOpeningBilling(false);
    }
  }

  async function changeRole(userId: string, next: string) {
    try {
      await api.setTeamMemberRole(userId, next);
      await load();
    } catch (err) {
      showToast(
        isApiError(err) && err.status === 409
          ? 'A workspace needs at least one owner.'
          : 'Could not change that role.',
        'error'
      );
    }
  }

  async function remove(member: TeamMember) {
    const label = member.email || member.id;
    // Name what removal does AND what it deliberately does not do: what stays
    // with the team and what goes with the person (lib/workspaceRemoval).
    const confirmed = window.confirm(removeMemberConfirmText(label));
    if (!confirmed) return;
    try {
      const result = await api.removeTeamMember(member.id);
      showToast(
        `${label} removed — ${result.keys_revoked} key${result.keys_revoked === 1 ? '' : 's'} revoked, contributions kept`,
        'success'
      );
      await load();
    } catch (err) {
      showToast(
        isApiError(err) && err.status === 409
          ? 'A workspace needs at least one owner.'
          : 'Could not remove that person.',
        'error'
      );
    }
  }

  // Leaving is removing yourself: the same removal an owner performs, so the
  // same promise about contributions. The API refuses the last owner (409), and
  // the button is not offered to one, so that refusal is a race, not a path.
  const otherActiveOwners = (roster?.members || [])
    .filter((m) => m.role === 'owner' && m.status !== 'removed' && m.id !== selfId).length;

  async function leave() {
    if (!selfId) return;
    const confirmed = window.confirm(leaveWorkspaceConfirmText());
    if (!confirmed) return;
    try {
      await api.removeTeamMember(selfId);
    } catch (err) {
      showToast(
        isApiError(err) && err.status === 409
          ? 'You are this workspace\'s only owner. Make somebody else an owner before you leave.'
          : 'Could not leave the workspace.',
        'error'
      );
      return;
    }
    // Everything loaded in this tab belongs to the workspace just left.
    if (await switchToPersonalWorkspace()) {
      window.location.assign('/');
      return;
    }
    showToast('You left the workspace, but switching to your own did not complete. Use the workspace switcher.', 'error');
  }

  async function revoke(inviteId: string) {
    try {
      await api.revokeTeamInvite(inviteId);
      await load();
    } catch {
      showToast('Could not revoke that invitation.', 'error');
    }
  }

  return (
    <>
      <Head><title>Team · DeerDawn</title></Head>
      <PageScaffold
        title="Team"
        description="Everyone who shares this workspace. Projects stay private to whoever created them until they are explicitly shared."
      >
        {loading && <SurfacePanel className="p-6 text-sm text-text-secondary">Loading your team…</SurfacePanel>}

        {!loading && error && (
          <SurfacePanel className="p-6">
            <p className="text-sm text-text-secondary">{error}</p>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              {errorPlanLink ? (
                <Link href={errorPlanLink.href || '/settings/plan'} className="text-sm text-primary hover:underline">
                  {errorPlanLink.label}
                </Link>
              ) : null}
              <Button variant={errorPlanLink ? 'secondary' : 'primary'} onClick={() => void load()}>Try again</Button>
            </div>
          </SurfacePanel>
        )}

        {!loading && !error && roster && (
          <>
            {/* A lapsed subscription is a bill to fix, not an error and not an
                upsell: the roster is still here, and so is the way out of it. */}
            {inactive && (
              <SurfacePanel className="p-5 lg:p-6">
                <p className="text-sm text-text-primary">{inactiveTeamNotice(roster).line}</p>
                {/* Only to a person the roster names as an owner (lib/billingAccess). */}
                {inactiveTeamNotice(roster).billingLink ? (
                  <div className="mt-3">
                    <Link href="/settings/plan" className="text-sm text-primary hover:underline">
                      Update billing
                    </Link>
                  </div>
                ) : null}
                {/* The first payment never went through: check out again, not billing. */}
                {inactiveTeamNotice(roster).checkoutAgainHref ? (
                  <div className="mt-3">
                    <Link href={inactiveTeamNotice(roster).checkoutAgainHref!} className="text-sm text-primary hover:underline">
                      {CHECK_OUT_AGAIN_LABEL}
                    </Link>
                  </div>
                ) : null}
              </SurfacePanel>
            )}

            <SeatPanel roster={roster} busy={addingSeat || inviting} onAddSeat={() => void addSeat()} />
            <BillingRefusalNotice refusal={seatRefusal} onOpenBilling={() => void openBillingPage()} opening={openingBilling} />

            {config && <ConnectPanel config={config} />}

            <ProjectVisibilityPanel />

            <DomainPanel canAdminister={Boolean(canAdminister)} />

            {canAdminister && <TeamConnectionsPanel />}

            <SurfacePanel className="p-5 lg:p-6">
              <h2 className="text-base font-semibold text-text-primary">Access log</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Every read, write and export, and every change to who is in this workspace — with the
                person who did it.
              </p>
              <div className="mt-4">
                <Link href="/settings/audit" className="text-sm text-primary hover:underline">
                  Open the access log
                </Link>
              </div>
            </SurfacePanel>

            {canAdminister && !inactive && (
              <SurfacePanel className="p-5 lg:p-6">
                <h2 className="text-base font-semibold text-text-primary">Invite someone</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  They can already have a DeerDawn account — joining a workspace keeps their own projects private and separate.
                </p>
                <form className="mt-4 flex flex-wrap items-center gap-3" onSubmit={invite}>
                  <input
                    type="email"
                    required
                    aria-label="Email address"
                    className="min-w-[240px] flex-1 rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary"
                    placeholder="engineer@yourcompany.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <select
                    aria-label="Role"
                    className="rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary"
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                  >
                    {Object.entries(ROLE_COPY).map(([id, copy]) => (
                      <option key={id} value={id}>{id} — {copy}</option>
                    ))}
                  </select>
                  <Button type="submit" disabled={inviting}>{inviting ? 'Sending…' : 'Send invitation'}</Button>
                </form>

                {inviteError && (
                  <div className="mt-4 rounded-md border border-border-subtle bg-overlay-subtle p-3">
                    <p className="text-sm text-status-danger-text">
                      {inviteRefusalMessage(inviteError.status, inviteRefusalContext)}
                    </p>
                    {/* The refusal and the fix in the same place. Without this
                        the only route from "all seats are taken" was a plan
                        picker offering the plan this workspace already pays
                        for. */}
                    {inviteError.status === 402 && inviteRefusalContext.canAddSeat && (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Button
                          disabled={addingSeat || inviting}
                          onClick={() => void addSeat({ email: inviteError.email, role: inviteError.role })}
                        >
                          {addingSeat ? 'Adding a seat…' : 'Add a seat'}
                        </Button>
                        {/* Name the address the button will invite: the field
                            above may have been retyped since the refusal. */}
                        <span className="text-xs text-text-muted">
                          {`${perSeatPriceLine()}. We confirm first, then the invitation to ${inviteError.email} goes out.`}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {lastInvite && (
                  <div className="mt-4 space-y-2 rounded-md border border-border-subtle bg-overlay-subtle p-3">
                    <p className="text-xs text-text-primary">
                      {lastInvite.emailed
                        ? `We ${lastInvite.resent ? 're-emailed' : 'emailed'} ${lastInvite.email}. You can also share the link directly.`
                        : `The invitation email to ${lastInvite.email} was not sent. Copy this link and send it to them yourself.`}
                    </p>
                    {lastInvite.resent && (
                      <p className="text-xs text-text-secondary">
                        This replaced their earlier invitation, so the link in the first email no longer works.
                      </p>
                    )}
                    <p className="text-xs text-text-secondary">
                      {lastInvite.hasAccount
                        ? 'They already have a DeerDawn account, so this link adds them straight away.'
                        : 'They will create an account first, then land in this workspace.'}
                    </p>
                    <InviteLinkCopy link={lastInvite.link} />
                  </div>
                )}
              </SurfacePanel>
            )}

            <SurfacePanel className="p-5 lg:p-6">
              <h2 className="text-base font-semibold text-text-primary">People</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left">
                  <thead>
                    <tr className="border-b border-border-subtle text-[11px] uppercase tracking-wide text-text-muted">
                      <th className="pb-2 pr-4 font-semibold">Person</th>
                      <th className="pb-2 pr-4 font-semibold">Role</th>
                      <th className="pb-2 pr-4 font-semibold">Can</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {roster.members.map((member) => (
                      <MemberRow
                        key={member.id}
                        member={member}
                        canAdminister={Boolean(canAdminister)}
                        isSelf={member.id === selfId}
                        canLeave={member.id === selfId && (member.role !== 'owner' || otherActiveOwners > 0)}
                        onRole={(id, next) => void changeRole(id, next)}
                        onRemove={(m) => void remove(m)}
                        onLeave={() => void leave()}
                      />
                    ))}
                    {roster.invites.map((inv) => (
                      <InviteRow
                        key={inv.invite_id}
                        invite={inv}
                        canAdminister={Boolean(canAdminister)}
                        onRevoke={(id) => void revoke(id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </SurfacePanel>
          </>
        )}
      </PageScaffold>
    </>
  );
}
