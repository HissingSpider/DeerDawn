const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../../config/db');
const env = require('../../config/env');
const { requireAuth, evaluateWorkspaceFallback } = require('../../middleware/auth');
const { checkFeature, checkLimit } = require('../../services/entitlementService');
const { normalizePlanId } = require('../../config/plans');
const { isSelfHosted, dashboardBaseUrl, apiBaseUrl } = require('../../config/selfHosted');
const contextStore = require('../../store/contextSyncStore');
const encryption = require('../../services/encryptionService');
const workspace = require('../../services/workspaceService');
const authorStamps = require('../../services/authorStampService');
// For defaultShareSectionRows() only: what the defaults GRANT is stated once, in
// the service that enforces them, rather than restated as a literal here where
// it drifted into a downgrade.
const service = require('../../services/contextSyncService');
const { sendEmail } = require('../../services/email/resendClient');
const apiKeyCache = require('../../services/apiKeyCache');
// Who pays may not stop being part of a workspace while its subscription renews
// on their card (journey r6; services/billingOwnerService.js).
const billingOwner = require('../../services/billingOwnerService');
const billingNotices = require('../../services/billingNoticeService');
const { hostedConnections } = require('../oauth');

router.use(requireAuth);

// A READ-ONLY CREDENTIAL CHANGES NOTHING HERE.
//
// This router checked no scopes at all, so an API key minted ['context:read'] —
// the credential somebody hands a tool precisely so it cannot change anything —
// could take its holder off the team (revoking every key they had there), and
// an owner's read-only key could remove members, change roles, invite people,
// publish projects and move them between workspaces. Every non-GET route here
// is a write of membership, sharing or placement, so a key needs context:write
// (or context:admin) for any of them.
//
// The GRANTED scopes, not the ones capped to the bound workspace's role: the
// question is what the person let this credential do. What their ROLE lets them
// do is each route's own check. Session actors (the dashboard) are untouched —
// their scopes come from their session.
//
// LEAVING INCLUDED, AND THAT MEANS A VIEWER CANNOT LEAVE BY KEY. Viewer keys are
// only ever minted read-only (grantableScopes('viewer'), mcp-auth, keys.js), so
// no key a viewer can hold passes this. Deliberate: leaving revokes every key
// the person holds in the workspace, and a read-only credential — the one handed
// to a tool so it can change nothing — must not be able to do that (scan 25).
// A viewer leaves from the dashboard (Settings -> Team), whose session is not a
// key; the refusal below says so rather than only "get a write key", which a
// viewer cannot.
const KEY_WRITE_SCOPES = ['*', 'context:write', 'context:admin'];
function isSelfLeave(req) {
  if (req.method !== 'DELETE') return false;
  const parts = String(req.path || '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'members') return false;
  let target;
  try { target = decodeURIComponent(parts[1]); } catch { return false; }
  const person = workspace.actorPersonId(req.actor);
  return Boolean(person) && target === person;
}
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.actor?.type !== 'key') return next();
  const granted = Array.isArray(req.actor.granted_scopes) ? req.actor.granted_scopes
    : (Array.isArray(req.actor.scopes) ? req.actor.scopes : []);
  if (KEY_WRITE_SCOPES.some((scope) => granted.includes(scope))) return next();
  return res.status(403).json({
    error: 'insufficient_scope',
    message: isSelfLeave(req)
      ? 'This credential is read-only, and leaving revokes your keys in this workspace. Leave from the dashboard (Settings → Team), or use a key with write scope.'
      : 'This credential is read-only. Changing a team needs a key with context:write, or the dashboard.',
  });
});

// Three roles, not six. `admin`, `operator` and `approver` are governance
// residue from the product that moved to another repository, and carrying six
// role names into a five-person team buys nothing but ambiguity about which of
// them can spend money. Legacy values still map forward on read via
// workspaceService.normalizeRole, so an old row keeps working and can never
// grant more than it did.
const VALID_TEAM_ROLES = new Set(workspace.ROLES);
const SHAREABLE_SECTIONS = [
  'description',
  'current_task',
  'current_status',
  'goals',
  'open_questions',
  'recent_decisions',
  'tech_stack',
  'file_structure_summary',
  'blocking_issue',
  'task_progress',
  'recurring_context',
  'source_summary',
  'hot_paths',
  'entrypoints',
  'surfaces',
  'debugging_notes',
  // The task board, governed as one section: `completed_todos` (the Done
  // column) answers to this same key — see mapSectionFromField in
  // contextSyncService. Must stay in step with SHAREABLE_SECTIONS there: this
  // list is the allowlist the sharing UI writes rows against, and a section the
  // service honours but this list rejects cannot be configured at all.
  'todo_items',
];
// Must match contextSyncService's list, where the rule these encode is written
// out in full. In short: an absent share row means today's defaults (so a
// project shared with no configuration shares its board), an explicit row means
// the author's own choice, and a default added later is NEVER backfilled onto a
// configuration somebody saved. This copy is used for ONE thing: the `defaults`
// the sharing UI opens its read/edit state on. The ROWS a save writes for an
// explicit empty sections array come from service.defaultShareSectionRows(),
// because what a default GRANTS is a question the gate answers — restating it
// here as a literal is how it drifted into writing a read-only decision log
// over a share that had been writable.
const DEFAULT_SHARED_SECTIONS = ['current_task', 'current_status', 'recent_decisions', 'todo_items'];

// ── WHO MAY SEE A PROJECT, AND WHO MAY MOVE IT ──────────────────────────────
//
// Three surfaces answered this question and no two of them agreed. The listing
// filtered on visibility; GET /projects/:id/access filtered on nothing at all
// and returned any project's name and visibility to any member; and PATCH
// /projects/:id/sharing checked only that the caller administers the workspace.
// The results were a member who could never share their OWN project — the one
// person with any claim to that decision — and an owner who could flip a
// colleague's PERSONAL project to shared, which is precisely the state CLAUDE.md
// defines as "its author, and nobody else, not even a workspace owner".
//
// Both answers live here, once, and every surface reads them.
//
// Attribution is by PERSON: `identities` is workspaceService.actorIdentities,
// never actor.id, because a key-authed actor's id is the key. A project with NO
// author predates per-user attribution and belongs to the workspace, which is
// what the store's own visibility clause says too.

// A ROW WITH NO VISIBILITY IS A PRIVATE ROW.
//
// context_projects.visibility is `TEXT NOT NULL DEFAULT 'private'` (sql/schema.sql
// and the store's own ADD COLUMN), so null reaches these functions only from a
// projection that left it out or a caller that built the row by hand. Treating
// the absence as its own state is how a project ends up in no branch at all;
// normalising once, here, means neither function has to ask twice.
function projectVisibility(project) {
  return project?.visibility || 'private';
}

/** Is this project visible to the actor at all? Anything else must 404, because
 *  a 403 on an invisible project confirms it exists. */
function mayReadProject(project, { identities, isOwner }) {
  if (!project) return false;
  if (!project.owner_user_id || identities.has(project.owner_user_id)) return true;
  const visibility = projectVisibility(project);
  if (visibility === 'shared') return true;
  if (visibility === 'personal') return false;
  return Boolean(isOwner);
}

/**
 * May the actor change WHERE this project lives (visibility, section policy)?
 *
 * Assumes mayReadProject already passed — an unreadable project is a 404 before
 * this is asked.
 *
 *   author (member or owner)   -> yes, on their own project, always
 *   personal WITH an author,
 *     not that author           -> no, and nobody can, an owner included
 *   viewer                      -> no; a viewer reads, it is the whole role
 *   no author at all            -> workspace owners only, whatever the
 *                                  visibility: it belongs to the workspace
 *   somebody else's SHARED,
 *     owner                     -> yes (shared -> private is an org decision)
 *   somebody else's PRIVATE,
 *     owner                     -> only once the author has left the workspace
 *                                  (`authorLeft`); until then it is the author's
 *                                  call, the same rule as delete, archive and move
 *                                  (contextSyncService holdsProjectPowers)
 *
 * Returns the sentence to show, so the dashboard shows the server's reason
 * instead of "Could not change that."
 */
function projectSharingPermission(project, { identities, role, authorLeft = false }) {
  const isAuthor = Boolean(project.owner_user_id) && identities.has(project.owner_user_id);
  const isOwner = workspace.canAdminister(role);
  if (!workspace.canWrite(role)) {
    return { allowed: false, reason: 'A viewer can read this workspace but cannot change what is shared in it.' };
  }
  // NO AUTHOR MEANS NOBODY TO PROTECT, AND IT IS DECIDED FIRST.
  //
  // `personal` is a guarantee made to a PERSON: this is yours and nobody else's.
  // A row with owner_user_id NULL — a legacy project, one created by an internal
  // actor, anything predating per-user attribution — has no such person, and the
  // first version of this function still applied the personal guard to it. That
  // made an unattributed personal project permanently unmanageable: refused to
  // every member AND to every owner, with no author who could ever come and
  // change it, and it 404'd out of a PATCH that mayReadProject had just let
  // through. An orphan row is workspace property; the workspace's owners manage
  // it. That is the least harmful reading, and the only one with an exit.
  if (!project.owner_user_id) {
    return isOwner
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'This project has no author, so it belongs to the workspace. Only an owner can change it.' };
  }
  // PERSONAL IS THE AUTHOR'S ALONE. Checked before the owner branch on purpose:
  // an owner reaching a colleague's personal project is the bug, not the
  // exception.
  if (projectVisibility(project) === 'personal' && !isAuthor) {
    return { allowed: false, notFound: true, reason: null };
  }
  if (isAuthor) return { allowed: true, reason: null };
  if (isOwner && projectVisibility(project) === 'private' && !authorLeft) {
    return {
      allowed: false,
      reason: 'This is a private project and its author is still in the workspace, so only the author can change who sees it. A workspace owner can once the author has left.',
    };
  }
  return isOwner
    ? { allowed: true, reason: null }
    : { allowed: false, reason: 'Only this project’s author or a workspace owner can change who sees it.' };
}

const { getEntitlements } = require('../../services/entitlementService');

/**
 * Seat limits (and the team feature) for display, read through the SAME helper
 * the invite gate enforces with.
 *
 * This used to read getPlan(plan_tier) — the static plan config, which knows
 * nothing about organizations.purchased_seats. So a team that bought eight seats
 * saw "5 of 5, all seats taken" while invites kept succeeding to eight, and a
 * custom three-seat deal advertised five and then threw at the fourth invite.
 * The display and the gate have to come from one place or they will disagree
 * exactly for the customers who paid to change the number.
 */
async function getSeatEntitlementsForOrg(orgId) {
  const entitlements = await getEntitlements(orgId).catch(() => null);
  return { limits: entitlements?.limits || {}, features: entitlements?.features || {} };
}

/**
 * The billing facts the roster needs to explain ITSELF.
 *
 * A roster with no cap, a roster over its cap and a roster the workspace has
 * stopped paying for look identical from the dashboard's side, and it was
 * guessing: it read any refusal as "buy the Team plan" and offered an upgrade
 * to people who had already bought it. These four fields are what tell a seat
 * shortage apart from a lapsed card, and a live subscription (which a seat
 * change reprices) from none (which needs a real checkout).
 */
async function getWorkspaceBilling(orgId) {
  const res = await db.query(
    'SELECT plan_tier, subscription_status, stripe_subscription_id, purchased_seats FROM organizations WHERE org_id = $1',
    [orgId],
    orgId
  ).catch(() => ({ rows: [] }));
  const row = res.rows[0] || {};
  const purchased = Number(row.purchased_seats);
  return {
    plan_tier: normalizePlanId(row.plan_tier),
    subscription_status: row.subscription_status || null,
    has_subscription: Boolean(row.stripe_subscription_id),
    seats_purchased: Number.isFinite(purchased) && purchased > 0 ? purchased : null,
    // More people in the workspace than seats paid for: `{ members, seats,
    // over_by }`, else null. Nobody is suspended over it; the owner is told
    // (here, on the plan page, and by one email per episode).
    seat_shortfall: await billingNotices.seatShortfallForOrg(orgId).catch(() => null),
  };
}

