/**
 * DeerDawn has TWO independent MCP dispatchers, and they drifted (2026-08-29).
 *
 *   - packages/mcp-server/src/tools/context-sync.ts serves LOCAL stdio.
 *   - apps/api/src/routes/mcp.js serves the HOSTED connectors — Claude.ai,
 *     ChatGPT, Cursor — which is how most real users connect.
 *
 * They are hand-maintained duplicates over the same tool names, so a fix applied
 * to one is invisible in the other. That is not hypothetical: mark_resolved's
 * fan-out bug (one title resolving up to five unrelated entities, and
 * overwriting each entity's summary with the resolution note) was fixed in the
 * local dispatcher while the remote one carried it unchanged — live for exactly
 * the users who do not run stdio.
 *
 * These assertions are on SOURCE TEXT, which is a weak instrument. It is used
 * deliberately: the two implementations cannot import each other (apps/api is
 * CommonJS-only, packages/mcp-server is TypeScript over HTTP), so there is
 * usually no shared module to compare. The point is not to prove the behaviour
 * matches, it is to fail loudly the next time one side is edited alone.
 * Assertions are kept comment-blind so a reworded comment cannot turn them red
 * or green.
 *
 * The exception worth copying: both sides DO require packages/shared-context, so
 * anything that lands there (formatPortfolio, for one) is genuinely single-source
 * and needs no parity assertion at all. Prefer that shape over another mirrored
 * pair whenever the thing being added is pure formatting or pure schema.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REMOTE = path.join(ROOT, 'apps/api/src/routes/mcp.js');
const LOCAL = path.join(ROOT, 'packages/mcp-server/src/tools/context-sync.ts');

/**
 * Strip comments so we assert on CODE, not prose.
 *
 * The `/*` must be preceded by whitespace or an opening bracket, and that guard
 * is load-bearing rather than tidiness. A bare /\*[\s\S]*?\*\/ finds its first
 * opener inside a STRING — context-sync.ts line 80 sends
 * `Accept: 'application/json, text/plain, * /*'` — and then runs to the next
 * `* /` roughly 1,400 lines later, deleting ~58KB of the local dispatcher before
 * any assertion sees it. Every local-side check here was reading half a file,
 * and the negative ones ("neither dispatcher does X") were passing on absence
 * caused by the stripper rather than by the code.
 */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/(^|[\s{(,;])\/\*(?:(?!\*\/)[\s\S])*?\*\//g, '$1')
    .replace(/^\s*\/\/.*$/gm, '');
}

const remote = code(REMOTE);
const local = code(LOCAL);

// Scoped to the mark_resolved handler rather than the whole file, and the
// narrowing is a correction. The bug is "hand the SEARCH RESULTS straight to the
// upsert", which can only happen where the upsert is. Applied file-wide, the
// pattern also fires on any unrelated `candidates.map(...)` that builds a
// string — resolveProjectRefs renders one to list the projects an ambiguous name
// matched, immediately before refusing — and a guard that reddens on code doing
// the opposite of the bug teaches people to rename variables around it.
function resolveHandler(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `mark_resolved handler found (${marker})`);
  const next = src.indexOf('case \'', start + marker.length);
  return src.slice(start, next === -1 ? src.length : next);
}

test('neither dispatcher resolves the whole candidate list', () => {
  // The exact shape of the bug: handing search results straight to the upsert.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      !/candidates\.map\(/.test(resolveHandler(src, 'case \'mark_resolved\'')),
      `${name} dispatcher maps over every candidate — one title must resolve at most one entity`
    );
  }
});

// The local resolver lives in its own two files rather than in the dispatcher
// module the rest of this suite reads, so this check names them explicitly. The
// hosted side keeps it inline because apps/api is CommonJS and cannot import the
// TypeScript one; that is the same constraint this whole file exists for.
const LOCAL_REF = path.join(ROOT, 'packages/mcp-server/src/project-ref.ts');
const LOCAL_WIRING = path.join(ROOT, 'packages/mcp-server/src/tools/index.ts');

test('both dispatchers resolve a project NAME to an id, centrally', () => {
  // The model holds names, not ids. The brief prints a name, the board prints a
  // name, and the id appears in exactly one listing as a UUID nobody carries
  // between turns, so "use the name" is the most likely call the model can make
  // and every project_id description on this surface invites it.
  //
  // The local dispatcher has resolved this since project-ref.ts. The hosted one
  // never did: it passed the reference through verbatim, the store missed, and
  // the caller got a bare internal_error naming nothing. Most real users are on
  // the hosted connector, so the fix existed for the smaller half of them.
  //
  // Resolution must be CENTRAL on both sides. Wiring it per handler is how three
  // of manage_memory's nine targets ended up with it and six without.
  const localRef = code(LOCAL_REF);
  const localWiring = code(LOCAL_WIRING);

  assert.ok(
    /args = await resolveProjectRefs\(args, actor\)/.test(remote),
    'remote dispatcher does not resolve project names before the switch',
  );
  assert.ok(
    /await resolveProjectRefs\(args, client\)/.test(localWiring),
    'local dispatcher no longer resolves project names before handling a call',
  );

  for (const [name, src] of [['remote', remote], ['local', localRef]]) {
    assert.ok(
      /looksLikeProjectId/.test(src),
      `${name} resolver has no id fast path, so every call pays for a name lookup`,
    );
    assert.ok(
      /matches \$\{candidates\.length\} projects/.test(src),
      `${name} resolver does not refuse an ambiguous project name`,
    );
    assert.ok(
      /PROJECT_REF_KEYS/.test(src),
      `${name} resolver does not rewrite every project reference key`,
    );
  }
});

test('both dispatchers refuse an ambiguous title', () => {
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /nothing was resolved/.test(src),
      `${name} dispatcher has no ambiguity refusal`
    );
  }
});

test('neither dispatcher overwrites an entity summary with the resolution note', () => {
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      !/summary:\s*(notes|parsed\.notes)\s*\?/.test(src),
      `${name} dispatcher replaces summary with the note — it belongs in metadata.resolution_note`
    );
    assert.ok(
      /resolution_note/.test(src),
      `${name} dispatcher does not file the note under metadata.resolution_note`
    );
  }
});

