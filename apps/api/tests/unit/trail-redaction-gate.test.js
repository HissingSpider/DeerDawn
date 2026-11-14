/**
 * Trail redaction + publish gate (LAUNCH BLOCKER). No DB.
 *
 * These assertions are the reason a Trail can be made public at all. Weakening
 * one to make a workflow smoother re-opens the leak it was written to close —
 * if a test here is in the way, the fix is a better scanner, not a bypass.
 */
const test = require('node:test');
const assert = require('node:assert');

const { scanContent, excludePaths } = require('../../src/services/trail/trailScan');
const publish = require('../../src/services/trail/trailPublish');
const { buildTrail } = require('../../src/services/trail/trailExport');
const { makeProject } = require('../helpers/trailFixture');

function leakyTrail() {
  const project = makeProject({ withSecrets: true });
  return buildTrail({
    project,
    graph: project.graph,
    source: { repo_url: 'https://github.com/example/repo', commit_sha: 'a1b2c3d4e5f6' },
    exportedAt: '2026-08-17T00:00:00.000Z',
    trailId: 'trail_leaky',
  });
}

function resolveAll(findings, action, justification) {
  const decisions = {};
  for (const finding of findings) {
    decisions[finding.id] = { action, digest: finding.digest, justification };
  }
  return decisions;
}

test('the scanner catches every category the workspace actually leaks', () => {
  const trail = leakyTrail();
  const { findings } = scanContent(trail.content, { seededNames: ['Tanya Reyes'] });
  const categories = new Set(findings.map((finding) => finding.category));
  for (const expected of ['credential', 'email', 'home_path', 'financial', 'account_number', 'person_name']) {
    assert.ok(categories.has(expected), `expected a ${expected} finding, got: ${[...categories].join(', ')}`);
  }
});

test('findings never re-leak the secret they flag', () => {
  const trail = leakyTrail();
  const { findings } = scanContent(trail.content);
  const credential = findings.find((finding) => finding.category === 'credential');
  assert.ok(credential, 'expected a credential finding');
  assert.ok(!credential.excerpt.includes('sk-proj-abcdefghijklmnop1234'), `excerpt leaked the key: ${credential.excerpt}`);
  const email = findings.find((finding) => finding.category === 'email');
  assert.ok(!email.excerpt.includes('tanya.reyes@'), `excerpt leaked the full address: ${email.excerpt}`);
});

test('the scanner is never weaker than the storage redactor', () => {
  // Anything utils/secretRedaction masks on the way in must be flagged on the
  // way out, so adding a provider pattern there cannot silently leave a hole here.
  const samples = [
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'xoxb-123456789012-abcdefghijkl',
    'postgres://user:s3cr3tpassword@db.example.com/app',
  ];
  for (const sample of samples) {
    const { findings } = scanContent({ brief: { description: `note ${sample} here` } });
    assert.ok(
      findings.some((finding) => finding.category === 'credential'),
      `no credential finding for: ${sample}`,
    );
  }
});

test('a clean Trail produces no high-severity findings', () => {
  const project = makeProject({ withSecrets: false });
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_clean', exportedAt: '2026-08-17T00:00:00.000Z' });
  const { findings } = scanContent(trail.content, { includeHeuristicNames: false });
  const high = findings.filter((finding) => finding.severity === 'high');
  assert.deepStrictEqual(high.map((f) => `${f.category}@${f.path}`), [], 'clean fixture should not trip high-severity detectors');
});

test('publish is refused when a single finding is left unresolved', () => {
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail, { seededNames: ['Tanya Reyes'] });
  assert.ok(preview.findings.length > 1);

  const decisions = resolveAll(preview.findings.slice(1), 'exclude');
  const result = publish.finalizePublish(trail, decisions, { seededNames: ['Tanya Reyes'] });
  assert.strictEqual(result.ok, false);
  const unresolved = result.errors.filter((error) => error.code === 'unresolved_finding');
  assert.strictEqual(unresolved.length, 1);
  assert.strictEqual(unresolved[0].finding_id, preview.findings[0].id);
});

test('there is no publish-all shortcut', () => {
  const trail = leakyTrail();
  for (const key of ['*', 'all', 'approve_all', '__all__']) {
    const result = publish.finalizePublish(trail, { [key]: { action: 'keep', justification: 'ship it already' } });
    assert.strictEqual(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.code === 'bulk_approval_rejected'),
      `"${key}" should be rejected as a bulk approval`,
    );
  }
});

