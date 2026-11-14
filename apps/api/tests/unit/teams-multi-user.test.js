'use strict';

// Multi-user workspaces: the invariants, and a guard for each bug that shipped.
//
// Several of these are SOURCE-TEXT assertions rather than behavioural ones. That
// is deliberate and follows the pattern already used for plan-copy drift: the
// bugs here were not wrong behaviour that a normal test would have caught, they
// were controls that silently did nothing — a cipher gated on a field that is
// never set, an ACL that returned true on its first line, a listing with no
// filter. Nothing failed, so nothing could go red. The only test that catches
// the reintroduction of a no-op is one that reads the code.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// Comment-blind: the files most likely to quote a bad pattern are the ones whose
// comments explain why it was bad, and a raw scan would fail on its own
// documentation — making deletion of the explanation the fastest way to green.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// The choke point
// ---------------------------------------------------------------------------

// The inline form, OR the same derivation split across declarations:
//
//   const orgId = req.actor.org_id || null;
//   const ownerKey = orgId || actorId;      // where actorId = req.actor.id
//
// mcp-auth.js shipped exactly that, and the single-expression regex could not
// see it. Variables are collected per file and only count when assigned
// DIRECTLY from actor.org_id / actor.id, so an unrelated `a || b` never matches.
function derivesOwnerKeyInline(body) {
  if (/actor[?.]*\.org_id\s*\|\|\s*(req\.)?actor[?.]*\.id/.test(body)) return true;
  const orgVars = new Set();
  const idVars = new Set();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:req\.)?actor[?.]*\.org_id\b(?:\s*\|\|\s*(?:null|undefined|''))?\s*;/g)) orgVars.add(m[1]);
  for (const m of body.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:req\.)?actor[?.]*\.id\b\s*;/g)) idVars.add(m[1]);
  const org = `(?:${[...orgVars].join('|') || '(?!)'}|(?:req\\.)?actor[?.]*\\.org_id)`;
  const id = `(?:${[...idVars].join('|') || '(?!)'}|(?:req\\.)?actor[?.]*\\.id)`;
  return new RegExp(`(?<![\\w.])${org}\\s*(?:\\|\\||\\?\\?)\\s*${id}(?![\\w])`).test(body);
}

test('the owner_key guard catches the split form, and only that', () => {
  assert.ok(derivesOwnerKeyInline('const x = actor.org_id || actor.id;'));
  assert.ok(derivesOwnerKeyInline(
    'const actorId = req.actor.id;\n    const orgId = req.actor.org_id || null;\n    const ownerKey = orgId || actorId;'
  ), 'the mcp-auth.js split derivation must be caught');
  assert.ok(derivesOwnerKeyInline('const orgId = req.actor.org_id;\nconst k = orgId ?? req.actor.id;'));
  assert.ok(!derivesOwnerKeyInline('const orgId = req.actor.org_id;\nconst k = orgId || fallback;'));
  assert.ok(!derivesOwnerKeyInline('const personal = req.actor.org_id;\nconst k = active || personal;'));
  assert.ok(!derivesOwnerKeyInline('const k = workspace.defaultOwnerKey(req.actor);'));
});

test('owner_key is derived in exactly one place', () => {
  // `actor.org_id || actor.id` was copied to ~40 call sites. While an org was
  // always one person that expression could not be wrong; the moment a second
  // human shares an org it is an authorization decision, and one copied 40 times
  // is one that will be got wrong at the 41st.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, full);
      // The resolver itself is where the expression is allowed to live.
      if (rel === path.join('services', 'workspaceService.js')) continue;
      const body = stripComments(fs.readFileSync(full, 'utf8'));
      if (derivesOwnerKeyInline(body)) offenders.push(rel);
    }
  };
  walk(SRC);
  assert.deepStrictEqual(
    offenders, [],
    `owner_key must come from workspaceService.defaultOwnerKey/resolveOwnerKey, not an inline expression. Offenders: ${offenders.join(', ')}`
  );
});

test('team routes resolve the workspace, never read req.actor.org_id raw', () => {
  // The scan above only catches the INLINE `org_id || id` form. A bare
  // `req.actor.org_id` slipped past it, and ensureTeamAccess read exactly that —
  // pointing a dozen team routes at the caller's personal workspace instead of
  // the one they had switched into. Silently, against the wrong tenant.
  //
  // Scoped to teams.js because billing and org-settings routes legitimately mean
  // the billing org; every route in this file means the workspace.
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));

  // Targets the DEFECT SHAPE rather than counting occurrences. Three reads of
  // req.actor.org_id are legitimate and mean exactly what they say — which
  // workspace is the caller's OWN (the switcher's 'personal' flag, the creator's
  // billing tier, and excluding your own org from domain offers). A count-based
  // guard flags those forever and gets loosened until it asserts nothing.
  //
  // What must never come back is org_id standing in for the WORKSPACE.
  assert.ok(
    /const orgId = workspace\.defaultOwnerKey\(req\.actor\)/.test(teams),
    'ensureTeamAccess must resolve the bound workspace'
  );
  assert.ok(
    !/const orgId = req\.actor\.org_id/.test(teams),
    'no handler may take its workspace from the org the caller signed up under'
  );
});

test('team routes attribute to the person, never to the credential', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  // actor.id is the API KEY id for key-authed traffic. Writing it into
  // workspace_members produced an orphan row that locked the founder out of the
  // workspace they had just created, and comparing it to owner_user_id refused a
  // genuine owner their own project.
  assert.ok(
    !/req\.actor\.id/.test(teams),
    'teams.js must use workspace.actorPersonId / actorIdentities, not req.actor.id'
  );
});

test('every admin gate in teams.js resolves the workspace role', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  // canAdminister(req.actor.role) reads the ORG-level role, which is 'admin' by
  // default for nearly everyone and normalizes to 'owner' — so a viewer passed
  // the owners-only gate on the sharing endpoint.
  assert.ok(
    !/canAdminister\(req\.actor\.role\)/.test(teams),
    'admin gates must use await workspace.resolveRole(req.actor, orgId)'
  );
});