test('both dispatchers key entity identity on node_type, not the metadata label', () => {
  // The DB is UNIQUE (owner_key, node_type, canonical_key). Writing
  // metadata.entity_type when the two disagree lands on a different identity and
  // duplicates instead of updating.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      !/entity_type:\s*\w+\.metadata\?\.entity_type\s*\|\|\s*\w+\.node_type/.test(src),
      `${name} dispatcher prefers metadata.entity_type over node_type for identity`
    );
  }
});

test('both dispatchers can set the current task directly', () => {
  // Extraction has never been able to write current_task, so a brief's headline
  // stays pinned to finished work unless there is a direct path.
  assert.ok(/current_task:\s*taskText/.test(remote), 'remote update_context cannot set the task');
  assert.ok(/current_task:\s*task\b/.test(local), 'local update_context cannot set the task');
});

test('both dispatchers report a task that landed MASKED as written, not NOT changed (round 15)', () => {
  // The store redacts a patch before it merges, so a task naming a key is
  // stored with [REDACTED] in it. Compared with the raw words, the hosted side
  // called that "NOT changed" and the model retried a landed write forever.
  // Both must compare against the masked form and say so in the same words.
  assert.match(local, /written, with sensitive text redacted/, 'local dispatcher lost its masked-task reply');
  assert.match(remote, /written, with sensitive text redacted/, 'hosted dispatcher reports a masked task as NOT changed');
  assert.match(remote, /redactForStorage\(taskText\)/, 'hosted writeTask no longer compares against the masked task');
});

test('the remote manage_memory accepts the task parameter (advertised, or held while in review)', () => {
  // A capability the catalog does not advertise does not exist to the model.
  //
  // This used to read the `update_context` block — a tool retired from
  // tools/list, reached today only as manage_memory's dispatch target — so it
  // stayed green while the ADVERTISED tool, manage_memory, refused `task` as an
  // unsupported argument. It now reads the tool a hosted model actually calls.
  // Advertising `task` there is held while the ChatGPT resubmission is in review
  // (the catalog must stay byte-identical); until then the server must at least
  // ACCEPT it, via HELD_UNADVERTISED_PROPERTIES. When the hold lifts, drop the
  // second branch.
  const raw = fs.readFileSync(REMOTE, 'utf8');
  const i = raw.indexOf('name: \'manage_memory\'');
  assert.ok(i > 0, 'manage_memory is missing from the remote catalog');
  const block = raw.slice(i, raw.indexOf('outputSchema', i));
  const advertised = /\btask:\s*\{\s*type:\s*'string'/.test(block);
  const { validateToolArguments } = require('../../src/services/mcpSafety');
  const probe = { name: 'manage_memory', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, additionalProperties: false } };
  let accepted = true;
  try { validateToolArguments(probe, { action: 'update', task: 'Ship the importer' }); } catch { accepted = false; }
  assert.ok(advertised || accepted, 'hosted manage_memory neither advertises nor accepts `task` — the brief headline is unwritable on hosted');
});

test('both dispatchers reach cross-project memory through recall', () => {
  // Cross-project memory is the one thing DeerDawn does that a per-project
  // notes file cannot, and until this landed it had no model-facing surface at
  // all: it was reachable only by a human opening /portfolio. A session could
  // never volunteer "you already decided this in your other project".
  //
  // Landing it on ONE dispatcher would be worse than not landing it: the hosted
  // connectors are how most people connect, so a local-only version would be
  // invisible to almost everyone who has it.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /portfolio: 'get_portfolio'/.test(src),
      `${name} dispatcher has no recall action for cross-project memory`
    );
    assert.ok(
      /case 'get_portfolio'/.test(src),
      `${name} dispatcher routes recall to get_portfolio but cannot handle it`
    );
    assert.ok(
      /'portfolio'\]/.test(src),
      `${name} catalog does not advertise portfolio in recall's action enum`
    );
  }
});

test('neither dispatcher renders the portfolio itself', () => {
  // The rendering lives in shared-context, which BOTH sides already require.
  // That makes it the one part of this feature that physically cannot drift,
  // and it is the only such part — everything else here is hand-mirrored.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /formatPortfolio\(/.test(src),
      `${name} dispatcher does not use the shared portfolio formatter`
    );
  }
});

test('both dispatchers reuse the portfolio service instead of re-querying', () => {
  // A context_graph_* join on a column with no index scans every owner's rows
  // and trips the 8s DB breaker; the portfolio path already solved that with one
  // owner-scoped CTE. A second implementation would reintroduce it, so the
  // remote side must call the service and the local side must call the endpoint.
  assert.ok(
    /portfolioService\.getPortfolio\(/.test(remote),
    'remote get_portfolio does not delegate to portfolioService'
  );
  assert.ok(
    /client\.getPortfolio\(/.test(local),
    'local get_portfolio does not delegate to the portfolio endpoint'
  );
  assert.ok(
    !/context_graph_evidence/.test(remote) && !/context_graph_evidence/.test(local),
    'a dispatcher is writing its own cross-project query'
  );
});

test('both catalogs say what workspace scope actually does', () => {
  // It used to read "Entity scope for action=entities" against a bare
  // ['workspace','project'] enum, which tells a model nothing. A model that does
  // not know `workspace` means ALL projects will never reach for it, so the
  // account-wide lookup existed and was never used.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /workspace looks across ALL of this account/.test(src),
      `${name} catalog still describes scope without saying workspace spans every project`
    );
  }
});

test('the remote catalog advertises the portfolio action', () => {
  // A capability the catalog does not advertise does not exist to the model.
  const raw = fs.readFileSync(REMOTE, 'utf8');
  const i = raw.indexOf('name: \'recall\'');
  assert.ok(i > 0, 'recall is missing from the remote catalog');
  const block = raw.slice(i, i + 2000);
  const actions = /enum:\s*\[([^\]]*)\]/.exec(block);
  assert.ok(actions, 'remote recall advertises no action enum');
  assert.ok(/'portfolio'/.test(actions[1]), 'remote recall does not advertise action portfolio');
});

test('neither dispatcher lets dry_run fail open', () => {
  // dry_run is the difference between a READ (return the merge plan) and a WRITE
  // (perform the merge). `=== true` fails OPEN: a client that stringifies
  // booleans asks for a plan and gets a real merge. Both dispatchers must coerce
  // and must refuse a value they do not recognise, rather than silently choosing
  // the branch that writes.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      !/dryRun:\s*dry_run === true/.test(src) && !/dry_run:\s*args\?\.dry_run === true/.test(src),
      `${name} dispatcher decides dry_run with a bare === true, which fails open on a stringified boolean`
    );
  }
});