test('keeping a high-severity finding costs a per-finding justification', () => {
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail);
  const high = preview.findings.filter((finding) => finding.severity === 'high');
  assert.ok(high.length, 'fixture should contain high-severity findings');

  // Bulk "keep" with no justification: rejected, one error per high finding.
  const bare = publish.finalizePublish(trail, resolveAll(preview.findings, 'keep'));
  assert.strictEqual(bare.ok, false);
  const required = bare.errors.filter((error) => error.code === 'justification_required');
  assert.strictEqual(required.length, high.length);

  // A one-word justification is not a justification.
  const lazy = publish.finalizePublish(trail, resolveAll(preview.findings, 'keep', 'ok'));
  assert.ok(lazy.errors.some((error) => error.code === 'justification_required'));
});

test('a decision does not survive an edit to the field it approved', () => {
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail);
  const decisions = resolveAll(preview.findings, 'exclude');

  const edited = JSON.parse(JSON.stringify(trail));
  edited.content.brief.description = 'Rewritten, now with OPENAI_API_KEY=sk-proj-zzzzzzzzzzzzzzzz9999 instead.';

  const result = publish.finalizePublish(edited, decisions);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.code === 'unresolved_finding' || error.code === 'stale_decision'),
    `expected the stale approval to be refused, got: ${JSON.stringify(result.errors.map((e) => e.code))}`,
  );
});

test('a decision set from a stale scan is rejected, not silently ignored', () => {
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail);
  const decisions = resolveAll(preview.findings, 'exclude');
  decisions.deadbeefdeadbeef = { action: 'exclude' };
  const result = publish.finalizePublish(trail, decisions);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'unknown_finding'));
});

test('excluding every finding publishes, and the sensitive material is gone', () => {
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail, { seededNames: ['Tanya Reyes'] });
  const result = publish.finalizePublish(trail, resolveAll(preview.findings, 'exclude'), { seededNames: ['Tanya Reyes'] });

  assert.strictEqual(result.ok, true, `expected publish to succeed, errors: ${JSON.stringify(result.errors)}`);
  const serialized = JSON.stringify(result.trail);
  for (const secret of ['sk-proj-abcdefghijklmnop1234', 'tanya.reyes@apexfund.example.com', '/Users/dev', '4111 1111 1111 1111']) {
    assert.ok(!serialized.includes(secret), `published Trail still contains: ${secret}`);
  }
  assert.strictEqual(result.trail.manifest.redaction.scanned, true);
  assert.ok(result.trail.manifest.redaction.excluded_paths.length > 0);
});

test('the published Trail is re-sealed over the REDACTED bytes', () => {
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail, { seededNames: ['Tanya Reyes'] });
  const result = publish.finalizePublish(trail, resolveAll(preview.findings, 'exclude'), { seededNames: ['Tanya Reyes'] });
  assert.strictEqual(result.ok, true);
  const { verifyChecksum } = require('../../src/services/trail/trailFormat');
  assert.strictEqual(verifyChecksum(result.trail).valid, true, 'a stale checksum would read as tampering to any consumer');
  assert.notStrictEqual(result.trail.checksum.value, trail.checksum.value);
});

test('the server re-scans the redacted result rather than trusting the first pass', () => {
  // Two credentials in adjacent array members. Excluding the first shifts the
  // second's index, so the first scan's paths are stale by the time redaction
  // is applied — exactly the case the second pass exists to catch.
  const content = {
    brief: {},
    decisions: [
      { summary: 'first', reasoning: 'key AKIAIOSFODNN7EXAMPLE here' },
      { summary: 'second', reasoning: 'key AKIAJJJJJJJJJJJJJJJJ here' },
    ],
    graph: { nodes: [], edges: [] },
    paths: [], findings: [], commands: [], board: { cards: [] },
  };
  const first = scanContent(content).findings;
  assert.strictEqual(first.length, 2);

  // Resolve only the first path; the naive result would leave the second secret
  // in place while reporting success.
  const { content: redacted } = excludePaths(content, [first[0].path]);
  const rescan = scanContent(redacted).findings;
  assert.strictEqual(rescan.length, 1, 'the second credential must still be found after the index shift');
  assert.ok(JSON.stringify(redacted).includes('AKIAJJJJJJJJJJJJJJJJ'));
});

