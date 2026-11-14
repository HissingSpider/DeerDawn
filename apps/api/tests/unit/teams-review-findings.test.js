'use strict';

// One guard per defect found reviewing the multi-user workspace change.
//
// Same reasoning as teams-multi-user.test.js, and it applies harder here: every
// one of these bugs was a control that silently did nothing, or a guard whose
// condition could never be true. Nothing threw, nothing 500'd, nothing went red
// — a viewer could delete a company's workspace and get a 200 back. The only
// test that catches the reintroduction of a no-op is one that reads the code.
//
// Where a real behavioural assertion is possible without a database, it is used
// (see the scope-ceiling and sentinel tests below).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// Comment-blind, for the same reason the sibling suite is: these files explain
// the bug in prose directly above the fix, so a raw scan would pass on the
// explanation and deleting the comment would be the fastest route to green.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// --- Finding 1: DELETE /account could purge a workspace the caller merely joined.

test('account deletion is gated on the workspace role, not the org-level scope', () => {
  const src = stripComments(read(path.join('routes', 'context', 'context-sync.js')));
  const start = src.indexOf('router.delete(\'/account\'');
  assert.ok(start > -1, 'DELETE /account must exist to be guarded');
  const handler = src.slice(start, start + 2000);

  assert.ok(
    /resolveRole\s*\(/.test(handler) && /canAdminister\s*\(/.test(handler),
    'DELETE /account must resolve the WORKSPACE role. requireContextAdmin only checks the ' +
    'context:admin scope, which comes from users.role — "owner" for every self-signup — so ' +
    'on a bound workspace it separates nobody from anybody.'
  );
  assert.ok(
    /isSharedWorkspace\s*\(/.test(handler),
    'DELETE /account must refuse a workspace that still has other members. "Delete my account" ' +
    'must never be a route to destroying other people\'s work.'
  );
});

// --- Finding 5: key management authorized on users.role while scoped to the workspace.

test('key routes authorize on workspace membership, not requireRole(users.role)', () => {
  const src = stripComments(read(path.join('routes', 'shared', 'keys.js')));
  assert.ok(
    !/requireRole\s*\(/.test(src),
    'keys.js must not gate on requireRole: it reads users.role, which is "owner" for every ' +
    'self-signup, while the key it mints is stamped with the BOUND workspace.'
  );
  // Membership, not write access (scan 11): requiring canWrite() refused a
  // viewer any key and left grantableScopes('viewer') dead. The role still
  // sets the ceiling below, so a viewer's key is read-only.
  assert.ok(
    /resolveRole\s*\(/.test(src) && /getMembership\s*\(/.test(src),
    'minting a workspace credential must require membership in that workspace'
  );
  assert.ok(
    /grantableScopes\s*\(/.test(src),
    'a key must never carry scopes its creator does not hold, or it becomes a privilege ladder'
  );
  assert.ok(
    /owner_id\s*=\s*ANY/.test(src) || /actorIdentities/.test(src),
    'the key listing must be scoped to the caller unless they administer the workspace'
  );
  // Role and scope are different axes. Dropping requireRole fixed the role one
  // and would have left the credential one open: a context:read key could mint
  // itself a context:write key, since its holder's ROLE is usually owner.
  // A credential must not mint or revoke a credential. Key actors carry a
  // hard-coded role ('operator' -> member) that describes the KEY, not the
  // person, so a role check alone reads every API key as a writer and lets a
  // leaked one issue more.
  assert.ok(
    (src.match(/req\.actor\?\.type === 'key'/g) || []).length >= 2,
    'both the create and delete key routes must refuse key actors outright'
  );
  const writers = src.match(/router\.(post|delete)\([^)]*\)/g) || [];
  assert.strictEqual(writers.length, 2, 'expected exactly the create and delete key routes');
  for (const route of writers) {
    assert.ok(
      /requireAnyScope/.test(route),
      `a key route must gate on the credential's scope as well as the person's role: ${route}`
    );
  }
});

test('a role can never grant a scope above itself', () => {
  const workspace = require(path.join(SRC, 'services', 'workspaceService.js'));
  assert.deepStrictEqual(workspace.grantableScopes('viewer'), ['context:read']);
  assert.ok(!workspace.grantableScopes('member').includes('context:admin'),
    'a member minting a context:admin key would reach owner-only routes their session is refused');
  assert.ok(workspace.grantableScopes('owner').includes('context:admin'));
  // Fails closed: an unrecognised role gets the least privilege, never the most.
  assert.deepStrictEqual(workspace.grantableScopes('nonsense'), ['context:read']);
  assert.deepStrictEqual(workspace.grantableScopes(undefined), ['context:read']);
});

// --- Findings 7 and 8: unguarded structural mutations, and an unfiltered listing.

test('every structural project mutation goes through one permission guard', () => {
  const src = stripComments(read(path.join('services', 'contextSyncService.js')));
  assert.ok(/async function assertProjectMutable\s*\(/.test(src),
    'the three mutations need a shared guard, not three remembered checks');

  // The body of ONE function: from its declaration to the next top-level
  // declaration. This used to be a fixed 700-character window, and a window
  // leaks: switchSubproject "passed" for months only because archiveProject,
  // declared right after it, put its own assertProjectMutable( call inside
  // switchSubproject's 700 characters. The day a function was added between
  // them the test went red, and what it had been vouching for was never there.
  const bodyOf = (fn) => {
    const start = src.indexOf(`async function ${fn}(`);
    assert.ok(start > -1, `${fn} must exist`);
    const next = src.slice(start + 1).search(/\n(?:async )?function \w+\s*\(/);
    return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
  };

  for (const fn of ['setProjectParent', 'archiveProject', 'unarchiveProject']) {
    assert.ok(
      /assertProjectMutable\s*\(/.test(bodyOf(fn)),
      `${fn} must check permission. Scoped by owner_key alone it is not a check at all on a ` +
      'shared workspace, and manage_projects exposes archive/restore straight to MCP.'
    );
  }

  // Choosing where YOU work is not a mutation of the project: the pin and the
  // session binding are both filed per person and change nothing anybody else
  // reads, so a viewer may select any project they can read. What they must
  // never do is select one they cannot read, so the gate these two need is the
  // visibility-filtered getProject, and an owner_key-scoped store read would be
  // the hole.
  for (const fn of ['switchSubproject', 'bindSessionToProject']) {
    const body = bodyOf(fn);
    assert.ok(
      /await getProject\s*\(\s*actor\s*,/.test(body),
      `${fn} must resolve the project through getProject(actor, ...), the visibility gate`
    );
    assert.ok(
      !/store\.getProject\s*\(/.test(body),
      `${fn} reads the project straight from the store, which is scoped by owner_key alone`
    );
  }
});

test('deleting a project goes through the same guard as archiving it', () => {
  const routes = stripComments(read(path.join('routes', 'context', 'context-sync.js')));
  const start = routes.indexOf('router.delete(\'/projects/:projectId\'');
  assert.ok(start > -1, 'DELETE /projects/:projectId must exist');
  const body = routes.slice(start, start + 900);
  assert.ok(
    /assertProjectMutable\s*\(/.test(body),
    'DELETE /projects/:projectId must use assertProjectMutable. getProject only answers whether ' +
    'someone may READ it, so a viewer on a shared workspace could delete a teammate\'s project.'
  );
  assert.ok(!/service\.getProject\s*\(/.test(body), 'the read path is not a permission check for a delete');
});

test('the archived-project listing is filtered like every other listing', () => {
  const store = stripComments(read(path.join('store', 'contextSyncStore.js')));
  const start = store.indexOf('async function listArchivedProjects(');
  assert.ok(start > -1, 'listArchivedProjects must exist');
  const body = store.slice(start, start + 900);
  assert.ok(
    /visibilityClause\s*\(/.test(body),
    'listArchivedProjects must use visibilityClause. It feeds the start_session notice, which ' +
    'recites project NAMES — so an unfiltered read hands a viewer the name and id of a ' +
    'teammate\'s archived personal project.'
  );

  const service = stripComments(read(path.join('services', 'contextSyncService.js')));
  const wrapper = service.slice(service.indexOf('async function listArchivedProjectSummaries('), service.indexOf('async function unarchiveProject('));
  assert.ok(/actorIdentities/.test(wrapper),
    'the caller must pass identities through, or visibilityClause fails closed and returns nothing');
});

// --- Finding 2: the data key that was never read back.

test('getDek uses the key the database kept, not the one it generated', () => {
  const src = stripComments(read(path.join('services', 'encryptionService.js')));
  const start = src.indexOf('async function getDek(');
  assert.ok(start > -1, 'getDek must exist');
  const body = src.slice(start, src.indexOf('function shouldEncrypt') > start ? src.indexOf('function shouldEncrypt') : start + 3000);

  assert.ok(
    /ON CONFLICT[\s\S]*?DO NOTHING[\s\S]*?RETURNING/i.test(body),
    'the INSERT must RETURNING so the caller learns whether it won. Without that, two ' +
    'concurrent first writes for one owner produce two keys — one stored, one used to encrypt ' +
    'a row nothing can ever decrypt.'
  );
  assert.ok(
    /inserted\.rows\.length/.test(body) && /SELECT encrypted_dek/.test(body.slice(body.indexOf('RETURNING'))),
    'on losing the race it must re-read and use the stored key'
  );
});

// --- Finding 3: the fail-closed sentinel, written back over the data it stood for.

test('a context that failed to decrypt can never be saved over the original', () => {
  const store = stripComments(read(path.join('store', 'contextSyncStore.js')));
  const start = store.indexOf('async function saveProject(');
  assert.ok(start > -1, 'saveProject must exist');
  const body = store.slice(start, start + 1600);
  assert.ok(
    /_decrypt_error/.test(body),
    'saveProject must refuse { _decrypt_error: true }. rowToProject substitutes it when ' +
    'decryption fails, so the ordinary read-merge-save loop would encrypt the marker over the ' +
    'still-recoverable ciphertext and report success.'
  );
});

// --- Finding 4: a re-seal guarded on a column the query never selected.

test('the project move reads the context it claims to re-encrypt', () => {
  const src = read(path.join('routes', 'shared', 'teams.js'));
  const start = src.indexOf('router.post(\'/projects/:projectId/move\'');
  assert.ok(start > -1, 'the move route must exist');
  // Up to the UPDATE that moves owner_key: the re-seal has to precede it, and
  // a fixed character window broke on every guard added above the re-seal.
  const end = src.indexOf('SET owner_key = $2', start);
  assert.ok(end > start, 'the move must update owner_key');
  const handler = src.slice(start, end);

  const select = handler.match(/SELECT ([^']*?) FROM context_projects/);
  assert.ok(select, 'the move must read the project row');
  assert.ok(
    /\bcontext\b/.test(select[1]),
    'the SELECT must include `context`. The re-seal below is guarded on project.context, so ' +
    'omitting the column made the guard permanently false: the row moved with ciphertext still ' +
    'sealed under the source workspace\'s key, and every later read failed its auth tag.'
  );
  assert.ok(
    /encryptContextObject\s*\(\s*target/.test(stripComments(handler)),
    'the context must be re-sealed under the TARGET workspace key before owner_key moves'
  );
});

// --- Finding 6: the workspace nobody could select from an MCP client.

test('a session with no header resolves the workspace the person chose', () => {
  const auth = stripComments(read(path.join('middleware', 'auth.js')));
  // Anchored on the function that actually does the resolving rather than on
  // bindWorkspace plus a byte count: the original slice of 2500 characters from
  // bindWorkspace ran out the moment anything was added between the two, and
  // reported the fallback as missing when it was three functions further down.
  const start = auth.indexOf('async function resolveWorkspaceBinding(');
  assert.ok(start > -1, 'resolveWorkspaceBinding must exist');
  const end = auth.indexOf('async function fallBackToPersonalWorkspace(', start);
  const body = auth.slice(start, end > start ? end : start + 4000);
  assert.ok(
    /getActiveWorkspace\s*\(/.test(body),
    'the header-less path must consult the stored active workspace. An MCP ' +
    'client cannot send one and its OAuth token carries the personal org, so without this an ' +
    'invited teammate\'s whole agent loop resolves to their own empty workspace.'
  );
  // ...and only for the credentials that cannot name a workspace themselves. A
  // dashboard-minted or device-flow API KEY carries the workspace it was minted
  // against; letting it follow the active row instead moved somebody's personal
  // key into the team the moment they accepted an invite.
  assert.ok(
    /credentialFollowsActiveWorkspace\s*\(/.test(body),
    'the fallback must be narrowed to credentials that cannot express a workspace'
  );

  const workspace = require(path.join(SRC, 'services', 'workspaceService.js'));
  assert.strictEqual(typeof workspace.getActiveWorkspace, 'function');
  assert.strictEqual(typeof workspace.setActiveWorkspace, 'function');
});

// --- Finding 9: a second admission door with no seat gate on it.

test('domain join is gated exactly as invite is', () => {
  const src = stripComments(read(path.join('routes', 'shared', 'teams.js')));
  const start = src.indexOf('router.post(\'/joinable/:workspaceKey/accept\'');
  assert.ok(start > -1, 'the domain-join route must exist');
  const handler = src.slice(start, start + 2000);

  // The cap is enforced INSIDE addMember's per-workspace lock (scan 13):
  // counted in the handler, concurrent joiners each saw the same free seat.
  // This pin used to require checkLimit in the handler, which is the race.
  assert.ok(
    /addMember\([^)]*seatCheck/.test(handler),
    'domain join must enforce the seat cap. Without it a workspace that correctly 402s on ' +
    'invite six still admits employees six through forty through the domain door, unbilled.'
  );
  const service = stripComments(read(path.join('services', 'workspaceService.js')));
  const addMember = service.slice(service.indexOf('async function addMember'), service.indexOf('async function hasEverHeldTwoMembers'));
  assert.ok(/if \(seatCheck\)[\s\S]*checkLimit\s*\(/.test(addMember), 'addMember enforces the cap under its lock');
  assert.ok(
    /ensureTeamAccessFor\s*\(/.test(handler),
    'domain join must check the team_management entitlement against the TARGET workspace'
  );
  assert.ok(
    /402/.test(handler),
    'a full workspace is a billing answer, not a 500'
  );
});

// --- Finding 10: a one-time repair executed on every boot.

test('the attribution repair runs once, not on every start', () => {
  const src = stripComments(read(path.join('config', 'autoMigrate.js')));
  assert.ok(
    /context_migrations/.test(src),
    'a marker table must record that the repair ran'
  );
  const start = src.indexOf('UPDATE context_projects p');
  assert.ok(start > -1, 'the repair must still exist');
  const before = src.slice(Math.max(0, start - 1200), start);
  // Quote-agnostic: eslint --fix rewrites string delimiters, and a guard that
  // breaks when the linter reformats the line it watches is a guard that will be
  // deleted rather than understood.
  assert.ok(
    /SELECT 1 FROM context_migrations WHERE name = \\?'attribution_key_to_person_v1/.test(before),
    'the three unbounded UPDATEs must be skipped once applied. Re-running them every boot ' +
    'inside the migration transaction means the first boot that exceeds the statement timeout ' +
    'rolls back and retries the same work forever.'
  );
});

// --- Follow-ups the review named but did not fix.

test('every checkout path carries a seat count', () => {
  // Seat plumbing existed in stripeService and no caller used it, so isPerSeat
  // computed a quantity nobody passed: a per-seat plan billed one seat's price
  // for a whole team, silently and correctly-looking.
  for (const route of ['billing.js', 'orgs.js']) {
    const src = stripComments(read(path.join('routes', 'shared', route)));
    const call = src.match(/createCheckoutSession\([^)]*\{[^}]*\}/s);
    assert.ok(call, `${route} must call createCheckoutSession`);
    assert.ok(/seats/.test(call[0]), `${route} must pass seats through to checkout`);
  }
});

test('the workspace switch is written to the server, not only this browser', () => {
  const nav = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'dashboard', 'src', 'components', 'layout', 'TopNav.tsx'),
    'utf8'
  );
  assert.ok(
    /setActiveWorkspaceOnServer/.test(nav),
    'the switcher must persist server-side. localStorage plus a header is a ' +
    'browser-only choice, and an MCP client cannot send that header — so the ' +
    'dashboard and the person\'s agent sessions would disagree about which ' +
    'workspace they are in.'
  );
});

(async () => {
  console.log('=== Teams review findings — one guard per defect ===\n');
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
