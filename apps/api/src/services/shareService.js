'use strict';

const { PLANS } = require('../config/plans');
const crypto = require('crypto');
const store = require('../store/contextSyncStore');
const { scanContent } = require('./trail/trailScan');
const { redactDeep } = require('../utils/secretRedaction');
// Module reference, not a destructured binding — see portfolioService.
const entitlementService = require('./entitlementService');
const productEvents = require('./productEventsService');
const workspace = require('./workspaceService');
// Module reference, not a destructured binding — see portfolioService. The
// visibility model lives in contextSyncService and must not be reimplemented
// here: a second copy of "who may read this project" is how the first one
// stopped being enforced.
const contextSync = require('./contextSyncService');

function getActorKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

// 22 chars of base64url ≈ 132 bits. The token IS the authorisation for an
// unlisted link, so it has to be long enough that guessing is not a strategy.
function mintToken() {
  return crypto.randomBytes(16).toString('base64url');
}

// The referral code. Public by design — it rides in a query string from the
// share page to the signup form — so it is minted as an INDEPENDENT random
// value, never derived from the share token or from anything about the owner.
//
// What that buys, precisely:
//   - It is not the share token, so a code leaked through analytics, a referrer
//     header or a pasted URL grants no read access to the brief.
//   - It is not a function of the account, so there is nothing to invert: no
//     email, no user id, no org id, no project id, no plan, no share count.
//   - It is per SHARE, not per account. Two links from the same person carry
//     unrelated codes, so an observer holding both cannot tell they came from
//     one person — which a naive ?ref=<account_id> would hand over for free.
// The `s_` prefix is what makes share-driven referrals separable from any other
// referral_code source in a single PostHog filter.
const REF_CODE_PREFIX = 's_';

function mintRefCode() {
  return `${REF_CODE_PREFIX}${crypto.randomBytes(9).toString('base64url')}`;
}

function isShareRefCode(value) {
  return typeof value === 'string' && value.startsWith(REF_CODE_PREFIX) && value.length > REF_CODE_PREFIX.length;
}

/**
 * Emit one of the three referral moments. Best-effort and never awaited by a
 * caller on a request path — a share page must render for a stranger even when
 * the analytics insert fails.
 *
 * `share_link_viewed` is the anonymous one, and it passes NO user, NO org and NO
 * anonymous_id. That is deliberate: recordProductEvent's attempt-scoped guard
 * then stamps `$process_person_profile: false`, so the event lands in PostHog
 * without minting a person. A share link is posted in public and read by
 * strangers, so without that guard every passer-by — and every link-preview
 * crawler — would become a brand-new "real user" carrying one event and no
 * is_test flag. That is exactly the 11-people-from-nowhere cliff the device-flow
 * endpoint manufactured on the activation funnel.
 *
 * The session_id is the ref code rather than a fresh id per request: it is
 * link-scoped, not person-scoped, it keeps distinctId non-null (posthog-node
 * drops an event with no distinct id, which would leave the view unqueryable),
 * and it cannot be joined back to a visitor.
 */
function emitShareEvent(actor, { event_name, session_id = null, metadata }) {
  Promise.resolve()
    .then(() => productEvents.recordProductEvent(actor, {
      event_name,
      source: 'api',
      surface: 'share_link',
      ...(session_id ? { session_id } : {}),
      metadata,
    }))
    .catch((err) => console.warn(`[SHARE] ${event_name} not recorded:`, err && err.message ? err.message : err));
}

// ─── Whose brief is this, and who may publish it ────────────────────────────
//
// Every entry point below used to load its project with
// `store.getProject(ownerKey, projectId)` — the WORKSPACE key, which every
// member shares — and then act on the row. The project's own visibility never
// came into it. In a team workspace that made a colleague's `personal` project
// previewable by anyone, scan report included, and mintable as a PUBLIC link by
// anyone holding context:write. `personal` is the one state that means "nobody
// else, not even a workspace owner"; the share page is an unauthenticated URL.
//
// Two separate decisions, deliberately not collapsed into one:
//   VISIBILITY decides whether the project exists FOR YOU at all, and it is the
//   same check every other read goes through. A project you cannot see is
//   `project_not_found`, never 403 — a 403 confirms it exists, which is half of
//   what `personal` is hiding.
//
//   AUTHORITY decides whether you may publish it. That is the AUTHOR: minting a
//   link puts a brief on a URL with no auth on it, and no screen offers to do
//   that with somebody else's work. A workspace owner reading `private` work is
//   continuity when a colleague leaves — publishing it is a different power, the
//   same line canEditSectionForActor already draws between reading and writing.
function shareForbidden(message) {
  const err = new Error('share_forbidden');
  err.status = 403;
  err.publicMessage = message;
  return err;
}

