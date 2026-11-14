import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { DeerdawnClient } from '../src/client.js';
import type { Config } from '../src/config.js';

const base = 'http://localhost:21111';
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

describe('cloud write queue', () => {
  const originalHome = process.env.DEERDAWN_HOME;

  afterEach(() => {
    nock.cleanAll();
    if (originalHome === undefined) delete process.env.DEERDAWN_HOME;
    else process.env.DEERDAWN_HOME = originalHome;
  });

  it('queues structured events when cloud write fails and flushes them later', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'deerdawn-cloud-queue-'));
    process.env.DEERDAWN_HOME = tempHome;
    const queuePath = join(tempHome, 'cloud-write-queue.json');

    nock(base)
      .post('/api/v1/context/events')
      .reply(503, { error: 'temporarily_unavailable' });

    const client = makeClient();
    const queued = await client.recordContextEvent({
      event_type: 'task_started',
      project_id: 'project_123',
      summary: 'Start implementing cloud-first queue behavior.',
    });

    expect(queued.queued).toBe(true);
    const persisted = JSON.parse(readFileSync(queuePath, 'utf8'));
    expect(persisted.entries).toHaveLength(1);

    nock.cleanAll();
    nock(base)
      .post('/api/v1/context/events')
      .reply(202, { status: 'accepted' });

    const flushed = await client.flushQueuedContextWrites();
    expect(flushed.flushed).toBe(1);
    const after = JSON.parse(readFileSync(queuePath, 'utf8'));
    expect(after.entries).toHaveLength(0);

    rmSync(tempHome, { recursive: true, force: true });
  });
});
