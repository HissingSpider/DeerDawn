import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { DeerdawnClient } from '../src/client.js';
import type { Config } from '../src/config.js';

const base = 'http://localhost:19999';
const apiKey = 'dd_sandbox_abcdefghijklmnopqrstuvwxyz0123456789';

function makeClient(): DeerdawnClient {
  const config: Config = {
    apiUrl: base,
    apiKey,
    environment: 'sandbox',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 0,
    retryBackoffMs: 100,
  };
  return new DeerdawnClient(config);
}

afterEach(() => {
  nock.cleanAll();
});

describe('DeerdawnClient HTTP mapping', () => {
  it('getOrganizationSettings reads /api/v1/orgs/usage', async () => {
    nock(base)
      .get('/api/v1/orgs/usage')
      .reply(200, {
        org_name: 'Acme',
        plan: {
          org_id: 'org-1',
          tier: 'growth',
          fail_mode: 'closed',
          redaction_mode: 'strict',
          is_locked: false,
          shadow_mode: false,
          redaction_keys: [],
        },
      });

    const s = await makeClient().getOrganizationSettings();
    expect(s.org_id).toBe('org-1');
    expect(s.name).toBe('Acme');
    expect(s.plan).toBe('growth');
    expect(s.fail_mode).toBe('closed');
  });

  it('recordProductEvent posts to /api/v1/product-events', async () => {
    nock(base)
      .post('/api/v1/product-events', (body) => {
        return body.event_name === 'mcp_runtime_started' && body.source === 'mcp';
      })
      .reply(201, { event: { event_id: 'evt-1' } });

    const result = await makeClient().recordProductEvent({
      event_name: 'mcp_runtime_started',
      source: 'mcp',
      metadata: { execution_source: 'stdio' },
    });

    expect(result.event.event_id).toBe('evt-1');
  });

  it('getAuditLogs uses /api/v1/audit', async () => {
    nock(base)
      .get('/api/v1/audit')
      .reply(200, {
        logs: [{ log_id: 'l1', org_id: 'org-1', actor: 'u1', action: 'read', created_at: '2020-01-01T00:00:00.000Z' }],
      });

    const r = await makeClient().getAuditLogs();
    expect(r.logs).toHaveLength(1);
    expect(r.total).toBe(1);
    expect(r.logs[0].actor).toBe('u1');
  });

  it('getWorkspaceOverview reads /api/v1/context/workspace/overview', async () => {
    nock(base)
      .get('/api/v1/context/workspace/overview')
      .query({ mode: 'overview', verbosity: 'standard', include: 'projects,knowledge', format: 'json' })
      .reply(200, {
        overview: {
          summary: { now: ['Ship overview'] },
          layers: {
            direct_context: {
              id: 'direct_context',
              title: 'Direct context',
              summary: 'Current work from MCP, chats, projects, and active tasks.',
              status: 'active',
              input_count: 3,
              selected_count: 2,
              highlights: ['Atlas: ship overview'],
            },
            passive_enrichment: {
              id: 'passive_enrichment',
              title: 'Passive enrichment',
              summary: 'Imported notes and docs quietly strengthening active context.',
              status: 'warming',
              input_count: 1,
              selected_count: 0,
              highlights: ['No imported enrichments selected yet.'],
            },
            intelligence: {
              id: 'intelligence',
              title: 'Intelligence layer',
              summary: 'Ranking, deduplication, and packaging decide what survives.',
              status: 'active',
              input_count: 4,
              selected_count: 2,
              highlights: ['Ranking active-task context ahead of archival memory.'],
            },
          },
          projects: [],
          knowledge: [],
          tools: [],
          capabilities: [],
          provenance: [],
        },
      });

    const result = await makeClient().getWorkspaceOverview({
      mode: 'overview',
      verbosity: 'standard',
      include: ['projects', 'knowledge'],
      format: 'json',
    });

    expect(result.summary.now[0]).toBe('Ship overview');
    expect(result.layers.direct_context.id).toBe('direct_context');
  });

  it('upsertWorkspaceEntities posts typed entities and relations', async () => {
    nock(base)
      .post('/api/v1/context/workspace/entities', (body) => {
        return (
          Array.isArray(body.entities) &&
          body.entities[0]?.entity_type === 'knowledge' &&
          Array.isArray(body.relations) &&
          body.relations[0]?.relation_type === 'supports'
        );
      })
      .reply(200, {
        entities: [{ canonical_key: 'knowledge:layered-briefs' }],
        relations: [{ relation_type: 'supports' }],
      });

    const result = await makeClient().upsertWorkspaceEntities({
      entities: [{
        entity_type: 'knowledge',
        title: 'Layered briefs',
        summary: 'Short summary first, deeper sections later.',
      }],
      relations: [{
        from_canonical_key: 'knowledge:layered-briefs',
        to_canonical_key: 'capability:workspace-overview',
        relation_type: 'supports',
      }],
    });

    expect(result.entities[0].canonical_key).toBe('knowledge:layered-briefs');
    expect(result.relations[0].relation_type).toBe('supports');
  });

  it('getNextBestContext reads /api/v1/context/workspace/next', async () => {
    nock(base)
      .get('/api/v1/context/workspace/next')
      // session_id is sent on every next-best call so the server can withhold
      // cards another agent is holding. Asserted as a matcher rather than a
      // literal because the id is per-process.
      // cwd travels as a header now (location-headers.ts): it must NOT be in the URL.
      .query((q) => q.tool === 'codex' && q.cwd === undefined && q.limit === '3' && typeof q.session_id === 'string' && q.session_id.length > 0)
      .matchHeader('x-deerdawn-cwd', encodeURIComponent('/repo/atlas'))
      .reply(200, {
        result: {
          summary: 'Most relevant next context for Atlas.',
          suggestions: [
            {
              kind: 'entity',
              label: 'Layered startup summaries',
              reason: 'Pinned workspace knowledge.',
              score: 0.93,
              canonical_key: 'knowledge:layered-startup-summaries',
            },
          ],
          provenance: [],
        },
      }, { 'X-DeerDawn-Location': 'header' });

    const result = await makeClient().getNextBestContext({
      tool: 'codex',
      cwd: '/repo/atlas',
      limit: 3,
    });

    expect(result.suggestions[0].canonical_key).toBe('knowledge:layered-startup-summaries');
  });

  it('getWorkspaceEntities forwards scope and curated filters', async () => {
    nock(base)
      .get('/api/v1/context/workspace/entities')
      .query({ scope: 'workspace', curated_only: 1, status: 'active', format: 'json' })
      .reply(200, { entities: [{ canonical_key: 'knowledge:atlas' }] });

    const result = await makeClient().getWorkspaceEntities({
      scope: 'workspace',
      curated_only: true,
      status: 'active',
      format: 'json',
    });

    expect(result.entities[0].canonical_key).toBe('knowledge:atlas');
  });

  it('getProjectMap reads the durable project map endpoint', async () => {
    nock(base)
      .get('/api/v1/context/projects/project_123/map')
      .query({ verbosity: 'standard', format: 'json' })
      .reply(200, {
        project_map: {
          project_id: 'project_123',
          project_name: 'Atlas',
          hot_paths: [{ label: 'auth modal', path: 'apps/marketing/src/components/AuthModal.tsx' }],
          entrypoints: [],
          surfaces: [],
          debugging_notes: [],
        },
      });

    const result = await makeClient().getProjectMap({
      project_id: 'project_123',
      verbosity: 'standard',
      format: 'json',
    });

    expect(result.project_id).toBe('project_123');
    expect(result.hot_paths[0].label).toBe('auth modal');
  });

  it('findKnownPaths reads workspace known-path memory', async () => {
    nock(base)
      .get('/api/v1/context/workspace/known-paths')
      .query({ query: 'auth modal', project_id: 'project_123', limit: 5, format: 'json' })
      .reply(200, {
        results: [{ project_id: 'project_123', kind: 'hot_path', label: 'auth modal', path: 'apps/marketing/src/components/AuthModal.tsx' }],
      });

    const result = await makeClient().findKnownPaths({
      query: 'auth modal',
      project_id: 'project_123',
      limit: 5,
      format: 'json',
    });

    expect(result.results[0].kind).toBe('hot_path');
  });

  it('recordHotPaths posts durable path memory to the project endpoint', async () => {
    nock(base)
      .post('/api/v1/context/projects/project_123/hot-paths', (body) => {
        return Array.isArray(body.items) && body.items[0]?.label === 'auth modal';
      })
      .reply(200, {
        project_id: 'project_123',
        project_name: 'Atlas',
        hot_paths: [{ label: 'auth modal', path: 'apps/marketing/src/components/AuthModal.tsx' }],
      });

    const result = await makeClient().recordHotPaths('project_123', [
      { label: 'auth modal', path: 'apps/marketing/src/components/AuthModal.tsx' },
    ]);

    expect(result.hot_paths[0].path).toContain('AuthModal.tsx');
  });

  it('recordDebugFinding posts durable debugging notes to the project endpoint', async () => {
    nock(base)
      .post('/api/v1/context/projects/project_123/debug-findings', (body) => {
        return body.summary === 'Verification should stay in the modal' && body.paths[0] === 'apps/marketing/src/components/AuthModal.tsx';
      })
      .reply(200, {
        project_id: 'project_123',
        project_name: 'Atlas',
        debugging_notes: [{ summary: 'Verification should stay in the modal', paths: ['apps/marketing/src/components/AuthModal.tsx'] }],
      });

    const result = await makeClient().recordDebugFinding('project_123', {
      summary: 'Verification should stay in the modal',
      paths: ['apps/marketing/src/components/AuthModal.tsx'],
    });

    expect(result.debugging_notes[0].summary).toMatch(/stay in the modal/);
  });

  it('recordContextEvent posts structured cloud events to /api/v1/context/events', async () => {
    nock(base)
      .post('/api/v1/context/events', (body) => {
        return body.event_type === 'decision_made'
          && body.project_id === 'project_123'
          && body.summary === 'Use cloud-first runtime enforcement.'
          && body.metadata?.surface === 'codex';
      })
      .reply(202, { status: 'accepted', event_type: 'decision_made' });

    const result = await makeClient().recordContextEvent({
      event_type: 'decision_made',
      project_id: 'project_123',
      summary: 'Use cloud-first runtime enforcement.',
      metadata: { surface: 'codex' },
    });

    expect(result.status).toBe('accepted');
    expect(result.event_type).toBe('decision_made');
  });

  // Locks the update_context write-path contract: what pushContextUpdate actually
  // sends must match what the API's /context/extraction route accepts. Drift here
  // is what produced the live ZodError that unit tests missed, because they posted
  // a hand-written body to the route instead of the real client payload.
  it('pushContextUpdate posts the extraction contract and patches commands', async () => {
    let extractionBody: any = null;
    let commandsBody: any = null;
    nock(base)
      .post('/api/v1/context/extraction', (body) => { extractionBody = body; return true; })
      .reply(202, { project: { project_id: 'p1' } });
    nock(base)
      .patch('/api/v1/context/p1/context', (body) => { commandsBody = body; return true; })
      .reply(200, { ok: true });

    await makeClient().pushContextUpdate('p1', 'Shipped the auth fix', 'claude_code', [
      { label: 'test', run: 'npm test' },
    ]);

    expect(extractionBody.project_id).toBe('p1');
    expect(extractionBody.tool).toBe('claude_code');
    expect(extractionBody.chunks).toEqual([{ role: 'assistant', text: 'Shipped the auth fix' }]);
    expect(typeof extractionBody.session_id).toBe('string');
    expect(commandsBody.commands).toEqual([{ label: 'test', run: 'npm test' }]);
  });

  it('an unidentified client\'s save, session and create name no tool (activation 3a/3b)', async () => {
    // No handshake in this process and no DEERDAWN_SURFACE_ID: claude_code below
    // is the rendering DEFAULT, not this client's identity.
    const prevEnv = process.env.DEERDAWN_SURFACE_ID;
    delete process.env.DEERDAWN_SURFACE_ID;
    try {
      let extractionBody: any = null;
      let createBody: any = null;
      let activeQuery: any = null;
      nock(base).post('/api/v1/context/extraction', (body) => { extractionBody = body; return true; }).reply(202, { project: { project_id: 'p1' } });
      nock(base).post('/api/v1/context/projects', (body) => { createBody = body; return true; }).reply(201, { project: { project_id: 'p2', project_name: 'X' } });
      // Twice: an API that does not acknowledge the location headers is asked again with them in the query.
      nock(base).get('/api/v1/context/active').query((q) => { activeQuery = q; return true; }).times(2).reply(200, { brief: null });

      await makeClient().pushContextUpdate('p1', 'Shipped it', 'claude_code');
      await makeClient().createContextProject('X', undefined, undefined, { workspaceKey: null, mcpSession: { tool: null } });
      await makeClient().getActiveContextByCwd('/tmp', 'claude_code', 'standard', true);

      expect(extractionBody.tool_identified).toBe(false);
      expect(createBody.from_mcp_session).toBe(true);
      expect(createBody.session_tool).toBeUndefined();
      expect(String(activeQuery.tool_identified)).toBe('0');
    } finally {
      if (prevEnv === undefined) delete process.env.DEERDAWN_SURFACE_ID;
      else process.env.DEERDAWN_SURFACE_ID = prevEnv;
    }
  });

  it('pushContextUpdate merges commands by label onto the stored log instead of replacing it', async () => {
    let commandsBody: any = null;
    nock(base)
      .post('/api/v1/context/extraction')
      .reply(202, {
        project: {
          project_id: 'p1',
          context: { commands: [{ label: 'lint', run: 'npm run lint' }, { label: 'test', run: 'npm test' }] },
        },
      });
    nock(base)
      .patch('/api/v1/context/p1/context', (body) => { commandsBody = body; return true; })
      .reply(200, { ok: true });

    await makeClient().pushContextUpdate('p1', 'Switched the test command', 'claude_code', [
      { label: 'test', run: 'bash scripts/run-db-test.sh npm test' },
    ]);

    // THE BUG: the PATCH is a replace, so sending one command deleted `lint`.
    expect(commandsBody.commands).toEqual([
      { label: 'lint', run: 'npm run lint' },
      { label: 'test', run: 'bash scripts/run-db-test.sh npm test' },
    ]);
  });

  it('only an update_context caller marks the write explicit; the import path does not', async () => {
    const bodies: any[] = [];
    nock(base).post('/api/v1/context/extraction', (body) => { bodies.push(body); return true; }).times(2).reply(202, { project: { project_id: 'p1' } });

    await makeClient().pushContextUpdate('p1', 'A sentence the caller asked to keep', 'claude_code', undefined, { explicit: true });
    await makeClient().pushContextUpdate('p1', 'A whole imported CLAUDE.md body');

    expect(bodies[0].explicit).toBe(true);
    expect('explicit' in bodies[1]).toBe(false);
  });

  it('pushContextUpdate skips the commands patch when none provided', async () => {
    const scope = nock(base)
      .post('/api/v1/context/extraction')
      .reply(202, { project: { project_id: 'p1' } });

    await makeClient().pushContextUpdate('p1', 'No commands here');

    // Only the extraction POST is registered; if the client also tried to PATCH
    // commands, nock would throw on an unmatched request.
    expect(scope.isDone()).toBe(true);
  });
});
