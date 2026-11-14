/**
 * Product events are relayed to PostHog. They carried process.cwd() — a home
 * directory, a user name, usually a client's name — on every tool call, and the
 * raw exception message on every failure.
 *
 * Asserted at the wire: whatever a call site hands recordProductEvent, this is
 * what the API receives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { DeerdawnClient } from '../src/client.js';
import { telemetryErrorCode, telemetryPathCategory, scrubTelemetryText } from '../src/telemetry-safe.js';

const API = 'http://localhost:21179';

function makeClient(): DeerdawnClient {
  return new DeerdawnClient({
    apiUrl: API, apiKey: 'dd_sandbox_abcdefghijklmnopqrstuvwxyz0123456789', environment: 'sandbox',
    cacheEnabled: false, cacheTtlSeconds: 60, maxRetries: 0, retryBackoffMs: 100,
  });
}

async function sentBody(event: Parameters<DeerdawnClient['recordProductEvent']>[0]): Promise<any> {
  let body: any = null;
  nock(API).post('/api/v1/product-events').reply(200, (_uri, requestBody) => { body = requestBody; return { ok: true }; });
  await makeClient().recordProductEvent(event);
  return body;
}

afterEach(() => nock.cleanAll());

describe('product events carry no filesystem path and no raw error', () => {
  const cwd = '/Users/jane.doe/clients/AcmeCorp/secret-merger';

  it('drops a working directory passed as `path`', async () => {
    const body = await sentBody({ event_name: 'mcp_tool_call_succeeded', source: 'mcp', path: cwd, metadata: { tool_name: 'recall' } });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('jane.doe');
    expect(wire).not.toContain('AcmeCorp');
    expect(wire).not.toContain('secret-merger');
    expect(body.path).toBeNull();
    expect(body.metadata.tool_name).toBe('recall');
  });

  it('drops a Windows working directory too', async () => {
    const body = await sentBody({ event_name: 'mcp_runtime_started', source: 'mcp', path: 'C:\\Users\\jane\\AcmeCorp' });
    expect(JSON.stringify(body)).not.toContain('AcmeCorp');
  });

  it('keeps a category token', async () => {
    const body = await sentBody({ event_name: 'mcp_runtime_started', source: 'mcp', path: 'git_repo' });
    expect(body.path).toBe('git_repo');
  });

  it('scrubs a raw error message: no path, no secret, clipped', async () => {
    const message = `ENOENT: no such file or directory, open '${cwd}/.env' while using postgres://app:` + 'hunter2pw@db.internal/app ' + 'x'.repeat(400);
    const body = await sentBody({ event_name: 'mcp_tool_call_failed', source: 'mcp', metadata: { tool_name: 'recall', error: message } });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('jane.doe');
    expect(wire).not.toContain('AcmeCorp');
    expect(wire).not.toContain('hunter2pw');
    expect(body.metadata.error.length).toBeLessThanOrEqual(120);
    expect(body.metadata.error.startsWith('ENOENT')).toBe(true);
  });

  it('leaves non-string metadata and ordinary strings alone', async () => {
    const body = await sentBody({
      event_name: 'context_import_completed', source: 'mcp',
      metadata: { count: 3, ok: true, client_name: 'claude-code', client_version: '2.1.0', docs: 'https://deerdawn.com/docs/mcp-server' },
    });
    expect(body.metadata).toEqual({ count: 3, ok: true, client_name: 'claude-code', client_version: '2.1.0', docs: 'https://deerdawn.com/docs/mcp-server' });
  });
});

describe('telemetryPathCategory', () => {
  it('answers with a category and never with any part of the path', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'AcmeCorp-telemetry-')));
    try {
      const repo = path.join(tmp, 'secret-merger');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'src'));
      expect(telemetryPathCategory(path.join(repo, 'src'))).toBe('git_repo');
      expect(telemetryPathCategory(os.homedir())).toBe('home_dir');
      expect(telemetryPathCategory(null)).toBe('unknown');
      for (const dir of [repo, tmp, os.homedir(), '/']) {
        expect(telemetryPathCategory(dir)).toMatch(/^[a-z_]+$/);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('telemetryErrorCode', () => {
  it('is a code, never the message', () => {
    const secretish = new Error(`cannot read /Users/jane.doe/AcmeCorp/.env`);
    expect(telemetryErrorCode(secretish)).toBe('Error');
    expect(telemetryErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(telemetryErrorCode({ response: { status: 404 }, message: '/Users/jane' })).toBe('http_404');
    expect(telemetryErrorCode(Object.assign(new Error('bad'), { code: -32602 }))).toBe('mcp_-32602');
    expect(telemetryErrorCode(Object.assign(new Error('x'), { code: '/Users/jane/not a code' }))).toBe('Error');
    expect(telemetryErrorCode('a string thrown')).toBe('unknown_error');
    expect(telemetryErrorCode(null)).toBe('unknown_error');
  });
});

describe('scrubTelemetryText', () => {
  it('removes absolute paths in every spelling and keeps URLs', () => {
    expect(scrubTelemetryText('open /Users/jane/x failed')).toBe('open [path] failed');
    expect(scrubTelemetryText('open ~/work/x failed')).toBe('open [path] failed');
    expect(scrubTelemetryText('open C:\\Users\\jane\\x failed')).toBe('open [path] failed');
    expect(scrubTelemetryText('see https://deerdawn.com/docs/x')).toBe('see https://deerdawn.com/docs/x');
    expect(scrubTelemetryText('a/b relative')).toBe('a/b relative');
  });
});