function projectNotFound() {
  const err = new Error('project_not_found');
  err.status = 404;
  return err;
}

/** The project as this actor may see it, or `project_not_found`. */
async function loadVisibleProject(actor, ownerKey, projectId) {
  const project = await store.getProject(ownerKey, projectId);
  if (!project) throw projectNotFound();
  const policy = await contextSync.getProjectSharePolicy(actor, project).catch(() => null);
  if (!contextSync.canViewProjectForActor(actor, project, policy)) throw projectNotFound();
  return { project, policy };
}

/**
 * Publishing — minting a link, or widening one — is the author's call.
 * An unattributed project (owner_user_id NULL) predates per-user attribution and
 * belongs to the workspace, which is what isProjectOwner already encodes; that is
 * every solo account and every project older than the teams release, so this adds
 * no gate at all to the single-player product.
 */
function assertMayPublish(actor, project) {
  if (contextSync.isProjectOwner(actor, project)) return;
  throw shareForbidden('Only the person whose project this is can publish a share link for it.');
}

async function assertShareAllowed(actor) {
  // The WORKSPACE's plan governs, not the person's own org (usually Free for an
  // invited teammate) — see portfolioService.isPortfolioUnlocked.
  const ownerKey = getActorKey(actor);
  if (ownerKey === 'org-system') return;
  const entitlements = await entitlementService.getEntitlementsForExistingOrg(ownerKey).catch(() => null);
  if (!entitlements) return;
  if (!entitlements.features?.trail_share) {
    const err = new Error('share_requires_upgrade');
    err.status = 403;
    err.upgrade_required = true;
    err.publicMessage = `Share links are part of ${PLANS.developer_basic.publicName}. Your projects and briefs stay unlimited on Free.`;
    throw err;
  }
}

// The four slots the share page renders, and nothing else. This is an allow-list
// on purpose: the brief carries plenty the owner never meant to publish (hot
// paths, commands, file structure, per-tool presence), and an allow-list fails
// closed when a new field is added to the context schema, whereas a deny-list
// silently starts publishing it.
function buildSharePayload(project) {
  const context = project.context || {};
  const clip = (list, n) => (Array.isArray(list) ? list.slice(0, n) : []);
  return {
    project_name: project.project_name,
    description: context.description || '',
    tech_stack: clip(context.tech_stack, 8),
    updated_at: project.updated_at,
    brief_updated_at: context.last_updated || project.updated_at,
    slots: {
      shipped: clip(context.shipped, 8).map((entry) => ({
        summary: entry.summary,
        at: entry.shipped_at || null,
      })),
      decided: clip((context.recent_decisions || []).filter((d) => d && !d.resolved), 8).map((entry) => ({
        summary: entry.summary,
        reasoning: entry.reasoning || null,
        at: entry.decided_at || null,
        importance: entry.importance || 'normal',
      })),
      open: clip(context.open_questions, 8).map((q) => ({ summary: typeof q === 'string' ? q : String(q?.summary || '') })),
      landmines: clip(context.landmines, 8).map((entry) => ({
        summary: entry.summary,
        importance: entry.importance || 'high',
      })),
    },
  };
}

/**
 * Scan what would actually be published — the four slots, not the whole project
 * row. This is the point of the card: a brief legitimately contains internal
 * file counts, deliberate technical debt and what is currently broken, and that
 * is simultaneously the best demo and the real leak risk, in the same object. So
 * the scan runs on the BRIEF CONTENT, not on connected repos.
 */
// trailScan's sectionForPath only understands paths rooted at `content.` — it
// was written for a sealed Trail document — so it labels every finding here
// 'unknown'. The label is what the reviewer scans down the list, so it is worth
// deriving properly, and deriving it HERE rather than teaching the shared
// scanner about a second root keeps the Trails publish gate untouched.
const SLOT_LABELS = {
  shipped: 'Shipped',
  decided: 'Decided',
  open: 'Open',
  landmines: 'Will bite you',
};

function sectionForBriefPath(path) {
  const slot = /^brief\.slots\.([A-Za-z_]+)/.exec(path);
  if (slot) return SLOT_LABELS[slot[1]] || slot[1];
  const field = /^brief\.([A-Za-z_]+)/.exec(path);
  return field ? field[1].replace(/_/g, ' ') : 'brief';
}

