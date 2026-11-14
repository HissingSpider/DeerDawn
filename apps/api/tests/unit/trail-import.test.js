/**
 * Trail import — the non-clobbering merge. No DB.
 *
 * The property under test throughout: importing a stranger's Trail into a
 * project you have been building for months must never cost you anything you
 * already knew.
 */
const test = require('node:test');
const assert = require('node:assert');

const { planImport, canonicalKeyFor } = require('../../src/services/trail/trailImport');
const { buildTrail } = require('../../src/services/trail/trailExport');
const { makeProject } = require('../helpers/trailFixture');

function trailFrom(overrides = {}) {
  const project = makeProject();
  Object.assign(project.context, overrides);
  return buildTrail({ project, graph: project.graph, trailId: 'trail_import', exportedAt: '2026-08-17T00:00:00.000Z' });
}

test('importing into an empty project fills every section', () => {
  const trail = trailFrom();
  const plan = planImport(trail, null);

  assert.strictEqual(plan.patch.current_task, 'Harden the extraction retry path');
  assert.ok(plan.patch.goals.length >= 2);
  assert.ok(plan.patch.recent_decisions.length > 0);
  assert.ok(plan.patch.hot_paths.length > 0);
  assert.ok(plan.patch.commands.length > 0);
  assert.ok(plan.entities.length > 0);
  assert.ok(plan.relations.length > 0);
  assert.strictEqual(plan.summary.into_new_project, true);
});

test('an existing scalar is never overwritten, and the conflict is reported', () => {
  const trail = trailFrom();
  const target = {
    project_id: 'project_target',
    context: {
      current_task: 'My own task, thanks',
      current_status: 'My own status',
      description: 'My own description',
    },
  };
  const plan = planImport(trail, target);

  assert.strictEqual(plan.patch.current_task, undefined);
  assert.strictEqual(plan.patch.current_status, undefined);
  assert.strictEqual(plan.patch.description, undefined);

  const fields = plan.conflicts.map((conflict) => conflict.field);
  for (const field of ['current_task', 'current_status', 'description']) {
    assert.ok(fields.includes(field), `expected a reported conflict for ${field}`);
  }
  assert.ok(plan.conflicts.every((conflict) => conflict.resolution === 'kept_existing'));
});

test('an empty scalar is filled rather than skipped', () => {
  const trail = trailFrom();
  const plan = planImport(trail, { project_id: 'p', context: { current_task: '   ', current_status: 'mine' } });
  assert.strictEqual(plan.patch.current_task, 'Harden the extraction retry path');
  assert.strictEqual(plan.patch.current_status, undefined);
});

test('list fields union instead of replacing — this is the clobber that mergeContextObject would do', () => {
  const trail = trailFrom();
  const target = {
    project_id: 'p',
    context: { goals: ['Ship the thing I actually care about'], tech_stack: ['Go'] },
  };
  const plan = planImport(trail, target);

  assert.ok(plan.patch.goals.includes('Ship the thing I actually care about'), 'the project lost its own goal');
  assert.ok(plan.patch.goals.includes('Never lose a decision'), 'the imported goal did not arrive');
  assert.ok(plan.patch.tech_stack.includes('Go'));
  assert.ok(plan.patch.tech_stack.includes('PostgreSQL'));
});

test('a local command wins a label collision and the difference is reported', () => {
  const trail = trailFrom();
  const target = {
    project_id: 'p',
    context: { commands: [{ label: 'Migrate', command: 'npm run my-own-migrate' }] },
  };
  const plan = planImport(trail, target);

  const migrate = plan.patch.commands.filter((entry) => entry.label === 'Migrate');
  assert.strictEqual(migrate.length, 1);
  assert.strictEqual(migrate[0].command, 'npm run my-own-migrate');
  assert.ok(plan.conflicts.some((conflict) => conflict.field === 'commands.Migrate'));
});

test('hot paths are keyed on the path, so a local label survives', () => {
  const trail = trailFrom();
  const target = {
    project_id: 'p',
    context: { hot_paths: [{ path: 'apps/api/src/services/contextSyncService.js', label: 'MY label', why: 'my reason' }] },
  };
  const plan = planImport(trail, target);
  const entries = plan.patch.hot_paths.filter((entry) => entry.path === 'apps/api/src/services/contextSyncService.js');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].label, 'MY label');
});