test('the manifest cannot carry a secret the content redaction removed', () => {
  // Regression: manifest.description was an independent COPY of
  // content.brief.description. Excluding the content field left the identical
  // credential sitting in the manifest, and because the gate only scanned
  // `content`, the re-scan came back clean and the publish succeeded. The
  // manifest is now derived from the redacted content and the whole document is
  // scanned before it ships.
  const trail = leakyTrail();
  assert.ok(trail.manifest.description.includes('sk-proj-'), 'fixture must reproduce the copy');

  const preview = publish.buildPreview(trail, { seededNames: ['Tanya Reyes'] });
  const result = publish.finalizePublish(trail, resolveAll(preview.findings, 'exclude'), { seededNames: ['Tanya Reyes'] });

  assert.strictEqual(result.ok, true);
  assert.ok(!result.trail.manifest.description.includes('sk-proj-'), 'manifest still carries the credential');
  assert.ok(!JSON.stringify(result.trail.manifest).includes('sk-proj-'));
});

test('a secret planted only in the manifest blocks the publish', () => {
  // The backstop, tested directly: a manifest field that is NOT a copy of
  // anything in content must still stop the gate.
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail, { seededNames: ['Tanya Reyes'] });
  const decisions = resolveAll(preview.findings, 'exclude');

  const planted = JSON.parse(JSON.stringify(trail));
  planted.manifest.exporter.version = 'build ghp_abcdefghijklmnopqrstuvwxyz0123';

  const result = publish.finalizePublish(planted, decisions, { seededNames: ['Tanya Reyes'] });
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.code === 'unresolved_in_published_document'),
    `expected the whole-document scan to catch it, got: ${JSON.stringify(result.errors.map((e) => e.code))}`,
  );
});

test('unpublish flips state and refuses to promise a recall', () => {
  const trail = leakyTrail();
  const result = publish.unpublish(trail, { reason: 'leaked a client name' });
  assert.strictEqual(result.trail.manifest.published.state, 'unpublished');
  assert.ok(result.trail.manifest.published.unpublished_at);
  assert.match(result.notice, /does not recall copies/i);
  const { verifyChecksum } = require('../../src/services/trail/trailFormat');
  assert.strictEqual(verifyChecksum(result.trail).valid, true);
});

test('excludePaths removes the field entirely rather than masking it', () => {
  const content = { brief: { description: 'secret AKIAIOSFODNN7EXAMPLE here', current_task: 'keep me' }, graph: { nodes: [], edges: [] } };
  const { content: out, removed } = excludePaths(content, ['content.brief.description']);
  assert.deepStrictEqual(removed, ['content.brief.description']);
  assert.strictEqual(out.brief.description, undefined);
  assert.strictEqual(out.brief.current_task, 'keep me');
  assert.ok(!JSON.stringify(out).includes('REDACTED'), 'a published Trail should not advertise where a secret used to be');
});