test('the project listing refuses an unattributed call instead of returning everything', () => {
  const store = stripComments(fs.readFileSync(path.join(SRC, 'store', 'contextSyncStore.js'), 'utf8'));
  const clause = store.slice(store.indexOf('function visibilityClause'), store.indexOf('async function listProjects'));
  // It used to return '' — no predicate at all — for any caller that forgot to
  // pass identities, and four user-facing services did. Portfolio and
  // cross-project surface names AND decisions, so the leak reached the brief.
  assert.ok(/throw new Error/.test(clause), 'an unattributed listing must throw, not silently return the workspace');
  assert.ok(/if \(system\) return ''/.test(clause), 'a genuine system caller must opt in explicitly');
});

test('no service lists projects without scoping or declaring itself system', () => {
  const offenders = [];
  const servicesDir = path.join(SRC, 'services');
  for (const name of fs.readdirSync(servicesDir)) {
    if (!name.endsWith('.js')) continue;
    const body = stripComments(fs.readFileSync(path.join(servicesDir, name), 'utf8'));
    for (const call of body.match(/store\.(listProjects|getSubprojects)\([^;]*?\)/gs) || []) {
      if (!/actorIdentities|system:\s*true/.test(call)) offenders.push(`${name}: ${call.slice(0, 60)}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `unscoped project listings: ${offenders.join(' | ')}`);
});

test('a bound workspace outranks the actor\'s own org', () => {
  const workspace = require('../../src/services/workspaceService');
  // Without this an invited teammate resolves to the personal org their user row
  // was created in, joins a team, and sees an empty product.
  assert.strictEqual(
    workspace.defaultOwnerKey({ org_id: 'org_personal', workspace_key: 'org_acme' }),
    'org_acme'
  );
  assert.strictEqual(workspace.defaultOwnerKey({ org_id: 'org_personal' }), 'org_personal');
  assert.strictEqual(workspace.defaultOwnerKey({ id: 'user-1' }), 'user-1');
});

test('the workspace header is validated before anything reads data', () => {
  const body = stripComments(read('middleware/auth.js'));
  assert.ok(body.includes('bindWorkspace'), 'auth must bind a workspace');
  assert.ok(
    /resolveOwnerKey/.test(body),
    'the header must go through resolveOwnerKey, which checks membership'
  );
  assert.ok(
    !/workspace_key\s*=\s*(requested|req\.headers)/.test(body),
    'a client-supplied workspace must never be trusted straight onto the actor'
  );
});

// ---------------------------------------------------------------------------
// Identity: the person, not the credential
// ---------------------------------------------------------------------------

test('a key-authed actor attributes to its owner, not the key', () => {
  const workspace = require('../../src/services/workspaceService');
  // actor.id is the KEY id for key auth. Attributing to it made
  // listProjectContributors count credentials and call them teammates, and made
  // rotating a key turn you into a different person.
  assert.strictEqual(workspace.actorPersonId({ type: 'key', id: 'key_1', owner_id: 'user-7' }), 'user-7');
  assert.strictEqual(workspace.actorPersonId({ type: 'user', id: 'user-7' }), 'user-7');
  assert.strictEqual(workspace.actorPersonId({ type: 'system', id: 'system-key' }), null);
});

test('identity matching stays wide enough to find your own legacy rows', () => {
  const workspace = require('../../src/services/workspaceService');
  const ids = workspace.actorIdentities({ type: 'key', id: 'key_1', owner_id: 'user-7' });
  // Widening cannot leak across people — one person's key id is never another's
  // — while narrowing would hide somebody's own history from them.
  assert.ok(ids.includes('user-7') && ids.includes('key_1'));
});

test('attribution is written as the person at every write site', () => {
  const body = stripComments(read('services/contextSyncService.js'));
  assert.ok(
    !/owner_user_id:\s*actor\?\.id/.test(body),
    'project ownership must be stamped with actorPersonId, not the raw actor id'
  );
  assert.ok(
    !/recordEvent\([^)]*actor\?\.id\s*\|\|\s*null\)/.test(body),
    'event attribution must be stamped with actorPersonId'
  );
});

// ---------------------------------------------------------------------------
// Privacy: private has to mean private
// ---------------------------------------------------------------------------

test('sharing a workspace is not by itself project access', () => {
  const service = require('../../src/services/contextSyncService');
  const sarah = { id: 'user-sarah', org_id: 'org_acme', type: 'user', role: 'admin' };
  const marcusPrivate = {
    project_id: 'p1', owner_key: 'org_acme', owner_user_id: 'user-marcus', visibility: 'private',
  };
  // The old first line was `owner_key === actorKey`, and owner_key IS the org for
  // every project in it — so this returned true before visibility was consulted
  // and the whole ACL beneath it was unreachable.
  assert.strictEqual(
    service.canViewProjectForActor(sarah, marcusPrivate, { enabled: false }), false,
    'a teammate must not see a private project'
  );
  // Note role: 'admin' above — admin is the DEFAULT role in this codebase, so an
  // admin bypass here would have re-opened the leak for essentially everyone.
});

test('a shared project needs an enabled policy, and an owner always sees their own', () => {
  const service = require('../../src/services/contextSyncService');
  const sarah = { id: 'user-sarah', org_id: 'org_acme', type: 'user' };
  const shared = { owner_key: 'org_acme', owner_user_id: 'user-marcus', visibility: 'shared' };
  assert.strictEqual(service.canViewProjectForActor(sarah, shared, { enabled: true }), true);
  assert.strictEqual(service.canViewProjectForActor(sarah, shared, { enabled: false }), false);

  const hers = { owner_key: 'org_acme', owner_user_id: 'user-sarah', visibility: 'private' };
  assert.strictEqual(service.canViewProjectForActor(sarah, hers, { enabled: false }), true);

  // Unattributed = created before per-user attribution existed = belongs to the
  // workspace. Resolved to the founding owner the moment a second member joins.
  const legacy = { owner_key: 'org_acme', owner_user_id: null, visibility: 'private' };
  assert.strictEqual(service.canViewProjectForActor(sarah, legacy, { enabled: false }), true);

  // Another workspace entirely is never visible, whatever the policy says.
  const foreign = { owner_key: 'org_other', owner_user_id: 'user-sarah', visibility: 'shared' };
  assert.strictEqual(service.canViewProjectForActor(sarah, foreign, { enabled: true }), false);
});

test('a key-authed actor still owns their own project', () => {
  const service = require('../../src/services/contextSyncService');
  // actor.id is the API KEY id for key auth — which is nearly all MCP traffic —
  // while owner_user_id stores the person. Comparing the two directly makes you
  // fail the ownership check on your own project, so the visibility filter hides
  // your own private work from your own brief. Caught by layer3 on the way in.
  const viaKey = { type: 'key', id: 'key_abc', owner_id: 'user-sarah', org_id: 'org_acme' };
  const hers = { owner_key: 'org_acme', owner_user_id: 'user-sarah', visibility: 'private' };
  assert.strictEqual(service.canViewProjectForActor(viaKey, hers, { enabled: false }), true);

  const marcus = { owner_key: 'org_acme', owner_user_id: 'user-marcus', visibility: 'private' };
  assert.strictEqual(service.canViewProjectForActor(viaKey, marcus, { enabled: false }), false);
});

test('personal work is nobody else\'s, including the workspace owner\'s', () => {
  const service = require('../../src/services/contextSyncService');
  const owner = { id: 'user-owner', org_id: 'org_acme', type: 'user' };
  const personal = { owner_key: 'org_acme', owner_user_id: 'user-member', visibility: 'personal' };
  // The only rule a workspace owner cannot override, and the entire reason the
  // state exists: an independent side project that happens to live here is not
  // the org's to read.
  assert.strictEqual(
    service.canViewProjectForActor(owner, personal, { workspaceRole: 'owner', enabled: false }), false,
    'an owner must not read a colleague\'s personal project'
  );
});

test('org-owned private work is readable by an owner, and only readable', () => {
  const service = require('../../src/services/contextSyncService');
  const owner = { id: 'user-owner', org_id: 'org_acme', type: 'user' };
  const other = { id: 'user-other', org_id: 'org_acme', type: 'user' };
  const priv = { owner_key: 'org_acme', owner_user_id: 'user-member', visibility: 'private' };

  // Readable: it is org property, and an owner who cannot see it cannot pick it
  // up when its author leaves.
  assert.strictEqual(service.canViewProjectForActor(owner, priv, { workspaceRole: 'owner', enabled: false }), true);
  // But not by an ordinary member — private still means not shared.
  assert.strictEqual(service.canViewProjectForActor(other, priv, { workspaceRole: 'member', enabled: false }), false);
  // And not WRITABLE. Reading solves continuity; rewriting a colleague's brief
  // is a different power and nobody asked for it.
  assert.strictEqual(
    service.canEditSectionForActor(owner, priv, { workspaceRole: 'owner', enabled: false }, 'current_task'), false,
    'an owner reads org-owned private work but does not silently rewrite it'
  );
});

test('listings distinguish the two kinds of private', () => {
  const store = stripComments(fs.readFileSync(path.join(SRC, 'store', 'contextSyncStore.js'), 'utf8'));
  const clause = store.slice(store.indexOf('function visibilityClause'), store.indexOf('async function listProjects'));
  // 'personal' must appear in NEITHER branch: it is reachable only through
  // owner_user_id, so no role enumerates somebody else's personal work.
  assert.ok(!/'personal'/.test(clause), 'no role may enumerate personal work');
  assert.ok(/isWorkspaceOwner \? \['shared', 'private'\] : \['shared'\]/.test(clause),
    'an owner lists org-owned private work; a member does not');
});

test('work that predates the team becomes personal, not merely private', () => {
  const service = stripComments(read('services/workspaceService.js'));
  const fn = service.slice(service.indexOf('async function backfillProjectOwnership'));
  // 'private' is readable by a workspace owner, which is right for team work and
  // wrong for everything written when this workspace was one person's. The
  // guarantee has to hold against a FUTURE co-owner, not only against whoever is
  // being invited today.
  assert.ok(
    /SET visibility = 'personal'[\s\S]{0,120}visibility = 'private'/.test(fn),
    'pre-team private projects must be flipped to personal at the moment a second member joins'
  );
});

test('project listings filter on visibility, not just owner_key', () => {
  // Enumeration is a separate leak from access: with the access check fixed but
  // the listing unfiltered, every project list, map, tree and overview still
  // recited teammates' private project NAMES — and a project name is frequently
  // the client's name.
  const body = stripComments(fs.readFileSync(path.join(SRC, 'store', 'contextSyncStore.js'), 'utf8'));
  const listing = body.slice(body.indexOf('async function listProjects'), body.indexOf('async function setProjectArchived'));
  assert.ok(/visibilityClause/.test(listing), 'listProjects and getSubprojects must apply the visibility clause');
  assert.ok(
    /owner_user_id IS NULL OR owner_user_id = ANY/.test(body),
    'the clause must admit unattributed rows and match any of the actor identities'
  );
});

// ---------------------------------------------------------------------------
// Encryption: the control that never ran
// ---------------------------------------------------------------------------

test('encryption is gated on the master key alone', () => {
  const encryption = require('../../src/services/encryptionService');
  const previous = process.env.ENCRYPTION_MASTER_KEY;
  try {
    process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
    // The old gate read actor.plan_tier, which NO code path sets on an actor, so
    // it was `undefined === 'pro'` on every request and every customer's context
    // was written in plaintext. It must not depend on the actor at all now.
    assert.strictEqual(encryption.shouldEncrypt(), true);
    assert.strictEqual(encryption.shouldEncrypt({ plan_tier: 'free' }), true);
    assert.strictEqual(encryption.shouldEncrypt(null), true);
    delete process.env.ENCRYPTION_MASTER_KEY;
    assert.strictEqual(encryption.shouldEncrypt(), false);
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = previous;
  }
});

test('no plan or tier may gate encryption again', () => {
  const body = stripComments(read('services/encryptionService.js'));
  assert.ok(!/plan_tier/.test(body), 'encryption must not be tied to a billing tier');
});

// ---------------------------------------------------------------------------
// Entitlements: the uncapped sentinel
// ---------------------------------------------------------------------------

test('checkLimit guards on Number.isFinite, so null means uncapped', () => {
  const body = stripComments(read('services/entitlementService.js'));
  // `limit !== undefined` let null through, and `count >= null` coerces to
  // `count >= 0` — true for every count including zero. A null limit read that
  // way is not uncapped, it is a cap of ZERO that rejects the first request.
  // Adding a seat cap (null on the uncapped tiers) is exactly what detonates it.
  assert.ok(/Number\.isFinite\(limit\)/.test(body), 'checkLimit must use Number.isFinite');
  assert.ok(
    !/limit\s*!==\s*undefined\s*&&\s*currentCount\s*>=\s*limit/.test(body),
    'the undefined-guard form must not come back'
  );
});

// ---------------------------------------------------------------------------
// Entitlements follow the workspace
// ---------------------------------------------------------------------------

test('plan limits come from the workspace being worked in, not the person', () => {
  const service = stripComments(read('services/contextSyncService.js'));
  const portfolio = stripComments(read('services/portfolioService.js'));
  // `actor.org_id || getActorKey(actor)` short-circuits BEFORE the workspace is
  // consulted, so an invited teammate whose own account is on Free got Free's
  // limits — the history window, the skill cap — inside a workspace their
  // employer pays for.
  for (const [name, body] of [['contextSyncService', service], ['portfolioService', portfolio]]) {
    assert.ok(
      !/actor\?\.org_id \|\| getActorKey\(actor\)/.test(body),
      `${name} must not prefer the personal org over the bound workspace when resolving entitlements`
    );
  }
});

// ---------------------------------------------------------------------------
// Seats at checkout
// ---------------------------------------------------------------------------

test('the seat cap follows what was actually purchased', () => {
  const { getEntitlementsFromOrg } = require('../../src/services/entitlementService');
  const seats = (org) => getEntitlementsFromOrg(org).limits.included_seats;

  // Buying eight and being capped at the plan's five would lock a paying
  // customer out of their own workspace, with no way to tell it was our
  // arithmetic rather than theirs.
  assert.strictEqual(seats({ plan_tier: 'developer_pro', subscription_status: 'active', purchased_seats: 8 }), 8);
  // Buying fewer than the default caps at what is paid for, not at the default.
  assert.strictEqual(seats({ plan_tier: 'developer_pro', subscription_status: 'active', purchased_seats: 2 }), 2);
  // No purchased count on record falls back to the plan, never to zero.
  assert.strictEqual(seats({ plan_tier: 'developer_pro', subscription_status: 'active' }), 5);
  assert.strictEqual(seats({ plan_tier: 'developer_pro', subscription_status: 'active', purchased_seats: null }), 5);
});

test('a cancelled subscription stops granting the seats it bought', () => {
  const { getEntitlementsFromOrg } = require('../../src/services/entitlementService');
  const seats = (org) => getEntitlementsFromOrg(org).limits.included_seats;
  // Honouring a purchased count after churn keeps selling somebody something
  // they stopped paying for.
  for (const status of ['cancelled', 'unpaid', 'past_due']) {
    assert.strictEqual(
      seats({ plan_tier: 'developer_pro', subscription_status: status, purchased_seats: 8 }), 1,
      `${status} must fall back to the free cap`,
    );
  }
  // A stray value on a free row is ignored outright.
  assert.strictEqual(seats({ plan_tier: 'free', subscription_status: 'active', purchased_seats: 99 }), 1);
});

test('seats are read from the subscription, never from checkout metadata', () => {
  const hook = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'webhooks-stripe.js'), 'utf8'));
  // Metadata is a snapshot of what was chosen at purchase. adjustable_quantity
  // means the buyer may have changed it on Stripe's own page afterwards, and the
  // portal lets them change it again later — a cap sourced from the snapshot
  // drifts away from what is being charged within one billing change.
  assert.ok(/function getSeatsFromSubscription/.test(hook), 'seats come from the subscription');
  assert.ok(
    !/metadata\??\.seats/.test(hook),
    'the webhook must not source the cap from checkout metadata',
  );
  // Only the line whose price maps to a plan is a seat; an overage or add-on has
  // its own quantity.
  assert.ok(/priceToPlan\[priceId\]/.test(hook.slice(hook.indexOf('function getSeatsFromSubscription'))),
    'only a plan-mapped line item counts as seats');
});

test('churn clears the purchased seat count', () => {
  const hook = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'webhooks-stripe.js'), 'utf8'));
  const deleted = hook.slice(hook.indexOf('case \'customer.subscription.deleted\''));
  // Scoped to the churn BRANCH rather than the first N characters of the case.
  // The window was 700 characters and the double-billing fix put the
  // still-paying-for-something-else check ahead of it, which pushed the real
  // seat-clearing out of view — the guard would have read a stricter webhook as
  // a broken one. The property is "the branch that writes free clears seats".
  const churn = deleted.slice(deleted.indexOf('planId: \'free\''));
  assert.ok(/clearSeats: true/.test(churn.slice(0, 400)), 'a cancelled org must not keep a paid seat cap');
  // And the branch that ADOPTS a surviving subscription must write the seats
  // the survivor is billed for, and must not clear them: that org is still
  // paying for seats.
  //
  // Two spellings carry them. By name (`seats: survivorSeats`), or, since the
  // unrecognised-price rule (2026-09-28) put every subscription write through
  // subscriptionState, by spreading the survivor's subscriptionState into the
  // write — and then the seats are only there if subscriptionState itself reads
  // them off the subscription. Both halves are checked, so dropping the seats
  // from the write, overriding them after the spread, or dropping them from the
  // mapping each fails here. (Behaviour: stripe-webhook-unrecognised-price
  // .test.js, "a surviving subscription is adopted with the seats Stripe bills
  // for it".)
  const survivor = deleted.slice(0, deleted.indexOf('planId: \'free\''));
  const adoption = survivor.slice(survivor.indexOf('reconcileSubscriptionState('));
  const adoptionCall = adoption.slice(0, adoption.indexOf('});'));
  assert.ok(adoptionCall.length > 0, 'the survivor branch must write the survivor onto the org');
  const byName = /\bseats:\s*survivorSeats\b/.test(adoptionCall);
  const spreadName = (/const\s*\{[^}]*\.\.\.(\w+)\s*\}\s*=\s*subscriptionState\(\s*survivor\s*\)/.exec(survivor) || [])[1];
  const bySpread = Boolean(spreadName)
    && new RegExp(`\\.\\.\\.${spreadName}\\b`).test(adoptionCall)
    && !/\bseats\s*:/.test(adoptionCall);
  const mapping = hook.slice(hook.indexOf('function subscriptionState('));
  const mappingReturn = mapping.slice(mapping.indexOf('return {'));
  const mappingCarriesSeats = /\bseats:\s*getSeatsFromSubscription\(\s*sub\s*\)/.test(mappingReturn.slice(0, mappingReturn.indexOf('};')));
  assert.ok(byName || (bySpread && mappingCarriesSeats), 'an adopted subscription keeps the seats it is billed for');
  assert.ok(!/clearSeats:\s*true/.test(adoptionCall), 'adopting a survivor must not clear the seats it is paying for');
});

test('a per-seat plan is not checked out at quantity one', () => {
  const stripe = stripComments(read('services/stripeService.js'));
  // A per-seat plan billed at quantity 1 charges one person's price for a whole
  // team — silently, and in the customer's favour, which is the kind of billing
  // bug nobody reports.
  assert.ok(
    !/const lineItems = \[\{ price: basePriceId, quantity: 1 \}\]/.test(stripe),
    'the seat count must not be hard-coded to one',
  );
  assert.ok(/adjustable_quantity/.test(stripe), 'the buyer should be able to correct the count in Stripe');
});

test('the seat count from a browser is clamped, not trusted', () => {
  const stripe = stripComments(read('services/stripeService.js'));
  // Matches the SHAPE, not one spelling of it, and no longer assumes the clamp
  // is INLINE in createCheckoutSession: the plan-change path needs the identical
  // bound (an upgrade to Team must not land on one seat either), so the clamp
  // now lives in one helper both call. Pinning the old location would have read
  // that consolidation as the clamp being deleted.
  const clamp = stripe.slice(stripe.indexOf('function resolveSeatQuantity'));
  assert.ok(
    /Math\.max\(\s*\w+\s*,\s*Math\.min\(\s*\d+\s*,\s*Math\.floor\(\s*Number\(\s*seats/.test(clamp),
    'seats arrive from a client and must be bounded on both sides',
  );
  for (const caller of ['createCheckoutSession', 'changeSubscriptionPlan']) {
    const body = stripe.slice(stripe.indexOf(`async function ${caller}`));
    assert.ok(
      /resolveSeatQuantity\(/.test(body.slice(0, 3000)),
      `${caller} must resolve seats through the shared clamp, not its own arithmetic`,
    );
  }
  assert.ok(
    !/Math\.max\(\s*1\s*,\s*Math\.min/.test(clamp),
    'the lower bound must come from the plan, or a per-seat plan with a floor sells one seat',
  );
});

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

test('the plan named Team can actually manage a team', () => {
  const plans = require('../../src/config/plans');
  const team = plans.getPlan('developer_pro');
  assert.strictEqual(team.publicName, 'Team');
  // It shipped with this false while every /teams route gated on it, so buying
  // Team unlocked no team routes at all.
  assert.strictEqual(team.features.team_management, true);
  assert.strictEqual(team.account_type, 'organization');
  assert.ok(Number.isFinite(team.limits.included_seats) && team.limits.included_seats > 1);
});

test('every plan advertising team management has room for a second seat', () => {
  const plans = require('../../src/config/plans');
  for (const id of ['free', 'developer_basic', 'developer_pro', 'lifetime', 'enterprise']) {
    const plan = plans.getPlan(id);
    const seats = plan.limits.included_seats;
    if (!plan.features.team_management) continue;
    assert.ok(
      seats === null || seats === undefined || seats > 1,
      `${id} advertises team management but allows ${seats} seat(s)`
    );
  }
});

test('the seat cap is enforced on the invite and never on a read', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  assert.ok(/checkLimit\([^)]*included_seats/.test(teams), 'the invite route must check the seat cap');
  const service = stripComments(read('services/contextSyncService.js'));
  const catchup = stripComments(read('services/sessionCatchupService.js'));
  // A paywall that throws inside somebody's agent loop produces a broken loop and
  // a bug report, never an upgrade.
  for (const [name, body] of [['contextSyncService', service], ['sessionCatchupService', catchup]]) {
    assert.ok(!/included_seats/.test(body), `${name} must not gate a read on seats`);
  }
});

// ---------------------------------------------------------------------------
// Attribution in the brief
// ---------------------------------------------------------------------------

test('a decision keeps its original author across re-ingestion', () => {
  const sc = require('@deerdawn/shared-context');
  const base = sc.createContextObject({ project_name: 'payments-api' });
  base.recent_decisions = [{
    summary: 'Cache TTL is 30s',
    decided_at: '2026-08-20T10:00:00.000Z',
    contributed_by: 'user-sarah',
  }];
  const merged = sc.mergeContextObject(base, {
    recent_decisions: [{
      summary: 'Cache TTL is 30s',
      decided_at: '2026-08-28T10:00:00.000Z',
      contributed_by: 'user-marcus',
    }],
  }, 'test');
  const entry = merged.recent_decisions.find((d) => d.summary === 'Cache TTL is 30s');
  // Whoever recorded a claim FIRST is who learned it. A later session re-sending
  // the same decision is corroboration, not a change of authorship.
  assert.strictEqual(entry.contributed_by, 'user-sarah');
  assert.strictEqual(entry.confirmed_by, 'user-marcus');
});

test('a genuinely new decision is attributed to whoever wrote it', () => {
  const sc = require('@deerdawn/shared-context');
  const base = sc.createContextObject({ project_name: 'payments-api' });
  const merged = sc.mergeContextObject(base, {
    recent_decisions: [{
      summary: 'Retry on 429',
      decided_at: '2026-08-29T10:00:00.000Z',
      contributed_by: 'user-marcus',
    }],
  }, 'test');
  assert.strictEqual(
    merged.recent_decisions.find((d) => d.summary === 'Retry on 429').contributed_by,
    'user-marcus'
  );
});

test('an unattributed decision survives the merge without gaining an author', () => {
  const sc = require('@deerdawn/shared-context');
  const base = sc.createContextObject({ project_name: 'payments-api' });
  const merged = sc.mergeContextObject(base, {
    recent_decisions: [{ summary: 'Legacy call', decided_at: '2026-08-29T10:00:00.000Z' }],
  }, 'test');
  const entry = merged.recent_decisions.find((d) => d.summary === 'Legacy call');
  // Null must render as "unattributed" downstream, never silently as the reader.
  assert.ok(!entry.contributed_by, 'no author must be invented');
});

// ---------------------------------------------------------------------------
// The committable config
// ---------------------------------------------------------------------------

test('the workspace config carries no credential', () => {
  const { formatMcpJsonConfig } = require('@deerdawn/shared-context');
  // The whole mechanism depends on an admin COMMITTING this file, so a key in it
  // would land a live workspace credential in git history, where it outlives
  // every rotation. The formatter only embeds one when passed one; the route
  // must never pass one.
  const contents = formatMcpJsonConfig('https://api.deerdawn.com');
  assert.ok(!/API_KEY/i.test(contents), 'a committable config must contain no credential');
  assert.ok(!/dd_[A-Za-z0-9]/.test(contents), 'no key material of any shape');

  // Naming the WORKSPACE is not naming a credential, and the distinction has to
  // hold: a workspace key is an identifier, and the header it feeds is
  // membership-checked on every request. Adding it must smuggle nothing in.
  const withWorkspace = formatMcpJsonConfig('https://api.deerdawn.com', '', 'org-team-1234');
  assert.ok(!/API_KEY/i.test(withWorkspace), 'a committable config must contain no credential');
  assert.ok(!/dd_[A-Za-z0-9]/.test(withWorkspace), 'no key material of any shape');
  assert.ok(/"DEERDAWN_WORKSPACE": "org-team-1234"/.test(withWorkspace),
    'a team config has to say which workspace the repo belongs to, or an existing install stays where it is');
  assert.ok(!/DEERDAWN_WORKSPACE/.test(contents),
    'and a personal config must not: there is nothing to point it at');

  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const route = teams.slice(teams.indexOf('/workspace-config'), teams.indexOf('/members'));
  // The API-KEY argument is the one that would put a credential in the file, so
  // the pin is on that argument being empty rather than on the call's arity.
  assert.ok(/formatMcpJsonConfig\(apiUrl, ''/.test(route),
    'call the shared formatter with no API key');
  assert.ok(/contains_secrets: false/.test(route), 'and say plainly that it is safe to commit');
});

test('connector config is built by the shared formatter, not hand-rolled', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const route = teams.slice(teams.indexOf('/workspace-config'), teams.indexOf('/members'));
  // Connector copy has drifted between surfaces before; one canonical producer
  // is the fix, so this route must not grow its own JSON literal.
  assert.ok(!/mcpServers/.test(route), 'no second copy of the config shape lives here');
});

// ---------------------------------------------------------------------------
// Credentials follow the workspace
// ---------------------------------------------------------------------------

test('an API key is minted in the workspace the caller is operating in', () => {
  const keys = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'keys.js'), 'utf8'));
  // A key's org_id is what every later request resolves owner_key from. Minting
  // against req.actor.org_id — the personal org on the user row — sent an
  // invited teammate's whole agent loop into their own workspace, silently, with
  // the team product simply appearing empty.
  assert.ok(
    !/const orgId = req\.actor\.org_id/.test(keys),
    'key routes must resolve the workspace, not read the personal org'
  );
  assert.ok(/workspace\.defaultOwnerKey\(req\.actor\)/.test(keys), 'and must do it through the resolver');
});

// ---------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------

test('removing a member never deletes what they contributed', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const removal = teams.slice(teams.indexOf('router.delete(\'/members/:userId\''));
  assert.ok(/removeMember/.test(removal), 'removal goes through workspaceService.removeMember');
  // dataErasureService deletes by owner_key across a dozen tables — correct for
  // closing an entire workspace, catastrophic for removing one person.
  assert.ok(!/dataErasure/i.test(teams), 'member removal must never route through the erasure service');
  // Scoped to the REMOVAL handler, not the whole file. Other routes legitimately
  // delete — moving a project revokes its public share links — and a file-wide
  // scan would either fail on those or have to be loosened until it stopped
  // asserting anything about removal at all.
  assert.ok(
    !/DELETE\s+FROM\s+context_/i.test(removal),
    'member removal must not delete context rows',
  );

  const service = stripComments(read('services/workspaceService.js'));
  const fn = service.slice(service.indexOf('async function removeMember'));
  assert.ok(/UPDATE workspace_members SET removed_at/.test(fn.slice(0, 600)), 'removal is a soft delete');
});

test('removal revokes the departing member\'s credentials, and says if it could not', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const removal = teams.slice(teams.indexOf('router.delete(\'/members/:userId\''));
  assert.ok(/api_keys SET status/.test(removal), 'an unrevoked key keeps reading the workspace over MCP');
  // The column is `status`, not `revoked_at`. Naming a column that does not exist
  // would have thrown into a .catch() and reported a clean removal that revoked
  // nothing — the exact silent-success shape this codebase keeps producing.
  assert.ok(!/revoked_at/.test(removal), 'api_keys has no revoked_at column');
  assert.ok(
    /membership_removed_keys_not_revoked/.test(removal),
    'a failed revocation must be reported, not swallowed'
  );
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

test('an invite no longer mints a shell user row', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const invite = teams.slice(teams.indexOf('router.post(\'/invite\''), teams.indexOf('router.post(\'/invite/accept\''));
  // users.email is globally UNIQUE, so INSERTing a user for the invitee raised
  // 23505 for anyone who already had an account — the four engineers who had each
  // tried DeerDawn were exactly the four who could not be invited.
  assert.ok(!/INSERT INTO users/.test(invite), 'invites must not insert into users');
  assert.ok(/createInvite/.test(invite), 'invites are their own record');
  assert.ok(!/user_exists/.test(teams), 'the 23505 catch that hid this must be gone');
});

test('an invite is addressed to a person, not to whoever holds the link', () => {
  const service = stripComments(read('services/workspaceService.js'));
  const fn = service.slice(service.indexOf('async function acceptInvite'));
  assert.ok(/invitedEmail !== actorEmail/.test(fn), 'the redeeming account must match the invited email');
  assert.ok(/token_hash/.test(fn), 'only the hash of an invite token may be stored');
  for (const reason of ['expired', 'already_accepted', 'revoked', 'wrong_account']) {
    assert.ok(fn.includes(reason), `acceptInvite must distinguish '${reason}'`);
  }
});

// ---------------------------------------------------------------------------
// Presence names people
// ---------------------------------------------------------------------------

test('a session records who is driving it', () => {
  const store = stripComments(fs.readFileSync(path.join(SRC, 'store', 'contextSyncStore.js'), 'utf8'));
  assert.ok(
    /ADD COLUMN IF NOT EXISTS user_id TEXT/.test(store),
    'context_sessions must carry the person, or presence can only name a session id'
  );
  const upsert = store.slice(store.indexOf('async function saveSession'));
  // COALESCE, not EXCLUDED: a later write that happens not to carry an identity
  // must not anonymise a session that already had one.
  assert.ok(
    /user_id = COALESCE\(EXCLUDED\.user_id, context_sessions\.user_id\)/.test(upsert),
    'an identity-free write must not blank an established one'
  );
});

test('presence resolves a name, and only pays for it when there is a peer', () => {
  const service = stripComments(read('services/contextSyncService.js'));
  const fn = service.slice(service.indexOf('async function getProjectPresence'), service.indexOf('async function upsertSession'));
  assert.ok(/display_name/.test(fn), 'presence must expose a human-readable peer');
  assert.ok(
    /peers\.some\(\(p\) => p\.user_id && p\.user_id !== selfId\)/.test(fn),
    'the roster lookup must be skipped on a solo workspace'
  );
  // The deliberate omission of cwd/host predates this change and must survive it:
  // a peer on a shared workspace is a colleague on their own machine.
  assert.ok(!/\bcwd: peer\./.test(fn) && !/\bhost: peer\./.test(fn), 'presence must not leak a peer machine path');
});

// ---------------------------------------------------------------------------
// Seeding a team from git history
// ---------------------------------------------------------------------------

test('a git author email is resolved to a member and never stored', () => {
  const service = stripComments(read('services/contextSyncService.js'));
  const fn = service.slice(service.indexOf('async function resolveDecisionAuthors'), service.indexOf('async function recordEvent'));
  // The email is the WIRE form. Storing it would put a personal address into
  // every teammate's brief; it is destructured out and only the id persists.
  assert.ok(/author_email: authorEmail, \.\.\.rest/.test(fn), 'the email must be stripped, not carried through');
  assert.ok(!/contributed_by: authorEmail/.test(fn), 'an email is never an author id');
});

test('an unmatched git author is unattributed, not credited to the importer', () => {
  const service = stripComments(read('services/contextSyncService.js'));
  const fn = service.slice(service.indexOf('async function resolveDecisionAuthors'), service.indexOf('async function recordEvent'));
  // Falling back to the importer here would credit whoever ran the seed with
  // everything their colleagues had ever written — the single most misleading
  // thing this feature could do.
  assert.ok(/resolved \? \{ \.\.\.rest, contributed_by: resolved \} : rest/.test(fn),
    'no member match must mean unattributed');
});

test('the roster is only loaded when an import actually carried authorship', () => {
  const service = stripComments(read('services/contextSyncService.js'));
  const fn = service.slice(service.indexOf('async function resolveDecisionAuthors'), service.indexOf('async function recordEvent'));
  assert.ok(/if \(emails\.size\)/.test(fn), 'a normal session write must not pay for a roster query');
});

// ---------------------------------------------------------------------------
// Domain joining
// ---------------------------------------------------------------------------

test('a public email provider can never be approved as a company domain', () => {
  const workspace = require('../../src/services/workspaceService');
  // Approving gmail.com would let anyone on earth join, and the person adding it
  // would not find out until it happened. Refused, not warned about.
  for (const domain of ['gmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'yahoo.com']) {
    assert.strictEqual(workspace.isPublicEmailDomain(domain), true, `${domain} must be refused`);
  }
  assert.strictEqual(workspace.isPublicEmailDomain('acme.com'), false);
  // Case and a leading @ are both things a person will type.
  assert.strictEqual(workspace.isPublicEmailDomain('@GMAIL.com'), true);
});

test('a domain offer is checked again at the moment it is accepted', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const accept = teams.slice(teams.indexOf('/joinable/:workspaceKey/accept'));
  // An offer is not a grant: the domain may have been revoked between the
  // listing and the click, and trusting the client's copy would make revocation
  // meaningless for anyone who already had the page open.
  assert.ok(/joinableWorkspaces\(req\.actor\.email\)/.test(accept), 'eligibility is re-derived, not trusted');
  assert.ok(/not_joinable/.test(accept), 'and refused when it no longer holds');
});

test('domain membership is offered, never applied automatically', () => {
  const service = stripComments(read('services/workspaceService.js'));
  const fn = service.slice(service.indexOf('async function joinableWorkspaces'));
  // Joining makes your work visible to other people. Nothing in the lookup path
  // may write a membership.
  assert.ok(!/addMember/.test(fn.slice(0, 900)), 'listing eligibility must not join anybody');
});

// ---------------------------------------------------------------------------
// Moving a project between workspaces
// ---------------------------------------------------------------------------

test('a moved project arrives private, never shared', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const move = teams.slice(teams.indexOf('/projects/:projectId/move'), teams.indexOf('/domains'));
  // Where it lives and who can read it are two decisions. Collapsing them makes
  // the move itself feel unsafe, so nobody moves anything.
  assert.ok(/visibility = 'private'/.test(move), 'a move must not publish the project');
  assert.ok(!/visibility = 'shared'/.test(move));
});

test('a move carries the project history, and says so when it cannot', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const move = teams.slice(teams.indexOf('/projects/:projectId/move'), teams.indexOf('/domains'));
  for (const table of ['context_sessions', 'context_session_loads']) {
    assert.ok(move.includes(table), `${table} must follow the project`);
  }
  // The graph follows by SIGHTING (workspaceService.carryProjectGraph), never
  // row-for-row by project_id: a node carries only the FIRST project that saw
  // it, so moving nodes by project_id took entities the rest of the workspace
  // still used (scan 13). This pin used to require the graph tables on the
  // row-for-row list, which is the bug.
  assert.ok(/workspace\.carryProjectGraph\(/.test(move), 'the graph must follow through carryProjectGraph');
  assert.ok(!/'context_graph_(nodes|edges|evidence)'/.test(move), 'graph tables must not be moved by project_id');
  // Reporting a clean move over a partial one is the failure this codebase keeps
  // producing; a half-moved project found weeks later is far worse than one
  // named at the time.
  assert.ok(/partial_move/.test(move), 'a partial move must be reported, not swallowed');
  // Share links minted while it was personal must not keep serving once it
  // belongs to a company workspace.
  assert.ok(/DELETE FROM context_share_tokens/.test(move), 'public links are revoked on a move');
});

test('the audit trail does not move with the project', () => {
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  const move = teams.slice(teams.indexOf('/projects/:projectId/move'), teams.indexOf('/domains'));
  // Those events happened in the other workspace. A log that relocates is not
  // much of a log — the move itself is recorded in both instead.
  assert.ok(!/UPDATE context_audit_logs/.test(move), 'history must not be rewritten by a move');
  assert.ok(/project_moved_out/.test(move), 'the origin workspace records the departure');
});

// ---------------------------------------------------------------------------
// Board assignment
// ---------------------------------------------------------------------------

test('assigning a card does not move it to another column', () => {
  const sc = require('@deerdawn/shared-context');
  let ctx = sc.createContextObject({ project_name: 'p' });
  ctx = sc.mergeContextObject(ctx, { add_todos: [{ title: 'Ship the audit view', phase: 'in_progress' }] }, 't');
  ctx = sc.mergeContextObject(ctx, { move_todos: [{ match: 'Ship the audit view', assignee: 'user-sarah' }] }, 't');
  const card = ctx.todo_items.find((c) => c.title === 'Ship the audit view');
  assert.strictEqual(card.assignee, 'user-sarah');
  // normalizeBoardPhase turns an absent phase into Backlog, so reading it
  // unconditionally would drag the card out of its column every time somebody
  // assigned it — a change nobody asked for, as a side effect of another.
  assert.strictEqual(card.phase, 'in_progress', 'assignment must not re-column the card');
});

test('an assignment can be cleared, because unassigned is a real state', () => {
  const sc = require('@deerdawn/shared-context');
  let ctx = sc.createContextObject({ project_name: 'p' });
  ctx = sc.mergeContextObject(ctx, { add_todos: [{ title: 'Ship the audit view', assignee: 'user-sarah' }] }, 't');
  ctx = sc.mergeContextObject(ctx, { move_todos: [{ match: 'Ship the audit view', assignee: null }] }, 't');
  assert.strictEqual(ctx.todo_items.find((c) => c.title === 'Ship the audit view').assignee, null);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('the audit log records who, and covers membership changes', () => {
  const routes = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'context', 'context-sync.js'), 'utf8'));
  assert.ok(/actor_user_id/.test(routes), 'context audit writes must carry an actor');
  const teams = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'shared', 'teams.js'), 'utf8'));
  for (const action of ['member_invited', 'invite_accepted', 'member_removed', 'role_changed', 'invite_revoked']) {
    assert.ok(teams.includes(action), `'${action}' must be audited — it is what a team audit is read for`);
  }
});

test('a key-authed action is attributed to the key owner in the audit log', () => {
  const routes = fs.readFileSync(path.join(SRC, 'routes', 'context', 'context-sync.js'), 'utf8');
  const fn = routes.slice(routes.indexOf('function actorUserId'), routes.indexOf('function logContextAudit'));
  assert.ok(/owner_id/.test(fn), 'a key id is not an answer to "who"');
});

(async () => {
  console.log('=== Teams / multi-user workspace tests ===\n');
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  }
})();