// Was pinned the other way ("someone else's finished work … arrives as
// Backlog"). A kind:project Trail is the project's own history moved between
// machines, and reopening its Done column put every finished card back in the
// importer's Backlog. Knowledge for other people's projects is a pack, which
// imports no cards at all (see the pack tests).
test('a project Trail keeps finished work finished: Done cards import as Done', () => {
  const trail = trailFrom();
  const plan = planImport(trail, null);
  const imported = plan.patch.add_todos.find((card) => card.title === 'Split the sync store');
  assert.ok(imported, 'the done card should still import');
  assert.strictEqual(imported.phase, 'done');
  const open = plan.patch.add_todos.find((card) => card.title === 'Instrument retry latency');
  assert.strictEqual(open.phase, 'in_progress', 'open cards keep their own column');
});

test('a legacy completed card with no phase but a completed_at imports as Done', () => {
  const trail = trailFrom({
    completed_todos: [{ id: 'card-0', title: 'Split the sync store', created_at: '2026-06-01T00:00:00.000Z', completed_at: '2026-06-10T00:00:00.000Z' }],
  });
  assert.strictEqual(trail.content.board.cards.find((c) => c.title === 'Split the sync store').phase, undefined, 'precondition: exported with no phase');
  const plan = planImport(trail, null);
  assert.strictEqual(plan.patch.add_todos.find((c) => c.title === 'Split the sync store').phase, 'done');
});

test('a board card the project already has is not duplicated', () => {
  const trail = trailFrom();
  const target = {
    project_id: 'p',
    context: { todo_items: [{ id: 'mine', title: 'Instrument retry latency', phase: 'done', created_at: '2026-07-01T00:00:00.000Z' }] },
  };
  const plan = planImport(trail, target);
  assert.ok(!(plan.patch.add_todos || []).some((card) => card.title === 'Instrument retry latency'));
});

test('importing the same Trail twice converges', () => {
  const trail = trailFrom();
  const first = planImport(trail, null);

  // Simulate the first import having landed.
  const target = {
    project_id: 'p',
    context: {
      current_task: first.patch.current_task,
      goals: first.patch.goals,
      tech_stack: first.patch.tech_stack,
      recent_decisions: first.patch.recent_decisions,
      hot_paths: first.patch.hot_paths,
      debugging_notes: first.patch.debugging_notes,
      commands: first.patch.commands,
      todo_items: (first.patch.add_todos || []).map((card, index) => ({
        id: `card-${index}`, title: card.title, phase: card.phase, created_at: '2026-08-17T00:00:00.000Z',
      })),
    },
  };
  const second = planImport(trail, target);

  assert.strictEqual(second.summary.applied.decisions, 0, 'decisions duplicated on re-import');
  assert.strictEqual(second.summary.applied.paths, 0, 'hot paths duplicated on re-import');
  assert.strictEqual(second.summary.applied.commands, 0, 'commands duplicated on re-import');
  assert.strictEqual(second.summary.applied.board_cards, 0, 'board cards duplicated on re-import');
});

test('graph edges resolve to entities the upsert will actually create', () => {
  const trail = trailFrom();
  const plan = planImport(trail, null);

  // Every relation endpoint must match the canonical key derived from one of the
  // planned entities — otherwise upsertWorkspaceEntities silently drops the edge
  // (`if (!fromNode || !toNode) continue;`) and the imported graph loses its
  // structure without any error.
  const entityKeys = new Set(plan.entities.map((entity) => canonicalKeyFor(entity.entity_type, entity.title)));
  assert.ok(plan.relations.length > 0, 'fixture should produce relations');
  for (const relation of plan.relations) {
    assert.ok(entityKeys.has(relation.from_canonical_key), `unresolvable from: ${relation.from_canonical_key}`);
    assert.ok(entityKeys.has(relation.to_canonical_key), `unresolvable to: ${relation.to_canonical_key}`);
  }
});