/** Is there an owner other than this user? Guards the last-owner cases. */
async function hasAnotherOwner(ownerKey, userId) {
  const members = await workspace.listMembers(ownerKey);
  return members.some((m) => m.role === 'owner' && m.user_id !== userId);
}

// Membership and sharing changes are exactly the events a team audit is read
// for, and none of them were logged. Routed through the same table as context
// activity so one view answers "what happened in this workspace".
async function logTeamAudit(actor, ownerKey, action, metadata = {}) {
  await db.query(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
     VALUES ($1, $2, NULL, $3, 'user', $4, 'dashboard', $5)`,
    // The PERSON, not the credential: actor.id is the API key id for key-authed
    // traffic, and GET /projects/:id/access joins this column to users.
    [`audit_${crypto.randomUUID()}`, ownerKey, action, workspace.actorPersonId(actor), metadata],
    'org-system'
  ).catch((err) => console.warn(`[TEAMS] audit write failed (${action}): ${err.message}`));
}

async function ensureTeamAccess(req, res) {
  // THE BOUND WORKSPACE, not the org the caller signed up under.
  //
  // bindWorkspace sets actor.workspace_key after checking membership; it does not
  // (and must not) rewrite actor.org_id. Reading org_id here therefore pointed
  // every route this gates at the caller's PERSONAL workspace: an invited
  // teammate got 'upgrade required' from their own free plan while a member of a
  // paying team, and an owner operating in a team invited people into their own
  // private org instead. Silently, against the wrong tenant.
  const orgId = workspace.defaultOwnerKey(req.actor);
  if (!orgId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }

  return ensureTeamAccessFor(orgId, res);
}

// The entitlement half, addressable by workspace key. Domain join admits somebody
// into a workspace that is NOT their bound one, so it cannot go through
// ensureTeamAccess — and calling neither is how it became a second, ungated door.
async function ensureTeamAccessFor(orgId, res) {
  if (!orgId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  try {
    await checkFeature(orgId, 'team_management');
    return orgId;
  } catch (err) {
    res.status(err.status || 403).json({
      error: err.code || 'upgrade_required',
      message: err.message,
      upgrade_required: true,
    });
    return null;
  }
}

/**
 * SEEING AND SHRINKING A WORKSPACE IS RECOVERY, NOT A TEAM FEATURE.
 *
 * `team_management` is false the moment a subscription goes past_due, unpaid or
 * cancelled — entitlementService drops an inactive org to free entitlements.
 * That is right for INVITING: a workspace nobody is paying for may not grow. It
 * was also refusing the owner the roster and the remove button, so the one
 * person who can fix the bill could not see who she was being billed for, and
 * the only way to shrink the team to what she will pay for was to write to
 * support. The billing gate was exempted for these routes already; this is the
 * second gate sitting behind it.
 *
 * Deliberately narrow. It admits an OWNER of the bound workspace, and only when
 * the workspace actually holds somebody besides her or an invitation she sent:
 * a workspace that never had a team has nothing to recover and keeps today's
 * upgrade refusal. Inviting, role changes and sharing stay gated.
 */
async function ensureRosterRecoveryAccess(req, res) {
  const orgId = workspace.defaultOwnerKey(req.actor);
  if (!orgId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  try {
    await checkFeature(orgId, 'team_management');
    return orgId;
  } catch (err) {
    if (await hasATeamToRecover(req.actor, orgId)) return orgId;
    res.status(err.status || 403).json({
      error: err.code || 'upgrade_required',
      message: err.message,
      upgrade_required: true,
    });
    return null;
  }
}

/** An owner, with somebody in the workspace besides herself or an invitation out. */
async function hasATeamToRecover(actor, orgId) {
  if (!workspace.canAdminister(await workspace.resolveRole(actor, orgId))) return false;
  const [activeMembers, pendingInvites] = await Promise.all([
    workspace.countActiveMembers(orgId),
    workspace.listInvites(orgId),
  ]);
  return activeMembers > 1 || pendingInvites.length > 0;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
  ));
}

function buildTeamInviteEmail({ inviteUrl, orgName, inviterEmail, role }) {
  const workspaceName = escapeHtml(orgName);
  const inviter = inviterEmail ? escapeHtml(inviterEmail) : 'A teammate';
  const safeUrl = escapeHtml(inviteUrl);
  const roleLabel = escapeHtml(role === 'viewer' ? 'a viewer' : role === 'owner' ? 'an owner' : 'a member');
  return {
    subject: `Join ${String(orgName || 'your team').slice(0, 80)} on DeerDawn`,
    html: `<!doctype html><html><body style="margin:0;background:#ffffff;">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#111827;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;">
<p>${inviter} invited you to join <strong>${workspaceName}</strong> on DeerDawn as ${roleLabel}.</p>
<p>DeerDawn keeps your team's AI sessions briefed on the project's current state, decisions and open questions.</p>
<p style="margin:28px 0;"><a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;">Accept the invitation</a></p>
<p style="color:#6b7280;font-size:13px;">This link expires in 7 days and only works for this email address. If you were not expecting it, you can ignore this email.</p>
</div></body></html>`,
  };
}

/**
 * Deliver an invitation. Returns true only when a channel accepted it.
 *
 * This used to post ONLY to TEAM_INVITE_EMAIL_WEBHOOK_URL / RESET_EMAIL_WEBHOOK_URL,
 * neither of which is set in production, while RESEND_API_KEY — the transport
 * every other email uses — was. So no invite was ever delivered, the route
 * returned 201, and the owner was told "Invitation sent". The result is now
 * returned to the caller as `email_sent`, so the dashboard can offer the link
 * instead of promising an email that never left.
 */
async function sendTeamInviteEmail({ email, inviteUrl, orgName, role, inviterEmail }) {
  const message = buildTeamInviteEmail({ inviteUrl, orgName, inviterEmail, role });
  const result = await sendEmail({
    to: email,
    subject: message.subject,
    html: message.html,
    emailType: 'team_invite',
  });
  if (result?.ok) return true;

  // Fallback for self-hosted installs that wired a webhook instead of Resend.
  // RESET_EMAIL_WEBHOOK_URL is the password-reset channel in auth.js, so it is a
  // genuine existing channel rather than a new one.
  const webhookUrl = process.env.TEAM_INVITE_EMAIL_WEBHOOK_URL || process.env.RESET_EMAIL_WEBHOOK_URL;
  if (webhookUrl) {
    const axios = require('axios');
    await axios.post(webhookUrl, {
      kind: 'team_invite',
      to: email,
      invite_url: inviteUrl,
      org_name: orgName,
      role,
    }, { timeout: 5000 });
    return true;
  }

  // LOG-03: an invite URL is a single-use org-membership capability and must NEVER be
  // logged in production. The link is still returned in the API response to the authorized
  // inviter (below), which is the intended out-of-band sharing path when email is unset.
  // SELF-HOSTED, NO EMAIL TRANSPORT: the operator's own log is the channel. The
  // link is a membership capability, which is why hosted production never logs
  // it (LOG-03); on a self-host the log belongs to the same person who would
  // otherwise hand the link over by hand, and without it a self-hoster with no
  // mail provider cannot invite anybody.
  if (isSelfHosted()) {
    console.info(`[TEAM] Invitation for ${email} (${role}) to ${orgName} was not emailed (no email transport configured). Share this link with them: ${inviteUrl}`);
    return false;
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn(`[TEAM] Invite created for ${email} (${role}) but not emailed (${result?.reason || result?.status || result?.error || 'send failed'}).`);
  } else if (process.env.ALLOW_INSECURE_EMAIL_LOGGING === 'true') {
    console.log(`[TEAM] (dev) Invite link for ${email} (${role}) @ ${orgName}: ${inviteUrl}`);
  }
  return false;
}

/**
 * Which workspaces may this person enter? Powers the dashboard's switcher.
 *
 * Deliberately NOT behind ensureTeamAccess: a free personal account has exactly
 * one workspace and must still be able to ask, or the switcher cannot render for
 * the person who has just been invited to their first team.
 */
router.get('/workspaces', async (req, res) => {
  try {
    const memberships = await workspace.listMemberships(workspace.actorPersonId(req.actor));
    // A PERSON'S OWN ORG IS NOT THEIRS WHEN THEY WERE REMOVED FROM IT.
    //
    // users.org_id is a TEAM for anybody created by the legacy invite path, and
    // for a founder who upgraded their own signup org and was then removed from
    // it. Every request into that org is refused (refuseOwnOrgBinding), yet this
    // listing appended it unconditionally and labelled it personal:true,
    // role:'owner' — offering the one workspace they are barred from as their
    // own. Omitted instead; member removal now re-homes such a person into a
    // fresh personal workspace, which is what they see here.
    //
    // THE PERSON'S org, not the credential's: a key's org_id is the workspace
    // it was minted in, so a key minted in a team listed that TEAM as
    // personal:true. See workspace.personalWorkspaceKey.
    const home = await workspace.personalWorkspaceKey(req.actor);
    const ownBarred = home
      ? await workspace.isRemovedFrom(home, req.actor)
      : false;
    const own = ownBarred ? null : home;
    const keys = [...new Set([own, ...memberships.map((m) => m.owner_key)].filter(Boolean))];

    const namesRes = keys.length
      ? await db.query(
        'SELECT org_id, name FROM organizations WHERE org_id = ANY($1)',
        [keys],
        'org-system'
      ).catch(() => ({ rows: [] }))
      : { rows: [] };
    const names = new Map(namesRes.rows.map((r) => [r.org_id, r.name]));
    const roles = new Map(memberships.map((m) => [m.owner_key, m.role]));
    // Whether each workspace already has team features. The new-team wizard
    // reads it so somebody already paying for Team is pointed at that workspace
    // instead of creating a second one, which starts on Free and would need a
    // second subscription.
    const teamEnabled = new Map(await Promise.all(keys.map(async (key) => {
      const entitlements = await getEntitlements(key).catch(() => null);
      return [key, Boolean(entitlements?.features?.team_management)];
    })));

    // WHERE THIS PERSON'S OTHER REQUESTS ARE ACTUALLY LANDING.
    //
    // This route is exempt from plan enforcement, deliberately: it is the exit
    // from a workspace somebody else stopped paying for. But exempt also means
    // never rebound, so while every other request was being served by the
    // personal workspace, this one went on answering `active: <the team>` — and
    // the dashboard rendered the team name over personal data, then wrote into
    // personal with a 201. `active` still means the stored choice; this says
    // what is being done with it.
    const fallback = await evaluateWorkspaceFallback(req).catch((err) => {
      console.error('[TEAMS] fallback evaluation failed:', err.message);
      return null;
    });

    return res.json({
      // Where this request is actually bound. A key with no header lands in
      // the workspace it was minted in (its org_id), which is not `own`.
      active: req.actor.workspace_key
        || (req.actor.type === 'key' ? req.actor.org_id : own)
        || null,
      fallback: fallback
        ? {
          from: fallback.from,
          from_name: names.get(fallback.from) || 'Workspace',
          to: fallback.to,
          reason: fallback.reason,
          ...(fallback.retry_checkout ? { retry_checkout: fallback.retry_checkout } : {}),
        }
        : null,
      workspaces: keys.map((key) => ({
        workspace: key,
        name: names.get(key) || 'Workspace',
        // Only a person's OWN org may be assumed theirs without a membership
        // row (an account the boot backfill has not reached yet). Anything
        // else with no role is not a workspace they hold, and reading "no row"
        // as owner is how a barred org came to be advertised as theirs.
        role: roles.get(key) || (key === own ? 'owner' : 'viewer'),
        personal: key === own,
        team_enabled: teamEnabled.get(key) || false,
      })),
    });
  } catch (err) {
    console.error('[TEAMS] list workspaces failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * The repo-committable connector config for this workspace.
 *
 * WHY THIS EXISTS. Per-person install friction does not add across a team, it
 * multiplies: the funnel is 43 signups to 1 connection, and a team of five where
 * two never connect produces a half-empty brief that reads as a broken product —
 * blamed on whoever championed it, after they have paid. So the team install has
 * to be one commit rather than N copy-paste rituals.
 *
 * IT CONTAINS NO CREDENTIAL, and that is the point rather than a limitation. The
 * file is meant to be committed, and a config carrying an API key would put a
 * live workspace credential into git history where it outlives every rotation.
 * It names the hosted server only; each teammate authenticates as themselves on
 * first use, which is also what keeps per-person attribution meaningful.
 */
router.get('/workspace-config', async (req, res) => {
  try {
    const ownerKey = workspace.defaultOwnerKey(req.actor);
    const orgRes = await db.query('SELECT name FROM organizations WHERE org_id = $1', [ownerKey], 'org-system')
      .catch(() => ({ rows: [] }));
    const name = orgRes.rows[0]?.name || 'your team';
    // Built by the SHARED formatter, not hand-rolled here. Connector copy has
    // drifted between surfaces before; one canonical producer is the fix.
    // Called with no API key on purpose — that argument is what would put a
    // credential in the file, and everything below promises there isn't one.
    const { formatMcpJsonConfig } = require('@deerdawn/shared-context');
    const apiUrl = process.env.DEERDAWN_PUBLIC_API_URL || process.env.DEERDAWN_API_URL || apiBaseUrl() || `${req.protocol}://${req.get('host')}`;
    // NAMING THE WORKSPACE IS WHAT MAKES THIS FILE DO ANYTHING FOR A TEAMMATE
    // WHO ALREADY HAD DEERDAWN. Their existing key is valid and personal, so
    // setup reuses it, the device flow never runs, and nothing in the file said
    // which workspace the repo belongs to: they connected successfully, to their
    // own empty workspace. DEERDAWN_WORKSPACE is an identifier rather than a
    // credential (see the shared formatter), so it may be committed; the header
    // it becomes is membership-checked on every request.
    //
    // NAMED BEFORE THE SECOND PERSON ARRIVES, OR THE FILE IS COMMITTED WITHOUT IT.
    //
    // This asked isSharedWorkspace, which is "more than one ACTIVE member". The
    // natural order is create the team, pay, commit this file, then invite — so
    // at the moment somebody copies it the workspace holds exactly one person
    // and the id was left out. The committed file is then the solo one forever,
    // and the teammate this whole mechanism exists for (somebody who already
    // had DeerDawn, whose saved key is valid and personal) lands in their own
    // empty workspace while the text below tells them to use the team's
    // .mcp.json.
    //
    // Four signals, any one of which means this workspace is a team's. Three
    // are true before anybody has joined. The last is the bound workspace not
    // being the org this person signed up under (the PERSON'S org, which for a
    // key is not the key's org_id — see workspace.personalWorkspaceKey), which
    // is only ever an extra yes.
    //
    // A genuinely personal workspace still gets no id: it would point at the
    // only place it could already go.
    const [shared, entitlements, pendingInvites, home] = await Promise.all([
      workspace.isSharedWorkspace(ownerKey).catch(() => false),
      getSeatEntitlementsForOrg(ownerKey).catch(() => ({ features: {} })),
      workspace.listInvites(ownerKey).catch(() => []),
      workspace.personalWorkspaceKey(req.actor).catch(() => null),
    ]);
    // On a self-host every workspace has team_management, so that signal says
    // nothing about THIS workspace there; the other three still do.
    const isTeam = shared
      || (!isSelfHosted() && entitlements.features?.team_management === true)
      || pendingInvites.length > 0
      || (Boolean(home) && ownerKey !== home);
    const mcpJson = `${formatMcpJsonConfig(apiUrl, '', isTeam ? ownerKey : '')}\n`;

    return res.json({
      workspace: ownerKey,
      workspace_name: name,
      // Nothing here is secret, so say so plainly — an admin who assumes
      // otherwise will not commit it, and the whole mechanism depends on them
      // committing it.
      contains_secrets: false,
      files: [
        {
          path: '.mcp.json',
          description: `Commit this at the repo root. Anyone who clones ${name}'s repo gets the connector; they sign in as themselves the first time their agent uses it.`,
          contents: mcpJson,
        },
      ],
      // WHAT THIS ACTUALLY DOES, INCLUDING FOR THE PEOPLE IT DOES NOT DO IT FOR.
      //
      // "A teammate who is connected sees this workspace" was false for the
      // teammate most likely to read it: somebody who already had DeerDawn
      // installed before accepting the invite. Their saved key is valid and
      // personal, so nothing re-runs the device flow and nothing re-reads this
      // file's environment unless their server is recent enough to send the
      // workspace header. Saying so is cheaper than the support thread where
      // somebody insists the team product is empty.
      verify: isTeam
        ? 'Run any agent in the repo and ask it to load the project brief. A teammate signing in for the first time lands in this workspace. A teammate who was already using DeerDawn should update @deerdawn/mcp-server and restart their agent, or run setup again from this dashboard, so their existing key points here.'
        : 'Run any agent in the repo and ask it to load the project brief. Whoever runs it signs in as themselves the first time.',
    });
  } catch (err) {
    console.error('[TEAMS] workspace config failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Who has actually opened this project.
 *
 * The roster answers "who COULD see this"; this answers "who DID", which is the
 * question a lead asks before putting a client's codebase in. Reads the same
 * audit table as everything else, grouped by person.
 *
 * Deliberately available to any member, not just owners: a shared workspace where
 * only the owner can see who read your work is a surveillance tool pointed one
 * way. Everyone can see the same thing about everyone.
 */
router.get('/projects/:projectId/access', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;

  try {
    const project = await db.query(
      'SELECT project_id, project_name, visibility, owner_user_id FROM context_projects WHERE project_id = $1 AND owner_key = $2',
      [req.params.projectId, orgId],
      'org-system'
    );
    if (!project.rows.length) return res.status(404).json({ error: 'project_not_found' });

    // THE SAME VISIBILITY RULE AS THE LISTING. This route had none: any member
    // could name any project id in the workspace and be told its name and its
    // visibility — including a colleague's `personal` project, the one class of
    // project nobody but its author may read. 404, not 403: the refusal must
    // not confirm the project exists.
    // Not caught: a failed role read would make a project an owner may read
    // answer "not found", which is a lie about existence built out of a database
    // error. It throws, and the handler answers 5xx.
    const identities = new Set(workspace.actorIdentities(req.actor).filter(Boolean));
    const isOwner = workspace.canAdminister(await workspace.resolveRole(req.actor, orgId));
    if (!mayReadProject(project.rows[0], { identities, isOwner })) {
      return res.status(404).json({ error: 'project_not_found' });
    }

    const rows = await db.query(
      `SELECT a.actor_user_id, u.email, COUNT(*)::int AS events,
              MAX(a.created_at) AS last_at,
              ARRAY_AGG(DISTINCT a.action) AS actions
         FROM context_audit_logs a
         LEFT JOIN users u ON u.user_id = a.actor_user_id
        WHERE a.owner_key = $1 AND a.project_id = $2 AND a.actor_user_id IS NOT NULL
        GROUP BY a.actor_user_id, u.email
        ORDER BY MAX(a.created_at) DESC`,
      [orgId, req.params.projectId],
      'org-system'
    ).catch(() => ({ rows: [] }));

    const members = await workspace.listMembers(orgId, { includeRemoved: true });
    const byId = new Map(members.map((m) => [m.user_id, m]));

    return res.json({
      project_id: project.rows[0].project_id,
      project_name: project.rows[0].project_name,
      visibility: project.rows[0].visibility,
      accessed_by: rows.rows.map((row) => ({
        user_id: row.actor_user_id,
        email: row.email || byId.get(row.actor_user_id)?.email || null,
        // A departed member who read this is exactly the case somebody is
        // checking for, so say they have left rather than omitting them.
        still_a_member: byId.get(row.actor_user_id)?.active ?? false,
        events: Number(row.events),
        last_at: row.last_at,
        actions: row.actions || [],
      })),
    });
  } catch (err) {
    console.error('[TEAMS] project access failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * A team workspace is created BY PAYING FOR IT (journey r6, owner's decision).
 *
 * It used to be created here, empty and on Free, at the first step of the
 * new-team wizard, and every abandoned checkout left one behind: a workspace with
 * one member and no way to invite anybody (Free has no team feature). Nothing is
 * created here now. The wizard opens a Team checkout that names the workspace
 * (POST /api/v1/billing/checkout with newWorkspaceName), and the Stripe webhook
 * creates it when Stripe confirms the subscription
 * (workspaceService.createTeamWorkspaceAtCheckout).
 *
 * It stays ALONGSIDE the person's own workspace, never converting it: converting
 * would silently turn every personal project into something that lives in a
 * company workspace, which is exactly the surprise the privacy model exists to
 * prevent. What moves in is the founder's choice, after the workspace exists.
 */
router.post('/workspaces', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name_required' });
  // Self-hosted: no checkout exists to create it, and none is needed — every
  // workspace has the team feature. Create it now, with the caller as owner.
  if (isSelfHosted()) {
    const founderUserId = workspace.actorPersonId(req.actor);
    if (!founderUserId) return res.status(403).json({ error: 'person_required', message: 'Only a signed-in person can found a workspace.' });
    try {
      const created = await workspace.createSelfHostedTeamWorkspace({ name, founderUserId });
      return res.status(201).json({ created: true, workspace: created });
    } catch (err) {
      console.error('[TEAMS] self-hosted workspace creation failed:', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }
  return res.status(402).json({
    error: 'checkout_required',
    created: false,
    message: 'A team workspace is created when its Team subscription is confirmed, so nothing was created. '
      + 'Start it with POST /api/v1/billing/checkout and newWorkspaceName.',
  });
});

/**
 * PUTTING A PROJECT DOWN IS A WRITE, AND SO IS TAKING ONE AWAY.
 *
 * Membership alone let a VIEWER — refused share_write_forbidden when creating a
 * project in the team — move one in, and so create it anyway. Moving writes
 * owner_key on both sides, so both sides need a role that writes: a viewer may
 * neither add a project to a workspace nor take one out of it. Answers the
 * refusal and returns true when the move must not happen.
 */
//
// Except a PERSONAL project on its way out, in its author's hands. Nobody else
// in the source workspace can read it, so the source role protects nothing
// there, and refusing it left a member demoted to viewer unable to take their
// own personal work home. Putting it DOWN still needs write in the target.
// Called before the route's 404, as it always was: a read-only caller is refused
// alike whether or not the id exists.
async function refuseReadOnlyMove(req, res, targetMembership, source, project = null) {
  const refuse = (which) => res.status(403).json({
    error: 'share_write_forbidden',
    message: `You have read-only (viewer) access to ${which} workspace, so nothing was moved.`,
  });
  if (!workspace.canWrite(targetMembership.role)) {
    refuse('that');
    return true;
  }
  const authorsOwnPersonal = project?.visibility === 'personal'
    && Boolean(project.owner_user_id)
    && workspace.actorIdentities(req.actor).includes(project.owner_user_id);
  if (authorsOwnPersonal) return false;
  if (!workspace.canWrite(await workspace.resolveRole(req.actor, source))) {
    refuse('this');
    return true;
  }
  return false;
}

// AUTHORSHIP IS NOT OWNERSHIP OF WHAT OTHERS WROTE INTO IT.
//
// A shared project carries the team's decisions, cards and tasks; a private one
// is org-owned work a workspace owner reads. Authoring either let a member carry
// it into their personal workspace, and with it everything their colleagues had
// written — the owner's project list came back empty. Only a 'personal' project,
// which nobody else could ever read, is the author's alone to take; anything
// else leaves a workspace on an owner's decision. An owner moving work out of
// their own workspace (the new-team wizard) is unaffected. Answers the refusal
// and returns true when the move must not happen.
async function refuseMemberMovingTeamWork(req, res, source, project) {
  if (project.visibility === 'personal') return false;
  if (workspace.canAdminister(await workspace.resolveRole(req.actor, source))) return false;
  res.status(403).json({
    error: 'owner_required_to_move',
    message: 'Only a workspace owner can move a shared or private project out of this workspace.',
  });
  return true;
}

/**
 * Move a project into another workspace the caller also belongs to.
 *
 * Both sides are checked: you must be able to take it (you own it) and to put it
 * down (you are a member of the destination). Moving is a WRITE of owner_key, so
 * everything hanging off the project follows it — a partial move would leave the
 * brief in one workspace and its history in another.
 */
router.post('/projects/:projectId/move', async (req, res) => {
  const target = typeof req.body?.workspace === 'string' ? req.body.workspace : '';
  if (!target) return res.status(400).json({ error: 'workspace_required' });

  try {
    const source = workspace.defaultOwnerKey(req.actor);
    // The PERSON, not the credential. actor.id is the API key id for key-authed
    // traffic, and workspace_members stores people — comparing the two refuses a
    // genuine member their own move.
    const personId = workspace.actorPersonId(req.actor);
    const membership = await workspace.getMembership(target, personId);
    if (!membership) return res.status(403).json({ error: 'not_a_member_of_target' });

    const found = await db.query(
      // `context` IS IN THIS LIST BECAUSE THE RE-SEAL BELOW READS IT.
      //
      // It was not, and the re-seal is guarded on `project.context`, so the guard
      // was never true and the whole block never ran — despite the comment under
      // it describing exactly the loss that then happened. The move reported
      // success and left ciphertext sealed under the SOURCE workspace's key with
      // owner_key pointing at the target, so every later read failed its auth tag.
      'SELECT project_id, project_name, owner_user_id, visibility, context FROM context_projects WHERE project_id = $1 AND owner_key = $2',
      [req.params.projectId, source],
      'org-system'
    );
    const project = found.rows[0];
    if (await refuseReadOnlyMove(req, res, membership, source, project)) return undefined;
    if (!project) return res.status(404).json({ error: 'project_not_found' });

    // Only its owner may move a project. An unattributed project belongs to the
    // workspace, so a workspace owner may move that one.
    // actorIdentities, not actorPersonId: a project stamped before the identity
    // fix carries a key id, and its real owner must still be able to move it.
    const isOwner = project.owner_user_id
      ? workspace.actorIdentities(req.actor).includes(project.owner_user_id)
      : workspace.canAdminister(await workspace.resolveRole(req.actor, source));
    if (!isOwner) return res.status(403).json({ error: 'not_your_project' });

    if (await refuseMemberMovingTeamWork(req, res, source, project)) return undefined;

    // Arrives PRIVATE, never shared. Moving a project into a team is a decision
    // about where it lives; publishing it to everyone is a second decision, and
    // collapsing the two would make the move itself feel unsafe.
    // RE-SEAL THE CONTEXT BEFORE THE OWNER_KEY MOVES.
    //
    // The data key is per WORKSPACE (user_encryption_keys is keyed by owner_key),
    // so ciphertext written under the source workspace cannot be opened under the
    // target's. Moving the row without re-encrypting leaves a blob that fails its
    // AES-GCM auth tag on the next read, and rowToProject fails closed — replacing
    // the brief with {_decrypt_error: true}, permanently, on the flagship
    // onboarding step. The move reports success; the loss surfaces later.
    //
    // Decrypt with the source key and re-encrypt with the target's. Done BEFORE
    // the owner_key update so a failure here aborts the move with the project
    // still readable where it started.
    let resealed = null;
    if (project.context && project.context._enc) {
      try {
        const plaintext = await encryption.decryptContextObject(source, project.context);
        resealed = await encryption.encryptContextObject(target, plaintext);
      } catch (err) {
        console.error(`[TEAMS] move: could not re-seal ${req.params.projectId}: ${err.message}`);
        return res.status(500).json({
          error: 'reseal_failed',
          message: 'The project was not moved: its context could not be re-encrypted for the destination workspace.',
        });
      }
    }

    const moved = await db.query(
      `UPDATE context_projects
          SET owner_key = $2,
              visibility = 'private',
              owner_user_id = COALESCE(owner_user_id, $3),
              context = COALESCE($4::jsonb, context),
              updated_at = NOW()
        WHERE project_id = $1 AND owner_key = $5`,
      [req.params.projectId, target, personId, resealed ? JSON.stringify(resealed) : null, source],
      'org-system'
    );
    // Guarded on owner_key so a concurrent move cannot be re-pointed by this one:
    // the SELECT above proved ownership at read time, not at write time.
    if (!moved.rowCount) {
      return res.status(409).json({ error: 'move_conflict', message: 'The project moved under us. Nothing was changed.' });
    }
    // Everything keyed by (owner_key, project_id) has to follow, or the brief
    // ends up in one workspace and its history in another.
    const failed = [];
    for (const table of [
      'context_sessions',
      'context_session_loads',
    ]) {
      await db.query(
        `UPDATE ${table} SET owner_key = $2 WHERE owner_key = $1 AND project_id = $3`,
        [source, target, req.params.projectId],
        'org-system'
      ).catch((err) => {
        console.error(`[TEAMS] move: ${table} did not follow: ${err.message}`);
        failed.push(table);
      });
    }

    // THE GRAPH FOLLOWS BY SIGHTING, NOT BY FIRST SIGHTING.
    //
    // It used to be on the list above, moved `WHERE project_id = $3`. A graph
    // node is one row per entity per workspace, stamped with the FIRST project
    // that saw it; everywhere else it is seen is an evidence row. So moving a
    // project took every entity it happened to see first — including ones the
    // rest of the workspace had since built on — out of the workspace, with the
    // workspace's summary on it, and left that workspace's evidence and edges
    // pointing at a node that was no longer there. carryProjectGraph moves what
    // only this project uses and copies what it shares (see workspaceService).
    //
    // One transaction, so a failure leaves the graph whole where it was and is
    // reported as a partial move, never half-carried. Project-scoped skills go
    // with the project for the reasons carryProjectSkills gives.
    try {
      const graphClient = await db.pool.connect();
      try {
        await graphClient.query('BEGIN');
        const exec = (text, params) => graphClient.query(text, params);
        await workspace.carryProjectGraph(exec, source, target, [req.params.projectId]);
        await workspace.carryProjectSkills(exec, source, target, [req.params.projectId]);
        await graphClient.query('COMMIT');
      } catch (err) {
        await graphClient.query('ROLLBACK').catch(() => { /* connection already broken */ });
        throw err;
      } finally {
        graphClient.release();
      }
    } catch (err) {
      console.error(`[TEAMS] move: the graph did not follow: ${err.message}`);
      failed.push('context_graph');
    }

    // Public share links are REVOKED rather than carried across. A link minted
    // while this was a personal project must not keep serving once the project
    // belongs to a company workspace — the person who created it consented to
    // sharing something else.
    const revokedLinks = await db.query(
      'DELETE FROM context_share_tokens WHERE owner_key = $1 AND project_id = $2',
      [source, req.params.projectId],
      'org-system'
    ).catch(() => ({ rowCount: 0 }));

    // The audit trail deliberately does NOT move. Those events happened in the
    // other workspace, and a log that relocates is not much of a log; the move
    // itself is recorded in both.
    // `visibility` is what the project was IN THIS WORKSPACE when it left, so
    // the audit view can hide the departure of a project that only its author
    // could ever see (a 'personal' one) from everybody but that author — the
    // same key project_deleted carries. project_name travels too: the project
    // no longer exists here to be looked up.
    await logTeamAudit(req.actor, source, 'project_moved_out', {
      project_id: req.params.projectId,
      project_name: project.project_name,
      visibility: project.visibility || null,
      to: target,
    });

    if (failed.length) {
      // Say what did not follow rather than reporting a clean move over a partial
      // one. A half-moved project is recoverable; a silently half-moved one is
      // found weeks later by somebody wondering where their history went.
      return res.status(500).json({
        error: 'partial_move',
        message: `The project moved but some history did not follow: ${failed.join(', ')}.`,
        project_id: req.params.projectId,
        workspace: target,
      });
    }

    await logTeamAudit(req.actor, target, 'project_moved', {
      project_id: req.params.projectId,
      from: source,
      name: project.project_name,
    });
    return res.json({
      success: true,
      project_id: req.params.projectId,
      workspace: target,
      visibility: 'private',
      share_links_revoked: revokedLinks.rowCount || 0,
    });
  } catch (err) {
    console.error('[TEAMS] project move failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});


router.get('/domains', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  try {
    return res.json({ domains: await workspace.listDomains(orgId) });
  } catch (err) {
    console.error('[TEAMS] list domains failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/domains', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  if (!workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))) {
    return res.status(403).json({ error: 'forbidden: owners only' });
  }
  try {
    const added = await workspace.addDomain(orgId, req.body?.domain, {
      role: typeof req.body?.role === 'string' ? req.body.role : 'member',
      addedBy: workspace.actorPersonId(req.actor),
    });
    await logTeamAudit(req.actor, orgId, 'domain_approved', added);
    return res.status(201).json(added);
  } catch (err) {
    // A public provider is refused with the reason, not a generic 400 — the
    // person adding it needs to know WHY, or they will assume a typo and retry.
    if (err.code === 'public_domain' || err.code === 'invalid_domain') {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    console.error('[TEAMS] add domain failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/domains/:domain', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  if (!workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))) {
    return res.status(403).json({ error: 'forbidden: owners only' });
  }
  try {
    const removed = await workspace.removeDomain(orgId, req.params.domain);
    if (!removed) return res.status(404).json({ error: 'domain_not_found' });
    await logTeamAudit(req.actor, orgId, 'domain_revoked', { domain: req.params.domain });
    return res.json({ success: true });
  } catch (err) {
    console.error('[TEAMS] remove domain failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Workspaces this person could join on their email domain — OFFERED, not joined.
 *
 * Joining makes your work visible to other people, and that is a decision a
 * person takes rather than one their email address takes for them.
 */
// Which workspace this person's sessions act in, including the ones they cannot
// send a header from. Reading it is how a client shows the current context;
// writing it is the switcher.
router.get('/active', async (req, res) => {
  try {
    const active = await workspace.getActiveWorkspace(req.actor);
    // The PERSON'S own workspace: a key's org_id is the workspace it was minted
    // in, and answered here it named a team as the person's personal one.
    const personal = await workspace.personalWorkspaceKey(req.actor);
    return res.json({ active_workspace: active, personal_workspace: personal || null });
  } catch (err) {
    console.error('[TEAMS] active workspace read failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/active', async (req, res) => {
  const requested = typeof req.body?.workspace === 'string' ? req.body.workspace : null;
  try {
    const active = await workspace.setActiveWorkspace(req.actor, requested);
    const personal = active ? null : await workspace.personalWorkspaceKey(req.actor);
    await logTeamAudit(req.actor, active || personal || req.actor.org_id, 'active_workspace_changed', {
      workspace: active || 'personal',
    });
    return res.json({ success: true, active_workspace: active });
  } catch (err) {
    if (err instanceof workspace.WorkspaceAccessError) {
      return res.status(403).json({ error: 'workspace_forbidden', message: err.message });
    }
    console.error('[TEAMS] active workspace write failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/joinable', async (req, res) => {
  try {
    const personId = workspace.actorPersonId(req.actor);
    const already = new Set((await workspace.listMemberships(personId)).map((m) => m.owner_key));
    // A workspace that REMOVED this person is not offered back to them. The
    // domain approves a company's employees in general; an owner removing one
    // is a decision about this person in particular, and only the owner
    // reverses it — by inviting them again.
    // Somebody who LEFT is offered it again, as the accept admits them.
    const removedFrom = new Set(await workspace.listRemovedMemberships(personId, { byOwnerOnly: true }));
    const home = await workspace.personalWorkspaceKey(req.actor);
    const candidates = (await workspace.joinableWorkspaces(req.actor.email))
      .filter((o) => !already.has(o.workspace)
        && !removedFrom.has(o.workspace)
        && o.workspace !== home);
    // AN OFFER THE ACCEPT WILL REFUSE IS NOT AN OFFER. Accepting checks the
    // workspace's plan (ensureTeamAccessFor), so a team whose subscription
    // lapsed — entitlements drop to free, team_management with them — was
    // listed here and then answered 403 upgrade_required to the one button the
    // listing put in front of the person. Same check, asked first. A seat
    // shortage is NOT filtered: that is momentary, and the accept names it.
    const accepting = await Promise.all(candidates.map((o) => checkFeature(o.workspace, 'team_management')
      .then(() => true)
      .catch(() => false)));
    const offers = candidates.filter((o, i) => accepting[i]);
    return res.json({ joinable: offers });
  } catch (err) {
    console.error('[TEAMS] joinable lookup failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/joinable/:workspaceKey/accept', async (req, res) => {
  try {
    const offers = await workspace.joinableWorkspaces(req.actor.email);
    const offer = offers.find((o) => o.workspace === req.params.workspaceKey);
    // Re-checked at accept time rather than trusted from the listing: the domain
    // may have been revoked between the two calls, and an offer is not a grant.
    if (!offer) return res.status(403).json({ error: 'not_joinable' });

    // REMOVAL IS NOT UNDONE BY THE DOMAIN DOOR.
    //
    // addMember's upsert clears removed_at, so without this an employee an
    // owner had just removed walked straight back in through their own email
    // domain — and their revoked keys were the only thing that had changed.
    // An explicit invitation still readmits them: that is the owner deciding.
    //
    // Only a removal an OWNER made. Somebody who left on their own is still an
    // employee the domain approves, and refusing them with "you were removed"
    // was untrue as well as a dead end.
    if (await workspace.isRemovedFrom(offer.workspace, req.actor, { byOwnerOnly: true })) {
      return res.status(403).json({
        error: 'removed_from_workspace',
        message: 'You were removed from this workspace. Ask one of its owners to invite you again.',
      });
    }

    const personId = workspace.actorPersonId(req.actor);
    // Already in: answer idempotently and write nothing. addMember's upsert
    // sets role = the domain's role, so re-accepting would silently demote an
    // owner (possibly the last one) to the domain default.
    const existing = await workspace.getMembership(offer.workspace, personId);
    if (existing) {
      return res.json({ success: true, workspace: offer.workspace, role: existing.role, activated: false });
    }

    // THE SEAT GATE HAS TO COVER EVERY DOOR, NOT THE ONE IT WAS WRITTEN BESIDE.
    //
    // /invite enforces both the plan feature and the seat cap; this route called
    // addMember directly, so a workspace that correctly 402s on invite number six
    // would still admit employees six through forty through the domain door,
    // uncapped and unbilled — and would admit them into a workspace whose plan has
    // team_management switched off entirely.
    //
    // And the seat count is taken INSIDE addMember's per-workspace lock
    // (seatCheck), not here: counted out here, concurrent joiners each saw the
    // same free seat and all got in. A full workspace throws 402 from there.
    //
    // `email` makes the door a redemption when this person also holds an open
    // invitation here: addMember admits them on the invitation's reserved seat
    // and role and spends it in the same transaction, so they are never a
    // member and a pending invitation at once (two seats), and the invitation
    // is not left open to walk back in on after a removal.
    const entitled = await ensureTeamAccessFor(offer.workspace, res);
    if (!entitled) return;

    const membership = await workspace.addMember(offer.workspace, personId, {
      role: offer.role,
      seatCheck: { email: req.actor.email },
    });
    // THE SAME LANDING AS AN INVITATION. acceptInvite points a new teammate's
    // header-less sessions (every MCP and OAuth client) at the workspace they
    // just joined; this door did not, so a domain joiner's agents went on
    // reading their own empty personal workspace and the team never appeared
    // on the surface it is sold on. Best-effort, as it is there.
    const activated = await workspace.activateJoinedWorkspace(offer.workspace, personId);
    await logTeamAudit(req.actor, offer.workspace, 'joined_via_domain', {
      user_id: personId,
      domain: String(req.actor.email || '').split('@').pop(),
    });
    return res.json({
      success: true,
      workspace: offer.workspace,
      role: membership?.role || offer.role,
      activated: activated === true,
    });
  } catch (err) {
    // A full workspace is a billing answer, not a server fault — same shape the
    // invite route returns, so the dashboard can offer the same upgrade.
    if (err.status === 402) {
      return res.status(402).json({ error: err.code, message: err.message, upgrade_required: true });
    }
    // Its last member is closing their account (workspaceService
    // markWorkspaceClosing): refused, not a server fault.
    if (err.code === 'workspace_closing') {
      return res.status(409).json({ error: err.code, message: err.message });
    }
    console.error('[TEAMS] domain join failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/members', async (req, res) => {
  const orgId = await ensureRosterRecoveryAccess(req, res);
  if (!orgId) return;

  try {
    // Read membership from workspace_members, not from `users`. The two disagree
    // the moment somebody belongs to a workspace that is not the org their user
    // row was created in, which is the entire point of the change.
    const [members, invites, entitlements, billing] = await Promise.all([
      workspace.listMembers(orgId, { includeRemoved: true }),
      workspace.listInvites(orgId),
      getSeatEntitlementsForOrg(orgId),
      getWorkspaceBilling(orgId),
    ]);
    const { limits, features } = entitlements;

    const active = members.filter((m) => m.active);
    res.json({
      actor_role: await workspace.resolveRole(req.actor, orgId),
      members: members.map((m) => ({
        id: m.user_id,
        email: m.email,
        role: m.role,
        // A departed member is listed, not deleted. Their contributions stay in
        // the workspace brief and stay attributed, so the roster has to be able
        // to explain who "Sarah" was when her name appears on a decision.
        status: m.active ? 'active' : 'removed',
        removed_at: m.removed_at,
        accepted_at: m.joined_at,
        created_at: m.joined_at,
      })),
      invites,
      seats: {
        used: active.length,
        pending: invites.length,
        included: limits.included_seats ?? null,
        // What the subscription is actually billed for. `included` is the
        // entitlement, which drops to the free tier's one seat the moment the
        // card fails — so on a lapsed team it describes the plan she has
        // stopped paying for, not the team she still has.
        purchased: billing.seats_purchased,
      },
      // False on a workspace whose subscription lapsed. The roster is served to
      // its owner anyway (see ensureRosterRecoveryAccess) and this is how the
      // dashboard tells that apart from a workspace that never had a team —
      // without it, the only honest thing it could render was an upgrade offer
      // to somebody who had already bought the plan.
      team_management: features.team_management === true,
      billing,
    });
  } catch (err) {
    console.error('[TEAMS] list members failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/invite', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  if (!workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))) {
    return res.status(403).json({ error: 'forbidden: owners only' });
  }

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const role = typeof req.body?.role === 'string' ? req.body.role : 'member';

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!VALID_TEAM_ROLES.has(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }

  try {
    // THE SEAT GATE LIVES HERE AND NOWHERE ELSE.
    //
    // Over the cap, this button refuses and says why. No read is ever gated:
    // every existing member keeps getting briefs, because a paywall that throws
    // inside somebody's agent loop produces a broken loop and a bug report, not
    // an upgrade. Pending invites count — otherwise the cap is trivially evaded
    // by sending them all at once.
    const [activeMembers, pendingInvites] = await Promise.all([
      workspace.countActiveMembers(orgId),
      workspace.listInvites(orgId),
    ]);
    const alreadyMember = (await workspace.listMembers(orgId))
      .some((m) => (m.email || '').toLowerCase() === email);
    if (alreadyMember) {
      return res.status(409).json({ error: 'already_a_member' });
    }

    // A RESEND IS NOT A NEW SEAT.
    //
    // The invite link is shown exactly once, so re-sending to the same address
    // is the ordinary way to get it to somebody who lost it. Counting pending
    // invitations is right — otherwise the cap is evaded by sending them all at
    // once — but the invitation being REFRESHED was counted against itself, so a
    // full workspace answered "Upgrade to add another person" about a person
    // whose seat was already spent. The owner's only way through was to revoke
    // and re-invite: the same seat, two round trips, and a dead link already
    // sitting in somebody's inbox.
    const existingInvite = pendingInvites.find((inv) => (inv.email || '').toLowerCase() === email);
    await checkLimit(orgId, 'included_seats', activeMembers + pendingInvites.length - (existingInvite ? 1 : 0));

    const orgRes = await db.query('SELECT name FROM organizations WHERE org_id = $1', [orgId], orgId);
    const orgName = orgRes.rows[0]?.name || 'DeerDawn team';

    const invite = await workspace.createInvite(orgId, email, {
      role,
      invitedBy: workspace.actorPersonId(req.actor),
    });
    const inviteLink = `${dashboardBaseUrl(process.env, env.DASHBOARD_URL)}/invite?token=${invite.token}`;

    // An invitation no longer INSERTs a shell `users` row into the target org.
    // It could not: users.email is globally UNIQUE, so inviting anyone who had
    // already signed up raised 23505 and came back as `user_exists` — the four
    // engineers who had each tried DeerDawn were exactly the four who could not
    // be invited to a workspace. Membership is its own record now, and an
    // existing account simply joins.
    const existing = await db.query(
      'SELECT user_id FROM users WHERE LOWER(email) = $1',
      [email],
      'org-system'
    ).catch(() => ({ rows: [] }));

    let inviterEmail = req.actor.email || null;
    if (!inviterEmail) {
      const inviter = await db.query(
        'SELECT email FROM users WHERE user_id = $1',
        [workspace.actorPersonId(req.actor)],
        'org-system'
      ).catch(() => ({ rows: [] }));
      inviterEmail = inviter.rows[0]?.email || null;
    }
    const emailSent = await sendTeamInviteEmail({ email, inviteUrl: inviteLink, orgName, role, inviterEmail })
      .catch((err) => {
        console.error('[TEAMS] invite email failed:', err.message);
        return false;
      });

    await logTeamAudit(req.actor, orgId, 'member_invited', { email, role, resent: Boolean(existingInvite) });

    res.status(201).json({
      success: true,
      invite_link: inviteLink,
      invite_expires_at: invite.expires_at,
      // True when this refreshed an invitation that was already outstanding —
      // createInvite replaces its token and expiry, so the link in the old email
      // is now dead and this one is the only one that works. The dashboard says
      // "re-sent" rather than "invited" on the strength of it.
      resent: Boolean(existingInvite),
      // False means nobody was emailed: the inviter must share invite_link.
      email_sent: emailSent === true,
      // Tells the dashboard whether to promise a one-click join or a sign-up.
      recipient_has_account: existing.rows.length > 0,
      member: { id: invite.invite_id, email, role, status: 'pending' },
    });
  } catch (err) {
    if (err.status === 402) {
      return res.status(402).json({ error: err.code, message: err.message, upgrade_required: true });
    }
    console.error('[TEAMS] invite failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Redeem an invitation as the signed-in user. This is the path that makes an
 * existing DeerDawn account joinable; brand-new people still arrive through the
 * signup flow and land here immediately afterwards.
 */
router.post('/invite/accept', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) return res.status(400).json({ error: 'missing_token' });

  try {
    // Resolve the person AND their email. A key-authed actor carries neither, so
    // without the lookup the wrong-account guard has nothing to compare against
    // and (now that it fails closed) would refuse a legitimate redemption.
    const personId = workspace.actorPersonId(req.actor);
    let email = req.actor.email;
    if (personId && !email) {
      const found = await db.query('SELECT email FROM users WHERE user_id = $1', [personId], 'org-system')
        .catch(() => ({ rows: [] }));
      email = found.rows[0]?.email || null;
    }
    const result = await workspace.acceptInvite(token, { id: personId, email });
    if (!result.ok) {
      // Name the actual failure. "Expired", "already used" and "addressed to
      // somebody else" look identical from outside and need different fixes,
      // and a single generic message sends people to support for all three.
      // A workspace that has stopped paying, or has no seat left, is a billing
      // answer about the WORKSPACE and not a verdict on the person holding the
      // link — 409, and the invitation stays pending, so paying again makes the
      // same link work.
      const status = result.reason === 'wrong_account'
        ? 403
        : (['workspace_not_accepting_members', 'workspace_closing'].includes(result.reason) ? 409 : 400);
      return res.status(status).json({
        error: result.reason,
        message: result.message || undefined,
        invited_email: result.invited_email || undefined,
      });
    }

    await logTeamAudit(req.actor, result.owner_key, 'invite_accepted', { role: result.membership?.role });
    const nameRes = await db.query(
      'SELECT name FROM organizations WHERE org_id = $1',
      [result.owner_key],
      'org-system'
    ).catch(() => ({ rows: [] }));
    return res.json({
      success: true,
      workspace: result.owner_key,
      workspace_name: nameRes.rows[0]?.name || null,
      role: result.membership?.role || 'member',
      // True when the server now resolves this person's header-less requests
      // (every MCP and OAuth session) to the joined workspace.
      activated: result.activated === true,
    });
  } catch (err) {
    console.error('[TEAMS] invite accept failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/invites/:inviteId', async (req, res) => {
  // Recovery: taking back an invitation is shrinking the team, the same as
  // removing somebody who accepted one.
  const orgId = await ensureRosterRecoveryAccess(req, res);
  if (!orgId) return;
  if (!workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))) {
    return res.status(403).json({ error: 'forbidden: owners only' });
  }
  try {
    const revoked = await workspace.revokeInvite(orgId, req.params.inviteId);
    if (!revoked) return res.status(404).json({ error: 'invite_not_found' });
    await logTeamAudit(req.actor, orgId, 'invite_revoked', { invite_id: req.params.inviteId });
    return res.json({ success: true });
  } catch (err) {
    console.error('[TEAMS] revoke invite failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/members/:userId', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  if (!workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))) {
    return res.status(403).json({ error: 'forbidden: owners only' });
  }
  const role = typeof req.body?.role === 'string' ? req.body.role : '';
  if (!VALID_TEAM_ROLES.has(role)) return res.status(400).json({ error: 'invalid_role' });

  try {
    if (role !== 'owner' && !(await hasAnotherOwner(orgId, req.params.userId))) {
      // Demoting the last owner leaves a workspace nobody can administer, bill,
      // or delete. Refuse rather than produce it.
      return res.status(409).json({ error: 'last_owner' });
    }
    // THE PAYER MAY NOT STEP DOWN while a subscription renews on their card, until
    // another owner has taken billing over. Only their own step-down: another
    // owner demoting them is not gated (the payer still has both ways out).
    if (role !== 'owner' && req.params.userId === workspace.actorPersonId(req.actor)) {
      const block = await billingOwner.checkPayerCanLeave(orgId, req.params.userId, { isOwner: true });
      if (block.blocked) return billingOwner.sendRefusal(res, 'step_down', block);
    }
    // setMemberRole re-counts the owners under the membership lock: the check
    // above is read before it, so two owners demoting each other at once both
    // pass it. The service is what actually refuses the second.
    const changed = await workspace.setMemberRole(orgId, req.params.userId, role);
    if (!changed) return res.status(404).json({ error: 'member_not_found' });
    await logTeamAudit(req.actor, orgId, 'role_changed', { user_id: req.params.userId, role });
    return res.json({ success: true, user_id: req.params.userId, role });
  } catch (err) {
    if (err?.code === 'last_owner') return res.status(409).json({ error: 'last_owner' });
    if (err instanceof billingOwner.BillingOwnerUnconfirmed) return billingOwner.sendUnconfirmed(res);
    console.error('[TEAMS] role change failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/members/:userId', async (req, res) => {
  // LEAVING IS REMOVING YOURSELF. The copy has always told people to "leave the
  // workspace" (the 409 on DELETE /context/account says so), and there was no
  // way to: this route was owners-only, so a member or viewer could only ask an
  // owner to remove them. Removing yourself is the same removal — soft-remove,
  // revoke your keys HERE, carry your personal projects out — and nothing in
  // any other workspace is touched.
  //
  // It needs neither the owner role nor the paid feature: nobody should have to
  // be billed, or promoted, to be allowed to go. An owner may leave only while
  // another active owner remains, checked under the membership lock
  // (requireAnotherOwner: 'if_owner') — the same guard as a role change, so two
  // co-owners leaving at once cannot both succeed.
  const personId = workspace.actorPersonId(req.actor);
  const leaving = Boolean(personId) && req.params.userId === personId;
  let orgId;
  if (leaving) {
    orgId = workspace.defaultOwnerKey(req.actor);
    if (!orgId) return res.status(403).json({ error: 'forbidden' });
    if (!(await workspace.resolveRole(req.actor, orgId))) {
      return res.status(404).json({ error: 'member_not_found' });
    }
  } else {
    orgId = await ensureRosterRecoveryAccess(req, res);
    if (!orgId) return;
    if (!workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))) {
      return res.status(403).json({ error: 'forbidden: owners only' });
    }
  }

  try {
    if (!leaving && !(await hasAnotherOwner(orgId, req.params.userId))) {
      return res.status(409).json({ error: 'last_owner' });
    }
    // Refused BEFORE anything is revoked: an owner told "you are the only owner"
    // must not also have lost their connected tools to the attempt.
    if (leaving && workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))
      && !(await hasAnotherOwner(orgId, req.params.userId))) {
      return res.status(409).json({
        error: 'last_owner',
        message: 'You are this workspace\'s only owner. Make somebody else an owner before you leave.',
      });
    }
    const targetMembership = await workspace.getMembership(orgId, req.params.userId);
    if (!targetMembership) {
      return res.status(404).json({ error: 'member_not_found' });
    }

    // THE PAYER MAY NOT LEAVE, AND MAY NOT BE REMOVED, while a subscription
    // renews on their card, until another owner has taken billing over (or the
    // subscription is set to end). Before anything is revoked. When somebody is
    // removing them, the refusal is addressed to that owner.
    const payerBlock = await billingOwner.checkPayerCanLeave(orgId, req.params.userId, {
      isOwner: workspace.canAdminister(targetMembership.role),
    });
    if (payerBlock.blocked) return billingOwner.sendRefusal(res, leaving ? 'leave' : 'remove', payerBlock);

    // THEIR CONNECTED AI TOOLS GO FIRST, AND A FAILURE HERE REMOVES NOBODY.
    //
    // An OAuth grant carries the approver's OWN org, not the workspace it was
    // approved for, so the org-keyed key revocation further down never reaches
    // it: the token stayed live for up to 90 days and a re-invite revived it
    // without anybody consenting again. Everything stamped for this workspace is
    // revoked, refresh records included; their connections for any other
    // workspace are theirs and stay.
    //
    // BEFORE the membership flips, not after. Done after, a failure answered
    // 500 over a removal that had already happened: the retry got 404
    // member_not_found and never reached the revoke, and the owner's list hides
    // removed people, so nothing could finish the job. Done first, a failure
    // changes nothing, the person is still a member, and the same request
    // works when repeated. A member whose tools were revoked and who was then
    // not removed just reconnects them.
    const connectionIdentities = workspace.actorIdentities({ type: 'user', id: req.params.userId });
    let connectionsRevoked;
    try {
      connectionsRevoked = await hostedConnections.revokeForPersonInWorkspace(orgId, connectionIdentities);
      if (connectionsRevoked.remaining.access_tokens || connectionsRevoked.remaining.refresh_tokens) {
        throw new Error(`left credentials behind: ${JSON.stringify(connectionsRevoked.remaining)}`);
      }
    } catch (err) {
      console.error(`[TEAMS] connection revocation failed for ${req.params.userId}: ${err.message}`);
      return res.status(500).json({
        error: 'connections_not_revoked',
        message: leaving
          ? 'Could not disconnect your connected AI tools, so you have not left. Try again.'
          : 'Could not disconnect their connected AI tools, so nothing was changed. Try again.',
      });
    }

    // Sets removed_at and NOTHING else. Everything this person contributed —
    // decisions, landmines, paths, events — stays in the workspace and stays
    // attributed to them, because that accumulated brief is the thing the team
    // is paying for and a product that forgets half of it when an engineer
    // leaves is the opposite of the one being sold.
    //
    // Deliberately NOT routed through dataErasureService, which deletes by
    // owner_key across a dozen tables. That is correct for closing an entire
    // workspace and catastrophic here.
    //
    // And when this workspace is the person's OWN (users.org_id) — a founder
    // who upgraded their signup org to Team and handed it to a co-owner, or
    // somebody the legacy invite path created inside it — they are re-homed
    // into a fresh personal workspace in the same transaction. Otherwise every
    // header-less request they make is refused by refuseOwnOrgBinding, with no
    // billing, no account deletion and no new workspace to escape to.
    //
    // Every removal carries the person's PERSONAL projects out with them —
    // into the new workspace for somebody re-homed, into their own
    // (users.org_id) for everybody else: nobody but the author can read one,
    // so left in the team it would be readable by nobody at all. Private and
    // shared projects are the team's and stay. Their "you" profile in this
    // workspace is the same kind of thing and goes the same way, merged into
    // the one they have at home (workspaceService.carryPersonalProfile).
    //
    // requireAnotherOwner: the owner count above is read outside the membership
    // lock, so two co-owners removing each other concurrently both passed it and
    // left the workspace with nobody. Re-counted under the lock, the second one
    // is refused.
    const {
      removed, reason = null, personalWorkspace, carriedTo = null, projectsMoved = [], projectsLeft = [], carryFailed = false,
      profileMoved = false, profileMerged = false, profileNotMoved = null, shareLinksRevoked = [],
    } = await workspace.removeMemberAndRehome(orgId, req.params.userId, {
      requireAnotherOwner: leaving ? 'if_owner' : true,
      voluntary: leaving,
    });
    if (reason === 'last_owner') {
      return res.status(409).json({
        error: 'last_owner',
        ...(leaving ? { message: 'You are this workspace\'s only owner. Make somebody else an owner before you leave.' } : {}),
      });
    }
    if (!removed) return res.status(404).json({ error: 'member_not_found' });

    // Revoke their credentials, or removal is cosmetic — an unrevoked key keeps
    // reading and writing the workspace over MCP long after the person is gone.
    // The column is `status`, not a revoked_at timestamp; an UPDATE naming a
    // column that does not exist would have thrown into the .catch() above and
    // reported a clean removal that revoked nothing.
    const revokedKeys = await db.query(
      `UPDATE api_keys SET status = $3 WHERE owner_id = $1 AND org_id = $2 AND status = $4
       RETURNING key_hash`,
      [req.params.userId, orgId, 'revoked', 'active'],
      orgId
    ).catch((err) => {
      console.error(`[TEAMS] key revocation failed for ${req.params.userId}: ${err.message}`);
      return null;
    });
    if (!revokedKeys) {
      // Say so rather than reporting a successful removal over a half-done one.
      return res.status(500).json({ error: 'membership_removed_keys_not_revoked' });
    }
    // A REVOKED ROW IS NOT A REVOKED KEY WHILE THE CACHE STILL HOLDS IT.
    //
    // authenticate() serves a key from apiKeyCache without re-reading
    // api_keys, and the cache refreshes its TTL on every use — so a key in
    // active use never expired out. Removal looked complete; re-invite the
    // person and the "revoked" key served the team again. Same invalidation
    // DELETE /keys/:id performs, across every instance.
    await Promise.all((revokedKeys.rows || [])
      .map((row) => row.key_hash)
      .filter(Boolean)
      .map((hash) => apiKeyCache.invalidateApiKey(hash).catch((err) => {
        console.error(`[TEAMS] key cache invalidation failed: ${err.message}`);
      })));

    // A second look, best effort: a refresh of one of those connections that
    // raced the revocation above may have minted a key after it read them. The
    // person is out now, so it is refused anyway (auth pins it to a workspace
    // they are not in), and addMember revokes any leftover grant on re-entry;
    // this only keeps the row honest. Its failure never undoes the removal.
    await hostedConnections.revokeForPersonInWorkspace(orgId, connectionIdentities)
      .catch((err) => console.error(`[TEAMS] second connection sweep failed for ${req.params.userId}: ${err.message}`));

    // A shortfall of seats may have been resolved by this departure.
    billingNotices.clearSeatShortfallIfResolved(orgId);

    await logTeamAudit(req.actor, orgId, leaving ? 'member_left' : 'member_removed', {
      user_id: req.params.userId,
      keys_revoked: revokedKeys.rowCount || 0,
      connections_revoked: connectionsRevoked.revoked.connections,
      ...(personalWorkspace ? { rehomed_to: personalWorkspace } : {}),
      ...(carriedTo ? {
        personal_projects_moved: projectsMoved.length,
        personal_projects_left: projectsLeft.length,
        ...(carryFailed ? { personal_projects_carry_failed: true } : {}),
      } : {}),
      ...(profileMoved ? { profile_moved: true } : {}),
      ...(profileNotMoved ? { profile_not_moved: profileNotMoved } : {}),
      ...(shareLinksRevoked.length ? { share_links_revoked: shareLinksRevoked.length } : {}),
    });
    return res.json({
      success: true,
      left: leaving,
      contributions_retained: true,
      keys_revoked: revokedKeys.rowCount || 0,
      // AI tools (Claude, ChatGPT, ...) they had connected to this workspace.
      connections_revoked: connectionsRevoked.revoked.connections,
      // Set when the removed person's own default workspace was this one and
      // they were given a new personal workspace to land in.
      rehomed_to: personalWorkspace || null,
      // Their personal projects, carried into personal_projects_moved_to
      // (rehomed_to for somebody re-homed, their own workspace otherwise).
      // Anything that could not be carried is still in this workspace, and
      // said so here rather than discovered later.
      personal_projects_moved: projectsMoved.length,
      personal_projects_moved_to: projectsMoved.length ? carriedTo : null,
      ...(projectsLeft.length || carryFailed ? {
        personal_projects_not_moved: carryFailed ? 'all' : projectsLeft,
      } : {}),
      // Their "you" profile in this workspace (about them, their recurring
      // instructions), which only they could read: moved to the same place
      // as the personal projects, and merged into the profile already there
      // (profile_merged) without overwriting anything. profile_not_moved names
      // why one with something written in it stayed here.
      profile_moved: profileMoved,
      profile_moved_to: profileMoved ? carriedTo : null,
      ...(profileMoved ? { profile_merged: profileMerged } : {}),
      ...(profileNotMoved ? { profile_not_moved: profileNotMoved } : {}),
      // Public share links this person minted on projects that STAY with the
      // team, turned off in the removal's transaction: a link is its author's
      // publication, and a departed author's links kept serving the live team
      // brief — decisions made after they left included. Prefixes only; the
      // token is the read credential. (Links on carried projects are deleted
      // with the carry and are not listed here.)
      share_links_revoked: shareLinksRevoked,
    });
  } catch (err) {
    if (err instanceof billingOwner.BillingOwnerUnconfirmed) return billingOwner.sendUnconfirmed(res);
    console.error('[TEAMS] member removal failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/projects-sharing', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  try {
    const projectsRes = await db.query(
      `SELECT project_id, owner_key, owner_user_id, visibility, project_name, updated_at
         FROM context_projects
        WHERE owner_key = $1
        ORDER BY updated_at DESC`,
      [orgId],
      orgId
    ).catch(() => ({ rows: [] }));

    // THE SAME THREE STATES AS EVERY OTHER READ. This listed every project in
    // the workspace to any member, so the sharing screen showed a teammate the
    // NAMES of a colleague's personal projects — the one class of project not
    // even a workspace owner may read. `personal`: its author. `private`: its
    // author and workspace owners. `shared`: the workspace. A row with no author
    // predates per-user attribution and belongs to the workspace, as it does in
    // the store's visibility clause.
    // Not caught, for the same reason the PATCH does not catch it: swallowing a
    // failed role read answers an owner with a SHORTER list and every row marked
    // unchangeable, and calls that a successful listing. The handler answers 5xx.
    const identities = new Set(workspace.actorIdentities(req.actor).filter(Boolean));
    const role = await workspace.resolveRole(req.actor, orgId);
    const isOwner = workspace.canAdminister(role);

    // Asked only when there is somebody's private project to decide on: an owner
    // may share or unshare one once its author has left.
    // (a legacy key-id stamp is resolved to its person: workspace.resolveAuthors)
    const authors = isOwner && projectsRes.rows.some((p) => p.owner_user_id)
      ? await workspace.resolveAuthors(orgId, projectsRes.rows.map((p) => p.owner_user_id))
      : null;

    // A PRIVATE project whose author stamp is a dead key id is re-stamped here, when
    // exactly one active non-owner member ever wrote to it (journey r7). The
    // owner's load of this listing is one of the two places that happens (the other
    // is the boot pass), and never a plain read of the project.
    if (authors) {
      for (const row of projectsRes.rows) {
        if (projectVisibility(row) !== 'private' || !row.owner_user_id || !authorStamps.looksLikeKeyId(row.owner_user_id)
          || authors.personOf(row.owner_user_id) !== null) continue;
        try {
          const full = await contextStore.getProject(orgId, row.project_id);
          const person = full ? await authorStamps.resolveAndRestamp(full, authors) : null;
          if (person) row.owner_user_id = person;
        } catch (err) {
          console.warn(`[TEAMS] author resolution for ${row.project_id} failed: ${err.message}`);
        }
      }
    }

    const rows = [];
    for (const project of projectsRes.rows.filter((p) => mayReadProject(p, { identities, isOwner }))) {
      const share = await contextStore.getProjectShare(project.project_id).catch(() => ({ share: null, sections: [], members: [] }));
      // WHAT THE PATCH WOULD ANSWER, decided by the same function the PATCH
      // uses. The sharing screen offered the dropdown to everyone and showed
      // "Could not change that. Nothing was moved." on the refusals — so a
      // member had no way to learn that their own project was theirs to share.
      const person = authors && project.owner_user_id ? authors.personOf(project.owner_user_id) : null;
      const permission = projectSharingPermission(
        // The actor's own legacy key-id stamp is the actor's authorship.
        { ...project, visibility: project.visibility || 'private', ...(person && identities.has(person) ? { owner_user_id: person } : {}) },
        { identities, role, authorLeft: Boolean(authors && project.owner_user_id && !authors.isActive(project.owner_user_id)) },
      );
      rows.push({
        project_id: project.project_id,
        project_name: project.project_name,
        owner_user_id: project.owner_user_id || null,
        visibility: project.visibility || 'private',
        can_change_visibility: Boolean(permission.allowed),
        visibility_locked_reason: permission.allowed ? null : (permission.reason || null),
        // Journey r7: a key-id stamp that resolves to nobody. Shown to owners only
        // ("Author unknown"), who may assign one active member
        // (POST /projects/:id/assign-author). Never a personal project (not listed).
        ...(authors && project.owner_user_id && authorStamps.looksLikeKeyId(project.owner_user_id)
          && authors.personOf(project.owner_user_id) === null ? { author_unknown: true } : {}),
        updated_at: project.updated_at,
        shared: Boolean(share.share?.enabled && project.visibility === 'shared'),
        sections: (share.sections || []).map((s) => ({
          section_key: s.section_key,
          can_view: Boolean(s.can_view),
          can_edit: Boolean(s.can_edit),
        })),
        members: (share.members || []).map((m) => ({
          user_id: m.user_id,
          role_override: m.role_override,
        })),
      });
    }

    return res.json({
      projects: rows,
      section_allowlist: SHAREABLE_SECTIONS,
      defaults: DEFAULT_SHARED_SECTIONS,
    });
  } catch (err) {
    console.error('[TEAMS] list project sharing failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/projects/:projectId/sharing', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  const projectId = req.params.projectId;
  // Three states now, not a boolean. `enabled` is still accepted so existing
  // callers keep working: true means shared, false means org-owned private —
  // which is what it has always meant, since nothing could previously express
  // "personal".
  const VISIBILITIES = new Set(['personal', 'private', 'shared']);
  const requested = typeof req.body?.visibility === 'string' ? req.body.visibility : null;
  if (requested && !VISIBILITIES.has(requested)) {
    return res.status(400).json({ error: 'invalid_visibility' });
  }
  const visibility = requested || (req.body?.enabled ? 'shared' : 'private');
  const enabled = visibility === 'shared';
  // A KEY THE PAYLOAD DOES NOT CARRY IS A KEY THE CALLER IS NOT EDITING.
  //
  // upsertProjectShare rewrites the WHOLE share — it DELETEs every section row
  // and every context_project_members row before re-inserting whatever it was
  // handed. So "absent" and "empty" have to be told apart here, or a caller who
  // only wanted to change the visibility deletes two policies they never
  // mentioned. That is exactly what happened: the sharing panel sends sections
  // and no members, and every tick wiped the per-project role overrides.
  //
  // Absent  -> preserve what is stored.
  // Present -> replace with what was sent, an explicit [] included: saying "no
  //            overrides" and "no configured sections" are decisions, and they
  //            have to stay expressible.
  const sectionsProvided = Array.isArray(req.body?.sections);
  const membersProvided = Array.isArray(req.body?.members);
  const sectionsInput = sectionsProvided ? req.body.sections : [];
  const membersInput = membersProvided ? req.body.members : [];

  const sections = sectionsInput
    .filter((row) => row && typeof row.section_key === 'string' && SHAREABLE_SECTIONS.includes(row.section_key))
    .map((row) => ({
      section_key: row.section_key,
      can_view: row.can_view !== false,
      // can_edit is only meaningful where can_view is: a writer merging into
      // content they cannot see is how one destroys what they never knew was
      // there. Zeroed on the row as well as refused at the gate.
      can_edit: row.can_view !== false && Boolean(row.can_edit),
    }));
  const members = membersInput
    .filter((row) => row && typeof row.user_id === 'string' && VALID_TEAM_ROLES.has(row.role_override))
    .map((row) => ({ user_id: row.user_id, role_override: row.role_override }));

  try {
    const projectRes = await db.query(
      'SELECT project_id, owner_key, owner_user_id, visibility FROM context_projects WHERE project_id = $1 AND owner_key = $2',
      [projectId, orgId],
      orgId
    );
    if (!projectRes.rows.length) {
      return res.status(404).json({ error: 'project_not_found' });
    }

    // AUTHORITY, AFTER VISIBILITY.
    //
    // This gate used to be `canAdminister(role)` and nothing else, checked
    // before the project was even read. Two things followed. A member could
    // never share their OWN project — the person whose work it is had no say in
    // where it lives, while the wizard's own promise was "shared with the team
    // only when you say so". And an owner's PATCH on a colleague's `personal`
    // project returned 200 and published it to the owner, contradicting the one
    // rule `personal` exists to state.
    //
    // Role still comes from workspace membership, never actor.role: the
    // org-level role is 'admin' by default for nearly everyone and normalizes
    // to owner, so reading it here would hand a viewer the whole screen.
    // NO `.catch` ON EITHER READ. A failed project read reaching this line as an
    // empty result would be answered "not found", and a failed role read would
    // be answered "you are a viewer" — a transient database error telling an
    // owner they have been demoted, and telling nobody that anything failed.
    // Both throw to the handler and answer 5xx, which is the same rule the share
    // read below already follows.
    const identities = new Set(workspace.actorIdentities(req.actor).filter(Boolean));
    const role = await workspace.resolveRole(req.actor, orgId);
    const current = projectRes.rows[0];
    if (!mayReadProject(current, { identities, isOwner: workspace.canAdminister(role) })) {
      return res.status(404).json({ error: 'project_not_found' });
    }
    const authors = workspace.canAdminister(role) && current.owner_user_id && projectVisibility(current) === 'private'
      ? await workspace.resolveAuthors(orgId, [current.owner_user_id])
      : null;
    const authorLeft = authors ? !authors.isActive(current.owner_user_id) : false;
    const person = authors ? authors.personOf(current.owner_user_id) : null;
    const permission = projectSharingPermission(
      person && identities.has(person) ? { ...current, owner_user_id: person } : current,
      { identities, role, authorLeft },
    );
    if (!permission.allowed) {
      // A personal project the caller did not author answers as though it were
      // not there. Confirming it exists is itself the disclosure.
      if (permission.notFound) return res.status(404).json({ error: 'project_not_found' });
      return res.status(403).json({ error: 'forbidden', message: permission.reason });
    }

    // What the share holds RIGHT NOW, so an omitted half of the payload can be
    // carried across rather than deleted.
    //
    // A FAILED READ IS NOT AN EMPTY SHARE. This caught the error and carried on
    // with `{ sections: [], members: [] }`, and the upsert below deletes every
    // row before re-inserting what it is handed — so one transient read error
    // turned "change the visibility" into "delete every section row and every
    // per-project override", with a 200. It throws now, the handler answers 5xx,
    // and nothing has been written. The read is skipped when both halves were
    // sent, because then nothing depends on it.
    const existing = sectionsProvided && membersProvided
      ? { sections: [], members: [] }
      : await contextStore.getProjectShare(projectId);
    const keptSections = (existing.sections || []).map((row) => ({
      section_key: row.section_key,
      can_view: Boolean(row.can_view),
      can_edit: Boolean(row.can_view) && Boolean(row.can_edit),
    }));
    // normalizeRole FIRST. A row written before the three-role model holds
    // 'admin' / 'operator' / 'approver'; filtering on the current names dropped
    // it, so saving an unrelated toggle silently revoked that person's override.
    // Legacy names map forward on read everywhere else; here they are also
    // written back in their current form.
    const keptMembers = (existing.members || [])
      .filter((row) => row && row.user_id && row.role_override)
      .map((row) => ({ user_id: row.user_id, role_override: workspace.normalizeRole(row.role_override) }));

    await db.query(
      `UPDATE context_projects
          SET visibility = $1, updated_at = NOW()
        WHERE project_id = $2 AND owner_key = $3`,
      [visibility, projectId, orgId],
      orgId
    );

    // THE DEFAULTS ARE NOT A DOWNGRADE.
    //
    // This branch used to write the default rows with
    // `can_edit: section_key !== 'recent_decisions'`, which is NOT what an
    // unconfigured share means: canEditSectionForActor's no-row fallback makes
    // every default section writable, so the first save of a project that had
    // been sharing a writable decision log turned it read-only — silently, from
    // a screen that showed the section as ticked and offered no edit control to
    // put it back. defaultShareSectionRows() is the one statement of what the
    // defaults grant, shared with the service that enforces them.
    //
    // It only fires for an EXPLICIT empty array now. An absent `sections` key
    // preserves the stored rows, which for an unconfigured project means writing
    // none at all — freezing today's defaults into rows is itself a decision the
    // caller did not make.
    const sectionsToWrite = sectionsProvided
      ? (sections.length ? sections : service.defaultShareSectionRows())
      : keptSections;

    await contextStore.upsertProjectShare(projectId, {
      org_id: orgId,
      enabled,
      sections: sectionsToWrite,
      members: membersProvided ? members : keptMembers,
      created_by: workspace.actorPersonId(req.actor),
      updated_by: workspace.actorPersonId(req.actor),
    });

    await db.query(
      `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      // actor_user_id: who changed who can see this is the one fact this line
      // is read for. It was never written, so the change was unattributable.
      [`audit_${crypto.randomUUID()}`, orgId, projectId, 'sharing_policy_updated', 'user', workspace.actorPersonId(req.actor), 'dashboard', {
        visibility,
        enabled,
        // What was WRITTEN, not what was sent: an omitted half of the payload is
        // carried across, and an audit line claiming zero sections on a save
        // that preserved four is worse than no audit line.
        section_count: sectionsToWrite.length,
        member_override_count: (membersProvided ? members : keptMembers).length,
        sections_replaced: sectionsProvided,
        members_replaced: membersProvided,
      }],
      'org-system'
    ).catch(() => {});

    const refreshed = await contextStore.getProjectShare(projectId);
    return res.json({
      project_id: projectId,
      visibility,
      shared: Boolean(enabled),
      sections: (refreshed.sections || []).map((s) => ({
        section_key: s.section_key,
        can_view: Boolean(s.can_view),
        can_edit: Boolean(s.can_edit),
      })),
      members: (refreshed.members || []).map((m) => ({
        user_id: m.user_id,
        role_override: m.role_override,
      })),
    });
  } catch (err) {
    console.error('[TEAMS] update project sharing failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── A project nobody can be identified as the author of (journey r7) ────────
//
// A key-id stamp that resolves to nobody (the key was deleted and the history
// does not name exactly one writer) leaves a project its owners cannot manage and
// its real author cannot see. The listing above marks it `author_unknown` for
// owners; an owner assigns ONE ACTIVE MEMBER here (themselves allowed). Only for
// such a stamp, never for a project whose author is known, never a personal one.
router.post('/projects/:projectId/assign-author', async (req, res) => {
  const orgId = await ensureTeamAccess(req, res);
  if (!orgId) return;
  const toPersonId = typeof req.body?.user_id === 'string' ? req.body.user_id : '';
  if (!toPersonId) return res.status(400).json({ error: 'user_id_required' });
  try {
    const role = await workspace.resolveRole(req.actor, orgId);
    if (!workspace.canAdminister(role)) {
      return res.status(403).json({ error: 'forbidden', message: 'Only a workspace owner can assign a project\'s author.' });
    }
    const result = await authorStamps.assignAuthor({
      ownerKey: orgId,
      projectId: req.params.projectId,
      toPersonId,
      byPersonId: workspace.actorPersonId(req.actor),
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof authorStamps.AuthorAssignError) {
      return res.status(err.status).json({ error: err.code, message: err.publicMessage });
    }
    console.error('[TEAMS] assign author failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// What the dashboard has not yet shown this person about authorship: they were
// made a project's author, or (for an owner) another owner took one over.
router.get('/author-notices', async (req, res) => {
  const orgId = workspace.defaultOwnerKey(req.actor);
  const person = workspace.actorPersonId(req.actor);
  if (!orgId || !person) return res.json({ notices: [] });
  try {
    return res.json({ notices: await authorStamps.listDashboardNotices(orgId, person) });
  } catch (err) {
    console.error('[TEAMS] author notices failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/author-notices/seen', async (req, res) => {
  const orgId = workspace.defaultOwnerKey(req.actor);
  const person = workspace.actorPersonId(req.actor);
  if (!orgId || !person) return res.json({ success: true, seen: 0 });
  try {
    const ids = Array.isArray(req.body?.notice_ids) ? req.body.notice_ids.filter((id) => typeof id === 'string') : [];
    return res.json({ success: true, seen: await authorStamps.markDashboardNoticesSeen(orgId, person, ids) });
  } catch (err) {
    console.error('[TEAMS] author notices seen failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Hosted connections approved for this workspace ──────────────────────────
//
// The AI tools (Claude, ChatGPT, an editor on the hosted endpoint) a colleague
// let into THIS workspace's memory over OAuth. A connection is the person's
// credential, so until now only they could see or remove it; once it reads and
// writes the team's memory, an owner has to be able to as well (BLOCKED 11).
//
// NARROW ON PURPOSE. Owners only. Only grants stamped as approved FOR the bound
// workspace at consent (oauth_workspace_key): never a member's personal
// workspace, another workspace of theirs, or a grant from before the stamp. No
// token, key id or hash is ever returned. Members and viewers keep exactly the
// own-connections route they had (GET /api/v1/connections). Disconnecting is the
// person's own revocation (routes/oauth.js), so the token is refused on its next
// call and cannot be refreshed back.
async function ownerOfBoundWorkspace(req, res) {
  // Recovery, not a team feature: an owner shedding a lapsed team still needs it.
  const orgId = await ensureRosterRecoveryAccess(req, res);
  if (!orgId) return null;
  if (!workspace.canAdminister(await workspace.resolveRole(req.actor, orgId))) {
    res.status(403).json({ error: 'forbidden: owners only' });
    return null;
  }
  return orgId;
}

router.get('/connections', async (req, res) => {
  const orgId = await ownerOfBoundWorkspace(req, res);
  if (!orgId) return;
  try {
    const [connections, members] = await Promise.all([
      hostedConnections.listForWorkspace(orgId),
      workspace.listMembers(orgId),
    ]);
    const emails = new Map(members.map((m) => [m.user_id, m.email || null]));
    const self = new Set(workspace.actorIdentities(req.actor));
    res.json({
      connections: connections.map(({ owner_id: personId, ...connection }) => ({
        ...connection,
        person: { user_id: personId, display_name: emails.get(personId) || personId },
        own: self.has(personId),
      })),
    });
  } catch (err) {
    console.error('[TEAMS] connections list failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/connections/:connectionId', async (req, res) => {
  // A leaked key must not be able to cut a colleague's tools off.
  if (req.actor?.type === 'key') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'API keys cannot disconnect connected apps. Sign in to the dashboard to manage them.',
    });
  }
  const orgId = await ownerOfBoundWorkspace(req, res);
  if (!orgId) return;
  const connectionId = String(req.params.connectionId || '');
  if (!/^conn_[0-9a-f]{32}$/.test(connectionId)) return res.status(404).json({ error: 'not_found' });
  try {
    const result = await hostedConnections.disconnectForWorkspace(orgId, connectionId);
    // Not this workspace's, or already gone: one answer for both, so the route
    // says nothing about any other workspace's connections.
    if (!result) return res.status(404).json({ error: 'not_found', message: 'That connection is not connected to this workspace.' });

    const { connection } = result;
    await logTeamAudit(req.actor, orgId, 'connection_disconnected_by_owner', {
      person_id: result.owner_id,
      client_name: connection.client_name || null,
      client_id: connection.client_id || null,
      connection_id: connectionId,
      revoked: result.revoked,
    });
    if (result.remaining.access_tokens || result.remaining.refresh_tokens) {
      console.error(`[TEAMS] Disconnect of ${connectionId} left credentials behind: ${JSON.stringify(result.remaining)}`);
      return res.status(500).json({
        error: 'disconnect_incomplete',
        message: 'The connection was not fully disconnected. Try again.',
        remaining: result.remaining,
      });
    }
    return res.json({ disconnected: true, connection, revoked: result.revoked, remaining: result.remaining });
  } catch (err) {
    console.error('[TEAMS] connection disconnect failed:', err);
    return res.status(500).json({ error: 'internal_error', message: 'Could not disconnect. Try again.' });
  }
});

module.exports = router;