function scanSharePayload(payload) {
  const scan = scanContent(payload, { rootPath: 'brief' });
  return {
    scanner_version: scan.scanner_version,
    scanned_at: scan.scanned_at,
    counts: scan.counts,
    findings: scan.findings.map((finding) => ({
      id: finding.id,
      path: finding.path,
      section: sectionForBriefPath(finding.path),
      category: finding.category,
      severity: finding.severity,
      excerpt: finding.excerpt,
    })),
  };
}

// Mask credentials on the way out, on EVERY read. The create-time scan is a gate
// the author walks once; this is the standing one, because the brief keeps
// changing after the link is minted. Without it, a key pasted into a decision
// summary on Tuesday is public on Wednesday with nobody involved in the decision.
// redactDeep is the canonical persist-time masker — the right tool here, where we
// want silent in-place masking rather than the scanner's report-and-block.
const maskDeep = (value) => redactDeep(value);

/**
 * Mint a share link. Unlisted by default; public requires an explicit visibility.
 *
 * The scan gate runs at EVERY visibility, including unlisted. An unlisted link is
 * still a URL with no auth on it — it gets pasted into a Slack channel, a PR
 * description, a tweet — so "unlisted" describes discoverability, not secrecy,
 * and gating only the public flip would protect the honest case and miss the
 * common one.
 */
async function createShare(actor, { project_id, visibility = 'unlisted', acknowledged_finding_ids = [] }) {
  await assertShareAllowed(actor);
  const ownerKey = getActorKey(actor);
  const { project } = await loadVisibleProject(actor, ownerKey, project_id);
  assertMayPublish(actor, project);

  const payload = buildSharePayload(project);
  const scan = scanSharePayload(payload);
  const acknowledged = new Set(acknowledged_finding_ids || []);
  const unresolved = scan.findings.filter((finding) => !acknowledged.has(finding.id));
  if (unresolved.length) {
    const err = new Error('share_scan_unresolved');
    err.status = 422;
    err.scan = { ...scan, unresolved_count: unresolved.length };
    err.publicMessage = `The scan found ${unresolved.length} thing${unresolved.length === 1 ? '' : 's'} in this brief that shouldn't leave your account. Review each one, then create the link.`;
    throw err;
  }

  const share = await store.createShareToken({
    token: mintToken(),
    owner_key: ownerKey,
    project_id,
    visibility,
    // The PERSON, not the credential: a key-authed actor.id is the key id, and a
    // link has to stay findable by its author after that key is rotated — and
    // revocable when that person leaves the workspace (removeMember).
    created_by: workspace.actorPersonId(actor) || actor?.id || null,
    ref_code: mintRefCode(),
  });

  // Moment 1 of 3. Identified — the sharer is signed in — so this is the event
  // that supplies the k-factor denominator: how many distinct accounts ever
  // create a link at all.
  // No session_id: distinctId precedence is user > session > anonymous > org, so
  // passing one here would outrank the org fallback and de-identify a sharer
  // whose actor carries an org but no user id (the API-key path). The ref code is
  // on the metadata, which is where it is needed.
  emitShareEvent(actor, {
    event_name: 'share_link_created',
    metadata: { visibility: share.visibility, ref_code: share.ref_code },
  });

  return { share, scan };
}

/** Preview the scan without minting anything — what the dashboard shows first. */
async function previewShare(actor, projectId) {
  const ownerKey = getActorKey(actor);
  // Preview is a READ of the brief, so it obeys exactly what a read obeys. It is
  // also the screen that enumerates what is sensitive in there, which made it the
  // more useful of the two leaks.
  //
  // And a read of the brief AS THIS ACTOR MAY READ IT. The visibility gate alone
  // answered "may you see this project?" and then built the payload from the raw
  // row, so a teammate on a share narrowed to goals was shown the description,
  // stack, decisions, open questions and landmines the author withheld — the
  // exact slots the brief beside it reported as "Not shared with you". The
  // author (who alone may mint) still previews the whole brief, because that is
  // what a link would publish; everybody else previews what they can already
  // read, which is the only honest answer a non-author's preview has.
  const { project, policy } = await loadVisibleProject(actor, ownerKey, projectId);
  const payload = buildSharePayload(contextSync.projectViewForActor(actor, project, policy));
  return { preview: maskDeep(payload), scan: scanSharePayload(payload) };
}

