import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleAuthTool } from '../src/tools/auth.js';
import { resetCredentialState, setCredentialRenewalListener } from '../src/auth-state.js';

/**
 * `setup` baked a 90-day device-flow key into the MCP env, where it outranks
 * credentials.json on every boot. Once it expired, get_auth_status answered
 * `url: null` because an env key was configured, while the 401 path told the
 * user to call get_auth_status. A circle with no exit.
 *
 * Driven against a real socket: /context/search is the key check, /auth/mcp/*
 * is the device flow.
 */
const GOOD_SAVED_KEY = 'dd_saved_key_that_works_123';
const VERIFICATION_URL = 'https://app.deerdawn.com/mcp-auth?code=TEST1234';

let server: http.Server;
let apiUrl = '';
let deviceFlowStarts = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url?.startsWith('/api/v1/context/search')) {
      return send(req.headers['x-api-key'] === GOOD_SAVED_KEY ? 200 : 401, { error: 'API Key has expired.' });
    }
    if (req.url?.startsWith('/api/v1/auth/mcp/start')) {
      deviceFlowStarts++;
      // A one-second window so the detached poller finishes during the run.
      return send(200, { device_code: 'dc_test', verification_url: VERIFICATION_URL, expires_in: 1, interval: 1 });
    }
    if (req.url?.startsWith('/api/v1/auth/mcp/token')) return send(200, { status: 'pending' });
    return send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('get_auth_status with a rejected DEERDAWN_API_KEY', () => {
  let dir: string;
  const prev = {
    DIR: process.env.DEERDAWN_DIR,
    URL: process.env.DEERDAWN_API_URL,
    KEY: process.env.DEERDAWN_API_KEY,
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-envkey-'));
    process.env.DEERDAWN_DIR = dir;
    process.env.DEERDAWN_API_URL = apiUrl;
    process.env.DEERDAWN_API_KEY = 'dd_env_key_that_expired_42';
    deviceFlowStarts = 0;
    resetCredentialState();
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('DEERDAWN_DIR', prev.DIR);
    restore('DEERDAWN_API_URL', prev.URL);
    restore('DEERDAWN_API_KEY', prev.KEY);
    resetCredentialState();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const status = async () => JSON.parse((await handleAuthTool('get_auth_status')).content[0].text);

  it('starts the device flow, returns its link, and says to remove the env var', async () => {
    const payload = await status();
    expect(payload.authenticated).toBe(false);
    expect(payload.url).toBe(VERIFICATION_URL);
    expect(deviceFlowStarts).toBe(1);
    expect(payload.message).toContain(VERIFICATION_URL);
    expect(payload.message).toMatch(/DEERDAWN_API_KEY/);
    expect(payload.message).toMatch(/Remove it/i);
    // The circular advice must not come back.
    expect(payload.message).not.toMatch(/call get_auth_status/i);
  });

  it('recovers onto a working saved key, hands it to the live client, and still flags the env var', async () => {
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ api_key: GOOD_SAVED_KEY }));
    let renewedWith: string | null = null;
    setCredentialRenewalListener((key) => { renewedWith = key; });

    const payload = await status();
    expect(payload.authenticated).toBe(true);
    expect(payload.source).toBe('saved');
    expect(payload.message).toMatch(/DEERDAWN_API_KEY/);
    expect(renewedWith).toBe(GOOD_SAVED_KEY);
    expect(deviceFlowStarts).toBe(0);
  });

  it('does not start a sign-in when the API is merely unreachable', async () => {
    process.env.DEERDAWN_API_URL = 'http://127.0.0.1:1';
    const payload = await status();
    expect(payload.authenticated).toBe(false);
    expect(payload.url).toBeNull();
    expect(payload.message).toMatch(/Could not reach/);
  });
});