test('both dispatchers can retire ONE open question', () => {
  // An agent session's only lever on open_questions was cleanup_context, which
  // clears the whole list along with the command log and the blocking issue. So
  // dead questions accumulated in live briefs: the only tool pointed at them was
  // a wrecking ball. The API half (POST /projects/:id/questions/resolve) shipped
  // first and nothing could reach it.
  //
  // Landing it on ONE dispatcher would be the same half-ship in a new place: the
  // hosted connectors are how most people connect.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /resolve_question: 'resolve_open_question'/.test(src),
      `${name} dispatcher has no manage_memory action for resolving a question`
    );
    assert.ok(
      /case 'resolve_open_question'/.test(src),
      `${name} dispatcher routes manage_memory to resolve_open_question but cannot handle it`
    );
    assert.ok(
      /'resolve_question'/.test(src),
      `${name} catalog does not advertise resolve_question in manage_memory's action enum`
    );
  }
});

test('resolving a QUESTION stays a separate action from resolving an ENTITY', () => {
  // `resolve` maps to mark_resolved, which searches the workspace graph and flips
  // an entity. Questions live in the brief's open_questions list — a different
  // store with a different identity rule. Folding both under one action would
  // mean picking the store from whichever optional argument happened to arrive,
  // which is loose matching on a destructive path.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /resolve: 'mark_resolved'/.test(src),
      `${name} dispatcher no longer maps resolve to mark_resolved`
    );
    assert.ok(
      !/resolve: 'resolve_open_question'/.test(src),
      `${name} dispatcher overloaded resolve onto the question store — the two must stay distinct actions`
    );
  }
});

test('neither dispatcher renders the question outcome itself', () => {
  // Same reasoning as formatPortfolio: the refusal wording is what a model reads
  // and acts on, so it lives in shared-context, which both sides already require.
  // That makes it the one part of this feature that physically cannot drift.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /formatQuestionResolution\(/.test(src),
      `${name} dispatcher does not use the shared question-resolution formatter`
    );
  }
});

test('both dispatchers surface the CANDIDATES, not a bare refusal', () => {
  // A caller told only "that was ambiguous" cannot become unambiguous. The remote
  // side reads the service outcome directly; the local side must unpack the 409's
  // `candidates` off the axios response, because handleApiError would otherwise
  // flatten it to "Conflicts with something that already exists" — a sentence
  // that is not even true here, since nothing was created.
  assert.ok(
    // Quoted as stored (scan 14): the candidates pass through the storage
    // redactor on the way out, which keeps every one of them.
    /candidates: (?:redactForStorage\()?outcome\.candidates/.test(remote),
    'remote resolve_open_question drops the candidate questions'
  );
  assert.ok(
    /question_ambiguous/.test(local) && /data\.candidates/.test(local),
    'local resolve_open_question does not read the 409 candidates off the response'
  );
  assert.ok(
    /question_not_found/.test(local),
    'local resolve_open_question does not distinguish a miss from a real failure'
  );

  // And the allow-list is the floor: an unlisted error code collapses to the
  // generic status message on every OTHER path that reaches handleApiError.
  const errors = code(path.join(ROOT, 'packages/mcp-server/src/utils/errors.ts'));
  const allowList = /ACTIONABLE_ERROR_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(errors);
  assert.ok(allowList, 'ACTIONABLE_ERROR_CODES not found');
  for (const codeName of ['question_ambiguous', 'question_not_found']) {
    assert.ok(
      allowList[1].includes(`'${codeName}'`),
      `${codeName} is not in ACTIONABLE_ERROR_CODES, so its message collapses to a generic failure`
    );
  }
});

test('neither dispatcher resolves a question by fuzzy guess of its own', () => {
  // The service already decided this: exact text first, fuzzy only when it lands
  // on exactly one, otherwise resolve nothing. A dispatcher that pre-matches the
  // text would reintroduce the fan-out one layer up, where the service's refusal
  // can no longer see it.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    const handler = src.slice(src.indexOf('case \'resolve_open_question\''), src.indexOf('case \'resolve_open_question\'') + 3000);
    assert.ok(
      !/open_questions[\s\S]{0,80}\.filter\([^)]*includes\(/.test(handler),
      `${name} dispatcher filters the question list itself instead of letting the service match`
    );
  }
});

test('the two dispatchers still cover the same tool names', () => {
  // A tool present in one and absent from the other is a silent capability gap
  // for whichever surface lacks it. This pins the DIRECTION that matters: every
  // tool the hosted connectors advertise must exist locally too.
  const rawRemote = fs.readFileSync(REMOTE, 'utf8');
  const catalogAt = rawRemote.indexOf('const TOOLS');
  const catalog = rawRemote.slice(catalogAt);
  const remoteNames = new Set([...catalog.matchAll(/^\s{4}name: '([a-z_]+)'/gm)].map((m) => m[1]));
  assert.ok(remoteNames.size > 20, `expected a full remote catalog, saw ${remoteNames.size}`);

  const rawLocal = fs.readFileSync(LOCAL, 'utf8');
  const missing = [...remoteNames].filter((n) => !rawLocal.includes(`'${n}'`));
  assert.deepEqual(
    missing.filter((n) => !DELIBERATE_REMOTE_ONLY.has(n)),
    [],
    `tools advertised remotely but absent locally: ${missing.join(', ')}`
  );
});

// ─── Card bodies ─────────────────────────────────────────────────────────────
// A board card can carry a body: the detail that does not fit in a title. Landing
// it on one dispatcher would be the usual half-ship — a body written from Claude
// Code that the hosted connectors cannot read, or the reverse.

test('both dispatchers accept the richer card form through the shared normalizer', () => {
  // `todos: string[]` is the published contract and stays a list of bare titles.
  // The richer {title, body, phase} form is normalized by ONE function, shared
  // with the API's todo_added handler, so the three cannot disagree about what
  // an entry means.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /normalizeTaskCardInputs\(/.test(src),
      `${name} dispatcher parses card input itself instead of using the shared normalizer`
    );
    assert.ok(
      /args\?\.cards/.test(src),
      `${name} dispatcher never reads the cards argument, so a body can only be written on the other surface`
    );
  }
});

