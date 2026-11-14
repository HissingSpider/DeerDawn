/**
 * What a hook may cost.
 *
 * capture-command runs after EVERY Bash call and capture-worktree-change after
 * every edit, inside the host's turn. They used the same API client as a tool
 * call — 30 second timeout, three backed-off retries — asked the API whether the
 * account's plan allows capture far more often than the answer changes, and
 * appended to an offline queue with no ceiling.
 *
 * HOME and DEERDAWN_HOME point at a temp dir before any module loads.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const API = 'http://localhost:21178';
const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'DEERDAWN_HOME', 'DEERDAWN_DIR', 'DEERDAWN_HOME_DIR', 'DEERDAWN_API_URL',
  'DEERDAWN_API_KEY', 'DEERDAWN_CAPTURE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_SURFACE_ID',
  'DEERDAWN_MAX_RETRIES', 'DEERDAWN_RETRY_BACKOFF_MS',
] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const API_KEY = 'dd_test_key_0123456789';
const KEY_ID = createHash('sha256').update(API_KEY).digest('hex').slice(0, 12);

describe('hook network budget', () => {
  let home: string;
  let stdinDescriptor: PropertyDescriptor | undefined;
  const entitlementPath = () => path.join(home, '.deerdawn', 'command-capture-entitlement.json');
  const queuePath = () => path.join(home, '.deerdawn', 'cloud-write-queue.json');

  function bashHookStdin(): void {
    const stream = Readable.from([Buffer.from(JSON.stringify({
      tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 },
    }))]) as any;
    stream.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  }

  async function runCommandHook(): Promise<{ captured: boolean }> {
    bashHookStdin();
    vi.resetModules(); // a hook is a fresh process every time
    const { captureCommandFromHook } = await import('../src/command-capture.js');
    return captureCommandFromHook();
  }

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-hook-budget-')));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.DEERDAWN_HOME = path.join(home, '.deerdawn');
    process.env.DEERDAWN_API_URL = API;
    fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
    fs.writeFileSync(path.join(home, '.deerdawn', 'credentials.json'), JSON.stringify({ api_key: API_KEY }));
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = repo;
    stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    nock.disableNetConnect();
  });

  afterEach(() => {
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
    nock.cleanAll();
    nock.enableNetConnect();
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('timeout and retry', () => {
    it('gives up on an API that does not answer within ~3s', async () => {
      nock(API).get('/api/v1/orgs/usage').delay(8000).reply(200, { plan: { tier: 'developer_pro' } });
      const started = Date.now();
      const result = await runCommandHook();
      const elapsed = Date.now() - started;
      expect(result.captured).toBe(false);
      expect(elapsed).toBeLessThan(4500);
    }, 15000);

    it('does not retry a 503: one request, not four', async () => {
      let hits = 0;
      nock(API).persist().get('/api/v1/orgs/usage').reply(() => { hits += 1; return [503, { error: 'unavailable' }]; });
      // Keep the unfixed path's backoff short so this fails fast instead of slowly.
      process.env.DEERDAWN_RETRY_BACKOFF_MS = '100';
      await runCommandHook();
      expect(hits).toBe(1);
    }, 15000);

    it('a tool-call client keeps its retries: the hook profile is opt-in', async () => {
      let hits = 0;
      nock(API).persist().get('/api/v1/orgs/usage').reply(() => { hits += 1; return [503, {}]; });
      vi.resetModules();
      const { DeerdawnClient } = await import('../src/client.js');
      const client = new DeerdawnClient({
        apiUrl: API, apiKey: 'dd_test_key_0123456789', environment: 'sandbox',
        cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 2, retryBackoffMs: 100,
      });
      await client.getOrganizationSettings().catch(() => null);
      expect(hits).toBe(3);
    }, 15000);
  });

  describe('the plan check', () => {
    it('remembers "not eligible" for longer than five minutes', async () => {
      let hits = 0;
      nock(API).persist().get('/api/v1/orgs/usage').reply(() => { hits += 1; return [200, { plan: { tier: 'free' } }]; });
      fs.writeFileSync(entitlementPath(), JSON.stringify({
        plan: 'free', allowed: false, key_id: KEY_ID, checked_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      }));
      const result = await runCommandHook();
      expect(result.captured).toBe(false);
      expect(hits).toBe(0);
    });

    it('but not forever: an upgrade is noticed within hours', async () => {
      let hits = 0;
      nock(API).persist()
        .get('/api/v1/orgs/usage').reply(() => { hits += 1; return [200, { plan: { tier: 'developer_basic' } }]; })
        .get(/\/api\/v1\/context\/active.*/).reply(200, { project_id: 'p_1', project_name: 'Atlas', match_kind: 'path' })
        .post('/api/v1/context/events').reply(202, {});
      fs.writeFileSync(entitlementPath(), JSON.stringify({
        plan: 'free', allowed: false, key_id: KEY_ID, checked_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      }));
      const result = await runCommandHook();
      expect(hits).toBe(1);
      expect(result.captured).toBe(true);
    });

    it('a FAILED check is remembered briefly, so an unreachable API is not asked on every command', async () => {
      let hits = 0;
      nock(API).persist().get('/api/v1/orgs/usage').reply(() => { hits += 1; return [500, {}]; });
      await runCommandHook();
      await runCommandHook();
      await runCommandHook();
      expect(hits).toBe(1);
    });

    it('a failed check answers with the last real verdict: being offline does not change your plan', async () => {
      const events: string[] = [];
      nock(API).persist()
        .get('/api/v1/orgs/usage').reply(500, {})
        .get(/\/api\/v1\/context\/active.*/).reply(200, { project_id: 'p_1', project_name: 'Atlas', match_kind: 'path' })
        .post('/api/v1/context/events').reply(() => { events.push('event'); return [202, {}]; });
      fs.writeFileSync(entitlementPath(), JSON.stringify({
        plan: 'developer_pro', allowed: true, key_id: KEY_ID, checked_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }));
      const result = await runCommandHook();
      expect(result.captured).toBe(true);
      expect(events).toHaveLength(1);
      // ...and the verdict survives beside the failure stamp.
      const cache = JSON.parse(fs.readFileSync(entitlementPath(), 'utf8'));
      expect(cache.allowed).toBe(true);
      expect(typeof cache.failed_at).toBe('string');
    });

    it('a "not eligible" written for a DIFFERENT key is not believed', async () => {
      let hits = 0;
      nock(API).persist()
        .get('/api/v1/orgs/usage').reply(() => { hits += 1; return [200, { plan: { tier: 'developer_pro' } }]; })
        .get(/\/api\/v1\/context\/active.*/).reply(200, { project_id: 'p_1', project_name: 'Atlas', match_kind: 'path' })
        .post('/api/v1/context/events').reply(202, {});
      fs.writeFileSync(entitlementPath(), JSON.stringify({
        plan: 'free', allowed: false, key_id: 'someoneelse0', checked_at: new Date().toISOString(),
      }));
      const result = await runCommandHook();
      expect(hits).toBe(1);
      expect(result.captured).toBe(true);
    });

    it('with no verdict at all, a failed check means no capture', async () => {
      nock(API).persist().get('/api/v1/orgs/usage').reply(500, {});
      expect((await runCommandHook()).captured).toBe(false);
    });
  });

  describe('the offline queue', () => {
    async function offlineClient() {
      vi.resetModules();
      const mod = await import('../src/client.js');
      nock(API).persist().post('/api/v1/context/events').reply(503, {});
      const client = new mod.DeerdawnClient({
        apiUrl: API, apiKey: 'dd_test_key_0123456789', environment: 'sandbox',
        cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 0, retryBackoffMs: 100,
      });
      return { client, mod };
    }

    it('is capped by count, and it is the OLDEST entries that go', async () => {
      const { client, mod } = await offlineClient();
      const total = mod.QUEUE_MAX_ENTRIES + 25;
      for (let i = 0; i < total; i++) {
        await client.recordContextEvent({ event_type: 'command_confirmed', project_id: 'p_1', summary: `command ${i}` });
      }
      const { entries } = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
      expect(entries).toHaveLength(mod.QUEUE_MAX_ENTRIES);
      expect(entries[entries.length - 1].body.summary).toBe(`command ${total - 1}`);
      expect(entries[0].body.summary).toBe('command 25');
    }, 30000);

    it('is capped by bytes', async () => {
      const { client, mod } = await offlineClient();
      const big = 'x'.repeat(40 * 1024);
      for (let i = 0; i < 30; i++) {
        await client.recordContextEvent({ event_type: 'file_changed', project_id: 'p_1', summary: `${i}:${big}` });
      }
      expect(fs.statSync(queuePath()).size).toBeLessThanOrEqual(mod.QUEUE_MAX_BYTES + 1024);
      const { entries } = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[entries.length - 1].body.summary.startsWith('29:')).toBe(true);
    }, 30000);

    it('one entry too large to ever fit does not evict the rest', async () => {
      const { client, mod } = await offlineClient();
      await client.recordContextEvent({ event_type: 'command_confirmed', project_id: 'p_1', summary: 'small and useful' });
      await client.recordContextEvent({ event_type: 'file_changed', project_id: 'p_1', summary: 'y'.repeat(mod.QUEUE_MAX_BYTES + 10) });
      const { entries } = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
      expect(entries.map((e: any) => e.body.summary)).toEqual(['small and useful']);
    });

    it('a queued event still flushes once the API is back', async () => {
      const { client } = await offlineClient();
      await client.recordContextEvent({ event_type: 'task_started', project_id: 'p_1', summary: 'queued while offline' });
      nock.cleanAll();
      nock(API).post('/api/v1/context/events').reply(202, {});
      expect(await client.flushQueuedContextWrites()).toEqual({ flushed: 1, remaining: 0 });
    });
  });
});
