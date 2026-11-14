/**
 * A workspace that is CLOSED is not a service that is DOWN.
 *
 * An ordinary key plus a team header on a team whose subscription has lapsed
 * gets 403 `subscription_inactive`. start_session collapsed every failure it
 * could not name into "context sync is unreachable right now (network or
 * service degraded) ... retry shortly", and every other tool into "Access
 * forbidden. Insufficient permissions." — so a lapsed team read as an outage to
 * every member of it, retrying was the one remedy guaranteed never to work, and
 * the one person who could fix it (a workspace owner, in the billing settings)
 * was never told there was anything to fix.
 *
 * The 409 `workspace_inactive` a WRITE gets was worse than unhelpful: unlisted,
 * it became "Conflicts with something that already exists", which is not true of
 * a refused write. Nothing was created and nothing conflicts.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { resetWorkspaceOverrideState } from '../src/workspace-override.js';

const WORKSPACE = 'org_acme_team';

describe('a workspace whose subscription has lapsed', () => {
  let server: http.Server;
  let apiUrl: string;
  let refusal: { status: number; body: Record<string, unknown> };
  const originalWorkspace = process.env.DEERDAWN_WORKSPACE;

  beforeEach(async () => {
    resetWorkspaceOverrideState();
    refusal = {
      status: 403,
      body: { error: 'subscription_inactive', message: 'Your subscription is not active. Update billing to restore access.' },
    };
    server = http.createServer((req, res) => {
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.statusCode = refusal.status;
      res.end(JSON.stringify(refusal.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (originalWorkspace === undefined) delete process.env.DEERDAWN_WORKSPACE;
    else process.env.DEERDAWN_WORKSPACE = originalWorkspace;
  });

  const makeClient = () => new DeerdawnClient({
    apiUrl, apiKey: 'dd_personal_key', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 0, retryBackoffMs: 10,
  } as any);

  const answer = (tool: string, args: Record<string, unknown> = {}) =>
    handleContextSyncTool(tool, args, makeClient()).then(
      (result: any) => String(result?.content?.[0]?.text ?? ''),
      (err: Error) => err.message,
    );

  it('is what start_session says, instead of calling it a network problem', async () => {
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;

    const said = await answer('start_session');

    expect(said).toContain(WORKSPACE);
    expect(said).toMatch(/subscription/i);
    expect(said).toMatch(/billing/i);
    expect(said).not.toMatch(/unreachable/i);
    expect(said).not.toMatch(/degraded/i);
    expect(said).not.toMatch(/retry shortly/i);
  });

  it('is what the other tools say, instead of "Insufficient permissions"', async () => {
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;

    const said = await answer('recall', { action: 'projects' });

    expect(said).toContain(WORKSPACE);
    expect(said).toMatch(/subscription/i);
    expect(said).not.toMatch(/Insufficient permissions/);
  });

  it('names the way out that matches where the workspace is actually set', async () => {
    process.env.DEERDAWN_WORKSPACE = WORKSPACE;

    const said = await answer('start_session');

    expect(said).toMatch(/DEERDAWN_WORKSPACE/);
    expect(said).toMatch(/work in your own workspace/i);
  });

  it('shows the server\'s own words on a 409, not "Conflicts with something that already exists"', async () => {
    // No workspace targeted by this install: the refusal arrives anyway, because
    // the key's own workspace is the one that lapsed. The service wrote the fix
    // into `message`, and that is the sentence that has to survive.
    delete process.env.DEERDAWN_WORKSPACE;
    refusal = {
      status: 409,
      body: {
        error: 'workspace_inactive',
        message: "Acme's subscription is inactive, so nothing was changed. Switch to your own workspace to keep working, or ask a workspace owner to update billing.",
      },
    };

    const said = await answer('manage_memory', { action: 'update', project_id: 'p_team', summary: 'Decided to keep the 429 budget.' });

    expect(said).toMatch(/subscription is inactive/i);
    expect(said).not.toMatch(/Conflicts with something that already exists/);
  });
});
