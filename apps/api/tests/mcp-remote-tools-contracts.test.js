'use strict';

// Remote MCP tool-surface contract tests.
//
// Guards against silent drift in the remote MCP connector
// (apps/api/src/routes/mcp.js — the endpoint Claude.ai / ChatGPT.com use). The
// remote connector must keep its tool definitions and dispatch handlers in sync,
// expose the agreed surface, and mirror the durable-structure tools that the
// local @deerdawn/mcp-server exposes — so web agents get the same
// explore-once / append-a-node loop as local Claude Code.
//
// Static source analysis only — no DB/Redis. Runs standalone:
//   node tests/mcp-remote-tools-contracts.test.js

process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('./helpers/privatePaths');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '../..');

const tests = [];
// `requires`: repo paths only the private repo has (the public export does
// not ship them); the test is reported as skipped where they are missing.
const test = (name, fn, { requires = [] } = {}) => tests.push([name, fn, privateSkipReason(...requires)]);

// The full set the remote connector must expose. Update this list deliberately
// when the connector surface changes on purpose — forcing that edit is the point.
const EXPECTED_REMOTE_TOOLS = [
  'start_session',
  'recall',
  'manage_projects',
  'manage_memory',
  'manage_tasks',
  'browse_skills',
  'build_subagent_brief',
];

// The durable repo-structure subset that must stay mirrored between the remote
// connector and the local @deerdawn/mcp-server.
const STRUCTURE_TOOLS = [
  'get_project_map',
  'find_known_paths',
  'get_workspace_entities',
  'record_hot_paths',
  'upsert_workspace_entities',
  'record_debug_finding',
];

const mcpSource = fs.readFileSync(path.join(apiRoot, 'src/routes/mcp.js'), 'utf8');
// The ChatGPT app submission is private (not in the public export); the tests
// that read it declare it in `requires`.
const submission = privateSkipReason('chatgpt-app-submission.json')
  ? null
  : JSON.parse(fs.readFileSync(path.join(repoRoot, 'chatgpt-app-submission.json'), 'utf8'));
const appSource = fs.readFileSync(path.join(apiRoot, 'src/app.js'), 'utf8');
const rateLimitSource = fs.readFileSync(path.join(apiRoot, 'src/middleware/rateLimit.js'), 'utf8');

