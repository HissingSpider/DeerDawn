/**
 * Hosted connector session identity.
 *
 * The hosted MCP transport is stateless, so it used to mint a fresh
 * `mcp-remote-${Date.now()}` on every write. Everything that counts agents —
 * presence, board holds, the contention baseline — counts DISTINCT session ids,
 * so one web client writing five times read as five colliding agents. That is
 * what produced the bogus 54.8% in the first production baseline.
 *
 * The property that fixes it is STABILITY, so that is what most of these guard:
 * the same person on the same surface must always produce the same id, with no
 * time component that could split one session across a boundary.
 *
 * The separation tests matter as much now. Presence names people, so two
 * colleagues sharing a workspace must NOT share a session id — that would
 * attribute one person's writing to the other.
 *
 * Pure (no DB). Run: node --test tests/unit/hosted-session-identity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { hostedSessionId, hostedSessionTool } = require('../../src/services/hostedSessionIdentity');
const { isSyntheticSessionId } = require('../../scripts/multi-agent-baseline.js');

const actor = { id: 'user-123' };

test('the same person and surface always produce the same id', () => {
  // The whole point. If this ever varies, every count of distinct agents
  // silently inflates again.
  assert.equal(hostedSessionId(actor, 'claude_web'), hostedSessionId(actor, 'claude_web'));
});

test('the id has no time component', () => {
  // A time bucket would split one session at the boundary and reintroduce the
  // over-count in slower motion, so assert there is no timestamp in there.
  const id = hostedSessionId(actor, 'claude_web');
  assert.doesNotMatch(id, /[0-9]{10,}/);
});

test('different surfaces for one person are different sessions', () => {
  // This is the case the feature exists for: a web conversation and an editor
  // agent writing to the same project must be visible to each other.
  assert.notEqual(hostedSessionId(actor, 'claude_web'), hostedSessionId(actor, 'chatgpt_web'));
});

test('different people are different sessions', () => {
  assert.notEqual(hostedSessionId({ id: 'user-1' }, 'claude_web'), hostedSessionId({ id: 'user-2' }, 'claude_web'));
});

test('two colleagues in ONE workspace are two sessions, not one', () => {
  // The change from the original single-user design. Deriving from the owner key
  // alone collapsed everyone in a shared workspace into one session — an
  // acceptable under-count when presence was anonymous, and wrong now that it
  // names people: it would show Sarah's writing under Alex's name, or hide one
  // of them from the other entirely.
  const sarah = hostedSessionId({ id: 'user-sarah', org_id: 'org-acme' }, 'claude_web');
  const alex = hostedSessionId({ id: 'user-alex', org_id: 'org-acme' }, 'claude_web');
  assert.notEqual(sarah, alex);
});

test('one person in two workspaces is two sessions', () => {
  // The id labels a row that lives in a specific workspace, so it has to be
  // keyed to the workspace the write actually lands in.
  const personal = hostedSessionId({ id: 'user-1', org_id: 'org-personal' }, 'claude_web');
  const team = hostedSessionId({ id: 'user-1', org_id: 'org-personal', workspace_key: 'org-acme' }, 'claude_web');
  assert.notEqual(personal, team);
});

test('the bound workspace wins over the signup org', () => {
  // defaultOwnerKey prefers workspace_key, and every store call resolves the
  // same way — an id keyed to the personal org would label a row living in the
  // team workspace.
  const a = hostedSessionId({ id: 'user-1', org_id: 'org-personal', workspace_key: 'org-acme' }, 'claude_web');
  const b = hostedSessionId({ id: 'user-1', org_id: 'org-other', workspace_key: 'org-acme' }, 'claude_web');
  assert.equal(a, b);
});

test('one person\'s two CONNECTIONS are two sessions', () => {
  // CHANGED DELIBERATELY. This used to assert the opposite — one person is one
  // session across their own keys — on the reasoning that actor.id is the key
  // id, so deriving from it is an over-count in another costume. That was true
  // while nothing hung off a session id. It stopped being true when a project
  // BINDING did: one shared row meant a claude.ai tab's write moved where an
  // editor connector's next id-less read and write landed. Two credentials are
  // two connectors, and a connector is what a person is actually working in.
  const one = hostedSessionId({ type: 'key', id: 'key-aaa', owner_id: 'user-7', org_id: 'org-1' }, 'claude_web');
  const two = hostedSessionId({ type: 'key', id: 'key-bbb', owner_id: 'user-7', org_id: 'org-1' }, 'claude_web');
  assert.notEqual(one, two);
});

test('one connection keeps its identity across a token refresh', () => {
  // The other half of the same decision, and the reason the OAuth client id is
  // stored on the key at all: a refresh grant mints a NEW api_keys row, so
  // keying on the key id would silently orphan this connection's project
  // binding about once a month, only for the people using the product most.
  const before = hostedSessionId({ type: 'key', id: 'key-old', owner_id: 'user-7', org_id: 'org-1', oauth_client_id: 'https://claude.ai/c' }, 'claude_web');
  const after = hostedSessionId({ type: 'key', id: 'key-new', owner_id: 'user-7', org_id: 'org-1', oauth_client_id: 'https://claude.ai/c' }, 'claude_web');
  assert.equal(before, after);
});

test('two OAuth clients for one person are two sessions', () => {
  const browser = hostedSessionId({ type: 'key', id: 'key-1', owner_id: 'user-7', org_id: 'org-1', oauth_client_id: 'https://claude.ai/c' }, 'claude_web');
  const editor = hostedSessionId({ type: 'key', id: 'key-2', owner_id: 'user-7', org_id: 'org-1', oauth_client_id: 'https://chatgpt.com/c' }, 'claude_web');
  assert.notEqual(browser, editor);
});

test('a declared tool cannot give one connection two identities', () => {
  // The id is what a binding hangs off, so one argument on one call must not be
  // able to move it. With a credential to key on, the label comes from the
  // credential and `tool` is ignored.
  const connection = { type: 'key', id: 'key-1', owner_id: 'user-7', org_id: 'org-1', oauth_client_id: 'https://claude.ai/c' };
  assert.equal(hostedSessionId(connection, 'claude_web'), hostedSessionId(connection, 'chatgpt_web'));
  assert.equal(hostedSessionId(connection), hostedSessionId(connection, 'claude_web'));
});

test('the label on the id names the real client', () => {
  // "via claude_web" for a Claude Code connector was the visible half of the
  // same defect. The registered name is checked before the host, because an
  // editor and a browser can both be registered under the same domain.
  const editor = { type: 'key', id: 'key-1', owner_id: 'user-7', org_id: 'org-1', oauth_client_id: 'https://claude.ai/code', oauth_client_name: 'Claude Code' };
  assert.match(hostedSessionId(editor, 'claude_web'), /^web-claude_code-/);
  assert.equal(hostedSessionTool(editor, undefined, 'unknown_web'), 'claude_code');
  // A caller that names its own surface is believed.
  assert.equal(hostedSessionTool(editor, 'cursor', 'unknown_web'), 'cursor');
  // And an unrecognised client still yields something the session schema accepts.
  assert.equal(hostedSessionTool({ type: 'key', id: 'k' }, undefined, 'unknown_web'), 'claude_web');
});

test('neither the owner key nor the person is exposed in the id', () => {
  const id = hostedSessionId({ id: 'user-secret-value', org_id: 'org-confidential' }, 'claude_web');
  assert.doesNotMatch(id, /secret/);
  assert.doesNotMatch(id, /confidential/);
});

test('a hostile tool value cannot inflate or break the id', () => {
  // `tool` is caller-declared and ends up inside a stored identifier.
  const id = hostedSessionId(actor, 'a'.repeat(500) + '/../../etc/passwd');
  assert.ok(id.length < 80, `id should stay bounded, got ${id.length}`);
  assert.doesNotMatch(id, /[/.]/);
});

test('a missing actor still yields a usable id', () => {
  // Never throw on a write path whose real job is saving someone's context.
  assert.ok(hostedSessionId(null, 'claude_web').length > 0);
  assert.ok(hostedSessionId(undefined, undefined).length > 0);
});

test('the derived id is NOT excluded by the baseline as a per-write id', () => {
  // The two have to agree: this id is stable and must keep counting, while the
  // timestamped ones must not. If the baseline pattern ever widened to catch
  // this prefix, web surfaces would silently vanish from contention.
  assert.equal(isSyntheticSessionId(hostedSessionId(actor, 'claude_web')), false);
  assert.equal(isSyntheticSessionId('mcp-remote-1787195137123'), true);
});

test('the hosted dispatcher no longer mints an id per write', () => {
  // The defect this exists to remove, pinned at its call site: a source-text
  // check because the failure is a line that looks unremarkable and silently
  // multiplies every agent count downstream.
  const fs = require('fs');
  const path = require('path');
  const mcp = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'routes', 'mcp.js'), 'utf8');
  const code = mcp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /`mcp-remote-\$\{Date\.now\(\)\}`/);
  assert.match(code, /hostedSessionId\(/);
});