test('the canonical key derivation matches contextSyncService', () => {
  // planImport addresses relations by canonical key; contextSyncService derives
  // the same key from entity_type + title when it upserts. If these two ever
  // drift, upsertWorkspaceEntities silently drops every imported edge
  // (`if (!fromNode || !toNode) continue;`) — an import that reports success and
  // quietly loses the graph structure.
  //
  // The service is read as source rather than required: requiring it opens the
  // database and Redis, which a unit test has no business doing. Extracting the
  // two functions is enough to prove the algorithms agree.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/contextSyncService.js'), 'utf8');

  const normalizeKeySource = /function normalizeKey\([\s\S]*?\n}/.exec(source);
  const canonicalSource = /function canonicalWorkspaceKey\([\s\S]*?\n}/.exec(source);
  assert.ok(normalizeKeySource, 'normalizeKey not found — did it get renamed?');
  assert.ok(canonicalSource, 'canonicalWorkspaceKey not found — did it get renamed?');

   
  const serviceCanonical = new Function(`
    ${normalizeKeySource[0]}
    ${canonicalSource[0]}
    return canonicalWorkspaceKey;
  `)();

  const samples = [
    ['service', 'Context API'],
    ['knowledge', 'Retry semantics note 0'],
    ['database', 'Primary Postgres'],
    ['capability', 'Two  spaces & punctuation!'],
    ['tool', '  leading and trailing  '],
    ['concept', 'MixedCase/Slashes-And_Underscores'],
  ];
  for (const [type, title] of samples) {
    assert.strictEqual(
      canonicalKeyFor(type, title),
      serviceCanonical(type, title),
      `canonical key drifted for ${type}/${title}`,
    );
  }
});

test('imported entities are tagged with the Trail they came from', () => {
  const trail = trailFrom();
  const plan = planImport(trail, null);
  assert.ok(plan.entities.every((entity) => entity.metadata.imported_from_trail === 'trail_import'));
});

test('import records attribution as a decision', () => {
  const trail = trailFrom();
  const plan = planImport(trail, null);
  const attribution = plan.patch.recent_decisions.find((entry) => /Imported Trail/.test(entry.summary));
  assert.ok(attribution, 'the project should be able to say where this context came from');
  assert.match(attribution.reasoning, /not pinned/i, 'an unpinned Trail should say so');
});

test('an unpinned Trail is flagged, a pinned one carries its SHA', () => {
  const project = makeProject();
  const pinned = buildTrail({
    project, graph: project.graph, trailId: 't',
    source: { repo_url: 'https://github.com/example/repo', commit_sha: 'a1b2c3d4e5f6' },
  });
  assert.strictEqual(pinned.manifest.source.pinned, true);

  const unpinned = buildTrail({ project, graph: project.graph, trailId: 't', source: { repo_url: 'https://github.com/example/repo' } });
  assert.strictEqual(unpinned.manifest.source.pinned, false);
  assert.strictEqual(unpinned.manifest.source.unpinned_reason, 'no_commit_sha');

  const bogus = buildTrail({ project, graph: project.graph, trailId: 't', source: { repo_url: 'https://x/y', commit_sha: 'not-a-sha' } });
  assert.strictEqual(bogus.manifest.source.unpinned_reason, 'invalid_commit_sha');
});

test('import refuses a tampered Trail', () => {
  const trail = trailFrom();
  const tampered = JSON.parse(JSON.stringify(trail));
  tampered.content.brief.current_task = 'injected';
  assert.throws(() => planImport(tampered, null), /checksum/i);
});

test('export drops owner-identifying fields entirely', () => {
  const project = makeProject();
  project.owner_key = 'owner_secret';
  project.owner_user_id = 'user_123';
  project.linked_paths = ['/Users/dev/Desktop/DeerDawn'];
  project.linked_conversations = ['conv_abc'];
  project.context.tool_presence = { claude_code: { last_seen_at: 'now', host: 'johns-laptop' } };

  const serialized = JSON.stringify(buildTrail({ project, graph: project.graph, trailId: 't' }));
  for (const leak of ['owner_secret', 'user_123', '/Users/dev', 'conv_abc', 'johns-laptop']) {
    assert.ok(!serialized.includes(leak), `export carried owner-identifying data: ${leak}`);
  }
});

test('export drops edges whose endpoints did not survive', () => {
  const project = makeProject();
  project.graph.edges.push({ edge_type: 'calls', from_node_id: 'node_service_0', to_node_id: 'node_that_does_not_exist' });
  const trail = buildTrail({ project, graph: project.graph, trailId: 't' });
  const ids = new Set(trail.content.graph.nodes.map((node) => node.node_id));
  for (const edge of trail.content.graph.edges) {
    assert.ok(ids.has(edge.from_node_id) && ids.has(edge.to_node_id), 'dangling edge survived export');
  }
});

// ─── Packs ───────────────────────────────────────────────────────────────────
// A pack is knowledge written for projects it was never part of. Fill-only
// already protects an established project; these tests are about the EMPTY one,
// where every field the pack carries would otherwise be adopted wholesale.

