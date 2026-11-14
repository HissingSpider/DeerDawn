import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { DeerdawnClient } from '../src/client.js';
import type { Config } from '../src/config.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';

// SCAN 24 (b) #4. A recall that named its project printed the project ID as its
// name and the literal "Last updated: null": the client hard-coded both for a
// project-id read of /inject, which does not send them.

const base = 'http://localhost:19998';

function makeClient(): DeerdawnClient {
  const config: Config = {
    apiUrl: base,
    apiKey: 'dd_sandbox_abcdefghijklmnopqrstuvwxyz0123456789',
    environment: 'sandbox',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    maxRetries: 0,
    retryBackoffMs: 100,
  };
  return new DeerdawnClient(config);
}

const BRIEF = 'Project: Aurora\nCurrent task: ship the ledger audit trail\nContext updated: 2 hours ago via claude_code';

afterEach(() => {
  nock.cleanAll();
});

describe('recall with a project_id', () => {
  it('does not print the id as the name, or "Last updated: null"', async () => {
    nock(base)
      .get('/api/v1/context/projects/project_abc123/inject')
      .query(true)
      .reply(200, { payload: { body: BRIEF, format: 'conversational' } });

    const result = await handleContextSyncTool('recall', { action: 'context', project_id: 'project_abc123' }, makeClient());
    const text = result.content[0].text as string;
    expect(text).not.toContain('Last updated: null');
    expect(text).not.toContain('Project: project_abc123');
    expect(text).toContain('Current task: ship the ledger audit trail');
  });

  it('the client reports what it does not know as null, and what the API sends as sent', async () => {
    nock(base)
      .get('/api/v1/context/projects/project_abc123/inject')
      .query(true)
      .reply(200, { payload: { body: BRIEF } });
    const plain = await makeClient().getActiveContext('project_abc123');
    expect(plain.project_name).toBeNull();
    expect(plain.last_updated).toBeNull();
    expect(plain.project_id).toBe('project_abc123');

    nock(base)
      .get('/api/v1/context/projects/project_abc123/inject')
      .query(true)
      .reply(200, { payload: { body: BRIEF, project_name: 'Aurora', updated_at: '2026-09-23T10:00:00Z' } });
    const named = await makeClient().getActiveContext('project_abc123');
    expect(named.project_name).toBe('Aurora');
    expect(named.last_updated).toBe('2026-09-23T10:00:00Z');
  });

  it('a sections read names the project the API names', async () => {
    nock(base)
      .get('/api/v1/context/projects/project_abc123/inject')
      .query((q) => q.sections === 'task')
      .reply(200, { payload: { body: 'Current task: ship it', sections: ['current_task'], project_id: 'project_abc123', project_name: 'Aurora' } });

    const result = await handleContextSyncTool('recall', { action: 'context', project_id: 'project_abc123', sections: ['task'] }, makeClient());
    const text = result.content[0].text as string;
    expect(text).toContain('Project: Aurora');
    expect(text).not.toContain('project_abc123');
  });
});