test('both catalogs advertise a body, or no model can write one', () => {
  // A capability the catalog does not advertise does not exist to the model —
  // the same failure update_context's `task` parameter had.
  const rawRemote = fs.readFileSync(REMOTE, 'utf8');
  const rawLocal = fs.readFileSync(LOCAL, 'utf8');
  for (const [name, raw, marker] of [
    ['remote', rawRemote, 'name: \'manage_tasks\''],
    ['remote claude', rawRemote, 'CLAUDE_MANAGE_TASKS_TOOL'],
    ['local', rawLocal, 'name: \'manage_tasks\''],
  ]) {
    const i = raw.indexOf(marker);
    assert.ok(i > 0, `${name} catalog has no manage_tasks`);
    const block = raw.slice(i, i + 2600);
    assert.ok(/cards:\s*\{/.test(block), `${name} manage_tasks does not advertise cards`);
    assert.ok(/body:\s*\{\s*type:\s*'string'/.test(block), `${name} manage_tasks does not advertise body`);
  }
});

test('neither dispatcher renders a card body itself', () => {
  // Same reasoning as formatPortfolio: the rendering lives in shared-context,
  // which both sides already require, so this half of the feature physically
  // cannot drift.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /formatTaskCardDetail\(/.test(src),
      `${name} dispatcher does not use the shared card-detail formatter`
    );
  }
});

test('neither dispatcher lists a body — in the text OR the structured payload', () => {
  // The listing already overran the MCP response limit on titles alone, which is
  // why bodies exist at all. A listing that dropped bodies from the text while
  // shipping them in structuredContent would blow the same budget, silently.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /taskBoardSnapshotForListing\(/.test(src),
      `${name} dispatcher ships a raw board snapshot, so every card body rides along in structuredContent`
    );
    assert.ok(
      /TASK_BODY_MARKER/.test(src),
      `${name} dispatcher does not mark which cards have a body, so nobody knows there is anything to open`
    );
  }
});

test('the hosted READ tool can open a card, not just list the board', () => {
  // The Claude catalog splits the board into read_tasks and manage_tasks, and its
  // manage_tasks deliberately has no 'list'. If only manage_tasks could open a
  // card, that catalog could write bodies it can never read back.
  const raw = fs.readFileSync(REMOTE, 'utf8');
  const i = raw.indexOf('name: \'read_tasks\'');
  assert.ok(i > 0, 'read_tasks is missing from the remote catalog');
  const block = raw.slice(i, i + 1000);
  assert.ok(/todos:\s*\{\s*type:\s*'array'/.test(block), 'read_tasks cannot be asked for a specific card');
  // Match the argument, not the whole call: `open` must reach renderTaskBoard as
  // the third argument, but the call is allowed to carry further arguments after
  // it (listing options, for one) without failing this.
  assert.ok(
    /case 'read_tasks':[\s\S]{0,600}renderTaskBoard\(actor, projectId, open\s*[,)]/.test(remote),
    'read_tasks advertises a card filter it never passes on'
  );
});

test('no advertised parameter uses JSON Schema type "integer"', () => {
  // cards_per_phase shipped as `integer` in 1.0.47 and was refused end to end on
  // every call, before AND after the server-side integer fix. Every pre-existing
  // numeric parameter in these catalogs uses `number` and works — recall's
  // `limit: 5` was verified against production in the same session that
  // `cards_per_phase: 2` failed.
  //
  // The rejecting layer was never localised: the server accepts `integer` when
  // the same validation is run locally. The reproducible fact is that the TYPE is
  // the only difference between a parameter that works and one that does not, so
  // the catalogs stick to the type that is proven end to end.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    const offenders = [...src.matchAll(/(\w+):\s*\{\s*type:\s*'integer'/g)].map((m) => m[1]);
    assert.deepEqual(
      offenders, [],
      `${name} catalog advertises type:'integer' for ${offenders.join(', ')} — use 'number' with a range instead; 'integer' is refused end to end over the connector`
    );
  }
});

test('both dispatchers advertise cards_per_phase, and both clamp it the same way', () => {
  // The parameter exists so a caller can see past the default 20 on a long
  // column. Advertised on one dispatcher only, it silently does nothing for
  // whichever half of the users are on the other — and most real users are on
  // the hosted one. An UNBOUNDED version would be worse than not having it: it
  // hands back the oversized response the cap was added to prevent.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(
      /cards_per_phase:\s*\{\s*type:\s*'number'/.test(src),
      `${name} catalog does not advertise cards_per_phase, so its callers cannot page a long column`
    );
    assert.ok(
      /cards_per_phase:[^}]*maximum:\s*50/.test(src),
      `${name} catalog advertises cards_per_phase without the 50 ceiling that keeps a listing bounded`
    );
  }
});

// Remote-only ON PURPOSE, not drift. The hosted catalog splits the task board
// into a write tool and a read tool so `readOnlyHint` can mean "writes nothing"
// on every catalog — the split the ChatGPT app review required. The local
// dispatcher folds the read into manage_tasks as action:'list' instead.
const DELIBERATE_REMOTE_ONLY = new Set(['read_tasks']);

test('the read/write split that justifies the remote-only tool still exists', () => {
  // If remote manage_tasks ever regains a 'list' action, read_tasks stops being
  // a deliberate split and becomes plain duplication — so this exception has to
  // expire on its own rather than sit in an allowlist forever.
  const raw = fs.readFileSync(REMOTE, 'utf8');
  const i = raw.indexOf('name: \'manage_tasks\'');
  assert.ok(i > 0, 'manage_tasks is missing from the remote catalog');
  const block = raw.slice(i, i + 1200);
  const actions = /enum:\s*\[([^\]]*)\]/.exec(block);
  assert.ok(actions, 'remote manage_tasks advertises no action enum');
  assert.ok(
    !/'list'/.test(actions[1]),
    'remote manage_tasks now offers action:\'list\', so read_tasks is no longer a read/write split — remove it from DELIBERATE_REMOTE_ONLY and reconcile the two catalogs'
  );
});

