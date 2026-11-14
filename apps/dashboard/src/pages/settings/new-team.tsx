import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { PageScaffold, SurfacePanel } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { showToast } from '@/components/ui/Toast';
import { api, isApiError, setActiveWorkspace, type ProjectSharing, type WorkspaceSummary } from '@/lib/api';
import { logger } from '@/lib/logger';
import { InviteLinkCopy } from '@/components/dashboard/InviteLinkCopy';
import { inviteFailureLabel, inviteWasEmailed, projectListRefusalMessage } from '@/lib/teamInvites';
import { mayOfferBilling } from '@/lib/billingAccess';
import { redirectToTrustedUrl } from '@/lib/redirects';
import { TEAM_MIN_SEATS, TEAM_PLAN_NAME, TEAM_TRIAL_DAYS, teamPricePhrase, type BillingCycle } from '@/lib/planCopy';
import {
  CHECKOUT_CANCELED_MESSAGE,
  WORKSPACE_LATE_MESSAGE,
  WORKSPACE_POLL_MS,
  WORKSPACE_WAIT_MS,
  createdWorkspace,
  readNewTeamArrival,
} from '@/lib/newTeamCheckout';
import { useDeployment } from '@/lib/deployment';

/**
 * Creating a team, in the order the decisions actually happen.
 *
 * A new workspace is created ALONGSIDE the person's own, never by converting it.
 * Converting is simpler and wrong: it would silently move every personal project
 * into something a company owns, which is the exact surprise the privacy model
 * exists to prevent.
 *
 * It is created BY PAYING FOR IT. The first step names the team and opens the Team
 * checkout; nothing exists until Stripe confirms the subscription, so abandoning
 * the checkout leaves no empty workspace behind. Back from Stripe, the wizard
 * waits for the workspace to appear and continues at step two.
 *
 * Step two is the one that matters. Showing what each project carries — "47
 * decisions, 12 landmines" — is the moment an admin sees they are contributing
 * an asset rather than filling in a form, and it is the only screen in the
 * product where the accumulated value is visible as a number.
 */

type Step = 'name' | 'waiting' | 'projects' | 'invite' | 'done';

function StepHeader({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'name', label: 'Name it and start Team' },
    { id: 'projects', label: 'Choose what moves in' },
    { id: 'invite', label: 'Invite people' },
  ];
  const index = steps.findIndex((s) => s.id === (step === 'waiting' ? 'name' : step));
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <span
          key={s.id}
          className={
            i === index
              ? 'rounded-full bg-primary/10 px-3 py-1 font-semibold text-primary'
              : 'rounded-full border border-border-subtle px-3 py-1 text-text-muted'
          }
        >
          {i + 1}. {s.label}
        </span>
      ))}
    </div>
  );
}

