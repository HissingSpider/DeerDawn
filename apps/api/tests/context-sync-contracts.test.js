const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('./helpers/privatePaths');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');

function readFromApi(relativePath) {
  return fs.readFileSync(path.join(apiRoot, relativePath), 'utf8');
}

function readFromRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function existsInRepo(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

// `requires`: repo paths the test reads that only the private repo has; the
// test is reported as skipped where they are missing (the public export).
function test(name, fn, { requires = [] } = {}) {
  const skip = privateSkipReason(...requires);
  if (skip) {
    console.log(`- ${name} (skipped: ${skip})`);
    return;
  }
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Context Sync Contract Tests ===\n');

const appSource = readFromApi('src/app.js');
const schemaSource = readFromApi('src/schemas/index.js');
const MARKETING = { requires: ['apps/marketing'] };
const AGENT_FILES = { requires: ['AGENTS.md', 'CLAUDE.md'] };
const readPrivate = (rel) => (privateSkipReason(rel) ? '' : readFromRepo(rel));
const marketingHome = readPrivate('apps/marketing/src/pages/index.tsx');
const quickstartPage = readPrivate('apps/marketing/src/pages/docs/quickstart.tsx');
const mcpPage = readPrivate('apps/marketing/src/pages/mcp.tsx');
const docsIndexPage = readPrivate('apps/marketing/src/pages/docs/index.tsx');
// The dashboard's landing page and its brief page are two different files as of
// the 2026-08-27 nav change: `/` is Today (what you touched last, across every
// project) and `/projects` is the brief that used to live there.
const dashboardToday = readFromRepo('apps/dashboard/src/pages/index.tsx');
const dashboardBrief = readFromRepo('apps/dashboard/src/pages/projects.tsx');
const agentsSource = readPrivate('AGENTS.md');
const claudeSource = readPrivate('CLAUDE.md');
const { buildDeerdawnInstructionLines } = require(path.join(repoRoot, 'packages/shared-context/src/deerdawnInstructions.js'));

test('API mounts a dedicated context sync route namespace', () => {
  assert(
    existsInRepo('apps/api/src/routes/context/context-sync.js'),
    'context sync route module is missing'
  );
  assert(
    appSource.includes('/api/v1/context'),
    'context sync route namespace is not mounted in the API app'
  );
});

test('API exposes context sync schemas and extraction contracts', () => {
  for (const token of [
    'ContextObjectSchema',
    'ContextEventSchema',
    'ExtractionRequestSchema',
    'ExtractionResponseSchema',
    'ContextRuntimeLayerSchema',
    'ProjectMatchResultSchema',
    'InjectionPayloadSchema',
    'WorkspaceOverviewResultSchema',
  ]) {
    assert(schemaSource.includes(token), `${token} is missing from schema exports`);
  }
});

test('MCP context sync tools expose workspace overview and typed workspace entity mutation', () => {
  const mcpToolsSource = readFromRepo('packages/mcp-server/src/tools/context-sync.ts');
  const mcpPromptSource = readFromRepo('packages/mcp-server/src/prompts/context-sync.ts');
  const mcpAuthSource = readFromRepo('packages/mcp-server/src/tools/auth.ts');
  const mcpIndexSource = readFromRepo('packages/mcp-server/src/tools/index.ts');
  for (const token of [
    'name: \'get_workspace_overview\'',
    'name: \'get_workspace_entities\'',
    'name: \'upsert_workspace_entities\'',
    'name: \'get_next_best_context\'',
    'name: \'cleanup_context\'',
    'name: \'get_project_map\'',
    'name: \'find_known_paths\'',
    'name: \'record_hot_paths\'',
    'name: \'record_debug_finding\'',
  ]) {
    assert(mcpToolsSource.includes(token), `context-sync MCP tools are missing ${token}`);
  }
  assert(mcpAuthSource.includes('name: \'apply_setup\''), 'auth MCP tools are missing apply_setup');
  assert(mcpAuthSource.includes('name: \'complete_setup\''), 'auth MCP tools are missing complete_setup');
  assert(
    mcpIndexSource.includes('AUTH_TOOLS') && mcpIndexSource.includes('complete_setup'),
    'tools router is missing complete_setup auth dispatch'
  );
  assert(
    mcpPromptSource.includes('Use DeerDawn before repo search for orientation and known paths'),
    'context sync assistant prompt is missing DeerDawn-first search guidance'
  );
});

test('team sharing routes and section permission guards exist', () => {
  const teamRoutesSource = readFromRepo('apps/api/src/routes/shared/teams.js');
  const contextRoutesSource = readFromRepo('apps/api/src/routes/context/context-sync.js');
  const contextServiceSource = readFromRepo('apps/api/src/services/contextSyncService.js');
  const contextStoreSource = readFromRepo('apps/api/src/store/contextSyncStore.js');

  for (const token of [
    'router.get(\'/projects-sharing\'',
    'router.patch(\'/projects/:projectId/sharing\'',
    'SHAREABLE_SECTIONS',
    'DEFAULT_SHARED_SECTIONS',
  ]) {
    assert(teamRoutesSource.includes(token), `teams sharing route is missing ${token}`);
  }

  for (const token of [
    'share_write_forbidden',
    'canEditSectionForActor',
    'canViewProjectForActor',
    'filterContextBySectionPolicy',
    'getProjectSharePolicy',
  ]) {
    assert(contextServiceSource.includes(token), `context sharing guard is missing ${token}`);
  }

  for (const token of [
    'context_project_shares',
    'context_project_share_sections',
    'context_project_members',
    'owner_user_id',
    'visibility',
    'upsertProjectShare',
    'getProjectShare',
  ]) {
    assert(contextStoreSource.includes(token), `context sharing storage is missing ${token}`);
  }

  assert(
    contextRoutesSource.includes('context_write_blocked') && contextRoutesSource.includes('share_write_forbidden'),
    'context routes are missing blocked write audit handling'
  );
});

test('command capture hooks and command lifecycle cleanup are wired', () => {
  const mcpAuthSource = readFromRepo('packages/mcp-server/src/auth.ts');
  const mcpIndexSource = readFromRepo('packages/mcp-server/src/index.ts');
  const contextServiceSource = readFromRepo('apps/api/src/services/contextSyncService.js');

  for (const token of [
    'matcher: \'Bash\'',
    'capture-command',
  ]) {
    assert(mcpAuthSource.includes(token), `hook auto-setup is missing ${token}`);
  }

  for (const token of [
    'cliCommand === \'capture-command\'',
    'captureCommandFromHook',
  ]) {
    assert(mcpIndexSource.includes(token), `mcp cli command dispatch is missing ${token}`);
  }

  for (const token of [
    'canCaptureCommandsForActor',
    'plan_not_eligible',
    'patch.commands = []',
  ]) {
    assert(contextServiceSource.includes(token), `context command lifecycle handling is missing ${token}`);
  }
});

test('repo-level agent instructions require DeerDawn-first orientation with repo-search fallback', () => {
  for (const source of [agentsSource, claudeSource]) {
    assert(source.includes('start_session'), 'agent instructions must require start_session');
    assert(
      source.includes('Use DeerDawn before repo search for orientation'),
      'agent instructions are missing DeerDawn-first orientation guidance'
    );
    assert(
      source.includes('Use repo search only when you need file-level or symbol-level resolution'),
      'agent instructions are missing explicit repo-search fallback boundaries'
    );
    assert(
      source.includes('record_hot_paths') || source.includes('write them back to DeerDawn'),
      'agent instructions are missing durable path writeback guidance'
    );
  }
}, AGENT_FILES);

test('generated DeerDawn instruction block contains required orientation and repo-search boundaries', () => {
  const generated = buildDeerdawnInstructionLines().join('\n');
  assert(
    generated.includes('Use DeerDawn before repo search for orientation'),
    'generated instruction block is missing DeerDawn-first orientation guidance'
  );
  assert(
    generated.includes('Use repo search only when you need file-level or symbol-level resolution'),
    'generated instruction block is missing explicit repo-search fallback boundaries'
  );
  assert(
    generated.includes('build_subagent_brief') && generated.includes('isolated/no-history'),
    'generated instruction block is missing the orchestrator subagent-brief rule'
  );
  assert(
    generated.includes('[DeerDawn Subagent Brief v1]') && generated.includes('skips the full `start_session`'),
    'generated instruction block is missing the marked worker startup exception'
  );
});

test('shared workspace packages exist for context contracts and tool adapters', () => {
  for (const relativePath of [
    'packages/shared-context/package.json',
    'packages/shared-context/src/index.js',
    'packages/tool-adapters/package.json',
    'packages/tool-adapters/src/index.js',
  ]) {
    assert(existsInRepo(relativePath), `${relativePath} is missing`);
  }
});

test('MCP server package and remote MCP infrastructure exist', () => {
  for (const relativePath of [
    'packages/mcp-server/package.json',
    'packages/mcp-server/src/tools/index.ts',
    'apps/api/src/routes/mcp.js',
  ]) {
    assert(existsInRepo(relativePath), `${relativePath} is missing`);
  }
  assert(!existsInRepo('apps/desktop'), 'apps/desktop should be removed — use apps/_archived if needed');
  assert(!existsInRepo('apps/extension'), 'apps/extension should be removed — use apps/_archived if needed');
});

test('marketing homepage presents the session-memory product architecture', () => {
  for (const token of [
    'Cold vs. briefed',
    'how-it-works',
    'Start free',
    '#demo',
  ]) {
    assert(marketingHome.includes(token), `marketing homepage is missing ${token}`);
  }
}, MARKETING);

test('quickstart doc teaches the MCP-first self-serve setup flow', () => {
  for (const token of [
    'Connect DeerDawn in under 5 minutes',
    'Create your workspace',
    'Remote MCP URL',
    'Confirm your first briefed session',
  ]) {
    assert(quickstartPage.includes(token), `quickstart doc is missing ${token}`);
  }
}, MARKETING);

test('mcp landing page matches the open self-serve launch posture', () => {
  for (const token of [
    'Get started free',
    'Self-serve',
    'remote MCP',
    'local MCP',
    'Claude.ai',
  ]) {
    assert(mcpPage.includes(token), `mcp page is missing ${token}`);
  }
}, MARKETING);

test('docs hub is centered on session memory and MCP setup', () => {
  for (const token of [
    'session memory',
    'MCP Quickstart',
    'DeerDawn docs',
    '/docs/quickstart',
  ]) {
    assert(docsIndexPage.includes(token), `docs hub is missing ${token}`);
  }
}, MARKETING);

test('dashboard primary mode stays focused on the new context-sync product while governance stays separate', () => {
  assert(
    dashboardBrief.includes('BriefWorkspace'),
    'the brief page (/projects) is missing the BriefWorkspace'
  );
  assert(
    dashboardBrief.includes('mcp_registered'),
    'the brief page should surface MCP setup status'
  );
  assert(
    dashboardBrief.includes('Get started'),
    'the brief page should show a get-started / first-value checklist'
  );
  // Whichever page a user lands on first has to be able to send an unconnected
  // account somewhere useful. Today is the default landing, so it carries the
  // same two routes rather than dead-ending someone with no projects yet.
  //
  // Today reaches the connect route through the CONNECT_ROUTE constant rather
  // than a literal, deliberately: the route used to be written twice on that page
  // with two DIFFERENT values, and a single constant is what stops that
  // recurring. So resolve the constant instead of grepping for the string —
  // asserting the literal would force the duplication back.
  const todayLib = readFromRepo('apps/dashboard/src/lib/todayConnection.ts');
  const connectRoute = /CONNECT_ROUTE\s*=\s*'([^']+)'/.exec(todayLib)?.[1];
  assert(connectRoute, 'todayConnection.ts must define CONNECT_ROUTE');
  assert(
    dashboardToday.includes('CONNECT_ROUTE') && connectRoute === '/onboarding',
    'Today should route an unconnected account to onboarding via CONNECT_ROUTE'
  );
  assert(
    dashboardToday.includes('/context/import'),
    'Today should offer the context import flow'
  );
  assert(
    dashboardBrief.includes('/onboarding') && dashboardBrief.includes('/context/import'),
    'the brief page should route incomplete setups to onboarding and context import flows'
  );
});

test('the dashboard landing page is Today, and it is built from cross-project recency', () => {
  // Today replaced the brief as the default landing because "what was I doing"
  // is the question that opens the tab. Its whole premise is that it reads
  // ACROSS projects — a version of this page scoped to one project would just be
  // a worse brief, which is why it was blocked on the project cap coming off.
  assert(
    dashboardToday.includes('getContextProjects'),
    'Today must read every project, not a single selected one'
  );
  assert(
    dashboardToday.includes('mcp_surfaces'),
    'Today must show connection health — which surfaces are live and when each last called in'
  );
  assert(
    !dashboardToday.includes('BriefWorkspace'),
    'Today is not the brief; the brief lives at /projects'
  );
});

test('launch operations docs exist for public launch and support response', () => {
  for (const relativePath of [
    'docs/deerdawn-launch-operations.md',
    'docs/deerdawn-support-playbook.md',
  ]) {
    assert(existsInRepo(relativePath), `${relativePath} is missing`);
  }
}, { requires: ['docs/deerdawn-launch-operations.md'] }); // internal ops docs: private repo only

if (process.exitCode) {
  console.error('\nContext sync contracts failed.');
} else {
  console.log('\nContext sync contracts in place.');
}