function packFrom(overrides = {}) {
  const project = makeProject();
  Object.assign(project.context, overrides);
  return buildTrail({ project, graph: project.graph, kind: 'pack', trailId: 'trail_pack', exportedAt: '2026-08-18T00:00:00.000Z' });
}

test('a pack never donates its author task state, even into an empty project', () => {
  const plan = planImport(packFrom(), null);

  for (const field of ['current_task', 'current_status', 'next_action', 'blocking_issue', 'task_progress', 'description', 'category', 'goals', 'open_questions', 'file_structure_summary']) {
    assert.strictEqual(plan.patch[field], undefined, `a pack donated ${field}`);
  }
  assert.strictEqual(plan.summary.kind, 'pack');
  // Silently dropping would be indistinguishable from the pack having nothing
  // to say, so what was withheld is reported.
  assert.ok(plan.summary.skipped_brief_fields.includes('current_task'));
  assert.ok(plan.summary.skipped_brief_fields.includes('goals'));
});

test('a pack still donates the knowledge worth having', () => {
  const plan = planImport(packFrom(), null);

  assert.ok(plan.patch.tech_stack.length > 0, 'tech_stack should travel');
  assert.ok(plan.patch.recent_decisions.length > 0, 'decisions should travel');
  assert.ok(plan.patch.hot_paths.length > 0, 'hot paths should travel');
  assert.ok(plan.patch.commands.length > 0, 'commands should travel');
  assert.ok(plan.entities.length > 0, 'graph nodes should travel');
  assert.ok(plan.relations.length > 0, 'graph edges should travel');
});

test('a pack donates no board cards — they are its author\'s work', () => {
  const plan = planImport(packFrom(), null);
  assert.strictEqual(plan.patch.add_todos, undefined);
  assert.strictEqual(plan.summary.applied.board_cards, 0);
});

test('the same Trail exported as a project does donate all of it', () => {
  const plan = planImport(trailFrom(), null);
  assert.strictEqual(plan.summary.kind, 'project');
  assert.ok(plan.patch.current_task, 'a project Trail fills an empty current_task');
  assert.ok(plan.patch.goals.length > 0);
  assert.deepStrictEqual(plan.summary.skipped_brief_fields, []);
});

test('a pack merged into an established project adds without conflicting', () => {
  const target = {
    project_id: 'project_target',
    context: {
      current_task: 'My own task',
      goals: ['Ship the thing'],
      tech_stack: ['TypeScript'],
    },
  };
  const plan = planImport(packFrom(), target);

  assert.strictEqual(plan.patch.current_task, undefined);
  assert.deepStrictEqual(plan.patch.goals, undefined, 'goals stay the importer\'s own');
  assert.ok(plan.patch.tech_stack.includes('TypeScript'), 'the existing stack survives the union');
  // No conflicts to report: a pack never proposed the fields that would collide.
  assert.strictEqual(plan.conflicts.filter((entry) => entry.field === 'current_task').length, 0);
});

test('a card body survives the export/import round trip', () => {
  // The detail IS the card. Exporting title+phase only meant a project handed to
  // someone else arrived as a list of headlines — repro steps, file paths and
  // specs silently dropped, with nothing in the payload to say so.
  const trail = trailFrom({
    todo_items: [
      { id: 'card-detailed', title: 'Reproduce the sync stall', body: 'Start the API, then POST /extraction twice inside a second.', phase: 'backlog', created_at: '2026-07-01T00:00:00.000Z' },
      { id: 'card-bare', title: 'Tune the backoff curve', phase: 'backlog', created_at: '2026-07-01T00:00:00.000Z' },
    ],
    completed_todos: [],
  });

  const exported = trail.content.board.cards.find((card) => card.id === 'card-detailed');
  assert.strictEqual(exported.body, 'Start the API, then POST /extraction twice inside a second.');

  const plan = planImport(trail, null);
  const detailed = plan.patch.add_todos.find((card) => card.title === 'Reproduce the sync stall');
  assert.strictEqual(detailed.body, 'Start the API, then POST /extraction twice inside a second.');

  // A card with no body must not gain an empty one — `body: ''` would make the
  // listing print a has-body marker for a card with nothing to open.
  const bare = plan.patch.add_todos.find((card) => card.title === 'Tune the backoff curve');
  assert.ok(bare, 'the bodyless card should still import');
  assert.strictEqual('body' in bare, false, 'a bodyless card must not acquire a body key');
});
