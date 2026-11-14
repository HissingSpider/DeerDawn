'use strict';

// Seed a pre-created reviewer account through the public API.
// In Clerk-authoritative production, create the reviewer as a Clerk password
// user first; a local-only password session cannot authorize the OAuth flow.
// This deliberately does not create credentials or print the API key.
const API_URL = String(process.env.DEERDAWN_API_URL || 'https://api.deerdawn.com').replace(/\/+$/, '');
const API_KEY = String(process.env.REVIEWER_API_KEY || '').trim();

if (!API_KEY.startsWith('dd_')) {
  console.error('Set REVIEWER_API_KEY to a reviewer-scoped DeerDawn API key.');
  process.exit(1);
}

/** ISO timestamp N days before now, so seeded history never ages out on re-seed. */
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function call(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${body.error || body.message || 'unknown error'}`);
  return body;
}

async function main() {
  const existing = await call('/api/v1/context/projects');
  const projects = Array.isArray(existing.projects) ? existing.projects : [];
  let project = projects.find((item) => item.project_name === 'Aurora Launch Review');
  if (!project) {
    const created = await call('/api/v1/context/projects', {
      method: 'POST',
      body: JSON.stringify({
        project_name: 'Aurora Launch Review',
        description: 'Synthetic product-launch workspace used only by marketplace reviewers.',
        goals: ['Verify cross-tool session continuity', 'Ship a safe OAuth-connected MCP launch'],
        current_status: 'Review fixtures are ready; OAuth and tool behavior are under verification.',
        tech_stack: ['Node.js', 'PostgreSQL', 'OAuth 2.1', 'Model Context Protocol'],
        recurring_context: ['All names and data in this workspace are fictional', 'Never store credentials in project context'],
      }),
    });
    project = created.project;
  }

  const projectId = project.project_id;
  await call(`/api/v1/context/projects/${encodeURIComponent(projectId)}/context`, {
    method: 'PATCH',
    body: JSON.stringify({
      current_task: 'Verify the production MCP connection and prepare the directory submission.',
      blocking_issue: 'Publisher business verification must be completed by an authorized account owner.',
      open_questions: ['Which directory finishes review first?', 'Does the reviewer need any additional fixture?'],
      // Stamped relative to the run, not to a fixed date. These used to be
      // hardcoded at 2026-08-09, which meant the fixture ROTTED: a plan with a
      // memory window drops entries older than N days, so seven days after that
      // date the reviewer's brief silently stopped carrying its own decisions —
      // whenever the seeder was run. A reviewer asking "what was decided?" then
      // got one unrelated entry and an upgrade notice. Days ago, so they read as
      // history rather than as something that happened this second.
      recent_decisions: [
        { summary: 'Use one universal MCP endpoint for every tenant.', reasoning: 'It keeps configuration and review behavior consistent.', importance: 'high', decided_at: daysAgo(3) },
        { summary: 'Keep v1 headless and MCP-only.', reasoning: 'The product value is structured context, not embedded UI.', importance: 'normal', decided_at: daysAgo(2) },
      ],
      hot_paths: [
        { path: 'apps/api/src/routes/mcp.js', label: 'Remote MCP endpoint', purpose: 'Tool catalog, dispatch, scopes, and safety boundary.' },
        { path: 'docs/launch/native-mcp-review-cases.json', label: 'Review corpus', purpose: 'Expected positive, negative, auth, isolation, and safety behavior.' },
      ],
      commands: [{ label: 'review_cases', run: 'npm run test:mcp-review -w deerdawn-api', note: 'Runs without production credentials.' }],
      add_todos: [{ title: 'Run reviewer OAuth smoke test', phase: 'in_progress' }],
    }),
  });

  // browse_skills is one of the seven advertised tools and a reviewer will run
  // it. Without a seeded skill the only honest demonstration is an empty list,
  // which reads as a broken tool rather than an empty account. Upsert is keyed
  // by (owner, slug), so re-running the seeder updates rather than duplicates.
  await call('/api/v1/context/skills', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Release checklist',
      slug: 'release-checklist',
      description: 'The steps this fictional workspace runs before shipping a release.',
      body: [
        '# Release checklist',
        '',
        'Synthetic fixture content. All names and data in this workspace are fictional.',
        '',
        '1. Confirm the OAuth smoke test passed against the staging tenant.',
        '2. Re-read the task board and close anything still sitting in Testing.',
        '3. Tag the release and record the decision in project memory.',
        '4. Announce the release to the team channel.',
      ].join('\n'),
    }),
  }).catch((error) => {
    // A skill cap or a disabled shared-skills flag on the reviewer tenant should
    // not abort a seed whose project fixtures already landed. Say so loudly
    // instead, because browse_skills then has nothing to show.
    console.error(`[seed] skill fixture not created: ${error.message}`);
  });

  console.log(JSON.stringify({ seeded: true, project_id: projectId, project_name: project.project_name }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