export default function NewTeamPage() {
  const [step, setStep] = useState<Step>('name');
  // Self-hosted: no checkout, no prices; the workspace is created on submit.
  const { selfHosted } = useDeployment();
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSharing[]>([]);
  // Why the listing is empty, when it is empty because it was refused rather
  // than because there is nothing there.
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [moved, setMoved] = useState<string[]>([]);
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState(false);
  // Every invitation this wizard created, with whether its email left. The
  // links used to be discarded, so an invite whose email never went out could
  // not reach anybody at all.
  const [invited, setInvited] = useState<{ email: string; link: string; emailed: boolean }[]>([]);
  const [needsTeamPlan, setNeedsTeamPlan] = useState(false);
  // A workspace this person owns that already has Team. A new workspace starts
  // on Free, so creating one here would mean paying for Team a second time;
  // offer the one they already pay for first.
  const [paidTeam, setPaidTeam] = useState<WorkspaceSummary | null>(null);
  const [createAnyway, setCreateAnyway] = useState(false);
  const router = useRouter();
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  // Said once, above the name step, when Stripe sent the person back unpaid.
  const [notice, setNotice] = useState<string | null>(null);

  // Back from Stripe. `?canceled=true`: nothing was created. `?resume=1&workspace=`:
  // the person paid; the workspace appears when the webhook lands, so look for it
  // in their own listing (the key in the URL is not an authority) until it does.
  useEffect(() => {
    if (!router.isReady) return;
    const arrival = readNewTeamArrival(router.query);
    if (arrival.canceled) setNotice(CHECKOUT_CANCELED_MESSAGE);
    if (!arrival.resume || !arrival.workspace) return;
    const key = arrival.workspace;
    setStep('waiting');
    let cancelled = false;
    const started = Date.now();
    const look = async () => {
      if (cancelled) return;
      try {
        const found = createdWorkspace(await api.getWorkspaces(), key);
        if (found) {
          if (cancelled) return;
          setWorkspace(found.workspace);
          setName(found.name);
          setStep('projects');
          return;
        }
      } catch (err) {
        logger.error('Could not look for the new workspace', err);
      }
      if (Date.now() - started >= WORKSPACE_WAIT_MS) {
        if (!cancelled) { setStep('name'); setNotice(WORKSPACE_LATE_MESSAGE); }
        return;
      }
      setTimeout(() => { void look(); }, WORKSPACE_POLL_MS);
    };
    void look();
    return () => { cancelled = true; };
  }, [router.isReady, router.query]);

  useEffect(() => {
    let cancelled = false;
    api.getWorkspaces()
      .then(({ workspaces }) => {
        if (cancelled) return;
        // On a self-host every workspace is team-enabled, so "you already pay
        // for a team" would point at whichever one came first.
        if (selfHosted) return;
        setPaidTeam(workspaces.find((w) => w.role === 'owner' && w.team_enabled) || null);
      })
      .catch(() => { /* no hint is fine: the wizard still works */ });
    return () => { cancelled = true; };
  }, [selfHosted]);

  // Switch INTO the new workspace, in the browser and on the server. The browser
  // half scopes the dashboard (the invite call's header included); the server
  // half is what agent sessions read, since MCP and OAuth clients send no
  // header. Only the browser half used to happen, so the founder's own agents
  // stayed in their personal workspace after creating a team.
  const enterWorkspace = useCallback(async (key: string) => {
    setActiveWorkspace(key);
    try {
      await api.setActiveWorkspaceOnServer(key);
    } catch (err) {
      logger.error('Failed to activate the new workspace on the server', err);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await api.getProjectSharing()).projects || []);
      setProjectsError(null);
    } catch (err) {
      // A REFUSED LIST IS NOT AN EMPTY ONE. This swallowed every failure and
      // fell through to "You have no projects to move yet", which for the 403
      // this step normally gets is a false statement about the reader's own
      // account. See projectListRefusalMessage.
      logger.error('Could not list projects to move', err);
      setProjects([]);
      setProjectsError(projectListRefusalMessage(isApiError(err) ? err.status : undefined));
    }
  }, []);

  useEffect(() => { if (step === 'projects') void loadProjects(); }, [step, loadProjects]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    if (selfHosted) {
      try {
        const created = await api.createSelfHostedWorkspace(name.trim());
        await enterWorkspace(created.workspace.key);
        setWorkspace(created.workspace.key);
        setName(created.workspace.name);
        setStep('projects');
      } catch (err) {
        logger.error('Workspace could not be created', err);
        showToast('Could not create that workspace.', 'error');
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      // Nothing is created here: this opens the Team checkout for a workspace
      // that does not exist yet. The webhook creates it when Stripe confirms.
      const started = await api.startTeamWorkspaceCheckout(name.trim(), cycle, TEAM_MIN_SEATS);
      if (!started.url) throw new Error('No checkout URL');
      redirectToTrustedUrl(started.url);
    } catch (err) {
      logger.error('Team checkout could not be opened', err);
      showToast('Could not open checkout for that workspace. Nothing was created.', 'error');
      setBusy(false);
    }
  }

  async function moveChosen() {
    if (!workspace) return;
    setBusy(true);
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const id of chosen) {
      try {
        await api.moveProjectToWorkspace(id, workspace);
        succeeded.push(id);
      } catch {
        failed.push(projects.find((p) => p.project_id === id)?.project_name || id);
      }
    }
    setMoved(succeeded);
    setBusy(false);
    // Name what did not move rather than reporting a clean step over a partial
    // one — a half-moved set found later is much worse than one said out loud now.
    if (failed.length) showToast(`These did not move: ${failed.join(', ')}`, 'error');
    setStep('invite');
  }

  // Leaving the invite step without inviting anyone still has to switch in.
  async function finish() {
    if (workspace) await enterWorkspace(workspace);
    setStep('done');
  }

  async function invite() {
    if (!workspace) return;
    const list = emails.split(/[,\s]+/).map((e) => e.trim()).filter((e) => e.includes('@'));
    if (!list.length) { await finish(); return; }
    setBusy(true);
    // The workspace header is what scopes an invite, so switch into the new
    // workspace before sending any.
    await enterWorkspace(workspace);
    const failed: string[] = [];
    const created: { email: string; link: string; emailed: boolean }[] = [];
    let planRefused = false;
    // Out of SEATS is not out of PLAN, and the two need opposite things. A
    // workspace with Team and no spare seat is not upgraded anywhere: it buys a
    // seat, which is a control on the Team page.
    let seatRefused = false;
    for (const email of list) {
      try {
        const result = await api.inviteTeamMember(email, 'member');
        created.push({ email, link: result.invite_link, emailed: inviteWasEmailed(result) });
      } catch (err) {
        const status = isApiError(err) ? err.status : undefined;
        if (status === 403) planRefused = true;
        if (status === 402) seatRefused = true;
        failed.push(inviteFailureLabel(email, status));
      }
    }
    setInvited(created);
    setNeedsTeamPlan(planRefused);
    setBusy(false);
    if (failed.length) {
      showToast(
        planRefused
          ? 'Inviting people needs the Team plan. Upgrade this workspace, then invite your team from Team settings.'
          : seatRefused
            ? `Not invited: ${failed.join(', ')}. Add a seat in Team settings, then invite them again.`
            : `Not invited: ${failed.join(', ')}`,
        'error'
      );
    }
    setStep('done');
  }

  return (
    <>
      <Head><title>New team · DeerDawn</title></Head>
      <PageScaffold
        title="Create a team workspace"
        description="A new workspace, alongside your own. Nothing you already have moves into it unless you say so."
      >
        {step !== 'done' && <SurfacePanel className="p-5 lg:p-6"><StepHeader step={step} /></SurfacePanel>}

        {step === 'name' && paidTeam && !createAnyway && (
          <SurfacePanel className="p-5 lg:p-6">
            <h2 className="text-base font-semibold text-text-primary">You already have Team on {paidTeam.name}</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Invite people there. A new workspace has its own Team subscription, paid for when you
              create it.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                onClick={async () => {
                  await enterWorkspace(paidTeam.workspace);
                  window.location.assign('/settings/team');
                }}
              >
                Invite people to {paidTeam.name}
              </Button>
              <Button variant="ghost" onClick={() => setCreateAnyway(true)}>
                Create a separate workspace anyway
              </Button>
            </div>
          </SurfacePanel>
        )}

        {step === 'name' && (!paidTeam || createAnyway) && (
          <SurfacePanel className="p-5 lg:p-6">
            <h2 className="text-base font-semibold text-text-primary">What is this team called?</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Usually your company or the squad that shares a codebase. Your personal workspace stays
              exactly as it is.
            </p>
            {selfHosted ? null : <p className="mt-2 text-sm text-text-secondary">
              A team workspace is created when you start {TEAM_PLAN_NAME} for it: {teamPricePhrase(cycle)}, from {TEAM_MIN_SEATS} seats,
              with a {TEAM_TRIAL_DAYS}-day free trial. Your card is collected at checkout. If you cancel there, nothing is created.
            </p>}
            {notice ? <p role="status" className="mt-3 text-sm text-text-muted">{notice}</p> : null}
            <form className="mt-4 flex flex-wrap items-center gap-3" onSubmit={create}>
              <input
                required
                aria-label="Workspace name"
                className="min-w-[240px] flex-1 rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary"
                placeholder="Acme Engineering"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
              {selfHosted ? null : <select
                aria-label="Billing cycle"
                className="rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary"
                value={cycle}
                onChange={(event) => setCycle(event.target.value === 'monthly' ? 'monthly' : 'annual')}
              >
                <option value="annual">Billed yearly</option>
                <option value="monthly">Billed monthly</option>
              </select>}
              <Button type="submit" disabled={busy}>
                {selfHosted
                  ? (busy ? 'Creating…' : 'Create workspace')
                  : (busy ? 'Opening checkout…' : 'Continue to payment')}
              </Button>
            </form>
          </SurfacePanel>
        )}

        {step === 'waiting' && (
          <SurfacePanel className="p-5 lg:p-6">
            <h2 className="text-base font-semibold text-text-primary">Setting up your workspace</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Your payment went through. The workspace appears as soon as it is confirmed, which
              takes a few seconds.
            </p>
          </SurfacePanel>
        )}

        {step === 'projects' && (
          <SurfacePanel className="p-5 lg:p-6">
            <h2 className="text-base font-semibold text-text-primary">What should move in?</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Everything you leave behind stays personal and stays yours. Anything you move arrives
              private — visible to you and to owners, and shared with the team only when you say so.
            </p>

            {projectsError ? (
              <p className="mt-4 text-sm text-text-muted">{projectsError}</p>
            ) : projects.length === 0 ? (
              <p className="mt-4 text-sm text-text-muted">You have no projects to move yet. That is fine — start fresh.</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {projects.map((project) => (
                  <li key={project.project_id} className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id={`move-${project.project_id}`}
                      checked={chosen.has(project.project_id)}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.target.checked) next.add(project.project_id);
                        else next.delete(project.project_id);
                        setChosen(next);
                      }}
                    />
                    <label htmlFor={`move-${project.project_id}`} className="text-sm text-text-primary">
                      {project.project_name}
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => void moveChosen()} disabled={busy}>
                {busy ? 'Moving…' : chosen.size ? `Move ${chosen.size} and continue` : 'Continue without moving anything'}
              </Button>
            </div>
          </SurfacePanel>
        )}

        {step === 'invite' && (
          <SurfacePanel className="p-5 lg:p-6">
            <h2 className="text-base font-semibold text-text-primary">Who else is on this?</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Email addresses, separated by commas. They can already have a DeerDawn account — joining
              a team keeps their own projects private and separate.
            </p>
            <textarea
              aria-label="Email addresses"
              rows={3}
              className="mt-4 w-full rounded-md border border-border-subtle bg-overlay-subtle px-3 py-2 text-sm text-text-primary"
              placeholder="sarah@acme.com, marcus@acme.com"
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
            />
            <div className="mt-4 flex flex-wrap gap-3">
              <Button onClick={() => void invite()} disabled={busy}>
                {busy ? 'Inviting…' : 'Send invitations'}
              </Button>
              <Button variant="ghost" onClick={() => void finish()} disabled={busy}>Skip for now</Button>
            </div>
          </SurfacePanel>
        )}

        {step === 'done' && (
          <SurfacePanel className="p-5 lg:p-6">
            <h2 className="text-base font-semibold text-text-primary">{name} is ready</h2>
            <p className="mt-2 text-sm text-text-secondary">
              {moved.length
                ? `${moved.length} project${moved.length === 1 ? '' : 's'} moved in. `
                : ''}
              The last step is the one that makes this work for everybody at once: commit the
              connector config to your repo, so your team gets it by cloning rather than by each
              setting it up.
            </p>
            {invited.length > 0 && (
              <div className="mt-5 space-y-3">
                <h3 className="text-sm font-semibold text-text-primary">Invitations</h3>
                {invited.map((entry) => (
                  <InviteLinkCopy
                    key={entry.email}
                    link={entry.link}
                    label={entry.emailed
                      ? `Emailed to ${entry.email}`
                      : `Not emailed to ${entry.email}. Send them this link yourself.`}
                  />
                ))}
              </div>
            )}
            {/* Only to a known owner (lib/billingAccess): the server made this
                person the new workspace's owner when it created it (a 201 from
                POST /teams/workspaces), which is what `workspace` records. */}
            {needsTeamPlan && mayOfferBilling({ ownerConfirmedByServer: Boolean(workspace) }) && (
              <p className="mt-4 text-sm text-text-secondary">
                Some invitations were refused because this workspace is not on the Team plan.{' '}
                <Link href="/settings/plan" className="text-primary hover:underline">Upgrade to Team</Link>
                {' '}and invite them again from Team settings.
              </p>
            )}
            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                onClick={() => {
                  // Already active on both sides by now; a full load re-scopes
                  // everything this tab fetched while it was the old workspace.
                  if (workspace) setActiveWorkspace(workspace);
                  window.location.assign('/settings/team');
                }}
              >
                Open the team settings
              </Button>
            </div>
          </SurfacePanel>
        )}
      </PageScaffold>
    </>
  );
}