/**
 * Neither dispatcher may let an LLM decide whether the user's own sentence is
 * remembered (2026-09-19).
 *
 * update_context's summary is something a person explicitly sent, so it is an
 * instruction, not a candidate. The local dispatcher has always backed its
 * extraction call with a deterministic decision_made event for exactly that
 * reason. The hosted one did not, so its whole write rode on a model call —
 * and when the routing heuristic started skipping that call for every
 * already-bound session, "Context updated" was answered over an untouched row
 * for months.
 */
test('both dispatchers store the caller\'s summary without needing the model', () => {
  // The HOSTED half of this used to grep update_context's source for
  // `event_type: 'decision_made'` and `last_updated !== beforeStamp`. The second
  // string IS the bug that shipped under it: a delta of {category} moves
  // last_updated, so the comparison answered "stored" over a brief that did not
  // contain the caller's words. The hosted contract is now proven by reading the
  // row back, with and without a model, in
  // tests/integration/explicit-update-contract.test.js and
  // tests/integration/context-writeback-readback.test.js.
  //
  // What stays pinned here is only that both dispatchers reach the ONE service
  // path that owns the rule, so neither can quietly grow its own copy again.
  const i = remote.indexOf('case \'update_context\': {');
  assert.ok(i > 0, 'update_context is missing from the remote dispatcher');
  const block = remote.slice(i, remote.indexOf('case \'', i + 40));
  assert.match(
    block,
    /service\.recordExplicitUpdate\(actor,/,
    'remote update_context no longer goes through recordExplicitUpdate, the one path that stores the caller\'s words verbatim'
  );

  const localBlock = local.slice(
    local.indexOf('case \'update_context\':'),
    local.indexOf('case \'', local.indexOf('case \'update_context\':') + 60),
  );
  assert.match(
    localBlock,
    /event_type: 'decision_made'|explicit: true/,
    'the local dispatcher neither sends its update as explicit nor keeps its own deterministic summary event'
  );
});

/**
 * The same bug on the READ side, found on Fly v545 (2026-09-19).
 *
 * The local dispatcher's GetContextSchema has always had `project_id` optional,
 * described as "Omit to get the most recently active project", and its handler
 * passes undefined straight through to getActiveContext. The hosted one opened
 * with `throw new Error('project_id required')`.
 *
 * That is not a small asymmetry: get_context is what `recall({action:"context"})`
 * dispatches to, the most called read on the connector most real users are on,
 * and recall's OWN advertised schema says "Optional project ID. Some actions use
 * the active project when omitted." The catalog promised the fallback and the
 * handler refused it — the same shape as the write-side bug pinned below, on the
 * read side, and found nine months later because nobody diffs the two by hand.
 */
test('recall context falls back to the active project on both dispatchers', () => {
  const i = remote.indexOf('case \'get_context\': {');
  assert.ok(i > 0, 'get_context is missing from the remote dispatcher');
  const block = remote.slice(i, i + 900);
  assert.ok(
    !/throw new Error\('project_id required'\)/.test(block),
    'remote get_context still refuses an omitted project_id, while recall advertises the active-project fallback'
  );
  assert.match(
    block,
    /resolveProjectRefOrActive\(actor, args\?\.project_id/,
    'remote get_context does not resolve the active project'
  );

  // Local: the zod schema is the gate. An optional field there is what makes the
  // client's own `projectId?` fallback reachable at all.
  const schema = local.slice(local.indexOf('const GetContextSchema = z.object({'));
  assert.match(
    schema.slice(0, 200),
    /project_id: z\.string\(\)\.optional\(\)/,
    'GetContextSchema now requires project_id, so the local side has lost the fallback the remote one just gained'
  );

  // And the advertised contract that made this a broken promise rather than a
  // missing feature. Comment-blind by construction: this reads the catalog entry.
  const raw = fs.readFileSync(REMOTE, 'utf8');
  const recallIdx = raw.indexOf('name: \'recall\'');
  assert.ok(recallIdx > 0, 'recall is missing from the remote catalog');
  assert.match(
    raw.slice(recallIdx, recallIdx + 1200),
    /project_id: \{ type: 'string', description: '[^']*active project when omitted/,
    'recall no longer advertises the active-project fallback — if that is deliberate, this whole test should go with it'
  );
});

/**
 * The description promised a fallback the schema refused (2026-09-04).
 *
 * Every project_id on both catalogs is advertised as "omit to use the active
 * project", but record_hot_paths, record_debug_finding and (locally)
 * confirm_claim required it outright — so the documented call was rejected
 * before it reached either service, on the write path the product exists for.
 * The two dispatchers had the SAME bug independently, which is the whole reason
 * this file exists; they now have to gain the fallback together.
 */
test('the manage_memory writes fall back to the active project on both dispatchers', () => {
  // The handler blocks, not the whole file: several OTHER tools name a project
  // as required in their own description (export_trail, archive_project), and
  // those refusals are honest.
  const REMOTE_CASES = ['record_hot_paths', 'record_debug_finding', 'update_context'];
  for (const name of REMOTE_CASES) {
    const i = remote.indexOf(`case '${name}': {`);
    assert.ok(i > 0, `${name} is missing from the remote dispatcher`);
    const block = remote.slice(i, i + 1400);
    assert.ok(
      !/throw new Error\('project_id required'\)/.test(block),
      `remote ${name} still rejects an omitted project_id outright, while manage_memory advertises the fallback`
    );
    assert.match(
      block,
      /resolveProjectRefOrActive\(actor, args\?\.project_id/,
      `remote ${name} does not resolve the active project`
    );
  }

  // Local: the zod schemas are the gate, so the fallback below them is only
  // reachable if they stop demanding the field.
  for (const schema of ['RecordHotPathsSchema', 'RecordDebugFindingSchema', 'ConfirmClaimSchema']) {
    const block = local.slice(local.indexOf(`const ${schema} = z.object({`));
    assert.match(
      block.slice(0, 200),
      /project_id: z\.string\(\)\.min\(1\)\.optional\(\)/,
      `${schema} still requires project_id, so the cwd fallback below it is unreachable`
    );
  }

  // Each side resolves through ONE helper rather than a fourth inline copy.
  assert.ok(
    (local.match(/resolveProjectIdFromCwd\(client, parsed\.project_id/g) || []).length >= 3,
    'the local record_* writes do not all route through resolveProjectIdFromCwd'
  );
});

test('neither catalog advertises project_id as required on a record_* write', () => {
  for (const [label, file] of [['remote', REMOTE], ['local', LOCAL]]) {
    const raw = fs.readFileSync(file, 'utf8');
    for (const tool of ['record_hot_paths', 'record_debug_finding']) {
      const i = raw.indexOf(`name: '${tool}'`);
      assert.ok(i > 0, `${tool} is missing from the ${label} catalog`);
      const required = /required:\s*\[([^\]]*)\]/.exec(raw.slice(i, i + 900));
      assert.ok(required, `${label} ${tool} advertises no required list`);
      assert.ok(
        !/project_id/.test(required[1]),
        `${label} ${tool} advertises project_id as required while its description says it may be omitted`
      );
    }
  }
});

test('an empty account gets the same first-session guide from both dispatchers', () => {
  // Session one used to be cold on the hosted server: the overview placeholder
  // cleared the emptiness check, so a brand-new user got "No active workspace
  // summary yet." and no next step. Both sides now render one shared guide.
  const remote = fs.readFileSync(REMOTE, 'utf8');
  const local = fs.readFileSync(LOCAL, 'utf8');
  assert.match(remote, /require\('[./]+packages\/shared-context\/src\/firstSessionGuide\.js'\)/);
  assert.match(local, /from '[./]+shared-context\/src\/firstSessionGuide\.js'/);
  assert.match(remote, /if \(!deliveredRealContext\) \{[\s\S]{0,700}buildFirstSessionGuide\(\)/,
    'the hosted guide must be keyed on the structured overview, not on the rendered text length');
  // Local also carries the seeding answer from setup (ask first without a yes).
  assert.match(local, /buildFirstSessionGuide\(\{ local: true, readRepoWithoutAsking: repoSeedConsented\(\) \}\)/);
});

test('both dispatchers resolve move/complete/remove to exactly one card, by id', () => {
  // manage_tasks move/complete used matchesAnyTodoCard — a bidirectional
  // substring test — and the merge applied the query to every card containing
  // it: one "auth" completed three cards and reported one. Both dispatchers now
  // resolve through shared-context's resolveTaskCard (the rule remove already
  // used) and send the resolved card's id, so the merge cannot fan out either.
  for (const [name, src] of [['remote', remote], ['local', local]]) {
    assert.ok(/resolveTaskCard\(/.test(src), `${name} dispatcher does not resolve cards through resolveTaskCard`);
    assert.ok(!/matchesAnyTodoCard\(/.test(src), `${name} dispatcher still fuzzy-matches cards for a write`);
    for (const event of ['todo_moved', 'todo_completed', 'todo_removed']) {
      const at = src.indexOf(`'${event}'`);
      assert.ok(at !== -1, `${name}: ${event} emitted`);
      assert.ok(
        /todo: (?:r\.)?card\.id/.test(src.slice(at, at + 400)),
        `${name}: ${event} must name the resolved card by id, not echo the query`
      );
    }
  }
});

// start_session had no parity assertion at all, and drifted twice:
//
//   1. The local catalog advertises `verbosity`; the hosted one declared
//      `properties: {}`, which mcpSafety hardens to additionalProperties:false.
//      A CLAUDE.md written against the local server therefore failed on its
//      very first call to a hosted connector with "not a supported argument".
//   2. Local renders the active project's full injection (via /active). Hosted
//      rendered the startup workspace overview, which carries no decisions,
//      open questions, landmines, board or hot paths.
function startSessionDescriptor(src) {
  const start = src.search(/name:\s*'start_session'/);
  assert.ok(start !== -1, 'start_session descriptor found');
  const next = src.indexOf('name: \'', start + 20);
  return src.slice(start, next === -1 ? src.length : next);
}

function startSessionHandler(src) {
  const start = src.indexOf('case \'start_session\':');
  assert.ok(start !== -1, 'start_session handler found');
  const next = src.indexOf('case \'', start + 25);
  return src.slice(start, next === -1 ? src.length : next);
}

test('both catalogs advertise the same start_session verbosity enum', { skip: 'held: start_session verbosity is not advertised while the ChatGPT resubmission is in review' }, () => {
  const enumOf = (name, src) => {
    const m = startSessionDescriptor(src).match(/verbosity:\s*\{[^}]*enum:\s*\[([^\]]*)\]/);
    assert.ok(m, `${name} start_session advertises verbosity`);
    return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(enumOf('remote', remote), enumOf('local', local));
  assert.deepEqual(enumOf('remote', remote), ['light', 'standard']);
});

test('both dispatchers deliver the active project brief from start_session, not only an overview', () => {
  const hosted = startSessionHandler(remote);
  assert.match(hosted, /service\.renderInjection\(\s*actor,\s*activeForDedup\.project_id/,
    'hosted start_session renders the active project injection');
  assert.match(hosted, /args\?\.verbosity === 'light'/, 'hosted start_session reads verbosity');
  // The overview is the fallback for no active project, never the default body.
  assert.match(hosted, /if \(!body\) \{[\s\S]{0,200}getWorkspaceOverview\(/,
    'the overview is only the fallback when no brief rendered');
  // Hosted telemetry is emitted once, by recordRemoteSessionDelivery; the
  // injection must not emit a second context_delivered for the same start.
  assert.match(hosted, /record_side_effects:\s*false/);

  const stdio = startSessionHandler(local);
  assert.match(stdio, /getActiveContextByCwd\(/, 'local start_session fetches /active');
  assert.match(stdio, /args\?\.verbosity === 'light'/, 'local start_session reads verbosity');
});

// import_trail's contents cap is ONE number, MAX_TRAIL_CHARS in shared-context,
// and every layer a .dawn crosses reads it: the hosted field validator, the REST
// import schema, the JSON body parser in front of both, and the local runtime's
// pre-flight. Four hand-typed limits drift; a 4,000 default refused every real
// archive, and a 256kb parser would 413 before any of them spoke.
test('both dispatchers bound import_trail contents by the shared MAX_TRAIL_CHARS', () => {
  const { MAX_TRAIL_CHARS } = require('../../../../packages/shared-context/src/index.js');
  assert.ok(Number.isInteger(MAX_TRAIL_CHARS) && MAX_TRAIL_CHARS >= 100_000 && MAX_TRAIL_CHARS <= 500_000, 'room for a real archive, and a bounded pre-auth body');

  const safety = code(path.join(ROOT, 'apps/api/src/services/mcpSafety.js'));
  assert.match(safety, /\btrail:\s*MAX_TRAIL_CHARS\b/, 'hosted validator admits trail up to MAX_TRAIL_CHARS');

  const { TRAIL_JSON_BODY_LIMIT } = require('../../src/config/bodyLimits');
  assert.ok(TRAIL_JSON_BODY_LIMIT >= MAX_TRAIL_CHARS * 2, 'the parser admits a fully escaped max-size archive');
  const app = code(path.join(ROOT, 'apps/api/src/app.js'));
  assert.match(app, /'\/api\/v1\/context\/trail\/import'/, 'REST import gets the trail body limit');
  assert.match(app, /MCP_RESOURCE_PATH,\s*CLAUDE_MCP_RESOURCE_PATH,\s*\.\.\.LEGACY_MCP_RESOURCE_PATHS/, 'every MCP path gets it');
  assert.match(remote, /express\.json\(\{\s*limit:\s*require\('\.\.\/config\/bodyLimits'\)\.TRAIL_JSON_BODY_LIMIT/,
    'the MCP router parser does not re-impose the 100kb default');
  const rest = code(path.join(ROOT, 'apps/api/src/routes/context/context-sync.js'));
  assert.match(rest, /trail:\s*z\.union\(\[z\.string\(\)\.max\(MAX_TRAIL_CHARS\)/);

  assert.match(local, /contents\.length > MAX_TRAIL_CHARS/, 'local import_trail refuses oversize contents before posting');
});

// `task` is the one field of the brief extraction cannot write, so it is the one
// field that can only be corrected by passing it explicitly. The local catalog
// has advertised it since the local half of this fix landed
// (deerdawn-write-path-bugs-2026-08, #2); the hosted half was never copied, so
// the hosted schema did not declare it and mcpSafety's additionalProperties:false
// refused it as "not a supported argument" — the drift this file exists to catch,
// on the write path the product exists for.
//
// Both dispatchers now ACCEPT it. They advertise it differently, and that
// asymmetry is HELD on purpose: the ChatGPT resubmission is in review against a
// cached scan of the hosted tools/list, so the published schema stays
// byte-identical while validation admits the field. When the app is approved,
// move `task` into the hosted inputSchema, delete HELD_UNADVERTISED_PROPERTIES,
// and this pair of assertions collapses into one.
test('both dispatchers accept manage_memory task; only the local one advertises it (HELD)', () => {
  assert.match(local, /task: \{ type: 'string'/, 'local manage_memory advertises task');
  // `summary` left this destructuring in round 13: it is read (and masked)
  // separately. The pin is about `task`, so summary is optional here.
  assert.match(local, /const \{ project_id, (?:summary, )?task, tool, commands \} = normalizedArgs;/,
    'local update_context reads task');

  // `tool` left this destructuring on purpose: the hosted side derives its
  // surface label from the credential (hostedSessionTool) rather than taking the
  // catalog default, so that a Claude Code connector no longer files itself as
  // claude_web. `task` is what this assertion is about, and is still read here.
  assert.match(remote, /const \{ summary, task, commands \} = args;/,
    'hosted update_context reads task');
  const safety = code(path.join(ROOT, 'apps/api/src/services/mcpSafety.js'));
  assert.match(safety, /HELD_UNADVERTISED_PROPERTIES = \{[\s\S]{0,200}?manage_memory: \{[\s\S]{0,120}?task:/,
    'hosted validation admits task even though the catalog does not declare it');

  // HELD: the hosted shop window is unchanged until the app is approved.
  const manageMemoryAt = remote.indexOf('name: \'manage_memory\'');
  const hostedManageMemory = remote.slice(
    manageMemoryAt,
    // There is an earlier `name: 'manage_tasks'` (the board widget's _meta), so
    // the end of the declaration has to be searched for AFTER its start.
    remote.indexOf('name: \'manage_tasks\'', manageMemoryAt),
  );
  assert.ok(hostedManageMemory.length > 500, 'the hosted manage_memory declaration was found');
  assert.ok(!/\btask: \{ type: 'string'/.test(hostedManageMemory),
    'HELD: the hosted catalog must not declare task while the ChatGPT resubmission is in review');
});

// Scan 14: finish_task over a brief with NO current task invented a shipped item
// ("Task completed in <project>", confidence 1) on both dispatchers. Neither may
// fall back to a made-up summary, both skip the event when there is no task, and
// both say the same sentence.
test('finish_task with no current task: no invented shipped summary, same sentence on both', () => {
  const sentence = (src) => (src.match(/NO_TASK_TO_COMPLETE = '([^']+)'/) || [])[1];
  assert.ok(sentence(remote), 'hosted declares NO_TASK_TO_COMPLETE');
  assert.equal(sentence(local), sentence(remote), 'the two dispatchers say the same thing');
  for (const [name, src] of [['hosted', remote], ['local', local]]) {
    assert.ok(!/Task completed in \$\{/.test(src), `${name} still invents a task_completed summary`);
    assert.ok(/currentTask \? `Task remains recorded as completed: "\$\{currentTask\}"\.` : NO_TASK_TO_COMPLETE/.test(src),
      `${name} replies with NO_TASK_TO_COMPLETE when there is no task`);
  }
  // `const event =`: scan 23 keeps the event's reply to name the sections a
  // teammate's completion skipped.
  assert.match(remote, /if \(!refused\.length && currentTask\) \{\s*(?:const event = )?await service\.applyStructuredContextEvent/,
    'hosted emits task_completed only when there is a task');
  assert.match(local, /if \(currentTask\) \{\s*(?:const event = )?await client\.recordContextEvent\(\{\s*event_type: 'task_completed'/,
    'local emits task_completed only when there is a task');
});

// Scan 19: at 300 open cards every manage_tasks add evicted the oldest OPEN card,
// and both add handlers DROPPED the event result that named it (move and complete
// already collected theirs). The service now refuses an add that would pass the
// open-card limit, so an add never evicts open work; but an add into Done can
// still push the oldest completion off, and both add handlers must name it.
test('both manage_tasks add handlers collect what the write evicted', () => {
  const addHandler = (src, marker) => {
    const at = src.indexOf(marker);
    assert.ok(at !== -1, `add handler found (${marker})`);
    return src.slice(at, at + 9000);
  };
  const hosted = addHandler(remote, 'if (action === \'add\') {');
  const localAdd = addHandler(local, 'if (action === \'add\') {');
  assert.match(hosted, /collectEvictedCards\(\[\], await emit\('todo_added'/, 'hosted add keeps the event result');
  assert.match(hosted, /describeEvictedCards\(evicted\)/, 'hosted add reply names evicted cards');
  assert.match(localAdd, /collectEvictedCards\(evictedOnAdd, await client\.recordContextEvent\(\{\s*event_type: 'todo_added'/,
    'local add keeps the event result');
  assert.match(localAdd, /describeEvictedCards\(evictedOnAdd\)/, 'local add reply names evicted cards');
});

// Journey round 3, A1. After the nightly job archived both of a person's
// projects, start_session said "2 archived projects are waiting, not gone ...
// call recall(action:"projects") for the IDs", and both listings answered as if
// there were none: the hosted one "No projects yet. Use manage_projects with
// action "create" to create one.", the local one "[DeerDawn — 0 projects]". An
// assistant that believed either created an empty project beside the archived
// one. The listing is now rendered in ONE place, shared-context's
// formatProjectListing, from the live tree AND the archived feed, so the two
// dispatchers cannot say different things; these fail the day one side goes
// back to rendering its own.
function caseHandler(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `handler found (${marker})`);
  const next = src.indexOf('case \'', start + marker.length);
  return src.slice(start, next === -1 ? src.length : next);
}

test('neither dispatcher renders the project listing itself, and both list archived projects', () => {
  const hosted = caseHandler(remote, 'case \'list_projects\'');
  const localListing = caseHandler(local, 'case \'list_projects\'');
  for (const [name, src] of [['hosted', hosted], ['local', localListing]]) {
    assert.ok(/formatProjectListing\(/.test(src), `${name} list_projects does not use the shared listing formatter`);
    assert.ok(!/No projects yet/.test(src), `${name} list_projects says "No projects yet" in its own words again`);
    assert.ok(!/lines\.push\(`• \$\{/.test(src), `${name} list_projects renders its own lines again`);
  }
  assert.match(hosted, /service\.listArchivedProjectSummaries\(actor, \{ limit: ARCHIVED_PROJECTS_FETCH_LIMIT \}\)/,
    'hosted list_projects does not read the archived feed');
  assert.match(localListing, /listArchivedForListing\(client, \{ strict: true \}\)/,
    'local list_projects does not read the archived feed (strictly: an API that ignored ?archived=1 answers with LIVE projects)');
  assert.match(local, /listArchivedContextProjects\(ARCHIVED_PROJECTS_FETCH_LIMIT\)/,
    'local archived feed reads the whole set');
});

test('both start_session notices count the whole archived feed, as the listing they point to does', () => {
  // A notice fed the default page of 10 says "10 archived projects" to somebody
  // the listing then shows 14.
  assert.match(remote, /listArchivedProjectSummaries\(actor, \{ limit: ARCHIVED_PROJECTS_FETCH_LIMIT \}\)\.catch\(\(\) => \[\]\);\s*archivedNoticeCache = formatArchivedProjectsNotice\(archived\)/,
    'hosted notice reads a page of the archived feed');
  assert.match(local, /formatArchivedProjectsNotice\(await listArchivedForListing\(client\)\)/,
    'local notice reads a page of the archived feed');
});

test('both dispatchers say the same thing when a project is archived', () => {
  // Both used to promise the project would leave the listing ("It won't appear
  // in recall({ action: "projects" })"); it is listed now, marked archived.
  assert.match(caseHandler(remote, 'case \'archive_project\''), /formatProjectArchivedReply\(project\)/);
  assert.match(caseHandler(local, 'case \'archive_project\''), /formatProjectArchivedReply\(/);
  for (const [name, src] of [['hosted', remote], ['local', local]]) {
    assert.ok(!/won't appear in recall|no longer appear in normal project lists/.test(src), `${name} still says an archived project leaves the listing`);
  }
});

test('both dispatchers refuse an entity with nothing to file it under, in the same words (journey r5)', () => {
  // An entity naming no project goes to the active project; with none, nothing is
  // saved workspace-wide, and the refusal says how to pick a project and how to
  // ask for the workspace. Two hand-written copies of one sentence.
  const sentence = (src, name) => {
    const m = new RegExp(`${name} = ([\\s\\S]*?);\\n`).exec(src);
    assert.ok(m, `${name} not found`);
    return Function(`return ${m[1]}`)();
  };
  const hostedSentence = sentence(remote, 'NO_PROJECT_FOR_ENTITIES');
  assert.equal(sentence(local, 'NO_PROJECT_FOR_ENTITIES'), hostedSentence);
  assert.match(hostedSentence, /Nothing was saved/);
  assert.match(hostedSentence, /scope:"workspace"/);
  for (const [name, src] of [['hosted', remote], ['local', local]]) {
    const handler = src.slice(src.indexOf('function fileEntitiesUnderProject') === -1 ? src.indexOf('async function fileEntitiesUnderProject') : src.indexOf('function fileEntitiesUnderProject'));
    assert.match(handler.slice(0, 2600), /NO_PROJECT_FOR_ENTITIES/, `${name} fileEntitiesUnderProject does not refuse`);
  }
  // And both say where the entities went, from the ONE note the service writes.
  assert.match(remote, /result\?\.filed_note/, 'hosted reply does not carry the service\'s filed_note');
  assert.match(local, /result\.filed_note/, 'local reply does not carry the service\'s filed_note');
});

test('both dispatchers book session one at create and lead start_session with the receipt (activation 3a/3b)', () => {
  // Create: hosted books the load in its dispatch; local flags the POST so the
  // server books it (a website create sends no flag and books nothing).
  assert.match(caseHandler(remote, 'case \'create_project\''), /recordCreationSessionLoad\(/);
  assert.match(caseHandler(local, 'case \'create_project\''), /mcpSession: \{ tool: resolveIdentifiedSurface\(\) \}/);
  // start_session: both put the server-rendered receipt line first.
  assert.match(caseHandler(remote, 'case \'start_session\''), /payload\.receipt/);
  assert.match(caseHandler(local, 'case \'start_session\''), /parts\.unshift\(activeResult\.receipt/);
});