test('a project is never blocked from publishing by its own name', () => {
  // Regression, found by publishing the demo projects through the real API.
  // collectSeededNames used to harvest every capitalized token from the owner's
  // project titles, so a project called "Sync Loop" seeded "Sync" and "Loop" as
  // personal names — which then matched that project's own title in the
  // manifest at HIGH severity. The whole-document backstop refused the publish,
  // and because the offending field is the title, no exclusion could clear it:
  // the project was permanently unpublishable under its own name.
  const project = makeProject();
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_selfname', exportedAt: '2026-08-17T00:00:00.000Z' });

  // Seeds are now the account holder only, never words lifted from titles.
  const preview = publish.buildPreview(trail, { seededNames: [] });
  const result = publish.finalizePublish(trail, resolveAll(preview.findings, 'exclude'), { seededNames: [] });

  assert.strictEqual(result.ok, true, `a clean project must publish, got: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(result.trail.manifest.title, 'Sync Loop', 'the title must survive publication intact');
});

test('backstop findings report the path they actually live at', () => {
  // The manifest is scanned as part of the whole document; a finding there must
  // not be reported under "content.manifest.…", which is a path that does not
  // exist and sends the author hunting for the wrong field.
  const trail = leakyTrail();
  const preview = publish.buildPreview(trail, { seededNames: [] });
  const planted = JSON.parse(JSON.stringify(trail));
  planted.manifest.exporter.version = 'build ghp_abcdefghijklmnopqrstuvwxyz0123';

  const result = publish.finalizePublish(planted, resolveAll(preview.findings, 'exclude'), { seededNames: [] });
  assert.strictEqual(result.ok, false);
  const backstop = result.errors.find((e) => e.code === 'unresolved_in_published_document');
  assert.ok(backstop, 'expected the backstop to fire');
  assert.match(backstop.path, /^manifest\./, `path should be rooted at the manifest, got ${backstop.path}`);
});

test('excluding the project name does not resurrect it in the manifest title', () => {
  // Regression: the manifest title is derived from content.brief.project_name,
  // and its fallback chain ended at the PRE-redaction manifest title. Excluding
  // the name therefore put the removed value straight back into the published
  // document — and since the resurrected field is a title, no further exclusion
  // could clear it. Found publishing a project literally named "Marketing Site".
  const project = makeProject();
  project.project_name = 'Marketing Site';
  project.context.project_name = 'Marketing Site';
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_name', exportedAt: '2026-08-17T00:00:00.000Z' });
  assert.strictEqual(trail.manifest.title, 'Marketing Site');

  const preview = publish.buildPreview(trail, { seededNames: [] });
  const nameFinding = preview.findings.find((f) => f.path === 'content.brief.project_name');
  assert.ok(nameFinding, 'fixture should flag the two-word title heuristically');

  const result = publish.finalizePublish(trail, resolveAll(preview.findings, 'exclude'), { seededNames: [] });
  assert.strictEqual(result.ok, true, `publish should succeed, got: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(result.trail.manifest.title, 'Untitled Trail', 'an excluded name must not come back as the title');
  assert.ok(!JSON.stringify(result.trail).includes('Marketing Site'));
});

test('a low-severity finding can be kept without a justification', () => {
  // The escape hatch that makes the gate usable: "Marketing Site" is not a
  // person, and saying so should cost one click, not an essay.
  const project = makeProject();
  project.project_name = 'Marketing Site';
  project.context.project_name = 'Marketing Site';
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_keep', exportedAt: '2026-08-17T00:00:00.000Z' });

  const preview = publish.buildPreview(trail, { seededNames: [] });
  assert.ok(preview.findings.every((f) => f.severity === 'low'), 'this fixture should only trip the heuristic');

  const result = publish.finalizePublish(trail, resolveAll(preview.findings, 'keep'), { seededNames: [] });
  assert.strictEqual(result.ok, true, `keeping a low finding should publish, got: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(result.trail.manifest.title, 'Marketing Site', 'a kept name stays intact');
});

test('machine identifiers are not mistaken for account numbers', () => {
  // Regression, found publishing real projects: every board card id and graph
  // node id looks like `todo-1787941234-9tbp6`, and the bare digit-run branch
  // matched the embedded timestamp — a HIGH "account number" finding per card
  // and per node on an ordinary publish.
  //
  // Worse than noise: the only way to clear a finding on an id is to exclude the
  // field, and excluding a node_id breaks every edge referencing it. The gate
  // would have corrupted the graph in the name of protecting it.
  const identifiers = [
    'todo-1787941234-9tbp6',
    'graph_node_a4ab518d-b85f-4331-8074-9c1f2e',
    'project_274f9619-676a-4378-a11b-533fb8eb973f',
    'trail_1787941234567',
  ];
  for (const id of identifiers) {
    const { findings } = scanContent({ brief: { note: id } });
    assert.deepStrictEqual(
      findings.filter((f) => f.category === 'account_number').map((f) => f.excerpt),
      [],
      `identifier flagged as an account number: ${id}`,
    );
  }

  // The detector must still catch the real thing.
  for (const real of ['account 123456789012 please', 'card 4111 1111 1111 1111', 'iban GB29NWBK60161331926819']) {
    const { findings } = scanContent({ brief: { note: real } });
    assert.ok(
      findings.some((f) => f.category === 'account_number'),
      `missed a real account number: ${real}`,
    );
  }
});

test('publishing never strips a graph node id an edge depends on', () => {
  // The structural consequence of the bug above, asserted directly: after a
  // publish, every edge endpoint must still resolve to a node that exists.
  const project = makeProject();
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_edges', exportedAt: '2026-08-17T00:00:00.000Z' });
  const preview = publish.buildPreview(trail, { seededNames: [] });
  const result = publish.finalizePublish(trail, resolveAll(preview.findings, 'keep'), { seededNames: [] });

  assert.strictEqual(result.ok, true, `expected publish, got: ${JSON.stringify(result.errors)}`);
  const ids = new Set(result.trail.content.graph.nodes.map((n) => n.node_id));
  assert.ok(result.trail.content.graph.edges.length > 0, 'fixture should carry edges');
  for (const edge of result.trail.content.graph.edges) {
    assert.ok(ids.has(edge.from_node_id) && ids.has(edge.to_node_id), `published Trail has a dangling edge: ${JSON.stringify(edge)}`);
  }
});

test('a card body is scanned, gated, and excludable without destroying the card', () => {
  // Board card bodies travel in an export. A body is free text the author wrote
  // and can hold anything, so this asserts the reason it is safe to publish:
  // the scanner walks content by SHAPE (trailScan.walkStrings), not by a field
  // allowlist, so a body is covered the moment it exists — no scanner change was
  // needed, and none may be assumed. If this test ever fails, `body` must come
  // back out of trailExport.buildBoard, not be waived here.
  const project = makeProject();
  project.context.todo_items = [{
    id: 'card-body',
    title: 'Reproduce the sync stall',
    body: 'Run from /Users/dev/clients/apexfund and email tanya.reyes@apexfund.example.com.',
    phase: 'backlog',
    created_at: '2026-07-01T00:00:00.000Z',
  }];
  project.context.completed_todos = [];
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_body', exportedAt: '2026-08-17T00:00:00.000Z' });

  assert.strictEqual(trail.content.board.cards[0].body, project.context.todo_items[0].body, 'the body must be in the export');

  const preview = publish.buildPreview(trail, { seededNames: [] });
  const bodyFindings = preview.findings.filter((f) => f.path === 'content.board.cards[0].body');
  const categories = new Set(bodyFindings.map((f) => f.category));
  assert.ok(categories.has('home_path'), 'a home path in a card body must be found');
  assert.ok(categories.has('email'), 'an email in a card body must be found');
  // The finding is attributable, so the author can act on the right card.
  assert.deepStrictEqual(bodyFindings[0].section, 'board');
  assert.deepStrictEqual(bodyFindings[0].entity, { kind: 'board_card', id: 'card-body' });

  // Leaving it unresolved must block.
  const blocked = publish.finalizePublish(trail, {}, { seededNames: [] });
  assert.strictEqual(blocked.ok, false, 'an unresolved card body must not publish');
  assert.ok(blocked.errors.some((e) => e.path === 'content.board.cards[0].body'));

  // Excluding the body removes the body ONLY — the card survives.
  const published = publish.finalizePublish(trail, resolveAll(preview.findings, 'exclude'), { seededNames: [] });
  assert.strictEqual(published.ok, true, `expected a publish, got: ${JSON.stringify(published.errors)}`);
  const card = published.trail.content.board.cards.find((c) => c.id === 'card-body');
  assert.ok(card, 'excluding a body must not delete the card');
  assert.strictEqual(card.title, 'Reproduce the sync stall');
  assert.strictEqual(card.body, undefined, 'the body must be gone');
});

test('a member id never leaves the workspace inside a published Trail', () => {
  // Decisions and findings are picked field by field, and `contributed_by` was
  // deliberately left off both lists: an author id is workspace bookkeeping,
  // exactly like owner_user_id, and a Trail is built to be published. Landmines
  // and shipped entries ride out as whole objects inside the brief, so the same
  // rule has to be applied to them by hand or attribution walks out with them.
  const project = {
    project_id: 'proj_attr',
    project_name: 'Payments API',
    context: {
      description: 'team work',
      landmines: [{ summary: 'Rotating the master key orphans every DEK', added_at: '2026-09-20T01:00:00.000Z', contributed_by: 'user-sarah' }],
      shipped: [{ summary: 'Shipped the share policy', shipped_at: '2026-09-20T02:00:00.000Z', contributed_by: 'user-sarah', confirmed_by: 'user-marcus' }],
      recent_decisions: [{ summary: 'Redis for the session cache', decided_at: '2026-09-20T03:00:00.000Z', contributed_by: 'user-sarah' }],
      debugging_notes: [{ summary: 'The consent redirect drops the code', added_at: '2026-09-20T04:00:00.000Z', contributed_by: 'user-marcus' }],
    },
  };
  const trail = buildTrail({ project, graph: { nodes: [], edges: [] }, trailId: 'trail_attr', exportedAt: '2026-09-20T05:00:00.000Z' });
  const serialized = JSON.stringify(trail.content);
  assert.ok(!serialized.includes('contributed_by'), `an author id travelled: ${serialized}`);
  assert.ok(!serialized.includes('confirmed_by'), `a corroborating id travelled: ${serialized}`);
  assert.ok(!serialized.includes('user-sarah'), 'no member id may appear anywhere in the content');
  // And the entries themselves still travel — stripping the author is not
  // dropping the landmine.
  assert.strictEqual(trail.content.brief.landmines.length, 1);
  assert.strictEqual(trail.content.brief.shipped.length, 1);
});