// Returns `can_create` alongside the list rather than making the client infer
// entitlement from a failed POST. Listing is deliberately NOT gated — a free
// account that downgraded still owns its existing links and must be able to see
// and revoke them; only minting new ones is a paid action.
//
// THE TOKEN IS THE READ CREDENTIAL, so the list is filtered on the TOKEN, not
// only on the name printed beside it. It used to return every live link in the
// workspace and blank the project_name of the ones the reader could not see —
// which hid the label and handed over the key: any teammate, a read-only viewer
// key included, got the token for a colleague's `personal` project, and the
// public share page then served that project's decisions, questions and
// landmines. A link is listed only when its project is one this actor may READ
// — the same visibility every other read obeys (personal: its author; private:
// author + workspace owners; shared: the workspace). A link whose project no
// longer exists here is listed only to the person who minted it, so they can
// still find and revoke it. A workspace nobody else's work can be in (a solo
// account) is unfiltered, exactly as before.
//
// SEEING THAT A LINK EXISTS IS NOT HOLDING IT. Filtering on project visibility
// still handed every teammate who can read a shared project the token of the
// author's unlisted link — and the public page serves the author's WHOLE brief,
// so on a share narrowed to goals (or left at the defaults) the token was a
// bypass of every section the author withheld from that same teammate. The token
// now goes only to the link's author (created_by), the project's author, and
// workspace owners — the people who may revoke it. Everybody else still sees the
// row (the project, its visibility, its views), with `token: null` and
// `token_withheld: true`, so the list stays honest about what is published.
async function listShares(actor) {
  const ownerKey = getActorKey(actor);
  const role = await workspace.resolveRole(actor, ownerKey).catch(() => null);
  const [shares, projects, canCreate, visible] = await Promise.all([
    store.listShareTokens(ownerKey),
    store.listProjects(ownerKey, {
      includeArchived: true,
      actorIdentities: workspace.actorIdentities(actor),
      isWorkspaceOwner: role === 'owner',
    }),
    assertShareAllowed(actor).then(() => true, () => false),
    contextSync.visibleProjectIdsForActor(actor, ownerKey),
  ]);
  const names = new Map(projects.map((p) => [p.project_id, p.project_name]));
  const authors = new Map(projects.map((p) => [p.project_id, p.owner_user_id || null]));
  let listed = shares;
  let mayHoldToken = () => true;
  if (visible) {
    const identities = new Set(workspace.actorIdentities(actor));
    const existing = new Set(await store.listVisibleProjectIds(ownerKey, { system: true }));
    listed = shares.filter((share) => (
      existing.has(share.project_id)
        ? visible.has(share.project_id) && names.has(share.project_id)
        : Boolean(share.created_by) && identities.has(share.created_by)
    ));
    const isWorkspaceOwner = workspace.canAdminister(role);
    // Strict author match: an unattributed project (owner_user_id NULL) counts as
    // everybody's in isProjectOwner, which is right for editing legacy work and
    // wrong for handing out a credential.
    mayHoldToken = (share) => isWorkspaceOwner
      || (Boolean(share.created_by) && identities.has(share.created_by))
      || (Boolean(authors.get(share.project_id)) && identities.has(authors.get(share.project_id)));
  }
  return {
    can_create: canCreate,
    shares: listed.map((share) => {
      const row = { ...share, project_name: names.get(share.project_id) || null };
      if (mayHoldToken(share)) return row;
      return { ...row, token: null, token_withheld: true };
    }),
  };
}

// Flipping unlisted -> public re-runs the gate against the brief AS IT IS NOW,
// not as it was when the link was minted. Those are frequently different briefs.
async function setShareVisibility(actor, token, visibility, { acknowledged_finding_ids = [] } = {}) {
  await assertShareAllowed(actor);
  const ownerKey = getActorKey(actor);
  const existing = await store.getShareTokenByToken(token);
  if (!existing || existing.owner_key !== ownerKey || existing.revoked_at) {
    const err = new Error('share_not_found');
    err.status = 404;
    throw err;
  }
  // Changing a live link's visibility is the same authority as minting it: the
  // unlisted -> public flip is the publication, just taken in two steps.
  const { project } = await loadVisibleProject(actor, ownerKey, existing.project_id);
  assertMayPublish(actor, project);
  if (visibility === 'public') {
    const scan = scanSharePayload(buildSharePayload(project));
    const acknowledged = new Set(acknowledged_finding_ids || []);
    const unresolved = scan.findings.filter((finding) => !acknowledged.has(finding.id));
    if (unresolved.length) {
      const err = new Error('share_scan_unresolved');
      err.status = 422;
      err.scan = { ...scan, unresolved_count: unresolved.length };
      err.publicMessage = `The brief has changed since this link was created and the scan found ${unresolved.length} thing${unresolved.length === 1 ? '' : 's'} to review before it goes public.`;
      throw err;
    }
  }
  return store.setShareTokenVisibility(ownerKey, token, visibility);
}