// Tool names advertised by tools/list.
function remoteToolDefs() {
  const start = mcpSource.indexOf('const ADVERTISED_TOOL_NAMES = new Set([');
  assert.ok(start !== -1, 'ADVERTISED_TOOL_NAMES found in mcp.js');
  const slice = mcpSource.slice(start, mcpSource.indexOf(']);', start));
  return [...slice.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

// The Claude catalog advertises one extra tool (read_tasks), so anything naming
// a tool has both sets to satisfy, not just the default one.
function claudeToolDefs() {
  const start = mcpSource.indexOf('const CLAUDE_ADVERTISED_TOOL_NAMES = new Set([');
  assert.ok(start !== -1, 'CLAUDE_ADVERTISED_TOOL_NAMES found in mcp.js');
  const slice = mcpSource.slice(start, mcpSource.indexOf(']);', start));
  return [...slice.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function callableToolDefs() {
  const start = mcpSource.indexOf('const TOOLS = [');
  assert.ok(start !== -1, 'TOOLS array found in mcp.js');
  const slice = mcpSource.slice(start, mcpSource.indexOf('module.exports', start));
  return [...slice.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

// Tool names handled in the dispatch() switch (between the function and the defs).
function remoteDispatchCases() {
  const start = mcpSource.indexOf('async function dispatch(');
  assert.ok(start !== -1, 'dispatch() found in mcp.js');
  const slice = mcpSource.slice(start, mcpSource.indexOf('// ─── Tool definitions', start));
  return [...slice.matchAll(/case\s*'([a-z_]+)'\s*:/g)].map((m) => m[1]);
}

function localContextSyncTools() {
  const src = fs.readFileSync(path.join(repoRoot, 'packages/mcp-server/src/tools/index.ts'), 'utf8');
  const m = src.match(/CONTEXT_SYNC_TOOLS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'CONTEXT_SYNC_TOOLS array found in mcp-server tools/index.ts');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const sorted = (arr) => [...new Set(arr)].sort();

test('submission artifact targets the current OpenAI import schema', () => {
  assert.strictEqual(
    submission.$schema,
    'https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json',
  );
  assert.strictEqual(submission.schema_version, 1);
  // EXACTLY 5, because that is what the OpenAI plugin console mandates:
  // "Please provide exactly 5 test cases". An earlier pass raised this to 7 to
  // give every advertised tool a case — a real coverage instinct, but the form
  // will not accept it, so the five must cover the core instead: session load,
  // recall, project create, memory write, task board.
  assert.strictEqual(submission.test_cases.length, 5, 'the console accepts exactly 5 positive test cases');
  assert.strictEqual(submission.negative_test_cases.length, 3, 'submission includes exactly three negative test cases');
}, { requires: ['chatgpt-app-submission.json'] });

// Comments inside a descriptor are NOT part of what the server publishes, so
// every assertion below reads a comment-stripped block. Without this a comment
// explaining why a hint is false ("the local package keeps destructiveHint:true")
// is indistinguishable from the hint itself, and the test reports the opposite of
// what the catalog serves. This repo has paid for that confusion before.
function stripComments(source) {
  return source.replace(/^[ \t]*\/\/.*$/gm, '');
}

function toolBlock(name) {
  const toolsStart = mcpSource.indexOf('const TOOLS = [');
  const start = mcpSource.indexOf(`name: '${name}'`, toolsStart);
  assert.ok(start !== -1, `${name} definition found`);
  const next = mcpSource.indexOf('\n  {\n    name: \'', start + 1);
  return stripComments(mcpSource.slice(start, next === -1 ? mcpSource.indexOf('\n];', start) : next));
}

test('every declared remote tool has a dispatch handler (and vice versa)', () => {
  const defs = sorted(callableToolDefs());
  const cases = sorted(remoteDispatchCases());
  assert.deepStrictEqual(
    defs,
    cases,
    `TOOLS definitions and dispatch cases drifted.\n  defs:  ${defs.join(', ')}\n  cases: ${cases.join(', ')}`,
  );
});

test('remote connector exposes exactly the expected tool surface', () => {
  assert.deepStrictEqual(
    sorted(remoteToolDefs()),
    sorted(EXPECTED_REMOTE_TOOLS),
    'Remote tool surface changed — if intentional, update EXPECTED_REMOTE_TOOLS in this test.',
  );
});

test('submission metadata matches the live advertised catalog and annotations', () => {
  assert.deepStrictEqual(sorted(Object.keys(submission.tools)), sorted(remoteToolDefs()));
  for (const name of remoteToolDefs()) {
    const block = toolBlock(name);
    // idempotentHint was missing from this loop, and consequently missing from
    // the submission JSON for all seven tools, for every submission to date. The
    // rejection asked us to "confirm annotations are explicitly set to true or
    // false (not null) for every tool", and an absent key reads as null.
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      const match = block.match(new RegExp(`${hint}:\\s*(true|false)`));
      assert.ok(match, `${name} declares ${hint}`);
      const declared = submission.tools[name].annotations[hint];
      assert.strictEqual(typeof declared, 'boolean', `${name} ${hint} is an explicit boolean in the submission JSON, never absent`);
      assert.strictEqual(declared, match[1] === 'true', `${name} ${hint} matches submission JSON`);
    }
    // A reviewer reads the justification, not the boolean, so an unexplained
    // hint is the same defect one step later.
    for (const key of ['read_only_justification', 'destructive_justification', 'idempotent_justification', 'open_world_justification']) {
      const text = submission.tools[name].justifications[key];
      assert.ok(typeof text === 'string' && text.trim().length > 20, `${name} explains ${key}`);
    }
    assert.ok(!/[—–]/.test(block), `${name} descriptor copy passes the humanizer dash check`);
  }
}, { requires: ['chatgpt-app-submission.json'] });

test('submission test copy matches invocation-level side effects', () => {
  const recallCase = submission.test_cases.find((item) => item.tools_triggered === 'recall');
  assert.ok(recallCase, 'submission includes a recall test case');
  // This assertion used to run the other way: recall recorded telemetry and
  // selection counters, so claiming a side-effect-free read would have been a
  // false statement to a reviewer. Read-only invocations now change no stored
  // data, so the claim is true and the submission should make it. (Their one
  // write is the content-free per-day usage row, services/toolUsageDays.js —
  // operational, like api_keys.last_used_at, and not the caller's data.)
  assert.match(
    recallCase.expected_output,
    /without changing stored data/i,
    'recall advertises readOnlyHint:true, so its test copy should say so',
  );
  // With only five slots, assert the five cover distinct core tools rather than
  // demanding one per advertised tool.
  const covered = new Set(submission.test_cases.map((item) => item.tools_triggered));
  assert.strictEqual(covered.size, 5, 'the five cases exercise five distinct tools');
  const advertised = new Set(remoteToolDefs());
  for (const name of covered) {
    assert.ok(advertised.has(name), `test case names ${name}, which is not advertised`);
  }
}, { requires: ['chatgpt-app-submission.json'] });

// ─── Submission copy must name fixtures that exist ───────────────────────────
// The submitted test cases are run by a human against the tenant that
// seed-native-reviewer.js prepares. Copy that names anything the seeder does not
// create fails in the reviewer's hands and reads as a broken app.
//
// This was real: the cases shipped naming "Aurora Release Review" (the fixture
// is "Aurora Launch Review"), a bare "project_123" (project IDs are
// project_<uuid>, so it resolves to nothing), and a "release-checklist" skill
// the seeder never created.
test('every submitted test case names only fixtures the reviewer seeder creates', () => {
  const seeder = fs.readFileSync(path.join(apiRoot, 'scripts/seed-native-reviewer.js'), 'utf8');
  const seededProject = (seeder.match(/project_name: '([^']+)'/) || [])[1];
  const seededCard = (seeder.match(/add_todos: \[\{ title: '([^']+)'/) || [])[1];
  const seededSkill = (seeder.match(/slug: '([^']+)'/) || [])[1];
  assert.ok(seededProject && seededCard && seededSkill, 'seeder still creates a project, a card, and a skill');

  for (const item of submission.test_cases) {
    const prompt = item.user_prompt;

    // A literal project id can never match a seeded project_<uuid>.
    assert.ok(
      !/\bproject_(?!<)[a-z0-9]{1,12}\b/i.test(prompt),
      `${item.tools_triggered} prompt hardcodes a project id that will not resolve: ${prompt}`,
    );
    // Any "Aurora ..." reference must be the seeded project, exactly.
    const aurora = prompt.match(/Aurora [A-Za-z]+ [A-Za-z]+/);
    if (aurora) {
      assert.strictEqual(aurora[0], seededProject, `${item.tools_triggered} names a project the seeder does not create`);
    }
    // Any quoted card title must be the seeded card, exactly.
    const quoted = prompt.match(/"([^"]+)"/);
    if (quoted) {
      assert.strictEqual(quoted[1], seededCard, `${item.tools_triggered} names a card the seeder does not create`);
    }
    // Any skill slug must be the seeded slug.
    if (/skill/i.test(prompt)) {
      const slug = prompt.match(/([a-z]+-[a-z]+)\b/);
      if (slug) assert.strictEqual(slug[1], seededSkill, `${item.tools_triggered} names a skill the seeder does not create`);
    }
  }
}, { requires: ['chatgpt-app-submission.json'] });

test('every tool has a description, input schema, output schema, and complete advertised annotations', () => {
  const start = mcpSource.indexOf('const TOOLS = [');
  const slice = mcpSource.slice(start, mcpSource.indexOf('module.exports', start));
  const count = callableToolDefs().length;
  assert.strictEqual((slice.match(/^ {4}description:/gm) || []).length, count, 'every tool has one description');
  assert.strictEqual((slice.match(/^ {4}inputSchema:/gm) || []).length, count, 'every tool has one input schema');
  assert.strictEqual((slice.match(/^ {4}annotations:/gm) || []).length, count, 'every tool has annotations');
  assert.strictEqual((slice.match(/^ {4}outputSchema:/gm) || []).length, count, 'every tool has one output schema');
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    assert.ok(mcpSource.includes(`${hint}: false`), `${hint} has an explicit safe default`);
  }
});

test('destructive hints match tools that can replace existing environment state', () => {
  const destructive = new Set([
    // 'recall' is deliberately absent: read-only invocations change none of the
    // caller's data (see readOnlyInvocation in mcp.js), so it replaces no state.
    //
    // 'start_session' is deliberately absent too, and this test used to require
    // the opposite. See the start_session test below.
    'manage_projects',
    'manage_memory',
    'manage_tasks',
    'switch_subproject',
    'update_context',
    'manage_todos',
    'archive_project',
    'set_project_parent',
    'rename_project',
    'record_hot_paths',
    'upsert_workspace_entities',
    'record_debug_finding',
    'mark_resolved',
    // Removes a question from the brief's open list. Non-additive, so the hint
    // is true — and it is the honest reason the answer must be supplied with it.
    'resolve_open_question',
    'cleanup_context',
    // get_workspace_overview, get_workspace_entities and get_next_best_context
    // are deliberately absent. All three are reads whose only write is an
    // additive selection counter, and all three are reached through recall,
    // which advertises readOnlyHint:true and destroys nothing. A delegate that
    // called itself destructive while its only caller called itself a pure read
    // meant one of the two was lying wherever a host looked.
  ]);
  const start = mcpSource.indexOf('const TOOLS = [');
  const end = mcpSource.indexOf('module.exports', start);
  const slice = stripComments(mcpSource.slice(start, end));
  const starts = [...slice.matchAll(/^ {4}name:\s*'([a-z_]+)'/gm)];
  for (let i = 0; i < starts.length; i += 1) {
    const name = starts[i][1];
    const block = slice.slice(starts[i].index, starts[i + 1]?.index ?? slice.length);
    const actual = /destructiveHint:\s*true/.test(block);
    assert.strictEqual(actual, destructive.has(name), `${name} destructiveHint must match its implementation`);
  }
});

test('start_session writes, and every write it makes is additive', () => {
  // This assertion is inverted from what it used to be, and the inversion is the
  // fix for the 2026-09-08 ChatGPT rejection ("annotations do not appear to
  // match the tool's behavior").
  //
  // The old rule read destructiveHint off one narrow fact: sessionDedup REPLACES
  // its marker instead of appending, so the write is not additive. But that
  // marker is a 90-second Redis key the server keeps for itself, and the same
  // descriptor's description promised in plain words that nothing stored is
  // changed or deleted. Publishing both is how a reviewer decides the catalog
  // does not describe the product.
  //
  // readOnlyHint stays false, because the session row and the events are real
  // writes and the honest failure mode here is over-claiming safety, not
  // under-claiming it.
  const block = toolBlock('start_session');
  assert.match(block, /readOnlyHint:\s*false/, 'the session row and dedup marker are environment writes');
  assert.match(block, /destructiveHint:\s*false/, 'every start_session write is additive');
  assert.ok(mcpSource.includes('checkAndMarkSessionLoad('), 'start_session refreshes the dedup marker');
  assert.ok(mcpSource.includes('buildSessionCatchup('), 'start_session records the session load');
  // The description and the annotation have to agree, which is the whole defect.
  assert.match(block, /does not change or delete stored project content/, 'the description states the same thing the annotation does');
});

test('no advertised descriptor promises in words what its annotation denies', () => {
  // The defect the 2026-09-08 ChatGPT rejection actually named, generalised.
  //
  // start_session shipped "It does not change or delete stored project content"
  // in its description and destructiveHint:true in its annotations, in the same
  // object. A reviewer comparing the two has no way to decide which half is the
  // product and which is the mistake, and the correct conclusion from outside is
  // that the catalog does not describe the tool. Every tool that carried an
  // internal rationale for its hint had one; none of them survive contact with
  // the sentence printed next to it.
  //
  // So: a descriptor that promises it destroys nothing may not claim it might,
  // and a descriptor that claims it might must say out loud what it replaces.
  const DISCLAIMS_DESTRUCTION = /(does not|never)[^.]*\b(delete|destroy)\b/i;
  const NAMES_WHAT_IT_REPLACES = /replace|overwrite|permanent|deletes|removing|clear/i;

  for (const name of remoteToolDefs()) {
    const block = toolBlock(name);
    const description = block.match(/description: '((?:[^'\\]|\\.)*)'/)[1];
    const destructive = /destructiveHint:\s*true/.test(block);
    const readOnly = /readOnlyHint:\s*true/.test(block);

    if (DISCLAIMS_DESTRUCTION.test(description)) {
      assert.strictEqual(destructive, false, `${name} tells the reader it deletes nothing, so it cannot advertise that it might`);
    }
    if (destructive) {
      assert.match(description, NAMES_WHAT_IT_REPLACES, `${name} advertises a destructive call, so its description must name what it replaces or deletes`);
    }
    if (readOnly) {
      assert.strictEqual(destructive, false, `${name} cannot be read-only and destructive at once`);
      assert.match(description, DISCLAIMS_DESTRUCTION, `${name} is advertised read-only, so its description should say what it leaves alone`);
    }
  }
});

test('read-only tools suppress every write, on every catalog, so their hints are true', () => {
  // An annotation is a claim. readOnlyHint:true has to mean the call changes
  // nothing of the caller's — not telemetry, not selection counters, not an
  // audit row. (The content-free per-day usage row every call writes is the
  // stated exception, like api_keys.last_used_at; see toolUsageDays.js.) This
  // used to hold only for the Claude catalog; ChatGPT saw the same three reads
  // advertised as destructive writes. Host-dependent behaviour is cloaking, so
  // suppression now follows the annotation everywhere.
  assert.ok(mcpSource.includes('function recordMcpCall('), 'remote wrapper records tool-call telemetry');
  // get_portfolio is a pure read: it calls portfolioService and writes nothing,
  // so it carries the read-only annotation and the wrapper suppresses telemetry
  // for it exactly as it does for recall, which is how it is normally reached.
  const READ_ONLY = new Set(['read_tasks', 'recall', 'get_portfolio', 'browse_skills', 'build_subagent_brief']);
  for (const name of callableToolDefs()) {
    const block = toolBlock(name);
    if (READ_ONLY.has(name)) {
      assert.match(block, /readOnlyHint:\s*true/, `${name} is explicitly read-only`);
      assert.match(block, /destructiveHint:\s*false/, `${name} replaces nothing`);
      assert.match(block, /idempotentHint:\s*true/, `${name} is safe to repeat`);
      continue;
    }
    assert.match(block, /readOnlyHint:\s*false/, `${name} records invocation state`);
    assert.match(block, /idempotentHint:\s*false/, `${name} records another event when repeated`);
  }
  assert.ok(
    mcpSource.includes('const readOnlyInvocation = tool?.annotations?.readOnlyHint === true'),
    'read-only suppression follows the annotation, not the catalog',
  );
  assert.ok(
    !/catalog === 'claude' && tool\?\.annotations\?\.readOnlyHint/.test(mcpSource),
    'the Claude-only gate on read-only suppression must not come back',
  );
  assert.ok(
    !mcpSource.includes('CLAUDE_READ_ONLY_TOOL_OVERRIDES'),
    'no host-specific description override: every catalog sees the same copy',
  );
  assert.ok(mcpSource.includes('track_selection: invocation.readOnlyInvocation ? false'), 'recall skips selection counters');
  assert.ok(mcpSource.includes('{ record_side_effects: !invocation.readOnlyInvocation }'), 'context recall disables render-time affinity and activation writes');
  assert.ok(mcpSource.includes('if (!invocation.readOnlyInvocation)'), 'worker briefs skip audit and product events');
});

// ─── The 2026-08-24 ChatGPT rejection ────────────────────────────────────────
// "Your app's tools include instructions that could cause the model to bypass
// normal safeguards or act outside authorized behavior."
//
// Two model-readable surfaces caused it, and both are cheap to reintroduce by
// accident, so both are pinned here.
test('published model-readable fields do not steer the model', () => {
  const instructions = require(path.join(repoRoot, 'packages/shared-context/src/mcpInstructions.js')).buildMcpInstructions();
  assert.ok(mcpSource.includes('instructions: buildMcpInstructions()'), 'initialize still publishes the instruction field');
  for (const [pattern, why] of [
    [/\balways call\b/i, 'mandates a tool call'],
    [/\bbefore your first response\b/i, 'gates the first reply'],
    [/\bdo not answer\b/i, 'forbids answering'],
    [/\bbefore (?:repo|codebase|code) search\b/i, 'ranks itself against the host\'s tools'],
    [/\bopen with at most\b/i, 'dictates the reply'],
  ]) {
    assert.ok(!pattern.test(instructions), `MCP instructions ${why} (${pattern}) — see packages/shared-context/src/mcpInstructions.js`);
  }
});

test('the prompt-injection escalation gate is enforced but never advertised', () => {
  const safety = fs.readFileSync(path.join(apiRoot, 'src/services/mcpSafety.js'), 'utf8');
  assert.ok(safety.includes('function advertisedToolInputSchema('), 'a separate advertised schema exists');
  assert.ok(
    /delete schema\.properties\.confirm_untrusted_input/.test(safety),
    'confirm_untrusted_input is stripped from the published schema',
  );
  assert.ok(
    mcpSource.includes('inputSchema: advertisedToolInputSchema(tool)'),
    'tools/list publishes the advertised schema, not the internal one',
  );
  assert.ok(
    safety.includes('args.confirm_untrusted_input !== true'),
    'the gate itself is still enforced at validation time',
  );
});

// A web client has no SessionStart hook, so the start_session payload IS its
// brief. sessionDedup's safety argument ("Claude Code still gets context from
// its own hook") does not transfer, and suppressing here answered the product's
// headline call with "context was loaded moments ago" and nothing else — for two
// ChatGPT conversations inside 90s, or one reviewer testing desktop/iOS/Android
// on a single account.
test('the hosted route never withholds the brief, but still gates session accounting', () => {
  const start = mcpSource.indexOf('case \'start_session\':');
  const end = mcpSource.indexOf('case \'list_projects\':', start);
  const block = mcpSource.slice(start, end);

  assert.ok(
    !/loaded moments ago/.test(block),
    'the hosted start_session must not return a pointer instead of the brief',
  );
  assert.ok(
    !/if \(dedup\.duplicate\) \{[\s\S]{0,200}return /.test(block),
    'no early return on a duplicate — a web client has no hook to fall back on',
  );
  // The marker is still written: the local path reads it, and there the hook
  // fallback makes suppression genuinely free.
  assert.ok(block.includes('checkAndMarkSessionLoad('), 'the dedup marker is still recorded');
  // And duplicates still must not book a second session or a second delivery.
  assert.ok(
    /const catchup = \(!dedup\.duplicate/.test(block),
    'a duplicate must not build a catch-up and inflate session_number',
  );
  assert.ok(
    /!invocation\.readOnlyInvocation && !dedup\.duplicate/.test(block),
    'a duplicate must not re-record context_delivered',
  );
});

// Two tests lived here that read the ORDER of statements in update_context's
// source ("the commands write appears after service.applyExtraction("). Both
// went red the moment the handler was refactored without changing what it does,
// and neither would have noticed the defects that were actually live: an
// inferred task replacing an explicit one, and the caller's words being dropped
// under `stored: true`. They are replaced by behaviour, against the real route
// and a real row, in tests/integration/explicit-update-contract.test.js:
//   - "update_context cannot replace an explicitly set task, whatever the model returns"
//   - "update_context merges commands by label and keeps the ones it was not sent"

test('every advertised tool declares OAuth scopes and dispatch enforces the same fail-closed map', () => {
  assert.match(mcpSource, /securitySchemes:\s*\[\{ type: 'oauth2', scopes: \[TOOL_SCOPES\[tool\.name\]\] \}\]/);
  assert.match(mcpSource, /const required = TOOL_SCOPES\[name\]/);
  assert.match(mcpSource, /if \(!required\)/, 'unmapped tools must fail closed');
  assert.match(mcpSource, /requireToolScope\(actor, name, args\)/, 'scope gate must run before dispatch');
  // The one narrowing (scan 24): a READ action inside a write-grouped tool needs
  // only context:read, decided by callWrites and nothing looser.
  assert.match(mcpSource, /if \(required === 'context:write' && READ_ACTIONS\[name\] && !callWrites\(name, args\)\) return 'context:read';/);
  assert.match(mcpSource, /'mcp\/www_authenticate'/, 'scope failures must trigger MCP OAuth reauthorization metadata');
});

test('remote calls share validation, redaction, budgets, timeouts, capacity, and safe errors', () => {
  for (const token of [
    'validateToolArguments(tool, args)',
    'sanitizeToolResult(await withTimeout(',
    'MCP_TOOL_TIMEOUT_MS',
    'MCP_MAX_CONCURRENCY',
    'normalizeMcpError(err)',
    'structuredContent: { error: normalized }',
  ]) {
    assert.ok(mcpSource.includes(token), `remote call path is missing ${token}`);
  }
  assert.match(mcpSource, /title:\s*tool\.annotations\?\.title/);
  // Published schemas are hardened AND stripped of the internal escalation gate.
  assert.match(mcpSource, /inputSchema:\s*advertisedToolInputSchema\(tool\)/);
});

test('remote MCP exposes capacity, latency, request-count, in-flight, and rate-limit signals', () => {
  for (const metric of ['mcp_request_duration_ms', 'mcp_requests_total', 'mcp_requests_in_flight']) {
    assert.ok(appSource.includes(metric), `metrics endpoint includes ${metric}`);
  }
  assert.ok(appSource.includes('observeMcpRequest, mcpUnauthenticatedIpLimiter, mcpToolLimiter, mcpRoutes'), 'canonical MCP route is observed and rate-limited, per credential AND per IP for unidentified traffic');
  assert.ok(rateLimitSource.includes('resolveRateLimitStore(\'rl:mcp-tool:\')'), 'MCP rate limits use Redis with the configured safe fallback');
  assert.ok(rateLimitSource.includes('code: -32029'), 'rate-limit response is MCP-classifiable');
});

test('tool names remain unique, narrow verb-oriented identifiers without promotional language', () => {
  const names = remoteToolDefs();
  assert.strictEqual(new Set(names).size, names.length, 'tool names are unique');
  const allowedPrefixes = /^(start|recall|browse|list|create|get|update|search|find|record|upsert|manage|switch|archive|set|rename|mark|build|cleanup)(?:_|$)/;
  for (const name of names) {
    assert.match(name, allowedPrefixes, `${name} begins with a plain-English action verb`);
    assert.ok(!/^(best|official|pick_me|recommended)(?:_|$)/.test(name), `${name} is not promotional`);
  }
});

test('remote tools pass the authenticated actor into the tenant-scoped context service', () => {
  assert.match(mcpSource, /async function dispatch\(name, args, actor/);
  assert.match(mcpSource, /service\.getProject\(actor,/);
  assert.match(mcpSource, /service\.recordExplicitUpdate\(actor,/);
  assert.match(mcpSource, /service\.recordDebugFinding\(actor,/);
  assert.match(mcpSource, /service\.applyStructuredContextEvent\(actor,/);
});

// Reply text is a first-run instruction surface. A hosted model can only call
// what tools/list advertises, so naming a dispatch-only tool in a reply hands it
// a call that fails as "Unknown tool" — the same failure as the setup copy that
// told every new user to call `update_context`, which was dispatchable and
// unlisted, and which is the best explanation this repo has for the 19 → 3
// activation gap. Two replies from mark_resolved were still telling callers to
// use `get_workspace_entities`; the advertised route is recall(action:"entities").
//
// Source text is a weak instrument, so the rule is deliberately narrow: only
// string literals containing whitespace are prose, which skips the dispatch
// target maps and every `case 'x':` label without needing to parse them.
test('handler replies never name a tool that tools/list does not advertise', () => {
  const advertised = new Set([...remoteToolDefs(), ...claudeToolDefs()]);
  const unadvertised = callableToolDefs().filter((name) => !advertised.has(name));
  assert.ok(unadvertised.length, 'this test is pointless if every callable tool is advertised');

  const start = mcpSource.indexOf('async function dispatch(');
  const end = mcpSource.indexOf('// ─── Tool definitions', start);
  assert.ok(start !== -1 && end !== -1, 'dispatch() body is readable');
  const body = stripComments(mcpSource.slice(start, end));

  const literals = body.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [];
  const offenders = [];
  for (const literal of literals) {
    if (!/\s/.test(literal)) continue;
    for (const name of unadvertised) {
      if (new RegExp(`(?:^|[^a-z_])${name}(?:[^a-z_]|$)`).test(literal)) {
        offenders.push(`${name} in ${literal.slice(0, 90)}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], `reply text names tools a hosted caller cannot call:\n  ${offenders.join('\n  ')}`);
});

test('structure tools are present on the remote connector', () => {
  const defs = new Set(callableToolDefs());
  for (const t of STRUCTURE_TOOLS) {
    assert.ok(defs.has(t), `structure tool "${t}" missing from remote connector (apps/api/src/routes/mcp.js)`);
  }
});

test('structure tools mirror names that exist in the local @deerdawn/mcp-server', () => {
  const local = new Set(localContextSyncTools());
  for (const t of STRUCTURE_TOOLS) {
    assert.ok(local.has(t), `structure tool "${t}" not in local CONTEXT_SYNC_TOOLS — a rename would silently break remote/local parity`);
  }
});

test('subagent brief tool stays mirrored and task-scoped, and truly writes nothing', () => {
  assert.ok(localContextSyncTools().includes('build_subagent_brief'), 'local MCP dispatch includes build_subagent_brief');
  assert.match(mcpSource, /build_subagent_brief:\s*'context:read'/, 'remote scope map keeps build_subagent_brief read-only');
  const toolStart = mcpSource.indexOf('name: \'build_subagent_brief\'');
  assert.ok(toolStart !== -1, 'remote build_subagent_brief definition exists');
  const toolSlice = mcpSource.slice(toolStart, toolStart + 2200);
  assert.match(toolSlice, /required:\s*\['task'\]/, 'delegated task is required');
  assert.match(toolSlice, /readOnlyHint:\s*true/, 'the brief builder writes nothing at all');
  // The description used to instruct orchestrators to run workers in
  // "isolated/no-history" mode. Telling a host to give the model less context is
  // not this tool's business to specify, and it reads as reducing oversight.
  assert.ok(
    !/isolated\/no-history/.test(toolSlice),
    'the tool description must not direct how the host runs its workers',
  );
});

// Web tools never auto-call a tool, so the dashboard's "is a tool connected?"
// check (product_events source='mcp') would never flip on auth alone unless the
// remote endpoint records the `initialize` handshake. Losing this signal strands
// the onboarding poll on "Waiting for your tool to connect…". Guard it.
test('remote endpoint records an mcp connect event on the initialize handshake', () => {
  const fnStart = mcpSource.indexOf('async function handleMcpRequest(');
  assert.ok(fnStart !== -1, 'handleMcpRequest() found in mcp.js');
  const fnBody = mcpSource.slice(fnStart, mcpSource.indexOf('\n}', fnStart));
  assert.ok(
    /method\s*===\s*'initialize'/.test(fnBody),
    'handleMcpRequest must branch on the initialize handshake to record the connect signal',
  );
  assert.ok(
    /recordMcpConnect\s*\(/.test(fnBody),
    'handleMcpRequest must call recordMcpConnect on initialize',
  );
  assert.ok(
    /event_name:\s*'mcp_runtime_started'/.test(mcpSource) && /source:\s*'mcp'/.test(mcpSource),
    'recordMcpConnect must emit a source=mcp mcp_runtime_started event so sync_health.mcp_registered flips on connect',
  );
});

(async () => {
  console.log('=== Remote MCP Tool-Surface Contract Tests ===\n');
  for (const [name, fn, skip] of tests) {
    if (skip) {
      console.log(`- ${name} (skipped: ${skip})`);
      continue;
    }
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  ${error.message}`);
      process.exitCode = 1;
    }
  }
})();

/**
 * A failure event that cannot say what failed.
 *
 * The hosted wrapper recorded only `normalized.code` — one of six values — and
 * discarded `normalized.message`, the sentence that names the offending field.
 * Over 14 days that produced 41 mcp_tool_call_failed rows on manage_memory
 * reading 'invalid_arguments' and nothing more: the cause was computed, returned
 * to the caller over the wire, and then dropped before it was recorded. The
 * local stdio server has always kept the message, which is the only reason the
 * matching stdio cluster was diagnosable at all.
 */
test('a hosted failure records WHICH field failed, not just that something did', () => {
  assert.match(
    mcpSource,
    /recordMcpCall\(actor, \{[^}]*errorMessage: normalized\.message[^}]*\}\)/,
    'the failure path drops normalized.message instead of recording it'
  );

  const emitter = mcpSource.slice(
    mcpSource.indexOf('function recordMcpCall('),
    mcpSource.indexOf('function recordMcpConnect(')
  );
  // Recorded under `error` — the SAME property name the local stdio server uses
  // for the same value — so one query spans both transports. Renaming it here
  // silently splits every cross-transport failure query in two.
  assert.match(emitter, /error: redactText\(errorMessage\)\.slice\(0, \d+\)/, 'the message is not redacted and bounded under `error`');
  assert.match(emitter, /error_code: String\(error\)/, 'the low-cardinality code to group by is still recorded');

  // Free text reaching long-term storage gets the redactor even though
  // normalizeMcpError already ran it. Belt and braces on the one field here that
  // can carry an arbitrary thrown message.
  assert.ok(
    /\bredactText,/.test(mcpSource),
    'redactText is not imported, so the telemetry path is relying on an upstream pass it does not control'
  );
});

test('the recorded failure message names the field and survives a credential', () => {
  const { normalizeMcpError, redactText } = require(path.join(apiRoot, 'src/services/mcpSafety.js'));
  const record = (err) => redactText(normalizeMcpError(err).message).slice(0, 200);

  const missing = Object.assign(new Error('.project_id is required'), { mcpCode: 'invalid_arguments' });
  assert.match(record(missing), /project_id is required/, 'the attributable detail is lost');

  // A DeerDawn key in the minted shape (dd_<8 hex>_<64 hex>). The output mask
  // matches the exact shapes since round 14; its old `dd_` + 16 guess also
  // rewrote Datadog identifiers in every hosted reply.
  const ddKey = `dd_0a1b2c3d_${'4e5f'.repeat(16)}`;
  const leaky = Object.assign(
    new Error(`rejected Bearer abc123def456ghi789 with ${ddKey}`),
    { mcpCode: 'invalid_arguments' }
  );
  const recorded = record(leaky);
  assert.ok(!/abc123def456ghi789/.test(recorded), 'a bearer token reached the event payload');
  assert.ok(!recorded.includes(ddKey.slice(0, 30)), 'a DeerDawn key reached the event payload');
});