// Revoking runs the other way: it makes a live link stop working. The author may
// do it, and so may a workspace owner — needing the author to turn something off
// is exactly the case where the author has been away. When the author is REMOVED
// from the workspace nobody has to: removeMemberAndRehome revokes every link they
// minted on a project that stays with the team, in the removal's own transaction
// (and the carry deletes the links on the personal projects that leave with
// them), so a departed author's link never goes on serving the team's brief.
async function revokeShare(actor, token) {
  const ownerKey = getActorKey(actor);
  const existing = await store.getShareTokenByToken(token);
  if (existing && !existing.revoked_at && existing.owner_key === ownerKey) {
    const project = await store.getProject(ownerKey, existing.project_id);
    const role = await workspace.resolveRole(actor, ownerKey).catch(() => null);
    if (project && !contextSync.isProjectOwner(actor, project) && !workspace.canAdminister(role)) {
      throw shareForbidden('Only the person whose project this is, or a workspace owner, can revoke this link.');
    }
  }
  const revoked = await store.revokeShareToken(ownerKey, token);
  if (!revoked) {
    const err = new Error('share_not_found');
    err.status = 404;
    throw err;
  }
  return revoked;
}

/**
 * The public read. No actor, no session — the caller is a stranger with a URL.
 *
 * Returns a discriminated result rather than throwing for the revoked case: a
 * turned-off link deserves "the owner turned this off", which is a real state a
 * visitor can understand, not a 404 that reads like the product is broken.
 */
async function getPublicShare(token) {
  const share = await store.getShareTokenByToken(token);
  if (!share) return { state: 'not_found' };
  if (share.revoked_at) return { state: 'revoked' };

  const project = await store.getProject(share.owner_key, share.project_id);
  if (!project) return { state: 'not_found' };

  store.recordShareTokenView(token).catch(() => {});

  // Moment 2 of 3. Anonymous by construction — see emitShareEvent for why no
  // person may be created here. The owner is NOT put on the event: it would put
  // one account's identity onto a stranger's event for no measurement gain,
  // since rolling views up to sharers is a server-side join on ref_code.
  if (share.ref_code) {
    emitShareEvent(null, {
      event_name: 'share_link_viewed',
      session_id: share.ref_code,
      metadata: { visibility: share.visibility, ref_code: share.ref_code },
    });
  }

  return {
    state: 'ok',
    visibility: share.visibility,
    // Safe to hand to an anonymous caller: this is the attribution pointer, not
    // the read credential, and the share page needs it to stamp its CTAs.
    ref_code: share.ref_code || null,
    brief: maskDeep(buildSharePayload(project)),
  };
}

/**
 * Moment 3 of 3 — conversion. Called from the Clerk user.created webhook with
 * whatever referral_code the visitor carried from the share page.
 *
 * Deliberately NOT a new event. account_created is the one authoritative signup
 * signal (once per real account, email and OAuth alike); a separate
 * share_converted event would be a fourth signup counter that structurally
 * misses the OAuth half, which is precisely how signup_completed under-counted
 * signups ~3:1 for months. So conversion is a PROPERTY on the authoritative
 * event, and it cannot drift from the signup count.
 *
 * Returns the share so the caller can flag the signup, or null when the code is
 * absent, foreign, or unknown — an unrecognised code is a normal outcome (a
 * revoked link, a stale bookmark, a hand-typed guess), never an error.
 */
async function recordShareConversion(refCode) {
  if (!isShareRefCode(refCode)) return null;
  try {
    return await store.recordShareTokenConversion(refCode);
  } catch (err) {
    console.warn('[SHARE] conversion not recorded:', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = {
  createShare,
  previewShare,
  listShares,
  setShareVisibility,
  revokeShare,
  getPublicShare,
  recordShareConversion,
  isShareRefCode,
  // exported for tests
  loadVisibleProject,
  mintRefCode,
  buildSharePayload,
  scanSharePayload,
  maskDeep,
  sectionForBriefPath,
};
